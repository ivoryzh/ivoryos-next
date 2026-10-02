'use strict';

// The store behaviour behind the edge <-> Cloud sync rules (docs/edge_cloud_sync.md):
//   * a removed device goes, the workflows mirrored from it stay as a record;
//   * a device that went quiet is offline without pretending it was just seen;
//   * a repeated step is N whole runs, each numbered, and Cloud can say how many are to come.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSqliteStore } = require('./store/sqlite.js');
const { removeDevice, archiveIdFor, isArchivedId } = require('./deviceRemoval.js');

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-sync-'));
  const store = createSqliteStore(path.join(dir, 'test.db'));
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return store;
}

async function withoutAws(fn) {
  const saved = process.env.AWS_IOT_ENDPOINT;
  delete process.env.AWS_IOT_ENDPOINT;
  try { return await fn(); } finally { if (saved !== undefined) process.env.AWS_IOT_ENDPOINT = saved; }
}

test('removing a device keeps its workflows as a record in the same workspace', async (t) => {
  const store = freshStore(t);
  await store.upsertDevicePlaceholder('rig-abc123', 'Flow rig');
  await store.upsertDeviceSchema('rig-abc123', { instruments: { pump: { dose: {} } } });
  await store.setOwner('device', 'rig-abc123', 'org:lab');
  await store.upsertSequence({ device_id: 'rig-abc123', name: 'wash', description: 'rinse', body: { script: [{ action: 'dose' }] } });
  await store.upsertSequence({ device_id: 'rig-abc123', name: 'prime', description: '', body: {} });

  const result = await withoutAws(() => removeDevice(store, 'rig-abc123'));
  assert.ok(isArchivedId(result.archived), result.archived);
  assert.strictEqual(result.workflows, 2);

  // The live device is gone: not listed, not owned, remembered as removed.
  assert.deepStrictEqual((await store.listDevices()).map((d) => d.id), []);
  assert.strictEqual(await store.getOwner('device', 'rig-abc123'), null);
  assert.deepStrictEqual(await store.listRemovedDeviceIds(), ['rig-abc123']);
  assert.deepStrictEqual(await store.listSequences('rig-abc123'), []);

  // Its workflows are still there, under a kept record the workspace owns, with the schema
  // they were written against.
  const kept = await store.listSequences(result.archived);
  assert.deepStrictEqual(kept.map((s) => s.name).sort(), ['prime', 'wash']);
  assert.deepStrictEqual(kept.find((s) => s.name === 'wash').body, { script: [{ action: 'dose' }] });
  assert.strictEqual(await store.getOwner('device', result.archived), 'org:lab');
  const [record] = await store.listDevices({ includeRemoved: true });
  assert.strictEqual(record.id, result.archived);
  assert.strictEqual(record.status, 'removed');
  assert.strictEqual(record.name, 'Flow rig');
  assert.deepStrictEqual(record.schema.instruments, { pump: { dose: {} } });
});

test('the same device paired again is a new device and cannot touch the kept copies', async (t) => {
  const store = freshStore(t);
  await store.upsertDevicePlaceholder('rig-abc123', 'Flow rig');
  await store.setOwner('device', 'rig-abc123', 'org:lab');
  await store.upsertSequence({ device_id: 'rig-abc123', name: 'wash', description: '', body: { v: 1 } });
  const { archived } = await withoutAws(() => removeDevice(store, 'rig-abc123'));

  // Paired again (another workspace, even) and publishing a workflow of the same name.
  await store.upsertDevicePlaceholder('rig-abc123', 'Flow rig');
  await store.setOwner('device', 'rig-abc123', 'org:other');
  await store.upsertSequence({ device_id: 'rig-abc123', name: 'wash', description: '', body: { v: 2 } });

  assert.deepStrictEqual((await store.listSequences(archived))[0].body, { v: 1 }, 'the record is untouched');
  assert.strictEqual(await store.getOwner('device', archived), 'org:lab', 'and still the first workspace\'s');
  assert.deepStrictEqual((await store.listDevices()).map((d) => d.id), ['rig-abc123']);
});

test('a device with no workflows leaves nothing behind', async (t) => {
  const store = freshStore(t);
  await store.upsertDevicePlaceholder('bare-1', 'Bare');
  await store.setOwner('device', 'bare-1', 'user:a');
  const result = await withoutAws(() => removeDevice(store, 'bare-1'));
  assert.strictEqual(result.archived, null);
  assert.deepStrictEqual(await store.listDevices({ includeRemoved: true }), []);
});

test('an archive id is recognisable and never a valid live id', () => {
  const id = archiveIdFor('my-deck-7k4m2q', new Date('2026-10-01T12:34:56Z'));
  assert.strictEqual(id, 'my-deck-7k4m2q~removed-20261001123456');
  assert.ok(isArchivedId(id));
  assert.ok(!isArchivedId('my-deck-7k4m2q'));
  // cleanDeviceId refuses it, so no edge can ever pair or publish under an archive id.
  assert.strictEqual(require('./pairing.js').cleanDeviceId(id), null);
});

test('a device that went quiet is offline, and keeps the time it was last heard from', async (t) => {
  const store = freshStore(t);
  await store.upsertDeviceStatus('dev1', 'online', true);
  const [before] = await store.listDevices();
  await new Promise((r) => setTimeout(r, 15));
  await store.markDeviceOffline('dev1');
  const [after] = await store.listDevices();
  assert.strictEqual(after.status, 'offline');
  assert.strictEqual(!!after.busy, false);
  assert.strictEqual(after.last_seen, before.last_seen, 'silence is not a sighting');
  // Paused is the device's own word, not silence: it is left alone.
  await store.upsertDeviceStatus('dev2', 'paused', false);
  await store.markDeviceOffline('dev2');
  assert.strictEqual((await store.listDevices()).find((d) => d.id === 'dev2').status, 'paused');
});

const task = (over = {}) => ({
  run_id: 'r1', node_id: 'A', device_id: 'dev1', block: { instrument: 'Library Workflows', method: 'wash' },
  run: null, members: ['A'], status: 'pending', repeat_every_ms: 0, repeat_total: 0, ...over,
});

test('"run it 3 times" is three dispatches, numbered, counted down for the device', async (t) => {
  const store = freshStore(t);
  await store.insertRun({ id: 'r1', name: 'Screen', status: 'running', nodes: [], edges: [] });
  await store.insertTasks([task({ repeat_total: 3 }), task({ node_id: 'B', status: 'blocked' })]);

  const seen = [];
  for (let occurrence = 1; occurrence <= 3; occurrence++) {
    const [ready] = await store.listTasksByStatus('pending');
    assert.strictEqual(ready.repeat_total, 3, 'the listing carries the count the dispatch numbers runs with');
    const state = await store.getTaskRepeat('r1', 'A');
    seen.push(`${state.repeat_done + 1} of ${state.repeat_total}`);
    const [summary] = await store.listRepeatingTasks();
    assert.strictEqual(summary.run_name, 'Screen');
    assert.strictEqual(summary.repeat_total - summary.repeat_done - 1, 3 - occurrence, 'runs still to come after this one');

    await store.updateTaskStatusFrom('r1', 'A', 'pending', 'queued', { dispatched: true });
    await store.updateTaskStatusIfNotTerminal('r1', 'A', 'completed', ['completed', 'error', 'cancelled', 'skipped']);
    const again = await store.scheduleTaskRepeat('r1', 'A');
    assert.strictEqual(again, occurrence < 3, `after run ${occurrence}`);
  }
  assert.deepStrictEqual(seen, ['1 of 3', '2 of 3', '3 of 3']);
  assert.deepStrictEqual(await store.listRepeatingTasks(), [], 'nothing left to come once the last has finished');
  assert.strictEqual(await store.getTaskRepeat('r1', 'nope'), null);
});

test('a workflow kept in Cloud only can be told apart from one the device has', async (t) => {
  const store = freshStore(t);
  await store.upsertDevicePlaceholder('dev1', 'Deck');
  await store.upsertSequence({ device_id: 'dev1', name: 'draft', description: '', body: { script: [], cloud_only: true } });
  await store.upsertSequence({ device_id: 'dev1', name: 'sent', description: '', body: { script: [] } });
  assert.strictEqual((await store.getSequence('dev1', 'draft')).body.cloud_only, true);
  assert.strictEqual((await store.getSequence('dev1', 'sent')).body.cloud_only, undefined);
  assert.strictEqual(await store.getSequence('dev1', 'missing'), null);
});
