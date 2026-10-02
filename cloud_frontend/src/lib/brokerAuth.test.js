'use strict';
// The LAN broker's identity and topic rules (brokerAuth.js), as pure functions and against a real
// embedded broker with real MQTT clients: a device with the secret from its pairing gets in and
// stays on its own topics; anyone else does not get in, and no device can send an `execute`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const mqtt = require('mqtt');

const auth = require('./brokerAuth.js');
const { startEmbeddedBroker } = require('./embedded-broker.js');
const { createSqliteStore } = require('./store/sqlite.js');

const P = 'ivoryos/edge';

test('a device publishes only what an edge publishes, under its own id', () => {
  for (const t of ['status', 'schema', 'sequences/Suzuki screen', 'task-status', 'task-result', 'presence', 'leave']) {
    assert.ok(auth.devicePublishAllowed(`${P}/rig-1/${t}`, P, 'rig-1'), t);
  }
  // What only Cloud sends: a device cannot drive itself, or anyone else.
  for (const t of ['execute', 'sequences-push', 'task-control', 'ping', 'removed', 'cloud-queue']) {
    assert.ok(!auth.devicePublishAllowed(`${P}/rig-1/${t}`, P, 'rig-1'), t);
  }
  assert.ok(!auth.devicePublishAllowed(`${P}/rig-2/status`, P, 'rig-1'), 'another device');
  assert.ok(!auth.devicePublishAllowed(`${P}/rig-1/sequences/a/b`, P, 'rig-1'), 'one level only');
  assert.ok(!auth.devicePublishAllowed(`${P}/rig-1/sequences/`, P, 'rig-1'), 'a name is required');
});

test('a device subscribes only to what Cloud sends it, exactly', () => {
  for (const t of ['execute', 'sequences-push', 'cloud-queue', 'task-control', 'removed', 'ping', 'presence']) {
    assert.ok(auth.deviceSubscribeAllowed(`${P}/rig-1/${t}`, P, 'rig-1'), t);
  }
  assert.ok(!auth.deviceSubscribeAllowed(`${P}/rig-2/execute`, P, 'rig-1'), 'another device');
  assert.ok(!auth.deviceSubscribeAllowed(`${P}/+/status`, P, 'rig-1'), 'wildcards');
  assert.ok(!auth.deviceSubscribeAllowed(`${P}/rig-1/#`, P, 'rig-1'), 'wildcards');
  assert.ok(!auth.deviceSubscribeAllowed(`${P}/rig-1/status`, P, 'rig-1'), 'another device\'s reports');
});

test('secrets are kept as hashes and compared exactly', () => {
  const s = auth.newSecret();
  assert.notStrictEqual(s, auth.newSecret());
  assert.ok(auth.secretMatches(s, auth.hashSecret(s)));
  assert.ok(!auth.secretMatches(`${s}x`, auth.hashSecret(s)));
  assert.ok(!auth.secretMatches('', auth.hashSecret('')));
  assert.ok(!auth.secretMatches(s, null));
});

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

/** Resolves to a connected client, or rejects with the broker's refusal. */
const connect = (url, opts) => new Promise((resolve, reject) => {
  const c = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 3000, ...opts });
  c.once('connect', () => resolve(c));
  c.once('error', (e) => { c.end(true); reject(e); });
});

test('the embedded broker admits a device by its pairing secret and keeps it to its own topics', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-broker-'));
  const store = createSqliteStore(path.join(dir, 'c.db'));
  const port = await freePort();
  const url = `mqtt://127.0.0.1:${port}`;
  const daemonSecret = auth.newSecret();
  const broker = await startEmbeddedBroker(url, {
    daemonSecret, prefix: P, credentialFor: (id) => store.getBrokerCredential(id),
  });
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.end(true);
    await broker.close?.();
    try { store.close(); } catch { /* closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(broker.started && broker.secured, broker.reason);

  // What pairing does: a secret for the device, only its hash kept.
  const secret = auth.newSecret();
  await store.setBrokerCredential('rig-1', auth.hashSecret(secret));

  // Strangers stay out: no login, a wrong secret, someone else's id, a device with no record.
  await assert.rejects(connect(url, { clientId: 'rig-1' }));
  await assert.rejects(connect(url, { clientId: 'rig-1', username: 'rig-1', password: 'guess' }));
  await assert.rejects(connect(url, { clientId: 'rig-2', username: 'rig-1', password: secret }));
  await assert.rejects(connect(url, { clientId: 'rig-9', username: 'rig-9', password: secret }));
  await assert.rejects(connect(url, { clientId: 'x', username: auth.DAEMON_USER, password: 'guess' }));

  const daemon = await connect(url, { clientId: 'daemon', username: auth.DAEMON_USER, password: daemonSecret });
  clients.push(daemon);
  const device = await connect(url, { clientId: 'rig-1', username: 'rig-1', password: secret });
  clients.push(device);

  // Subscriptions: its own inbound topics yes, another device's no (granted 128 = refused).
  // (mqtt.js reports a partly refused SUBACK as an error carrying the packet.)
  const granted = await device.subscribeAsync([`${P}/rig-1/execute`, `${P}/rig-2/execute`])
    .then((g) => g.map((x) => x.qos), (e) => e.packet?.granted);
  assert.deepStrictEqual(granted, [0, 128]);
  assert.ok(device.connected, 'a refused subscription does not end the connection');

  // The daemon hears the device's own reports and can send it work.
  const heard = new Promise((resolve) => daemon.on('message', (topic, msg) => resolve([topic, String(msg)])));
  await daemon.subscribeAsync(`${P}/+/status`);
  await device.publishAsync(`${P}/rig-1/status`, '{"online":true}', { qos: 1 });
  assert.deepStrictEqual(await heard, [`${P}/rig-1/status`, '{"online":true}']);
  const work = new Promise((resolve) => device.on('message', (topic) => resolve(topic)));
  await daemon.publishAsync(`${P}/rig-1/execute`, '{}', { qos: 1 });
  assert.strictEqual(await work, `${P}/rig-1/execute`);

  // A device that tries to send itself an `execute` is cut off, and nothing is delivered.
  const delivered = [];
  await daemon.subscribeAsync(`${P}/rig-1/execute`);
  daemon.on('message', (topic) => { if (topic.endsWith('/execute')) delivered.push(topic); });
  const closed = new Promise((resolve) => device.once('close', resolve));
  device.publish(`${P}/rig-1/execute`, '{}');
  await closed;
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(delivered, []);

  // Removing the device deletes its secret: its old token no longer gets in.
  await store.deleteBrokerCredential('rig-1');
  await assert.rejects(connect(url, { clientId: 'rig-1', username: 'rig-1', password: secret }));
});
