'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { commandProblem, commandStep, pauseKind, RESEND_AFTER_MS } = require('./taskCommands.js');
const { createSqliteStore } = require('./store/sqlite.js');

const asking = { status: 'running', progress: { state: 'waiting_input', pause: 'input:7:t0', prompt: 'Vial loaded?' } };
const failed = { status: 'running', progress: { state: 'error', pause: 'error:9:t1', error: 'Pump stalled' } };

test('a task is stopped for a person only while running with a pause', () => {
  assert.strictEqual(pauseKind(asking), 'input');
  assert.strictEqual(pauseKind(failed), 'error');
  assert.strictEqual(pauseKind({ ...failed, status: 'error' }), null, 'a finished task asks nothing');
  assert.strictEqual(pauseKind({ status: 'running', progress: { state: 'running' } }), null);
});

test('a decision must match the pause on screen and suit what it is about', () => {
  assert.strictEqual(commandProblem(asking, { action: 'input', pause: 'input:7:t0' }), null);
  assert.strictEqual(commandProblem(failed, { action: 'retry', pause: 'error:9:t1' }), null);
  assert.match(commandProblem(asking, { action: 'input', pause: 'input:7:OLD' }), /no longer waiting/);
  assert.match(commandProblem(asking, { action: 'retry', pause: 'input:7:t0' }), /does not apply/);
  assert.match(commandProblem(failed, { action: 'input', pause: 'error:9:t1' }), /does not apply/);
  const sent = { ...failed, command: { action: 'skip', pause: 'error:9:t1' } };
  assert.match(commandProblem(sent, { action: 'retry', pause: 'error:9:t1' }), /already been sent/);
});

test('a decision is sent, re-sent only after a while, and cleared once the pause has gone', () => {
  const now = Date.now();
  const cmd = { action: 'retry', pause: 'error:9:t1', state: 'pending' };
  assert.strictEqual(commandStep({ ...failed, command: cmd }, true, now), 'send');
  assert.strictEqual(commandStep({ ...failed, command: cmd }, false, now), 'wait', 'held while the device is away');
  const sent = { ...cmd, state: 'sent', sent_at: new Date(now).toISOString() };
  assert.strictEqual(commandStep({ ...failed, command: sent }, true, now + 1000), 'wait');
  assert.strictEqual(commandStep({ ...failed, command: sent }, true, now + RESEND_AFTER_MS), 'send');
  // Retried: the same step running again is a different pause (or none), so the decision is done.
  const moved = { status: 'running', progress: { state: 'running' }, command: sent };
  assert.strictEqual(commandStep(moved, true, now), 'clear');
  assert.strictEqual(commandStep({ ...failed, status: 'error', command: sent }, true, now), 'clear');
});

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-cmd-'));
  const store = createSqliteStore(path.join(dir, 'test.db'));
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return store;
}

test('the store takes a decision only for the pause the task is on, and a dispatch clears it', async (t) => {
  const store = freshStore(t);
  await store.insertTasks([{ run_id: 'r1', node_id: 'A', device_id: 'dev1', block: {}, members: ['A'], status: 'running' }]);
  await store.updateTaskStatusIfNotTerminal('r1', 'A', 'running', ['completed', 'error'], failed.progress);

  assert.strictEqual(await store.setTaskCommand('r1', 'A', { action: 'retry', pause: 'error:9:OLD', state: 'pending' }), false);
  assert.strictEqual(await store.setTaskCommand('r1', 'A', { action: 'retry', pause: 'error:9:t1', state: 'pending' }), true);
  const [row] = await store.listTaskCommands();
  assert.deepStrictEqual([row.node_id, row.command.action, row.progress.pause], ['A', 'retry', 'error:9:t1']);
  assert.strictEqual((await store.listRunTaskRecords('r1'))[0].command.action, 'retry');

  await store.updateTaskCommand('r1', 'A', null);
  assert.strictEqual((await store.listTaskCommands()).length, 0);

  await store.setTaskCommand('r1', 'A', { action: 'skip', pause: 'error:9:t1', state: 'pending' });
  await store.updateTaskStatusIfNotTerminal('r1', 'A', 'completed', ['error']);
  await store.scheduleTaskRepeat('r1', 'A'); // no cadence: stays completed
  await store.updateTaskStatusFrom('r1', 'A', 'completed', 'pending');
  await store.updateTaskStatusFrom('r1', 'A', 'pending', 'queued', { dispatched: true });
  assert.strictEqual((await store.listTaskCommands()).length, 0, 'a fresh dispatch carries no old decision');
});

test('a device picture is stored apart from the list, which only carries its version', async (t) => {
  const store = freshStore(t);
  await store.upsertDeviceStatus('dev1', 'online');
  assert.strictEqual(await store.setDeviceImage('ghost', 'data:image/png;base64,AA=='), false);
  assert.strictEqual(await store.setDeviceImage('dev1', 'data:image/png;base64,AA=='), true);
  const [listed] = await store.listDevices();
  assert.ok(listed.image_version);
  assert.strictEqual(listed.image, undefined, 'the polled list never carries the image itself');
  assert.strictEqual((await store.getDeviceImage('dev1')).image, 'data:image/png;base64,AA==');
  await store.setDeviceImage('dev1', null);
  assert.strictEqual(await store.getDeviceImage('dev1'), null);
  assert.strictEqual((await store.listDevices())[0].image_version, null);
});
