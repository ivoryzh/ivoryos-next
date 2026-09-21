// The one process that actually holds the MQTT connection. Next.js API routes are request-scoped
// and shouldn't own a long-lived broker connection, so this is a standalone Node process:
// `npm run daemon`, run once per deployment, separate from `next dev` / `next start`.
//
// It runs in either of two shapes, chosen by src/lib/store (see that module for the rules):
//
//   local — a lab on a LAN: SQLite file + a local mosquitto. No accounts, no keys, no internet.
//   cloud — the hosted product: Supabase + AWS IoT Core (or any remote broker), mutual TLS.
//
// Nothing below this comment branches on the mode: the store and the broker options are resolved
// once, and the dispatch loop is identical either way.
//
// It consumes the retained status/schema/sequences topics each Edge device publishes (see
// edge_server/ivoryos_edge/server.py's status_loop/publish_schema/publish_sequences), and owns
// the other direction too: dispatching `execute` tasks and walking each run's graph forward as
// they report back (see the Dispatch section further down).
//
// Unlike Next.js (which auto-loads .env.local for the app), a plain `node daemon.js` process
// starts with none of that — without this, every var below would be undefined even with a fully
// filled-in .env.local sitting right next to this file.
require('dotenv').config({ path: require('path').join(__dirname, '.env.local') });

const mqtt = require('mqtt');
const fs = require('fs');
// The scheduling rules — what depends on what, when a task is released, when a run is finished —
// are shared verbatim with the Next.js run route rather than reimplemented here. Plain CommonJS
// precisely so this build-step-free process can require it; see that module's header for why the
// two copies that used to exist disagreed.
const { TERMINAL_TASK_STATUSES, computeAdvance } = require('./src/lib/dag.js');
const { getStore, resolveBrokerUrl } = require('./src/lib/store');
const { startEmbeddedBroker } = require('./src/lib/embedded-broker.js');

let store;
try {
    store = getStore();
} catch (e) {
    console.error(`[Daemon] ${e.message}`);
    process.exit(1);
}
const MODE = store.mode;
console.log(`[Daemon] mode: ${MODE}  store: ${store.backend} (${store.location})`);

const TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX || 'ivoryos/edge';

// Local broker for LAN/dev (mqtt://host:port, no client cert), or AWS IoT Core (mutual TLS) in
// cloud deployments — same client_id-per-device-per-connection model the edge server itself uses.
function buildMqttOptions() {
    if (process.env.AWS_IOT_ENDPOINT) {
        return {
            url: resolveBrokerUrl(),
            options: {
                clientId: process.env.MQTT_CLIENT_ID || `ivoryos-cloud-daemon-${Date.now()}`,
                ca: fs.readFileSync(process.env.AWS_IOT_CA_PATH),
                cert: fs.readFileSync(process.env.AWS_IOT_CERT_PATH),
                key: fs.readFileSync(process.env.AWS_IOT_KEY_PATH),
            }
        };
    }
    return {
        url: resolveBrokerUrl(),
        options: { clientId: process.env.MQTT_CLIENT_ID || `ivoryos-cloud-daemon-${Date.now()}` }
    };
}

const { url, options } = buildMqttOptions();
// `manualConnect` so the embedded broker (if this process is going to be the broker) is listening
// before the first connection attempt. Without it the client races its own broker, fails once,
// and greets a brand new user with an MQTT error that resolves itself a second later — which is
// exactly the kind of noise that makes a working setup look broken.
const client = mqtt.connect(url, { ...options, manualConnect: true });

// Resolves on a later tick than this module body, so every handler below is registered before the
// connection is opened. Held for the shutdown path.
let embeddedBroker = null;
startEmbeddedBroker(url).then((result) => {
    if (result.started) {
        embeddedBroker = result;
        console.log(`[Daemon] Embedded broker listening on 0.0.0.0:${result.port} — no mosquitto needed.`);
    } else {
        console.log(`[Daemon] Using external broker (${result.reason}).`);
    }
    client.connect();
});
// Declared here, not beside watchBrokerConfig below: writeHeartbeat() runs at startup and reads
// it, and a `let` further down would still be in its temporal dead zone at that point.
let currentBrokerUrl = url;

client.on('connect', () => {
    console.log(`[Daemon] Connected to ${url}`);
    client.subscribe(`${TOPIC_PREFIX}/+/status`);
    client.subscribe(`${TOPIC_PREFIX}/+/schema`);
    client.subscribe(`${TOPIC_PREFIX}/+/sequences/+`);
    client.subscribe(`${TOPIC_PREFIX}/+/task-status`);
    // Retained messages replay immediately on subscribe — this is the entire "catch up on
    // reconnect" mechanism, for both this daemon restarting AND an edge device reconnecting.
    // No polling, no explicit sync request needed on either side.
    writeHeartbeat();
});

client.on('error', (err) => console.error('[Daemon] MQTT error:', err.message));
client.on('reconnect', () => console.log('[Daemon] Reconnecting...'));
client.on('close', () => { console.log('[Daemon] Connection closed.'); writeHeartbeat(); });
client.on('offline', () => { console.log('[Daemon] Offline (no connection).'); writeHeartbeat(); });

client.on('message', async (topic, message) => {
    const parts = topic.split('/'); // ivoryos/edge/{deviceId}/(status|schema|sequences/{name})
    const deviceId = parts[2];
    const kind = parts[3];

    // An empty retained payload is MQTT's tombstone: it is how a publisher deletes a retained
    // message. Must be handled before JSON.parse, which would otherwise reject it as bad JSON and
    // leave the deleted workflow in Cloud forever — which is exactly what used to happen.
    if (message.length === 0) {
        if (kind === 'sequences') {
            const name = parts[4];
            try {
                const removed = await store.deleteSequence(deviceId, name);
                if (removed) console.log(`[Daemon] Sequence ${deviceId}/${name} deleted on the device, removed from Cloud.`);
            } catch (e) {
                console.error(`[Daemon] Failed to remove deleted sequence ${deviceId}/${name}:`, e.message);
            }
        }
        return;
    }

    let payload;
    try {
        payload = JSON.parse(message.toString());
    } catch (e) {
        console.error(`[Daemon] Bad JSON on ${topic}:`, e.message);
        return;
    }

    try {
        if (kind === 'status') {
            await store.upsertDeviceStatus(deviceId, payload.online ? 'online' : 'offline');
        } else if (kind === 'schema') {
            await store.upsertDeviceSchema(deviceId, payload);
            const count = Object.keys((payload && payload.instruments) || {}).length;
            console.log(`[Daemon] ${deviceId} schema synced (${count} instruments)`);
        } else if (kind === 'sequences') {
            const name = parts[4];
            await store.upsertSequence({
                device_id: deviceId, name, description: payload.description || '', body: payload,
            });
            // The device echoing a sequence back IS the acknowledgement of a push we sent — the
            // device owns the durable copy, so a push is only real once its own retained topic
            // carries it.
            //
            // Correlated on the step content, NOT on body_hash: the device recomputes the hash
            // from the canonical body when it saves, so the hash Cloud sent is essentially never
            // the hash that comes back, and matching on it left every push unacknowledged forever
            // (observed: a push whose file had demonstrably landed on the device still read
            // 'sent'). Comparing the steps also keeps the property that mattered — a concurrent
            // bench edit that won echoes *different* content and so does not falsely ack.
            const acked = await ackIfEchoMatches(deviceId, name, payload);
            console.log(acked
                ? `[Daemon] Push ${deviceId}/${name} acknowledged by the device.`
                : `[Daemon] Synced sequence ${deviceId}/${name}`);
        } else if (kind === 'task-status') {
            await handleTaskStatus(payload);
        }
    } catch (e) {
        console.error(`[Daemon] Error handling ${topic}:`, e.message);
    }
});

// --- Liveness -----------------------------------------------------------------------------
// /api/health reads this. It lives in the store rather than a pid file because the Next app and
// the daemon need not share a filesystem in cloud mode, and the health check must mean the same
// thing in both. A missing or stale row is what tells the UI "the backend is down" instead of
// showing an empty device list that looks identical to "no devices are connected yet".
async function writeHeartbeat() {
    try {
        await store.setDaemonHeartbeat({
            brokerConnected: client.connected,
            brokerUrl: currentBrokerUrl,
            mode: MODE,
            storeLocation: store.location,
        });
    } catch (e) {
        console.error('[Daemon] Failed to write heartbeat:', e.message);
    }
}
setInterval(writeHeartbeat, 5000);
writeHeartbeat();

// --- Dispatch: the other half of the orchestrator loop. Cloud's "Run" button (see
// api/cloud-workflows/runs) inserts run_tasks rows with status 'pending' for every node whose
// dependencies are already satisfied; everything else starts 'blocked'. This daemon is the only
// process holding a live, authenticated MQTT connection, so it's also the only thing that can
// publish to a device's execute topic. The store tells it when a task becomes ready — via
// Supabase Realtime in cloud mode, via a short poll in LAN mode — whether that's from a fresh run
// or from a task just having unblocked one further downstream (see handleTaskStatus below).

async function handleTaskStatus(payload) {
    const { runId, nodeId, status } = payload;
    if (!runId || !nodeId || !status) return;

    // MQTT QoS 1 only guarantees at-least-once, in-order delivery per publisher connection — but
    // a "running" message sent moments before "completed" can still arrive after it (observed
    // directly: a run that genuinely completed on the edge showed completed->running in this log,
    // stale "running" landing late during a reconnect). Once a task reaches a terminal status,
    // refuse to move it backwards — this simply matches zero rows if the task already finished.
    const moved = await store.updateTaskStatusIfNotTerminal(
        runId, nodeId, status, TERMINAL_TASK_STATUSES,
    );
    if (!moved) {
        console.log(`[Daemon] Ignored stale '${status}' for already-finished task ${runId}/${nodeId}`);
        return;
    }
    console.log(`[Daemon] Task ${runId}/${nodeId} -> ${status}`);

    // Both outcomes advance the run, for opposite reasons: 'completed' can release dependents,
    // 'error' can strand them permanently. The error case used to just stamp the run 'error' and
    // return, which left every downstream task sitting at 'blocked' forever — safe (they never
    // ran) but indistinguishable in the UI from a run still making progress.
    if (status === 'completed' || status === 'error') {
        await advanceRun(runId);
    }
}

// Walk the run forward one step: release whatever the just-finished task unblocked, kill whatever
// it stranded, and decide whether the run as a whole is over. The rules are `computeAdvance` in
// src/lib/dag.js — the same function the run route planned this run with, so "what does this edge
// mean" has exactly one answer on both sides. This function is only the I/O around it.
//
// Re-reading the stored edges each time (rather than keeping a dependency list per task) keeps
// the graph single-sourced: the plan cannot drift from the graph it was derived from.
async function advanceRun(runId) {
    const run = await store.getRun(runId);
    if (!run || run.status !== 'running') return;

    const tasks = await store.listRunTasks(runId);
    if (!tasks) return;

    const { unblock, cancel, runStatus, stalled } = computeAdvance(run.nodes, run.edges, tasks);

    // Guarded on 'blocked' for the same reason dispatch claims before publishing: two task-status
    // messages landing together can run this twice concurrently, and a task already dispatched
    // must not be dragged back to 'pending' and published a second time.
    for (const nodeId of unblock) {
        await store.updateTaskStatusFrom(runId, nodeId, 'blocked', 'pending');
    }
    if (unblock.length) console.log(`[Daemon] Run ${runId}: released ${unblock.join(', ')}.`);

    for (const { nodeId, reason } of cancel) {
        const done = await store.updateTaskStatusFrom(runId, nodeId, 'blocked', 'cancelled');
        if (done) console.log(`[Daemon] Run ${runId}: cancelled ${nodeId} (${reason}).`);
    }

    if (runStatus !== 'running') {
        await store.updateRunStatus(runId, runStatus);
        if (stalled) {
            // No task is running, queued or ready, yet some are still blocked. The run route's
            // validation is supposed to make this impossible (a cycle was the only way to build
            // it on purpose), so reaching here means a graph got past validation — worth a loud
            // log rather than a run that quietly never ends.
            console.error(`[Daemon] Run ${runId} stalled: blocked tasks remain with nothing left to run. Marking it errored.`);
        } else {
            console.log(`[Daemon] Run ${runId} ${runStatus}.`);
        }
    }
}

// Publish one ready task to its device's execute topic.
//
// Claim first, publish second. The task is moved 'pending' -> 'queued' with a compare-and-set
// *before* anything goes on the wire, so whoever wins the CAS owns the dispatch and any
// concurrent notification (a second Realtime event, or the next LAN poll tick arriving while the
// publish is still in flight) loses it and does nothing. Publishing first and recording after —
// which is what this did originally — leaves a window where the same task can be sent to a real
// instrument twice. If the publish then fails, the claim is released back to 'pending' so the
// next tick retries it rather than leaving it stuck at 'queued' forever.
async function dispatchTask(task) {
    if (!task || task.status !== 'pending') return;

    const claimed = await store.updateTaskStatusFrom(
        task.run_id, task.node_id, 'pending', 'queued', { dispatched: true },
    );
    if (!claimed) return; // someone else already took it

    const execTopic = `${TOPIC_PREFIX}/${task.device_id}/execute`;
    const execPayload = JSON.stringify({
        block: task.block, runId: task.run_id, nodeId: task.node_id,
    });
    client.publish(execTopic, execPayload, { qos: 1 }, async (err) => {
        if (err) {
            console.error(`[Daemon] Failed to publish task ${task.run_id}/${task.node_id}:`, err.message);
            await store.updateTaskStatusFrom(task.run_id, task.node_id, 'queued', 'pending');
            return;
        }
        console.log(`[Daemon] Dispatched ${task.run_id}/${task.node_id} to ${task.device_id}`);
    });
}

// In cloud mode the store's Realtime subscription only streams changes going forward, so the
// startup scan re-dispatches anything left 'pending' from before this process last restarted.
// In LAN mode the poll *is* that scan, and the redundant pass is harmless.
const unsubscribe = store.subscribePendingTasks(dispatchTask, async () => {
    try {
        const stranded = await store.listTasksByStatus('pending');
        if (stranded.length) {
            console.log(`[Daemon] Found ${stranded.length} stranded pending task(s) from before startup, dispatching now.`);
            for (const task of stranded) await dispatchTask(task);
        }
    } catch (e) {
        console.error('[Daemon] Failed to scan for stranded pending tasks:', e.message);
    }
});
console.log('[Daemon] Watching for ready tasks.');

// --- Cloud -> Edge workflow pushes --------------------------------------------------------
// A sequence saved in the Cloud editor is queued in the store by the API route (which has no
// broker connection of its own) and published here. Marked 'sent' rather than 'acked': the
// device owns the durable copy, so the push is only complete once it echoes the body back on its
// own retained sequences topic (handled above). Re-sending a 'sent' push that was never echoed
// is deliberate — an at-least-once write of an idempotent, hash-identified body.
//
// Retrying 'sent' is not optional: `sequences-push` is deliberately NOT retained (a retained push
// would be re-applied by any device that reconnects later, forever, long after it stopped being
// what anyone wanted), so a push published while its device is offline is simply gone. Only the
// device's echo proves delivery, so anything below 'acked' is re-sent until it is — at-least-once
// delivery of an idempotent, hash-identified body. Caught by testing exactly that case: a push
// published while the edge server was restarting stayed 'sent' forever.
// The executable content of a workflow, with everything the device is entitled to rewrite on
// save stripped out: version, hashes, timestamps, authorship. Two bodies that produce this same
// string will run identically, which is the only sense in which a push "took effect".
function workflowFingerprint(body) {
    if (!body || typeof body !== 'object') return '';
    return JSON.stringify({
        prep: body.prep || [],
        script: body.script || body.sequence || [],
        cleanup: body.cleanup || [],
    });
}

async function ackIfEchoMatches(deviceId, name, echoedBody) {
    try {
        const push = await store.getSequencePush(deviceId, name);
        if (!push || push.status === 'acked') return false;
        if (workflowFingerprint(push.body) !== workflowFingerprint(echoedBody)) return false;
        return await store.ackSequencePush(deviceId, name);
    } catch (e) {
        console.error(`[Daemon] Failed to reconcile push ${deviceId}/${name}:`, e.message);
        return false;
    }
}

async function drainSequencePushes({ includeUnacked = false } = {}) {
    if (!client.connected) return;
    try {
        const statuses = includeUnacked ? ['pending', 'sent'] : ['pending'];
        const pending = (await Promise.all(statuses.map(s => store.listSequencePushes(s)))).flat();
        for (const push of pending) {
            const topic = `${TOPIC_PREFIX}/${push.device_id}/sequences-push`;
            const payload = JSON.stringify({ name: push.name, body: push.body, author: 'cloud' });
            await new Promise((resolve) => {
                client.publish(topic, payload, { qos: 1 }, async (err) => {
                    if (err) {
                        console.error(`[Daemon] Failed to push ${push.device_id}/${push.name}:`, err.message);
                    } else {
                        await store.setSequencePushStatus(push.device_id, push.name, 'sent');
                        console.log(`[Daemon] Pushed workflow ${push.device_id}/${push.name}, awaiting echo.`);
                    }
                    resolve();
                });
            });
        }
    } catch (e) {
        console.error('[Daemon] Failed to drain sequence pushes:', e.message);
    }
}
// Fast path for a freshly queued push; slower sweep that re-sends anything still unacknowledged
// (a device that was offline, or a publish the broker dropped).
setInterval(() => drainSequencePushes(), 1000);
setInterval(() => drainSequencePushes({ includeUnacked: true }), 15000);

// --- Broker reconfiguration ----------------------------------------------------------------
// The broker host is chosen in /settings and stored, so this process has to notice it changing
// without a restart. Polled rather than pushed: it changes roughly never, and a 3s poll avoids
// giving the Supabase and SQLite backends yet another change-feed to implement differently.
async function watchBrokerConfig() {
    try {
        const cfg = await store.getBrokerConfig();
        if (!cfg || !cfg.host) return;
        const desired = `mqtt://${cfg.host}:${cfg.port || 1883}`;
        // AWS IoT credentials are file/cert based and cannot be re-pointed by host alone, so a
        // stored host is honoured only where a plain broker URL is meaningful.
        if (process.env.AWS_IOT_ENDPOINT) return;
        if (desired === currentBrokerUrl) return;

        console.log(`[Daemon] Broker config changed: ${currentBrokerUrl} -> ${desired}. Reconnecting.`);
        currentBrokerUrl = desired;
        client.end(true, () => {
            // mqtt.js reconnects to the URL it was constructed with, so re-pointing means
            // replacing the stream rather than just calling reconnect().
            client.options.hostname = cfg.host;
            client.options.port = cfg.port || 1883;
            client.options.href = desired;
            client.reconnect();
        });
    } catch (e) {
        console.error('[Daemon] Failed to read broker config:', e.message);
    }
}
setInterval(watchBrokerConfig, 3000);
watchBrokerConfig();

// A device that drops without a clean disconnect still gets its LWT delivered (status: offline,
// retained) by the broker — but if the daemon itself was offline when that happened, it'll only
// see it once it reconnects and the retained message replays. This local timeout is a backstop
// for the daemon-was-connected-the-whole-time case, catching a device that goes silent without
// even the LWT firing (e.g. the broker itself losing that device's session ungracefully).
setInterval(async () => {
    try {
        await store.markStaleDevicesOffline(new Date(Date.now() - 15000).toISOString());
    } catch (e) {
        console.error('[Daemon] Failed to mark stale devices offline:', e.message);
    }
}, 5000);

// Leave a truthful heartbeat behind on a clean exit, so the UI says "backend stopped" straight
// away instead of waiting for the row to age out.
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        console.log(`\n[Daemon] ${signal} — shutting down.`);
        try { if (unsubscribe) unsubscribe(); } catch { /* nothing to release */ }
        try {
            await store.setDaemonHeartbeat({ brokerConnected: false, brokerUrl: url, mode: MODE, storeLocation: store.location });
        } catch { /* best effort */ }
        try { client.end(true); } catch { /* already closed */ }
        // Released before exit so a restart does not find its own port still held: the socket
        // would linger just long enough for the next run to decide an external broker owns 1883
        // and quietly connect to nothing.
        try { if (embeddedBroker) await embeddedBroker.close(); } catch { /* already down */ }
        try { store.close(); } catch { /* already closed */ }
        process.exit(0);
    });
}
