'use strict';

// Pairing (src/lib/pairing.js), against the LAN store; the Supabase store implements the same
// operations (migrations/0012). What is pinned here is what makes pairing safe: the code can only
// be approved, the credentials go only to the secret, once, and nothing outlives its window.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSqliteStore } = require('./store/sqlite.js');
const pairing = require('./pairing.js');

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-pair-'));
  const store = createSqliteStore(path.join(dir, 'test.db'));
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return store;
}

const later = (ms) => new Date(Date.now() + ms).toISOString();
const now = () => new Date().toISOString();

async function started(store, { name = 'Flow rig', expiresAt = later(pairing.TTL_MS) } = {}) {
  const code = pairing.generateCode();
  const secret = pairing.generateSecret();
  await store.createPairingRequest({ code, secretHash: pairing.hashSecret(secret), deviceName: name, instruments: ['pump', 'balance'], expiresAt });
  return { code, secret, hash: pairing.hashSecret(secret) };
}

test('codes avoid the characters people misread, and typing them loosely still matches', () => {
  for (let i = 0; i < 200; i++) assert.match(pairing.generateCode(), /^[2-9A-HJ-NP-Z]{8}$/);
  assert.strictEqual(pairing.normalizeCode(' 7k4m-9qx2 '), '7K4M9QX2');
  assert.strictEqual(pairing.formatCode('7K4M9QX2'), '7K4M-9QX2');
});

test('the secret is long, random, and stored only as its hash', () => {
  const a = pairing.generateSecret();
  assert.ok(a.length >= 40);
  assert.notStrictEqual(a, pairing.generateSecret());
  assert.match(pairing.hashSecret(a), /^[0-9a-f]{64}$/);
  assert.notStrictEqual(pairing.hashSecret(a), a);
});

test('names that would break MQTT topics are refused; ordinary ones are kept', () => {
  assert.strictEqual(pairing.cleanDeviceName('  Flow   rig PC '), 'Flow rig PC');
  for (const bad of ['a/b', 'pump+', 'x#', '', '   ', 'x'.repeat(65), 'bell\u0007']) {
    assert.strictEqual(pairing.cleanDeviceName(bad), null, bad);
  }
  assert.strictEqual(pairing.cleanDeviceName('tab\there'), 'tab here', 'whitespace is folded, not refused');
  assert.deepStrictEqual(pairing.cleanInstruments(['pump', 3, ' ', 'balance']), ['pump', 'balance']);
  assert.deepStrictEqual(pairing.cleanInstruments('pump'), []);
});

test('identity is the device id: new, the same device again, or someone else\'s', () => {
  const mine = ['user:a', 'org:lab'];
  assert.strictEqual(pairing.identityDecision({ exists: false, owner: null, workspaces: mine }), 'new');
  // "My deck" paired again, in one of my workspaces: reconnected, whatever it is called now
  assert.strictEqual(pairing.identityDecision({ exists: true, owner: 'org:lab', workspaces: mine }), 'reattach');
  // someone else's device: never handed over by typing its code
  assert.strictEqual(pairing.identityDecision({ exists: true, owner: 'user:b', workspaces: mine }), 'foreign');
  // paired before sign-in: only where claiming such devices is allowed (a lab's own Cloud)
  assert.strictEqual(pairing.identityDecision({ exists: true, owner: null, workspaces: mine, claimable: true }), 'reattach');
  assert.strictEqual(pairing.identityDecision({ exists: true, owner: null, workspaces: mine, claimable: false }), 'foreign');
});

test('device ids suit an MQTT topic and an AWS Thing name; names are only labels', () => {
  for (const good of ['my-deck-7k4m2q', 'edge_01', 'lab:rig-2']) assert.strictEqual(pairing.cleanDeviceId(good), good);
  for (const bad of ['', 'ab', 'a/b', 'my deck', 'x#', '-lead', 'x'.repeat(65)]) assert.strictEqual(pairing.cleanDeviceId(bad), null, bad);
  const a = pairing.generateDeviceId('My deck');
  assert.match(a, /^my-deck-[a-z2-9]{6}$/);
  assert.notStrictEqual(a, pairing.generateDeviceId('My deck'), 'two "My deck"s are two devices');
  // A name with nothing usable in it still makes a valid id.
  assert.match(pairing.generateDeviceId('Ω µ'), /^edge-[a-z2-9]{6}$/);
  assert.ok(pairing.cleanDeviceId(pairing.generateDeviceId('Ω µ')));
});

test('a removed device is remembered until it is paired again', async (t) => {
  const store = freshStore(t);
  assert.deepStrictEqual(await store.listRemovedDeviceIds(), []);
  await store.markDeviceRemoved('my-deck-7k4m2q');
  await store.markDeviceRemoved('my-deck-7k4m2q'); // twice is once
  assert.deepStrictEqual(await store.listRemovedDeviceIds(), ['my-deck-7k4m2q']);
  await store.clearDeviceRemoved('my-deck-7k4m2q');
  assert.deepStrictEqual(await store.listRemovedDeviceIds(), []);
});

test('removing a device deletes it and its workspace, and remembers it', async (t) => {
  const store = freshStore(t);
  const { removeDevice } = require('./deviceRemoval.js');
  await store.upsertDevicePlaceholder('rig-abc123', 'Flow rig');
  await store.setOwner('device', 'rig-abc123', 'org:lab');
  const saved = process.env.AWS_IOT_ENDPOINT;
  delete process.env.AWS_IOT_ENDPOINT;
  try {
    const result = await removeDevice(store, 'rig-abc123');
    assert.strictEqual(result.aws, null, 'no AWS on a LAN Cloud');
  } finally {
    if (saved !== undefined) process.env.AWS_IOT_ENDPOINT = saved;
  }
  assert.deepStrictEqual((await store.listDevices()).map((d) => d.id), []);
  assert.strictEqual(await store.getOwner('device', 'rig-abc123'), null);
  assert.deepStrictEqual(await store.listRemovedDeviceIds(), ['rig-abc123']);
});

test('a request waits until approved, then the secret collects it exactly once', async (t) => {
  const store = freshStore(t);
  const { code, hash } = await started(store);

  assert.strictEqual(pairing.pollOutcome(await store.getPairingRequestBySecret(hash)), 'waiting');
  assert.strictEqual(await store.claimPairingRequest(hash, now()), false, 'nothing to collect before approval');

  assert.strictEqual(await store.approvePairingRequest(code, 'Flow rig PC', now(), later(pairing.TTL_MS)), true);
  const approved = await store.getPairingRequest(code);
  assert.strictEqual(approved.device_name, 'Flow rig PC', 'the name chosen at approval wins');
  assert.deepStrictEqual(approved.instruments, ['pump', 'balance']);
  assert.strictEqual(pairing.pollOutcome(approved), 'approved');

  assert.strictEqual(await store.claimPairingRequest(hash, now()), true);
  assert.strictEqual(await store.claimPairingRequest(hash, now()), false, 'a second poll cannot mint a second identity');
  assert.strictEqual(pairing.pollOutcome(await store.getPairingRequest(code)), 'waiting', 'mid-provision reads as waiting');

  await store.finishPairingRequest(code, 'Flow rig PC', 'redeemed');
  const done = await store.getPairingRequest(code);
  assert.strictEqual(done.device_id, 'Flow rig PC');
  assert.ok(done.redeemed_at);
  assert.strictEqual(pairing.pollOutcome(done), 'used');
  assert.strictEqual(await store.approvePairingRequest(code, 'again', now(), later(1000)), false, 'cannot be approved twice');
});

test('a failed provision puts the request back so the next poll retries', async (t) => {
  const store = freshStore(t);
  const { code, hash } = await started(store);
  await store.approvePairingRequest(code, 'rig', now(), later(pairing.TTL_MS));
  assert.ok(await store.claimPairingRequest(hash, now()));
  await store.finishPairingRequest(code, null, 'approved');
  assert.ok(await store.claimPairingRequest(hash, now()));
});

test('only the secret finds the request; the code does not', async (t) => {
  const store = freshStore(t);
  const { code } = await started(store);
  assert.strictEqual(await store.getPairingRequestBySecret(pairing.hashSecret(code)), null);
  assert.strictEqual(await store.getPairingRequestBySecret(pairing.hashSecret('guess')), null);
  assert.strictEqual(pairing.pollOutcome(null), 'unknown');
});

test('denied is final', async (t) => {
  const store = freshStore(t);
  const { code, hash } = await started(store);
  assert.strictEqual(await store.denyPairingRequest(code, now()), true);
  assert.strictEqual(pairing.pollOutcome(await store.getPairingRequest(code)), 'denied');
  assert.strictEqual(await store.approvePairingRequest(code, 'x', now(), later(1000)), false);
  assert.strictEqual(await store.claimPairingRequest(hash, now()), false);
});

test('an expired request cannot be approved or collected, and is swept', async (t) => {
  const store = freshStore(t);
  const { code, hash } = await started(store, { expiresAt: later(-1000) });
  assert.strictEqual(pairing.pollOutcome(await store.getPairingRequest(code)), 'expired');
  assert.strictEqual(await store.approvePairingRequest(code, 'x', now(), later(1000)), false);
  assert.strictEqual(await store.claimPairingRequest(hash, now()), false);

  const kept = await started(store);
  await store.approvePairingRequest(kept.code, 'kept', now(), later(pairing.TTL_MS));
  await store.claimPairingRequest(kept.hash, now());
  await store.finishPairingRequest(kept.code, 'kept', 'redeemed');

  assert.strictEqual(await store.purgeExpiredPairingRequests(now()), 1);
  assert.strictEqual(await store.getPairingRequest(code), null);
  assert.ok(await store.getPairingRequest(kept.code), 'a completed pairing is kept as the record');
});

test('approving late restarts the clock, so the edge still has time to collect', async (t) => {
  const store = freshStore(t);
  const { code, hash } = await started(store, { expiresAt: later(2000) });
  await store.approvePairingRequest(code, 'rig', now(), later(pairing.TTL_MS));
  const row = await store.getPairingRequest(code);
  assert.ok(new Date(row.expires_at).getTime() > Date.now() + pairing.TTL_MS - 5000);
  assert.ok(await store.claimPairingRequest(hash, now()));
});

test('a device name is unique within a workspace, read the way a person reads it', () => {
  const taken = [{ id: 'flow-rig-ab12cd', name: 'Flow rig' }, { id: 'hplc-9z8y7x', name: 'HPLC' }];
  // Case and spacing do not make a different name.
  assert.deepStrictEqual(pairing.nameConflict('flow  RIG ', taken), taken[0]);
  assert.strictEqual(pairing.nameConflict('Flow rig 2', taken), null);
  // A device keeps its own name when it is paired again or renamed to the same thing.
  assert.strictEqual(pairing.nameConflict('Flow rig', taken, 'flow-rig-ab12cd'), null);
  assert.deepStrictEqual(pairing.nameConflict('HPLC', taken, 'flow-rig-ab12cd'), taken[1]);
  assert.strictEqual(pairing.nameConflict('', taken), null);
});

test('renaming a device changes its label and leaves its id alone', async (t) => {
  const store = freshStore(t);
  await store.upsertDevicePlaceholder('rig-abc123', 'Flow rig');
  assert.strictEqual(await store.renameDevice('rig-abc123', 'Pump rig'), true);
  assert.strictEqual(await store.renameDevice('nope', 'x'), false);
  const [device] = await store.listDevices();
  assert.strictEqual(device.id, 'rig-abc123');
  assert.strictEqual(device.name, 'Pump rig');
});
