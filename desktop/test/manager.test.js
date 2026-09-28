'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ProfileManager, portIsFree } = require('../src/manager');

const FAKE = path.join(__dirname, 'fake-edge.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-mgr-'));
const freePort = () => new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const post = (port, p) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject); req.end();
});
const getJson = (port, p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(JSON.parse(b))); }).on('error', reject);
});
const waitFor = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error('timed out');
};

// A "Python" that is node, and a "script" that is the fake edge: a script profile runs
// `<python> <script> <args>` with IVORYOS_PORT set, which is all the fake needs.
function fakeRuntime(overrides = {}) {
    return { python: process.execPath, ensurePackages: async () => {}, ...overrides };
}

test('script profiles start on their port, report it, and stop', async (t) => {
    const home = tmp();
    const mgr = new ProfileManager({ home, getRuntime: async () => fakeRuntime() });
    t.after(() => mgr.stopAll());
    const port = await freePort();
    const p = mgr.create({ kind: 'script', name: 'Demo', script: FAKE, port });
    const status = await mgr.start(p.id);
    assert.equal(status.state, 'running');
    assert.equal(status.url, `http://127.0.0.1:${port}`);
    assert.match(mgr.logTail(p.id), /fake edge listening/);
    await mgr.stop(p.id);
    assert.equal(mgr.statusOf(p.id).state, 'stopped');
});

test('two profiles cannot share a port, and the message names the other one', async (t) => {
    const home = tmp();
    const mgr = new ProfileManager({ home, getRuntime: async () => fakeRuntime() });
    t.after(() => mgr.stopAll());
    const port = await freePort();
    const a = mgr.create({ kind: 'script', name: 'Bench A', script: FAKE, port });
    const b = mgr.create({ kind: 'script', name: 'Bench B', script: FAKE, port });
    await mgr.start(a.id);
    await assert.rejects(mgr.start(b.id), /already used by "Bench A"/);
    assert.equal(mgr.statusOf(b.id).state, 'error');
    await mgr.stopAll();
});

test('the web Restart button (exit 75) keeps the profile running; a crash is reported', async (t) => {
    const home = tmp();
    const mgr = new ProfileManager({ home, getRuntime: async () => fakeRuntime() });
    t.after(() => mgr.stopAll());
    const port = await freePort();
    const p = mgr.create({ kind: 'script', name: 'Demo', script: FAKE, port });
    await mgr.start(p.id);
    const firstPid = (await getJson(port, '/api/status')).pid;
    await post(port, '/restart');
    // Wait for a different process to be answering: the old one keeps serving for a moment after
    // it asks to be restarted, and a request sent to it then would race its own exit.
    let pid = firstPid;
    await waitFor(() => { getJson(port, '/api/status').then((s) => { pid = s.pid; }, () => {}); return pid !== firstPid; });
    await waitFor(() => mgr.statusOf(p.id).state === 'running');
    const crashed = new Promise((resolve) => mgr.once('crashed', resolve));
    await post(port, '/crash');
    await crashed;
    assert.equal(mgr.statusOf(p.id).state, 'crashed');
    assert.match(mgr.statusOf(p.id).logTail, /Traceback: boom/);
});

test('an invalid profile does not start, and says why', async () => {
    const mgr = new ProfileManager({ home: tmp(), getRuntime: async () => fakeRuntime() });
    const p = mgr.create({ kind: 'script', name: 'Missing', script: '/nowhere/demo.py' });
    await assert.rejects(mgr.start(p.id), /does not exist/);
});

test('install writes the deck only after packages install, and a failure leaves it unchanged', async () => {
    const home = tmp();
    let fail = true;
    const installed = [];
    const mgr = new ProfileManager({ home, getRuntime: async () => fakeRuntime({
        ensurePackages: async (reqs) => { if (fail) throw Object.assign(new Error('uv pip failed'), { output: 'No solution found' }); installed.push(...reqs); },
    }) });
    const [deckProfile] = mgr.list();
    const manifest = { packages: ['vendor-pumps==1.0'], instruments: [{ name: 'pump', import: 'vendor_pumps', class: 'Pump', args: { port: 'COM3' } }] };

    await assert.rejects(mgr.install(deckProfile.id, manifest), /uv pip failed/);
    assert.deepEqual(mgr.readDeck(deckProfile.id).instruments || [], []);

    fail = false;
    const result = await mgr.install(deckProfile.id, manifest);
    assert.deepEqual(result.added, ['pump']);
    assert.deepEqual(installed, ['vendor-pumps==1.0']);
    assert.equal(mgr.readDeck(deckProfile.id).instruments[0].args.port, 'COM3');

    await mgr.saveInstrument(deckProfile.id, 'pump', { name: 'pump', import: 'vendor_pumps', class: 'Pump', args: { port: 'COM4' } });
    assert.equal(mgr.readDeck(deckProfile.id).instruments[0].args.port, 'COM4');
    await mgr.setInstrumentEnabled(deckProfile.id, 'pump', false);
    assert.equal(mgr.readDeck(deckProfile.id).instruments[0].enabled, false);
});

test('script profiles have no deck to edit', () => {
    const mgr = new ProfileManager({ home: tmp(), getRuntime: async () => fakeRuntime() });
    const p = mgr.create({ kind: 'script', script: FAKE });
    assert.throws(() => mgr.readDeck(p.id), /Only deck profiles/);
});

test('overlapping restarts and edits leave exactly one process, and Stop reaches it', async (t) => {
    const home = tmp();
    const mgr = new ProfileManager({ home, getRuntime: async () => fakeRuntime() });
    t.after(() => mgr.stopAll());
    const port = await freePort();
    const p = mgr.create({ kind: 'script', name: 'Busy bench', script: FAKE, port });
    await mgr.start(p.id);
    // What rapid clicking in the launcher does: several restarts in flight at once.
    await Promise.all([mgr.restart(p.id), mgr.restart(p.id), mgr.restart(p.id), mgr.start(p.id)]);
    const tracked = mgr.running.get(p.id).supervisor.child.pid;
    assert.equal((await getJson(port, '/api/status')).pid, tracked, 'the process answering is the one the manager tracks');
    await mgr.stop(p.id);
    assert.equal(mgr.statusOf(p.id).state, 'stopped');
    assert.ok(await portIsFree(port), 'nothing is left listening: no untracked edge survived');
});

test('a Cloud address without a scheme gets http on this computer or the lab network, https elsewhere', () => {
    const mgr = new ProfileManager({ home: tmp(), getRuntime: async () => fakeRuntime() });
    const cases = {
        'localhost:3002': 'http://localhost:3002',
        '192.168.1.20:3000/': 'http://192.168.1.20:3000',
        'labcloud.local:3000': 'http://labcloud.local:3000',
        'cloud.mylab.org': 'https://cloud.mylab.org',
        'https://localhost:3002': 'https://localhost:3002', // an explicit scheme is kept
    };
    for (const [typed, saved] of Object.entries(cases)) {
        mgr.setCloudUrl(typed);
        assert.equal(mgr.cloudUrl, saved, typed);
    }
    mgr.setCloudUrl('');
    assert.equal(mgr.cloudUrl, process.env.IVORYOS_CLOUD_URL || 'https://cloud.ivoryos.app');
});

test('the first profile of a fresh install gets its data folder when started', async (t) => {
    // loadProfiles makes that profile without writing its folder, and the edge runs with the
    // data folder as its cwd; a missing cwd failed every first launch as "spawn python ENOENT".
    const home = tmp();
    const mgr = new ProfileManager({ home, getRuntime: async () => fakeRuntime() });
    t.after(() => mgr.stopAll());
    const [first] = mgr.list();
    assert.equal(fs.existsSync(first.dataDir), false);
    mgr.update(first.id, { port: await freePort() });
    await mgr.start(first.id).catch(() => {}); // node is not an edge; only the folder matters here
    assert.ok(fs.existsSync(first.dataDir));
    assert.doesNotMatch(mgr.logTail(first.id), /ENOENT/);
});
