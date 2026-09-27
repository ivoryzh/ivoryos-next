'use strict';
// Stands in for the Python edge in supervisor tests: serves /api/status on the port given as its
// first argument (after an optional startup delay), exits 75 on POST /restart like the real
// /api/system/restart, and exits 1 on POST /crash.
const http = require('node:http');

const port = Number(process.argv[2] || process.env.IVORYOS_PORT);
const delay = Number(process.env.FAKE_START_DELAY_MS || 0);
if (process.env.FAKE_NEVER_READY) { console.log('fake edge: never ready'); setInterval(() => {}, 1000); return; }
if (process.env.FAKE_DIE_ON_START) { console.error('fake edge: ImportError: no module named vendor_sdk'); process.exit(1); }

setTimeout(() => {
    http.createServer((req, res) => {
        if (req.url === '/api/status') { res.end(JSON.stringify({ pid: process.pid, supervised: process.env.IVORYOS_SUPERVISED })); return; }
        if (req.method === 'POST' && req.url === '/restart') { res.end('{}'); setTimeout(() => process.exit(75), 50); return; }
        if (req.method === 'POST' && req.url === '/crash') { res.end('{}'); console.error('fake edge: Traceback: boom'); setTimeout(() => process.exit(1), 50); return; }
        res.statusCode = 404; res.end();
    }).listen(port, '127.0.0.1', () => console.log(`fake edge listening on ${port}`));
}, delay);
process.on('SIGTERM', () => process.exit(0));
