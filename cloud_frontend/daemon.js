// The one process that actually holds the AWS IoT / MQTT connection. Next.js API routes are
// request-scoped and shouldn't own a long-lived broker connection, so this is a standalone Node
// process: `node daemon.js`, run once per Cloud deployment, separate from `next start`.
//
// It only consumes the retained status/schema/sequences topics each Edge device publishes (see
// edge_server/ivoryos_edge/server.py's status_loop/publish_schema/publish_sequences) and writes
// them into this project's own Supabase database — a separate Supabase project from the Hub's,
// by design. It does NOT yet publish `execute` tasks back to devices; that's the dispatch half of
// the Cloud orchestrator (src/lib/orchestrator.ts) and still needs to be wired to this same
// connection — tracked separately, not done here.
// Unlike Next.js (which auto-loads .env.local for the app), a plain `node daemon.js` process
// starts with none of that — without this, every var below would be undefined even with a fully
// filled-in .env.local sitting right next to this file.
require('dotenv').config({ path: require('path').join(__dirname, '.env.local') });

const mqtt = require('mqtt');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[Daemon] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Refusing to start with no persistence target.');
    process.exit(1);
}
// Service-role key: full read/write, bypasses Row Level Security. Safe ONLY here — this script
// never runs in a browser context and must never be bundled into the Next.js app.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX || 'ivoryos/edge';

// Local broker for dev (mqtt://host:port with no client cert), or AWS IoT Core (mutual TLS) in
// production — same client_id-per-device-per-connection model the edge server itself uses.
function buildMqttOptions() {
    if (process.env.AWS_IOT_ENDPOINT) {
        return {
            url: `mqtts://${process.env.AWS_IOT_ENDPOINT}:8883`,
            options: {
                clientId: process.env.MQTT_CLIENT_ID || `ivoryos-cloud-daemon-${Date.now()}`,
                ca: fs.readFileSync(process.env.AWS_IOT_CA_PATH),
                cert: fs.readFileSync(process.env.AWS_IOT_CERT_PATH),
                key: fs.readFileSync(process.env.AWS_IOT_KEY_PATH),
            }
        };
    }
    return {
        url: process.env.MQTT_BROKER_URL || 'mqtt://127.0.0.1:1883',
        options: { clientId: process.env.MQTT_CLIENT_ID || `ivoryos-cloud-daemon-${Date.now()}` }
    };
}

const { url, options } = buildMqttOptions();
const client = mqtt.connect(url, options);

client.on('connect', () => {
    console.log(`[Daemon] Connected to ${url}`);
    client.subscribe(`${TOPIC_PREFIX}/+/status`);
    client.subscribe(`${TOPIC_PREFIX}/+/schema`);
    client.subscribe(`${TOPIC_PREFIX}/+/sequences/+`);
    client.subscribe(`${TOPIC_PREFIX}/+/task-status`);
    // Retained messages replay immediately on subscribe — this is the entire "catch up on
    // reconnect" mechanism, for both this daemon restarting AND an edge device reconnecting.
    // No polling, no explicit sync request needed on either side.
});

client.on('error', (err) => console.error('[Daemon] MQTT error:', err.message));
client.on('reconnect', () => console.log('[Daemon] Reconnecting...'));
client.on('close', () => console.log('[Daemon] Connection closed.'));
client.on('offline', () => console.log('[Daemon] Offline (no connection).'));

client.on('message', async (topic, message) => {
    const parts = topic.split('/'); // ivoryos/edge/{deviceId}/(status|schema|sequences/{name})
    const deviceId = parts[2];
    const kind = parts[3];

    let payload;
    try {
        payload = JSON.parse(message.toString());
    } catch (e) {
        console.error(`[Daemon] Bad JSON on ${topic}:`, e.message);
        return;
    }

    try {
        if (kind === 'status') {
            const { error } = await supabase.from('devices').upsert({
                id: deviceId,
                status: payload.online ? 'online' : 'offline',
                last_seen: new Date().toISOString(),
            }, { onConflict: 'id' });
            if (error) console.error(`[Daemon] Failed to upsert device status for ${deviceId}:`, error.message);
        } else if (kind === 'schema') {
            const { error } = await supabase.from('devices').upsert({
                id: deviceId,
                schema: payload,
                last_seen: new Date().toISOString(),
            }, { onConflict: 'id' });
            if (error) console.error(`[Daemon] Failed to upsert device schema for ${deviceId}:`, error.message);
        } else if (kind === 'sequences') {
            const name = parts[4];
            const { error } = await supabase.from('edge_sequences').upsert({
                device_id: deviceId,
                name,
                description: payload.description || '',
                body: payload,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'device_id,name' });
            if (error) console.error(`[Daemon] Failed to upsert sequence ${deviceId}/${name}:`, error.message);
            else console.log(`[Daemon] Synced sequence ${deviceId}/${name}`);
        } else if (kind === 'task-status') {
            await handleTaskStatus(payload);
        }
    } catch (e) {
        console.error(`[Daemon] Error handling ${topic}:`, e.message);
    }
});

// --- Dispatch: the other half of the orchestrator loop. Cloud's "Run" button (see
// api/cloud-workflows/runs) inserts run_tasks rows with status 'pending' for every node whose
// dependencies are already satisfied; everything else starts 'blocked'. This daemon is the only
// process holding a live, authenticated MQTT connection, so it's also the only thing that can
// actually publish to a device's execute topic — that's the "dispatch" AGENTS.md flagged as
// never having been wired up. A Realtime subscription (rather than polling) reacts the moment a
// task becomes pending, whether that's from a fresh run or from a task just having unblocked one
// further downstream (see handleTaskStatus below).
const TERMINAL_TASK_STATUSES = ['completed', 'error', 'cancelled'];

async function handleTaskStatus(payload) {
    const { runId, nodeId, status } = payload;
    if (!runId || !nodeId || !status) return;

    // MQTT QoS 1 only guarantees at-least-once, in-order delivery per publisher connection — but
    // a "running" message sent moments before "completed" can still arrive after it (observed
    // directly: a run that genuinely completed on the edge showed completed->running in this log,
    // stale "running" landing late during a reconnect). Once a task reaches a terminal status,
    // refuse to move it backwards — the `.not(...in...)` guard means this update simply matches
    // zero rows (not an error) if the task already finished.
    const { data, error } = await supabase
        .from('run_tasks')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('run_id', runId)
        .eq('node_id', nodeId)
        .not('status', 'in', `(${TERMINAL_TASK_STATUSES.join(',')})`)
        .select('status');
    if (error) {
        console.error(`[Daemon] Failed to update run_task ${runId}/${nodeId}:`, error.message);
        return;
    }
    if (!data || data.length === 0) {
        console.log(`[Daemon] Ignored stale '${status}' for already-finished task ${runId}/${nodeId}`);
        return;
    }
    console.log(`[Daemon] Task ${runId}/${nodeId} -> ${status}`);

    if (status === 'error') {
        await supabase.from('runs').update({ status: 'error', updated_at: new Date().toISOString() }).eq('id', runId);
        return;
    }
    if (status === 'completed') {
        await advanceRun(runId);
    }
}

// Mirrors the dependency-unlocking logic the old in-memory orchestrator.ts had (checkReadyNodes)
// — a node becomes dispatchable once every node it depends on (via the stored edges) has
// completed. Flow Control nodes aren't dispatched to any device at all (no run_tasks row exists
// for them), so they're always treated as already-satisfied dependencies.
async function advanceRun(runId) {
    const { data: run, error: runError } = await supabase.from('runs').select('nodes, edges, status').eq('id', runId).single();
    if (runError || !run || run.status !== 'running') return;

    const { data: tasks, error: tasksError } = await supabase.from('run_tasks').select('node_id, status').eq('run_id', runId);
    if (tasksError || !tasks) return;

    const taskByNode = new Map(tasks.map(t => [t.node_id, t.status]));
    const flowControlNodeIds = new Set(
        (run.nodes || [])
            .filter(n => n.data?.block?.instrument === 'Flow Control')
            .map(n => n.id)
    );

    const incoming = new Map();
    for (const e of (run.edges || [])) {
        if (!incoming.has(e.target)) incoming.set(e.target, []);
        incoming.get(e.target).push(e.source);
    }

    const isSatisfied = (nodeId) => flowControlNodeIds.has(nodeId) || taskByNode.get(nodeId) === 'completed';

    const toUnblock = [];
    for (const [nodeId, status] of taskByNode.entries()) {
        if (status !== 'blocked') continue;
        const deps = incoming.get(nodeId) || [];
        if (deps.every(isSatisfied)) toUnblock.push(nodeId);
    }

    for (const nodeId of toUnblock) {
        await supabase.from('run_tasks').update({ status: 'pending', updated_at: new Date().toISOString() }).eq('run_id', runId).eq('node_id', nodeId);
    }

    const stillActive = Array.from(taskByNode.values()).some(s => s !== 'completed') || toUnblock.length > 0;
    if (!stillActive) {
        await supabase.from('runs').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', runId);
        console.log(`[Daemon] Run ${runId} completed.`);
    }
}

// Dispatch: publish one pending task to its device's execute topic and flip it to 'queued'.
// Shared by the Realtime handler below (new/just-unblocked tasks) and the startup catch-up scan
// (tasks that were left 'pending' from before this process's last restart or MQTT drop — Realtime
// only streams changes going forward, it doesn't replay rows that were already pending when the
// subscription opened, so without this catch-up step a daemon restart mid-run would strand them).
async function dispatchTask(task) {
    if (!task || task.status !== 'pending') return;
    const execTopic = `${TOPIC_PREFIX}/${task.device_id}/execute`;
    const execPayload = JSON.stringify({ block: task.block, runId: task.run_id, nodeId: task.node_id });
    client.publish(execTopic, execPayload, { qos: 1 }, async (err) => {
        if (err) {
            console.error(`[Daemon] Failed to publish task ${task.run_id}/${task.node_id}:`, err.message);
            return;
        }
        const { error } = await supabase
            .from('run_tasks')
            .update({ status: 'queued', dispatched_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('run_id', task.run_id)
            .eq('node_id', task.node_id)
            .eq('status', 'pending'); // guard against a double-dispatch race
        if (error) console.error(`[Daemon] Failed to mark task ${task.run_id}/${task.node_id} queued:`, error.message);
        else console.log(`[Daemon] Dispatched ${task.run_id}/${task.node_id} to ${task.device_id}`);
    });
}

const dispatchChannel = supabase.channel('run_tasks_dispatch').on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'run_tasks', filter: 'status=eq.pending' },
    ({ new: task }) => dispatchTask(task)
).subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
        console.log('[Daemon] Watching run_tasks for dispatch.');
        const { data: strandedTasks, error } = await supabase.from('run_tasks').select('*').eq('status', 'pending');
        if (error) {
            console.error('[Daemon] Failed to scan for stranded pending tasks:', error.message);
        } else if (strandedTasks?.length) {
            console.log(`[Daemon] Found ${strandedTasks.length} stranded pending task(s) from before startup, dispatching now.`);
            for (const task of strandedTasks) await dispatchTask(task);
        }
    }
});

// A device that drops without a clean disconnect still gets its LWT delivered (status: offline,
// retained) by the broker — but if the daemon itself was offline when that happened, it'll only
// see it once it reconnects and the retained message replays. This local timeout is a backstop
// for the daemon-was-connected-the-whole-time case, catching a device that goes silent without
// even the LWT firing (e.g. the broker itself losing that device's session ungracefully).
setInterval(async () => {
    const staleBefore = new Date(Date.now() - 15000).toISOString();
    const { error } = await supabase
        .from('devices')
        .update({ status: 'offline' })
        .lt('last_seen', staleBefore)
        .eq('status', 'online');
    if (error) console.error('[Daemon] Failed to mark stale devices offline:', error.message);
}, 5000);
