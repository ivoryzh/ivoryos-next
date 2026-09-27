'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { EdgeSupervisor } = require('../src/supervisor');

const FAKE = path.join(__dirname, 'fake-edge.js');

function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
}

function request(port, method, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: urlPath }, (res) => {
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => resolve(body ? JSON.parse(body) : null));
        });
        req.on('error', reject);
        req.end();
    });
}

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));

async function supervisorFor(env = {}, extra = {}) {
    const port = await freePort();
    const sup = new EdgeSupervisor({ command: process.execPath, args: [FAKE, String(port)], port, env, readyTimeoutMs: 8000, ...extra });
    return { sup, port };
}

test('start resolves only once the edge answers, and marks it supervised', async () => {
    const { sup, port } = await supervisorFor({ FAKE_START_DELAY_MS: '600' });
    const started = Date.now();
    await sup.start();
    assert.ok(Date.now() - started >= 500, 'waited for readiness, not just for the spawn');
    assert.equal(sup.state, 'running');
    assert.equal((await request(port, 'GET', '/api/status')).supervised, '1');
    await sup.stop();
    assert.equal(sup.state, 'stopped');
});

test('exit code 75 restarts the edge instead of reporting a crash', async () => {
    const { sup, port } = await supervisorFor();
    await sup.start();
    const firstPid = (await request(port, 'GET', '/api/status')).pid;
    let crashed = false;
    sup.on('crashed', () => { crashed = true; });
    const readyAgain = once(sup, 'ready');
    await request(port, 'POST', '/restart');
    await readyAgain;
    assert.notEqual((await request(port, 'GET', '/api/status')).pid, firstPid);
    assert.equal(crashed, false);
    await sup.stop();
});

test('any other exit is a crash, reported with the end of the log', async () => {
    const { sup, port } = await supervisorFor();
    await sup.start();
    const crash = once(sup, 'crashed');
    await request(port, 'POST', '/crash');
    const info = await crash;
    assert.equal(info.code, 1);
    assert.match(info.logTail, /Traceback: boom/);
    assert.equal(sup.state, 'crashed');
});

test('an edge that dies while starting fails start() with its error in the log', async () => {
    const { sup } = await supervisorFor({ FAKE_DIE_ON_START: '1' });
    await assert.rejects(sup.start(), /exited before it was ready/);
    assert.match(sup.logTail, /no module named vendor_sdk/);
});

test('an edge that never answers is stopped after the timeout', async () => {
    const { sup } = await supervisorFor({ FAKE_NEVER_READY: '1' }, { readyTimeoutMs: 1500 });
    await assert.rejects(sup.start(), /did not become ready/);
    assert.equal(sup.child, null);
});

test('whileStopped runs with no edge process, then starts it again even if the work fails', async () => {
    const { sup, port } = await supervisorFor();
    await sup.start();
    await sup.whileStopped(async () => {
        assert.equal(sup.child, null);
        await assert.rejects(request(port, 'GET', '/api/status'));
    });
    assert.equal(sup.state, 'running');
    await assert.rejects(sup.whileStopped(async () => { throw new Error('pip failed'); }), /pip failed/);
    assert.equal(sup.state, 'running', 'the old deck is back up after a failed install');
    await sup.stop();
});

test('output is appended to the log file across restarts', async () => {
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-sup-')), 'logs', 'edge.log');
    const { sup } = await supervisorFor({}, { logFile });
    await sup.start();
    await sup.restart();
    await sup.stop();
    const text = fs.readFileSync(logFile, 'utf8');
    assert.equal((text.match(/--- starting edge/g) || []).length, 2);
    assert.match(text, /fake edge listening/);
});
