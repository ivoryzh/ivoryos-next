'use strict';

// `node --test` (built in since Node 18) — run with `npm test` from cloud_frontend/.
//
// These cover the two store behaviours that decide whether scheduled work ever actually happens,
// both of which fail *silently* when wrong: a repeat that is never re-dispatched, and a schedule
// occurrence claimed twice. Neither throws, neither logs — the run simply sits there, which is
// exactly what the readiness bug below did (every repeat stranded at `pending` forever, with the
// daemon's own log cheerfully reporting that the next occurrence had been scheduled).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSqliteStore } = require('./store/sqlite.js');

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-store-'));
  const store = createSqliteStore(path.join(dir, 'test.db'));
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return store;
}

const task = (over = {}) => ({
  run_id: 'r1', node_id: 'A', device_id: 'dev1', block: { instrument: 'Pump', method: 'dose' },
  run: null, members: ['A'], status: 'pending', repeat_every_ms: 0, repeat_total: 0, ...over,
});

test('a pending task with no not_before is ready', async (t) => {
  const store = freshStore(t);
  await store.insertTasks([task()]);
  const ready = await store.listTasksByStatus('pending');
  assert.strictEqual(ready.length, 1);
  assert.strictEqual(ready[0].node_id, 'A');
});

test('a pending task whose time has not come is held back, and released once it has', async (t) => {
  const store = freshStore(t);
  await store.insertTasks([
    task({ node_id: 'later', not_before: new Date(Date.now() + 60_000).toISOString() }),
    task({ node_id: 'due', not_before: new Date(Date.now() - 1_000).toISOString() }),
  ]);
  const ready = await store.listTasksByStatus('pending');
  assert.deepStrictEqual(ready.map(r => r.node_id), ['due']);
});

test('readiness is judged per row, not by its position in the result', async (t) => {
  // The regression this file exists for. `listTasksByStatus` filtered with a bare function
  // reference — `.filter(isDue)` — and Array.prototype.filter calls back with (row, index, array),
  // so the row's INDEX arrived as the "now" argument. Row 0 was therefore asked "were you due at
  // or before epoch?", which is never true of a real timestamp. Every repeating task stranded at
  // `pending` forever while the daemon logged that it had scheduled the next occurrence.
  //
  // Several rows, all genuinely due, so a filter that is position-sensitive cannot pass by luck.
  const store = freshStore(t);
  const past = new Date(Date.now() - 5_000).toISOString();
  await store.insertTasks(['A', 'B', 'C'].map(id => task({ node_id: id, not_before: past })));
  const ready = await store.listTasksByStatus('pending');
  assert.deepStrictEqual(ready.map(r => r.node_id).sort(), ['A', 'B', 'C']);
});

test('a completed repeating task comes back as pending, later, until its count runs out', async (t) => {
  const store = freshStore(t);
  await store.insertTasks([task({ repeat_every_ms: 50, repeat_total: 3 })]);

  for (let occurrence = 1; occurrence <= 2; occurrence++) {
    await store.updateTaskStatusFrom('r1', 'A', 'pending', 'queued');
    await store.updateTaskStatusIfNotTerminal('r1', 'A', 'completed', ['completed', 'error', 'cancelled']);

    assert.strictEqual(await store.scheduleTaskRepeat('r1', 'A'), true, `occurrence ${occurrence}`);
    const [row] = await store.listRunTasks('r1');
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.repeat_done, occurrence);

    // Not due yet, so nothing picks it up in the meantime.
    assert.deepStrictEqual(await store.listTasksByStatus('pending'), []);
    await new Promise(r => setTimeout(r, 70));
    assert.strictEqual((await store.listTasksByStatus('pending')).length, 1);
  }

  // The third occurrence is the last: it completes for good rather than coming back.
  await store.updateTaskStatusFrom('r1', 'A', 'pending', 'queued');
  await store.updateTaskStatusIfNotTerminal('r1', 'A', 'completed', ['completed', 'error', 'cancelled']);
  assert.strictEqual(await store.scheduleTaskRepeat('r1', 'A'), false);
  assert.strictEqual((await store.listRunTasks('r1'))[0].status, 'completed');
});

test('a count with no interval repeats back to back', async (t) => {
  // "Repeat 2 times" with the minutes box left empty used to run once: repeating required an
  // interval, and a blank one is 0. The count is what asks for a repeat.
  const store = freshStore(t);
  await store.insertTasks([task({ repeat_every_ms: 0, repeat_total: 2 })]);
  await store.updateTaskStatusIfNotTerminal('r1', 'A', 'completed', ['completed', 'error', 'cancelled']);
  assert.strictEqual(await store.scheduleTaskRepeat('r1', 'A'), true);
  assert.deepStrictEqual((await store.listTasksByStatus('pending')).map(r => r.node_id), ['A'], 'due immediately');

  await store.updateTaskStatusIfNotTerminal('r1', 'A', 'completed', ['completed', 'error', 'cancelled']);
  assert.strictEqual(await store.scheduleTaskRepeat('r1', 'A'), false, 'two runs in total, not three');
});

test('a task with no cadence never repeats', async (t) => {
  const store = freshStore(t);
  await store.insertTasks([task()]);
  await store.updateTaskStatusIfNotTerminal('r1', 'A', 'completed', ['completed', 'error', 'cancelled']);
  assert.strictEqual(await store.scheduleTaskRepeat('r1', 'A'), false);
});

test('only one caller can claim a schedule occurrence', async (t) => {
  // Two daemon ticks landing together (or one daemon overlapping its own restart) would otherwise
  // both start the same scheduled run — the schedule-level version of dispatching one task to real
  // hardware twice.
  const store = freshStore(t);
  const fireAt = new Date(Date.now() - 1_000).toISOString();
  await store.insertSchedule({
    id: 's1', name: 'Nightly', trigger_type: 'interval', every_ms: 60_000,
    nodes: [], edges: [], tasks: [task()], max_runs: 0, next_fire_at: fireAt,
  });

  const next = new Date(Date.now() + 60_000).toISOString();
  assert.strictEqual(await store.claimScheduleFiring('s1', fireAt, next, 'run_1'), true);
  assert.strictEqual(await store.claimScheduleFiring('s1', fireAt, next, 'run_2'), false,
    'the second caller read the same firing time and must lose');

  const after = await store.getSchedule('s1');
  assert.strictEqual(after.runs_fired, 1);
  assert.strictEqual(after.last_run_id, 'run_1');
});

test('a schedule with no further occurrence disables itself as it fires', async (t) => {
  const store = freshStore(t);
  const fireAt = new Date(Date.now() - 1_000).toISOString();
  await store.insertSchedule({
    id: 's1', name: 'Once', trigger_type: 'once', every_ms: 0,
    nodes: [], edges: [], tasks: [], max_runs: 1, next_fire_at: fireAt,
  });

  assert.strictEqual(await store.claimScheduleFiring('s1', fireAt, null, 'run_1'), true);
  const after = await store.getSchedule('s1');
  assert.strictEqual(after.enabled, false);
  assert.deepStrictEqual(await store.listDueSchedules(new Date().toISOString()), []);
});

test('a disabled or exhausted schedule is not due', async (t) => {
  const store = freshStore(t);
  const past = new Date(Date.now() - 1_000).toISOString();
  await store.insertSchedule({ id: 'off', enabled: false, every_ms: 60_000, next_fire_at: past, tasks: [] });
  await store.insertSchedule({ id: 'spent', every_ms: 60_000, next_fire_at: past, max_runs: 1, tasks: [] });
  await store.claimScheduleFiring('spent', past, past, 'run_1');
  await store.insertSchedule({ id: 'live', every_ms: 60_000, next_fire_at: past, tasks: [] });

  const due = await store.listDueSchedules(new Date().toISOString());
  assert.deepStrictEqual(due.map(s => s.id), ['live']);
});

test('a task carrying a whole run payload round-trips it', async (t) => {
  // The spreadsheet / optimization / merged-chain case: `run` is what actually goes on the wire,
  // and a null one means "dispatch the bare block" rather than "something is missing".
  const store = freshStore(t);
  const run = { name: 'Screen', parameters: { type: 'Spreadsheet' }, prep: [], sequence: [{ instrument: 'Pump' }], cleanup: [] };
  await store.insertTasks([task({ node_id: 'plain' }), task({ node_id: 'wrapped', run, members: ['wrapped', 'next'] })]);

  const ready = await store.listTasksByStatus('pending');
  const byNode = Object.fromEntries(ready.map(r => [r.node_id, r]));
  assert.strictEqual(byNode.plain.run, null);
  assert.deepStrictEqual(byNode.wrapped.run, run);
  assert.deepStrictEqual((await store.listRunTasks('r1')).find(r => r.node_id === 'wrapped').members,
    ['wrapped', 'next']);
});

test('a device is busy only while a Cloud task of ours is in flight on it', async (t) => {
  // Cloud holds a ready task until its device is free (daemon.js dispatchTask), so this check is
  // what decides whether a second workflow is sent or waits. Waiting-for-input counts as busy:
  // the device is mid-run, just paused on a person.
  const store = freshStore(t);
  await store.insertTasks([
    task({ node_id: 'done', status: 'completed' }),
    task({ node_id: 'later', status: 'blocked' }),
    task({ node_id: 'ready', status: 'pending' }),
    task({ node_id: 'other', device_id: 'dev2', status: 'running' }),
  ]);
  assert.strictEqual(await store.deviceHasActiveTask('dev1'), false);
  assert.strictEqual(await store.deviceHasActiveTask('dev2'), true);

  for (const status of ['queued', 'running', 'waiting_input']) {
    await store.updateTaskStatusFrom('r1', 'ready', (await store.listRunTasks('r1')).find(r => r.node_id === 'ready').status, status);
    assert.strictEqual(await store.deviceHasActiveTask('dev1'), true, `busy while ${status}`);
  }
});

test('progress from the device is stored, kept across plain status updates, and cleared on re-dispatch', async (t) => {
  const store = freshStore(t);
  const TERMINAL = ['completed', 'error', 'cancelled'];
  await store.insertTasks([task({ status: 'queued' })]);
  const progressOf = async () => (await store.listRecentTasks(10)).find(r => r.node_id === 'A').progress;

  await store.updateTaskStatusIfNotTerminal('r1', 'A', 'running', TERMINAL, { done: 3, total: 10, row: 2 });
  assert.deepStrictEqual(await progressOf(), { done: 3, total: 10, row: 2 });

  // A status change without a summary leaves the last one in place.
  await store.updateTaskStatusIfNotTerminal('r1', 'A', 'running', TERMINAL);
  assert.deepStrictEqual(await progressOf(), { done: 3, total: 10, row: 2 });

  // A late progress message after the task finished must not reopen it.
  await store.updateTaskStatusIfNotTerminal('r1', 'A', 'completed', TERMINAL);
  const moved = await store.updateTaskStatusIfNotTerminal('r1', 'A', 'running', TERMINAL, { done: 9, total: 10 });
  assert.strictEqual(moved, false);
  assert.strictEqual((await store.listRunTasks('r1'))[0].status, 'completed');

  // Dispatching the task again (a repeat's next occurrence) starts its progress over.
  await store.insertTasks([task({ node_id: 'B', status: 'pending' })]);
  await store.updateTaskStatusIfNotTerminal('r1', 'B', 'pending', TERMINAL, { done: 5, total: 5 });
  await store.updateTaskStatusFrom('r1', 'B', 'pending', 'queued', { dispatched: true });
  assert.strictEqual((await store.listRecentTasks(10)).find(r => r.node_id === 'B').progress, null);
});

test('a synced result is stored, summarised in the list, and returned whole on request', async (t) => {
  const store = freshStore(t);
  await store.insertRun({ id: 'r1', name: 'Screen' });
  await store.insertTasks([task({ status: 'completed' })]);
  const result = {
    edgeRunId: 42, name: 'Screen · Suzuki', status: 'completed', end_time: '2026-09-23T10:00:00',
    parameters: { type: 'Spreadsheet' }, steps: [{ id: 1, method: 'weigh', outputs: { result: 1.5 } }],
  };
  await store.setTaskResult('r1', 'A', result);

  const [summary] = await store.listTaskResults(10);
  assert.strictEqual(summary.name, 'Screen · Suzuki');
  assert.strictEqual(Number(summary.edge_run_id), 42);
  assert.strictEqual(summary.run_name, 'Screen');
  assert.strictEqual(summary.steps, undefined, 'the list does not carry every step');

  const full = await store.getTaskResult('r1', 'A');
  assert.deepStrictEqual(full.result, result);
  assert.ok((await store.listRecentTasks(10))[0].edge_run_id, 'the canvas can tell a result exists');
});

test('waiting tasks are the pending and blocked ones, with their run name', async (t) => {
  const store = freshStore(t);
  await store.insertRun({ id: 'r1', name: 'Screen' });
  await store.insertTasks([
    task({ node_id: 'A', status: 'pending' }),
    task({ node_id: 'B', status: 'blocked' }),
    task({ node_id: 'C', status: 'queued' }),
  ]);
  const waiting = await store.listWaitingTasks();
  assert.deepStrictEqual(waiting.map(w => [w.node_id, w.status]).sort(), [['A', 'pending'], ['B', 'blocked']]);
  assert.strictEqual(waiting[0].run_name, 'Screen');
  assert.strictEqual(waiting[0].block.method, 'dose');
});

test('runs are numbered after the name they share, never called "Distributed Run"', async (t) => {
  const store = freshStore(t);
  assert.strictEqual(await store.countRunsNamed('Screen'), 0);
  await store.insertRun({ id: 'a', name: 'Screen #1' });
  await store.insertRun({ id: 'b', name: 'Screen #2' });
  await store.insertRun({ id: 'c', name: 'Screening #1' });
  assert.strictEqual(await store.countRunsNamed('Screen'), 2, 'a longer name that starts the same is not counted');
});
