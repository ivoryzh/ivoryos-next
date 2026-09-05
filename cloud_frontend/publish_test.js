const mqtt = require('mqtt');
const client = mqtt.connect('mqtt://127.0.0.1:1883');

client.on('connect', () => {
    console.log("Connected, publishing heartbeat...");
    const payload = {
        deviceId: "edge-device-01",
        schema: { instruments: {}, instrument_meta: {} },
        status: "online"
    };
    client.publish('ivoryos/edge/edge-device-01/heartbeat', JSON.stringify(payload), () => {
        console.log("Published!");
        client.end();
    });
});
