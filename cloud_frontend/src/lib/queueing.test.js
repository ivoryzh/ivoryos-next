'use strict';

// Two things that went missing between "Run" and "Results":
//   * a step set to repeat ran N times on the device, and Cloud kept only the last record;
//   * a second run could only start now, taking the device in the gaps of the first, with no way
//     to say "after what is already going".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSqliteStore } = require('./store/sqlite.js');
const { computeAdvance } = require('./dag.js');

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-queue-'));
  const store = createSqliteStore(path.join(dir, 'test.db'));
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return store;
}

const task = (over = {}) => ({
  run_id: 'r1', node_id: 'A', device_id: 'dev1', block: {}, members: ['A'], status: 'pending', ...over,
});

test('every occurrence of a repeating step keeps its own record', async (t) => {
  const store = freshStore(t);
  await store.insertTasks([task({ repeat_total: 3 })]);
  for (const edgeRunId of [11, 12, 13]) {
    await store.setTaskResult('r1', 'A', { edgeRunId, status: 'completed', steps: [] });
  }
  // A redelivered message for the last run replaces its entry rather than adding a fourth.
  await store.setTaskResult('r1', 'A', { edgeRunId: 13, status: 'completed', steps: [{ id: 1 }] });
  const [rec] = await store.listRunTaskRecords('r1');
  assert.deepStrictEqual(rec.results.map((r) => r.edgeRunId), [11, 12, 13]);
  assert.strictEqual(rec.results[2].steps.length, 1);
  assert.strictEqual(rec.result.edgeRunId, 13, '`result` stays the latest');
});

test('a run queued after current work waits for open work on its devices, judged by tasks', async (t) => {
  const store = freshStore(t);
  await store.insertRun({ id: 'A', name: 'first', status: 'running', nodes: [], edges: [] });
  await store.insertRun({ id: 'Z', name: 'stale', status: 'running', nodes: [], edges: [] }); // no open tasks
  await store.insertTasks([
    task({ run_id: 'A', node_id: 'a1', status: 'pending' }), // e.g. a repeat's next occurrence
    task({ run_id: 'Z', node_id: 'z1', status: 'completed' }),
    task({ run_id: 'A', node_id: 'a2', device_id: 'dev2', status: 'running' }),
  ]);

  const ahead = await store.listOpenRunsOnDevices(['dev1']);
  assert.deepStrictEqual(ahead.map((r) => r.id), ['A'], 'a run left "running" with nothing open holds nothing up');
  assert.deepStrictEqual(await store.listOpenRunsOnDevices(['dev9']), []);

  await store.insertRun({ id: 'B', name: 'second', status: 'queued', nodes: [], edges: [], after_runs: ['A'] });
  assert.deepStrictEqual((await store.listQueuedRuns()).map((r) => [r.id, r.after_runs]), [['B', ['A']]]);
  assert.strictEqual(await store.runsHaveOpenTasks(['A']), true);

  await store.updateTaskStatusFrom('A', 'a1', 'pending', 'completed');
  await store.updateTaskStatusFrom('A', 'a2', 'running', 'completed');
  assert.strictEqual(await store.runsHaveOpenTasks(['A']), false);

  assert.strictEqual(await store.updateRunStatusFrom('B', 'queued', 'running'), true);
  assert.strictEqual(await store.updateRunStatusFrom('B', 'queued', 'running'), false, 'started once only');
});

test('starting a queued run releases exactly the steps that depend on nothing', () => {
  const nodes = [
    { id: 'start', data: { block: { instrument: 'Flow Control', method: 'Start' } } },
    { id: 'x', data: { block: { instrument: 'pump', method: 'dose' }, targetDeviceId: 'dev1' } },
    { id: 'y', data: { block: { instrument: 'pump', method: 'dose' }, targetDeviceId: 'dev1' } },
  ];
  const edges = [{ source: 'start', target: 'x' }, { source: 'x', target: 'y' }];
  const tasks = [{ node_id: 'x', status: 'blocked' }, { node_id: 'y', status: 'blocked' }];
  const { unblock, runStatus, stalled } = computeAdvance(nodes, edges, tasks);
  assert.deepStrictEqual(unblock, ['x']);
  assert.strictEqual(runStatus, 'running');
  assert.strictEqual(stalled, false);
});

test('the Cloud library keeps a workflow by name, with its first save date', async (t) => {
  const store = freshStore(t);
  await store.upsertCloudWorkflow({ name: 'Flow rig', description: 'v1', nodes: [{ id: 'a' }], edges: [], created_at: '2026-01-01T00:00:00.000Z' });
  await store.upsertCloudWorkflow({ name: 'Flow rig', description: 'v2', nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ id: 'e' }] });
  const rows = await store.listCloudWorkflows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].description, 'v2');
  assert.strictEqual(rows[0].nodes.length, 2);
  assert.strictEqual(rows[0].created_at, '2026-01-01T00:00:00.000Z', 're-saving does not reset when it was created');
});

test('a repeat is due a full interval after the previous one started, never in the past', () => {
  const { nextOccurrenceAt } = require('./store/sqlite.js');
  const now = Date.parse('2026-09-25T12:10:00.000Z');
  // Started 12:00, every 10 min: due 12:10 even though it finished at 12:00:02.
  assert.strictEqual(nextOccurrenceAt({ repeat_every_ms: 600000, dispatched_at: '2026-09-25T12:00:00.000Z' }, now - 1000),
    '2026-09-25T12:10:00.000Z');
  // Overran its interval: follows at once rather than being skipped.
  assert.strictEqual(nextOccurrenceAt({ repeat_every_ms: 60000, dispatched_at: '2026-09-25T12:00:00.000Z' }, now),
    new Date(now).toISOString());
  // Never dispatched (no start time): from now.
  assert.strictEqual(nextOccurrenceAt({ repeat_every_ms: 5000, dispatched_at: null }, now), new Date(now + 5000).toISOString());
});
