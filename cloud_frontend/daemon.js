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
    // Retained messages replay immediately on subscribe — this is the entire "catch up on
    // reconnect" mechanism, for both this daemon restarting AND an edge device reconnecting.
    // No polling, no explicit sync request needed on either side.
});

client.on('error', (err) => console.error('[Daemon] MQTT error:', err.message));

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
        }
    } catch (e) {
        console.error(`[Daemon] Error handling ${topic}:`, e.message);
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
