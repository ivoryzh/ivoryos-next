'use strict';
// Stands in for the Python edge in supervisor tests: serves /api/status on the port given as its
// first argument (after an optional startup delay), exits 75 on POST /restart like the real
// /api/system/restart, and exits 1 on POST /crash.
const http = require('node:http');

// FAKE_OWN_PORT: a script that picks its own port, announced the way an ivoryos_edge older than
// the launcher does ("on port N"). FAKE_NO_RUN: a script that never calls ivoryos_edge.run().
if (process.env.FAKE_REFUSE) { console.error('Cannot start: Another IvoryOS edge is already running with this data folder (C:\lab): process 4242.'); process.exit(1); }
if (process.env.FAKE_NO_RUN) { console.log('fake script: loaded the drivers, then ended'); process.exit(0); }
const port = Number(process.env.FAKE_OWN_PORT || process.argv[2] || process.env.IVORYOS_PORT);
if (process.env.FAKE_OWN_PORT) console.log(`Starting IvoryOS Edge Server on port ${port}...`);
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
