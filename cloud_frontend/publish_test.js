// Manual smoke test against a local MQTT broker (mosquitto etc.) — publishes to the new topic
// shape (status/schema/sequences, split out from the old single combined "heartbeat" topic) so
// `node daemon.js` has something to consume without needing a real edge_server running.
const mqtt = require('mqtt');
const client = mqtt.connect('mqtt://127.0.0.1:1883');

const deviceId = 'edge-device-01';

client.on('connect', () => {
    console.log('Connected, publishing test status/schema/sequence...');
    client.publish(`ivoryos/edge/${deviceId}/status`, JSON.stringify({ online: true, ts: Date.now() / 1000 }), { retain: true });
    client.publish(`ivoryos/edge/${deviceId}/schema`, JSON.stringify({ instruments: {}, instrument_meta: {} }), { retain: true });
    client.publish(`ivoryos/edge/${deviceId}/sequences/demo_sequence`, JSON.stringify({
        description: 'Test workflow',
        prep: [], sequence: [], cleanup: []
    }), { retain: true }, () => {
        console.log('Published!');
        client.end();
    });
});
