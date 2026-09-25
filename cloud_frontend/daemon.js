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
const {
    TERMINAL_TASK_STATUSES, CLOUD_DEVICE_ID, computeAdvance, evaluateCondition,
} = require('./src/lib/dag.js');
const { runContext } = require('./src/lib/cloudLogic.js');
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
    // A finished Cloud task's run record (edge queue.build_cloud_result), sent once at the end.
    client.subscribe(`${TOPIC_PREFIX}/+/task-result`);
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
            const prev = deviceState.get(deviceId);
            // An edge too old to report `busy` is never assumed idle, or its tasks could be failed
            // as lost while they wait in its queue.
            const idle = !!payload.online && 'busy' in (payload || {}) && !payload.busy;
            deviceState.set(deviceId, {
                online: !!payload.online,
                session: payload.session || null,
                busy: !!payload.busy,
                at: Date.now(),
                // When it last became idle, for spotting a task that was sent and never arrived.
                idleSince: idle ? (prev && prev.idleSince) || Date.now() : null,
            });
            await store.upsertDeviceStatus(deviceId, payload.online ? 'online' : 'offline', !!payload.busy);
            // Back from offline (or first heard since this process started): tell it what Cloud
            // is holding for it, since it missed every update while away.
            // `session` changes on every edge (re)connect: the retained heartbeat alone cannot
            // show a restart, so a summary sent to the previous process would never be resent.
            if (payload.online && (!(prev && prev.online) || (payload.session && prev.session !== payload.session))) {
                lastCloudQueue.delete(deviceId);
            }
        } else if (kind === 'task-result') {
            if (payload && payload.runId && payload.nodeId && payload.result) {
                await store.setTaskResult(payload.runId, payload.nodeId, payload.result);
                const steps = (payload.result.steps || []).length;
                console.log(`[Daemon] Results for ${payload.runId}/${payload.nodeId} stored (${steps} steps${payload.result.truncated ? ', truncated' : ''}).`);
            }
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
    // A progress update: the task is still running, only how far it has got changed. Stored with
    // the same terminal guard, so one landing after "completed" is dropped like a late "running".
    const progress = payload.progress && typeof payload.progress === 'object' ? payload.progress : undefined;
    if (progress) {
        await store.updateTaskStatusIfNotTerminal(runId, nodeId, status, TERMINAL_TASK_STATUSES, progress);
        return;
    }

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
    if (status === 'completed') {
        // A node with a cadence is not finished when one occurrence finishes — it is due again
        // later. Scheduling the next occurrence deliberately does NOT advance the run: nothing
        // downstream of a repeating node may start until it has run the number of times it was
        // asked to, which is what makes "every 20 minutes, 12 times" mean a sequence of 12 runs
        // rather than one run and eleven stragglers racing whatever came after it.
        try {
            if (await store.scheduleTaskRepeat(runId, nodeId)) {
                console.log(`[Daemon] Task ${runId}/${nodeId} repeats — next occurrence scheduled.`);
                return;
            }
        } catch (e) {
            // Falling through to advanceRun is the safe direction: the run finishes early rather
            // than hanging on an occurrence that was never scheduled.
            console.error(`[Daemon] Failed to schedule repeat for ${runId}/${nodeId}:`, e.message);
        }
    }

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

    const { unblock, cancel, skip, runStatus, stalled } = computeAdvance(run.nodes, run.edges, tasks);

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

    // An If's untaken branch (see dag.js rule 4).
    for (const nodeId of skip) {
        await store.updateTaskStatusFrom(runId, nodeId, 'blocked', 'skipped');
    }
    if (skip.length) console.log(`[Daemon] Run ${runId}: skipped ${skip.join(', ')} (branch not taken).`);

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
//
// One Cloud task per device at a time. Most instruments are single-threaded, and a task handed to
// a busy device only waits in that device's own queue, where Cloud can no longer reorder it,
// cancel it, or tell "waiting" from "lost". So a ready task stays 'pending' here until its device
// has nothing of ours in flight; the once-a-second sweep below offers it again. A task is one
// whole node -- a bare step, or a workflow with its prep, iterations and cleanup -- so this is
// "one workflow at a time per device", not one step.
const claimingFor = new Set(); // device ids with a check-and-claim in progress in this process

// Each device's latest heartbeat: `{online, busy, at}`. `busy` is the device's own answer -- any
// run in progress or queued there, including ones started at the bench, which Cloud's task table
// cannot see. Kept in memory: this process is the only dispatcher and hears every heartbeat, and
// the retained status replays the moment it (re)subscribes.
const deviceState = new Map();
const HEARTBEAT_STALE_MS = 15000;

/** Why a task for this device must wait, or null when it may go now. */
function deviceNotReady(deviceId) {
    const state = deviceState.get(deviceId);
    if (!state) return 'no heartbeat yet';
    if (!state.online) return 'offline';
    if (Date.now() - state.at > HEARTBEAT_STALE_MS) return 'heartbeat is stale';
    if (state.busy) return 'busy';
    return null;
}

async function dispatchTask(task) {
    if (!task || task.status !== 'pending') return;

    // A Cloud Logic step is Cloud's own work: claimed here, carried out by the sweep below. It
    // never touches a device queue, so it is not held behind a busy device either.
    if (String(task.device_id) === CLOUD_DEVICE_ID) {
        const claimed = await store.updateTaskStatusFrom(
            task.run_id, task.node_id, 'pending', 'running', { dispatched: true },
        );
        if (claimed) {
            console.log(`[Daemon] Cloud step ${task.run_id}/${task.node_id} (${(task.block || {}).method}) started.`);
            await stepCloudTask({ ...task, status: 'running', dispatched_at: new Date().toISOString(), progress: null });
        }
        return;
    }

    // The busy check and the claim must not interleave for one device: two ready tasks arriving
    // together would both see it idle and both be sent. The daemon is a single process, so an
    // in-memory guard is enough; the DB state takes over once the claim has landed.
    const device = String(task.device_id || '');
    // Held in Cloud -- scheduled runs and repeats included, since they all come through here --
    // while the device is offline or busy with anything, so nothing waits in the device's queue.
    if (deviceNotReady(device)) return;
    if (claimingFor.has(device)) return;
    claimingFor.add(device);
    let claimed = false;
    try {
        if (await store.deviceHasActiveTask(device)) return; // offered again by the next sweep
        claimed = await store.updateTaskStatusFrom(
            task.run_id, task.node_id, 'pending', 'queued', { dispatched: true },
        );
    } finally {
        claimingFor.delete(device);
    }
    if (!claimed) return; // someone else already took it

    const execTopic = `${TOPIC_PREFIX}/${task.device_id}/execute`;
    // Two shapes, and the edge accepts both (see handle_cloud_task in server.py). A step that is
    // one call still goes as a bare `block`: that is the original wire shape, and wrapping every
    // ordinary instrument call in a run envelope would grow the payload for nothing on a broker
    // that meters in 5KB increments. A spreadsheet or an optimization campaign cannot be
    // expressed as one block, so those carry a whole `run` instead.
    // A bare block carries no run name of its own, and the edge used to fall back to Cloud's ids
    // ("Cloud Node node_... (run_...)"), which mean nothing at the bench. Send the name the run
    // has here, plus which step this is.
    const block = task.block || {};
    const stepLabel = block.instrument === 'Library Workflows'
        ? String(block.method || '')
        : [block.instrument, block.method].filter(Boolean).join('.');
    let runName = '';
    try { runName = (await store.getRun(task.run_id))?.name || ''; } catch { /* the edge has a fallback */ }
    const execPayload = JSON.stringify(
        task.run
            ? { run: task.run, runId: task.run_id, nodeId: task.node_id }
            : {
                block: task.block, runId: task.run_id, nodeId: task.node_id,
                name: [runName, stepLabel].filter(Boolean).join(' · ') || undefined,
            },
    );
    client.publish(execTopic, execPayload, { qos: 1 }, async (err) => {
        if (err) {
            console.error(`[Daemon] Failed to publish task ${task.run_id}/${task.node_id}:`, err.message);
            await store.updateTaskStatusFrom(task.run_id, task.node_id, 'queued', 'pending');
            return;
        }
        console.log(`[Daemon] Dispatched ${task.run_id}/${task.node_id} to ${task.device_id}`);
    });
}

// --- Cloud Logic: the steps Cloud runs itself (dag.js rule 3) --------------------------------
// Wait, User_Input and If. Each one is advanced by `stepCloudTask`, which is idempotent and reads
// everything it needs from the stored row -- when it started (`dispatched_at`), what it is waiting
// for (`progress`) -- so a daemon restart mid-Wait or mid-question simply picks up where it was on
// the next sweep. Nothing here lives in a timer that a restart would lose.
//
// The outcome goes in `progress`: the If's branch (read by computeAdvance), the answer to a
// User_Input (read by a later If through runContext), and a message when it failed.

// How long an If waits for the value it tests before calling it missing. The edge sends a task's
// results before its final status, so the value is normally there already; this only covers a
// result message delayed past its status.
const IF_VALUE_GRACE_MS = 10000;

const bareName = (v) => String(v === undefined || v === null ? '' : v).trim().replace(/^#/, '');

function paramOf(block, key) {
    const params = block.params || {};
    if (params[key] !== undefined && params[key] !== '') return params[key];
    return (((block.schema || {}).parameters || {})[key] || {}).default;
}

/** Small enough to show on a card: a whole object as a value would not be. */
function displayValue(v) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return v;
    const s = JSON.stringify(v);
    return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

async function finishCloudTask(task, status, progress) {
    const moved = await store.updateTaskStatusIfNotTerminal(
        task.run_id, task.node_id, status, TERMINAL_TASK_STATUSES, progress,
    );
    if (!moved) return;
    console.log(`[Daemon] Cloud step ${task.run_id}/${task.node_id} -> ${status}`
        + (progress && progress.branch ? ` (took the ${progress.branch} branch)` : '')
        + (progress && progress.message ? `: ${progress.message}` : ''));
    await advanceRun(task.run_id);
}

async function setCloudProgress(task, progress) {
    if (JSON.stringify(task.progress || null) === JSON.stringify(progress)) return;
    await store.updateTaskStatusIfNotTerminal(task.run_id, task.node_id, 'running', TERMINAL_TASK_STATUSES, progress);
}

async function stepCloudTask(task) {
    const block = task.block || {};
    const started = Date.parse(task.dispatched_at || '') || Date.now();
    const progress = (task.progress && typeof task.progress === 'object') ? task.progress : {};

    if (block.method === 'Wait') {
        const seconds = Number(paramOf(block, 'seconds')) || 0;
        const until = started + seconds * 1000;
        if (Date.now() >= until) return finishCloudTask(task, 'completed', { state: 'done', seconds });
        return setCloudProgress(task, { state: 'waiting', seconds, until: new Date(until).toISOString() });
    }

    if (block.method === 'User_Input') {
        // The answer is written by the input route; completing the step is left to this process
        // so the daemon stays the only thing that advances a run.
        if (progress.answer !== undefined) return finishCloudTask(task, 'completed', { ...progress, state: 'answered' });
        return setCloudProgress(task, {
            state: 'waiting_input',
            prompt: String(paramOf(block, 'prompt') || ''),
            save_as: bareName(paramOf(block, 'save_as')),
        });
    }

    if (block.method === 'If') {
        const variable = bareName(paramOf(block, 'variable'));
        const operator = String(paramOf(block, 'operator') || '');
        const expected = paramOf(block, 'value');
        const ctx = runContext(await store.listRunTaskRecords(task.run_id));
        if (!Object.prototype.hasOwnProperty.call(ctx, variable)) {
            if (Date.now() - started < IF_VALUE_GRACE_MS) {
                return setCloudProgress(task, { state: 'waiting', note: `waiting for ${variable}` });
            }
            const known = Object.keys(ctx);
            return finishCloudTask(task, 'error', {
                state: 'error',
                message: `No earlier step saved a value named '${variable}'.`
                    + (known.length ? ` Saved so far: ${known.slice(0, 8).join(', ')}.` : ''),
            });
        }
        let taken;
        try {
            taken = evaluateCondition(ctx[variable], operator, expected);
        } catch (e) {
            return finishCloudTask(task, 'error', { state: 'error', message: e.message });
        }
        return finishCloudTask(task, 'completed', {
            state: 'done', branch: taken ? 'true' : 'false',
            variable, actual: displayValue(ctx[variable]), operator, value: expected,
        });
    }

    return finishCloudTask(task, 'error', { state: 'error', message: `Cloud cannot run '${block.method}'.` });
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

// --- Schedules: firing a whole run on a cadence ---------------------------------------------
// The other half of "trigger this at the right moment". A per-node cadence (above) repeats one
// step inside a run; a schedule starts the whole run again, which is what a standing experiment
// looks like — every hour, overnight, twice a day.
//
// A schedule stores its run ALREADY PLANNED: the same task rows `planRun` produced when it was
// created, with their run payloads built and validated then. Firing is therefore a pure copy, and
// this process needs no ability to build a payload — which is just as well, since it has no build
// step and cannot import the TypeScript that does it.

function nextFireAfter(schedule, from) {
    if (schedule.trigger_type === 'once') return null;
    const every = Number(schedule.every_ms) || 0;
    if (every <= 0) return null;
    // Counted from now rather than from the scheduled time, so a daemon that was down for an hour
    // resumes the cadence instead of firing the backlog it missed all at once.
    const fired = Number(schedule.runs_fired) || 0;
    const max = Number(schedule.max_runs) || 0;
    if (max && fired + 1 >= max) return null; // this firing is the last one
    return new Date(from + every).toISOString();
}

async function fireSchedule(schedule) {
    const runId = `run_${Date.now()}_${schedule.id.slice(-6)}`;
    const nextAt = nextFireAfter(schedule, Date.now());

    // Claim before inserting anything, for the same reason dispatch claims before it publishes:
    // two ticks landing together would otherwise both start this occurrence, and a scheduled run
    // reaches real instruments.
    const claimed = await store.claimScheduleFiring(
        schedule.id, schedule.next_fire_at, nextAt, runId,
    );
    if (!claimed) return;

    try {
        await store.insertRun({
            id: runId,
            name: schedule.name ? `${schedule.name} (scheduled)` : 'Scheduled Run',
            status: 'running',
            nodes: schedule.nodes,
            edges: schedule.edges,
        });
        // The stored plan carries each task's original status, so a graph whose second step waits
        // on its first still waits on this firing too.
        await store.insertTasks((schedule.tasks || []).map(t => ({ ...t, run_id: runId })));
        console.log(`[Daemon] Schedule ${schedule.id} fired as ${runId}`
            + (nextAt ? `; next at ${nextAt}.` : '; no further occurrences.'));
    } catch (e) {
        // The firing is already counted and cannot be un-claimed, so say loudly that this
        // occurrence produced nothing rather than leaving a gap nobody can explain later.
        console.error(`[Daemon] Schedule ${schedule.id} claimed but failed to start:`, e.message);
    }
}

async function tickSchedules() {
    try {
        const due = await store.listDueSchedules(new Date().toISOString());
        for (const schedule of due) await fireSchedule(schedule);
    } catch (e) {
        console.error('[Daemon] Schedule sweep failed:', e.message);
    }
}
// A second is far finer than any real cadence here (the smallest one the UI offers is a minute)
// and keeps a schedule from drifting visibly past the time it says it will fire.
setInterval(tickSchedules, 1000);
tickSchedules();

// A repeating task becomes due by the clock, not by anything arriving — Realtime has nothing to
// deliver when a `not_before` simply passes, and the LAN poll only re-reads rows it already
// skipped. This sweep is what actually picks those up.
// A task that was sent but never reached its device -- a dropped publish, or a device that
// restarted before starting it -- used to stay 'queued' forever, and now that Cloud holds a
// device's next task until the current one finishes, it would also block that device for good.
// The device reports `busy` the instant anything is queued there, so a task still 'queued' after
// the device has said "idle" continuously for a while is not in its queue. It is failed, never
// re-sent: if it did run and only its report was lost, sending it again would move the hardware
// twice.
const LOST_AFTER_DISPATCH_MS = 30000;
const LOST_AFTER_IDLE_MS = 20000;

async function failLostTasks() {
    const now = Date.now();
    for (const task of await store.listTasksByStatus('queued')) {
        const state = deviceState.get(String(task.device_id || ''));
        const sentAt = Date.parse(task.dispatched_at || '') || 0;
        if (!state || !state.online || !state.idleSince) continue;
        if (now - sentAt < LOST_AFTER_DISPATCH_MS || now - state.idleSince < LOST_AFTER_IDLE_MS) continue;
        const moved = await store.updateTaskStatusIfNotTerminal(
            task.run_id, task.node_id, 'error', TERMINAL_TASK_STATUSES,
        );
        if (moved) {
            console.warn(`[Daemon] Task ${task.run_id}/${task.node_id} never reached ${task.device_id}; marked error.`);
            await advanceRun(task.run_id);
        }
    }
}

// --- What Cloud is holding for each device -------------------------------------------------
// Tasks are never queued on a device (see dispatchTask), so a bench operator has no way to know
// that Cloud has three more waiting for this instrument, or a scheduled run due at 14:00. Each
// device is told, for awareness only: nothing on the device acts on it. Sent when the summary
// changes and when the device comes back online -- not periodically, and not retained (a retained
// publish needs iot:RetainPublish on the daemon's own AWS policy, whose absence is the silent
// disconnect loop AGENTS.md section 0 describes).
const lastCloudQueue = new Map();
const CLOUD_QUEUE_ITEMS = 5;

function taskLabel(task) {
    const block = task.block || {};
    const step = block.instrument === 'Library Workflows'
        ? String(block.method || '')
        : [block.instrument, block.method].filter(Boolean).join('.');
    return [task.run_name, step].filter(Boolean).join(' · ') || task.node_id;
}

async function publishCloudQueues() {
    if (!client.connected) return;
    const waiting = await store.listWaitingTasks();
    const schedules = (await store.listSchedules()).filter(s => s.enabled && s.next_fire_at);
    const devices = new Set([...deviceState.keys()].filter(id => deviceState.get(id).online));
    for (const t of waiting) devices.add(String(t.device_id));
    // Cloud's own steps wait on no device, and there is no device to tell.
    devices.delete(CLOUD_DEVICE_ID);

    for (const deviceId of devices) {
        const mine = waiting.filter(t => String(t.device_id) === deviceId);
        const nextSchedule = schedules
            .filter(s => (s.tasks || []).some(t => String(t.device_id) === deviceId))
            .map(s => ({ name: s.name, at: s.next_fire_at }))
            .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] || null;
        const summary = {
            waiting: mine.length,
            // 'ready' = could run now but held until this device is free; 'blocked' = waiting on
            // another step (maybe on another device) to finish first.
            ready: mine.filter(t => t.status === 'pending').length,
            items: mine.slice(0, CLOUD_QUEUE_ITEMS).map(t => ({
                label: taskLabel(t),
                status: t.status === 'pending' ? 'ready' : 'waiting',
                ...(t.not_before ? { due: t.not_before } : {}),
            })),
            nextSchedule,
        };
        const key = JSON.stringify(summary);
        if (lastCloudQueue.get(deviceId) === key) continue;
        lastCloudQueue.set(deviceId, key);
        client.publish(
            `${TOPIC_PREFIX}/${deviceId}/cloud-queue`,
            JSON.stringify({ ...summary, ts: Date.now() }),
            { qos: 1 },
        );
    }
}
setInterval(() => publishCloudQueues().catch(e => console.error('[Daemon] Cloud queue summary failed:', e.message)), 3000);

setInterval(async () => {
    try {
        await failLostTasks();
        for (const task of await store.listTasksByStatus('pending')) await dispatchTask(task);
        for (const task of await store.listTasksByStatus('running')) {
            if (String(task.device_id) === CLOUD_DEVICE_ID) await stepCloudTask(task);
        }
    } catch (e) {
        console.error('[Daemon] Due-task sweep failed:', e.message);
    }
}, 1000);

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
