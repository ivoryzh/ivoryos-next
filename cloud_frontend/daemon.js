const mqtt = require('mqtt');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), 'ivoryos_devices.json');
const TASKS_PATH = path.join(os.tmpdir(), 'ivoryos_tasks.json');

let devices = [];
try { devices = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); } catch {}

let tasks = [];
try { tasks = JSON.parse(fs.readFileSync(TASKS_PATH, 'utf-8')); } catch {}

const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://127.0.0.1:1883';
const client = mqtt.connect(brokerUrl);

client.on('connect', () => {
    console.log(`[Daemon] Connected to ${brokerUrl}`);
    client.subscribe('ivoryos/edge/+/heartbeat');
    client.subscribe('ivoryos/edge/+/status');
});

client.on('message', (topic, message) => {
    if (topic.endsWith('/heartbeat')) {
        try {
            const payload = JSON.parse(message.toString());
            const existing = devices.find(d => d.id === payload.deviceId);
            
            const device = {
                id: payload.deviceId,
                name: `Edge Node (${payload.deviceId})`,
                schema: payload.schema,
                status: payload.status,
                lastSeen: Date.now()
            };
            
            if (existing) {
                Object.assign(existing, device);
            } else {
                devices.push(device);
                console.log(`[Daemon] Registered new device: ${device.id}`);
            }
            
            fs.writeFileSync(DB_PATH, JSON.stringify(devices));
        } catch(e) {
            console.error("Failed to parse heartbeat", e);
        }
    } else if (topic.endsWith('/status')) {
        try {
            const payload = JSON.parse(message.toString());
            // payload expects: { runId, nodeId, status, result, error }
            const existingTask = tasks.find(t => t.runId === payload.runId && t.nodeId === payload.nodeId);
            if (existingTask) {
                Object.assign(existingTask, payload, { lastUpdated: Date.now() });
            } else {
                tasks.push({ ...payload, lastUpdated: Date.now() });
            }
            
            // Clean up tasks older than 5 minutes to prevent ballooning
            const fiveMinsAgo = Date.now() - 5 * 60 * 1000;
            tasks = tasks.filter(t => t.lastUpdated > fiveMinsAgo);
            
            fs.writeFileSync(TASKS_PATH, JSON.stringify(tasks));
            console.log(`[Daemon] Updated status for node ${payload.nodeId} -> ${payload.status}`);
        } catch (e) {
            console.error("Failed to parse status payload", e);
        }
    }
});

// Periodic cleanup of stale devices
setInterval(() => {
    const now = Date.now();
    const before = devices.length;
    devices = devices.filter(d => (now - d.lastSeen) < 15000);
    if (devices.length !== before) {
        console.log(`[Daemon] Removed stale devices. Active: ${devices.length}`);
        fs.writeFileSync(DB_PATH, JSON.stringify(devices));
    }
}, 5000);
