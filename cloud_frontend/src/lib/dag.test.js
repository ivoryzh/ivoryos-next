'use strict';

// `node --test` (built in since Node 18) — no test framework added to this project for the sake
// of one file. Run with `npm test` from cloud_frontend/.
//
// These are here because dag.js is the only place in Cloud where getting it subtly wrong actuates
// real hardware in the wrong order rather than throwing: the pre-existing bug this file pins down
// (case "Flow Control is transparent") dispatched a downstream instrument concurrently with the
// one it was drawn as waiting for, and nothing anywhere failed or logged.

const test = require('node:test');
const assert = require('node:assert');
const dag = require('./dag.js');

// Mirrors what the Orchestrator canvas actually puts on the wire: the Start node it seeds, a
// Flow Control node dragged from "Cloud Logic", and an ordinary instrument node with a device.
const start = { id: 'start_node', data: { targetDeviceId: '', block: { instrument: 'Flow Control', method: 'Start' } } };
const fc = (id, method = 'Sleep') => ({ id, data: { targetDeviceId: '', block: { instrument: 'Flow Control', method } } });
const inst = (id, dev = 'dev1') => ({ id, data: { targetDeviceId: dev, block: { instrument: 'Pump', method: 'dose' } } });
const e = (source, target) => ({ source, target });
const byNode = (tasks) => Object.fromEntries(tasks.map(t => [t.node_id, t]));
const codes = (problems) => problems.map(p => p.code);

test('a linear graph starts only its first step', () => {
  const nodes = [start, inst('A'), inst('B')];
  const edges = [e('start_node', 'A'), e('A', 'B')];
  const { errors, tasks } = dag.planRun('r', nodes, edges);
  assert.deepStrictEqual(errors, []);
  const t = byNode(tasks);
  assert.strictEqual(t.A.status, 'pending');
  assert.strictEqual(t.B.status, 'blocked');
  assert.deepStrictEqual(t.B.deps, ['A']);
});

test('Flow Control is transparent, not an already-met dependency', () => {
  // The regression this whole module exists for. `A -> Sleep -> B`: the old logic saw B's only
  // dependency as a Flow Control node, called it satisfied, and dispatched B alongside A.
  const nodes = [start, inst('A'), fc('sleep1'), inst('B')];
  const edges = [e('start_node', 'A'), e('A', 'sleep1'), e('sleep1', 'B')];
  const { errors, tasks } = dag.planRun('r', nodes, edges);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(tasks.length, 2, 'Flow Control nodes get no run_tasks row');
  const t = byNode(tasks);
  assert.strictEqual(t.A.status, 'pending');
  assert.strictEqual(t.B.status, 'blocked');
  assert.deepStrictEqual(t.B.deps, ['A'], 'the dependency resolves through the Sleep node to A');

  const advanced = dag.computeAdvance(nodes, edges, [
    { node_id: 'A', status: 'completed' },
    { node_id: 'B', status: 'blocked' },
  ]);
  assert.deepStrictEqual(advanced.unblock, ['B']);
  assert.strictEqual(advanced.runStatus, 'running');
});

test('a chain of Flow Control nodes is contracted away entirely', () => {
  const nodes = [start, inst('A'), fc('if1', 'If'), fc('sleep1'), inst('B')];
  const edges = [e('start_node', 'A'), e('A', 'if1'), e('if1', 'sleep1'), e('sleep1', 'B')];
  const { tasks } = dag.planRun('r', nodes, edges);
  assert.deepStrictEqual(byNode(tasks).B.deps, ['A']);
});

test('both spellings of the Flow Control instrument are recognised', () => {
  // 'Flow_Control' is what queue.py and the saved-JSON format use; the cloud side used to accept
  // only 'Flow Control' and rejected the other as an instrument step with no target device.
  const underscored = { id: 's', data: { block: { instrument: 'Flow_Control', method: 'Start' } } };
  assert.deepStrictEqual(dag.validateGraph([underscored, inst('A')], [e('s', 'A')]), []);
});

test('independent branches run in parallel and fan-in waits for all of them', () => {
  const nodes = [start, inst('A'), inst('B'), inst('C')];
  const edges = [e('start_node', 'A'), e('start_node', 'B'), e('A', 'C'), e('B', 'C')];
  const t = byNode(dag.planRun('r', nodes, edges).tasks);
  assert.strictEqual(t.A.status, 'pending');
  assert.strictEqual(t.B.status, 'pending');
  assert.strictEqual(t.C.status, 'blocked');

  const halfDone = dag.computeAdvance(nodes, edges, [
    { node_id: 'A', status: 'completed' }, { node_id: 'B', status: 'running' }, { node_id: 'C', status: 'blocked' },
  ]);
  assert.deepStrictEqual(halfDone.unblock, [], 'C must not start while B is still running');

  const allDone = dag.computeAdvance(nodes, edges, [
    { node_id: 'A', status: 'completed' }, { node_id: 'B', status: 'completed' }, { node_id: 'C', status: 'blocked' },
  ]);
  assert.deepStrictEqual(allDone.unblock, ['C']);
});

test('a diamond releases exactly the steps whose dependencies are met', () => {
  const nodes = [start, inst('A'), inst('B'), inst('C'), inst('D')];
  const edges = [e('start_node', 'A'), e('A', 'B'), e('A', 'C'), e('B', 'D'), e('C', 'D')];
  const t = byNode(dag.planRun('r', nodes, edges).tasks);
  assert.deepStrictEqual(t.D.deps.slice().sort(), ['B', 'C']);

  const afterA = dag.computeAdvance(nodes, edges, [
    { node_id: 'A', status: 'completed' }, { node_id: 'B', status: 'blocked' },
    { node_id: 'C', status: 'blocked' }, { node_id: 'D', status: 'blocked' },
  ]);
  assert.deepStrictEqual(afterA.unblock.slice().sort(), ['B', 'C']);
});

test('a cycle is rejected and the offending steps are named', () => {
  const nodes = [start, inst('A'), inst('B'), inst('C')];
  const edges = [e('start_node', 'A'), e('A', 'B'), e('B', 'C'), e('C', 'A')];
  const problems = dag.validateGraph(nodes, edges);
  const cycle = problems.find(p => p.code === 'cycle');
  assert.ok(cycle, 'expected a cycle problem, got ' + JSON.stringify(codes(problems)));
  for (const id of ['A', 'B', 'C']) assert.ok(cycle.message.includes(id), `message should name ${id}`);
});

test('structurally broken graphs are rejected', () => {
  assert.ok(codes(dag.validateGraph([start, inst('A')], [e('start_node', 'A'), e('A', 'A')])).includes('self_loop'));
  assert.ok(codes(dag.validateGraph([start, inst('A')], [e('start_node', 'A'), e('ghost', 'A')])).includes('dangling_edge'));
  assert.ok(codes(dag.validateGraph([start, inst('A'), inst('A')], [e('start_node', 'A')])).includes('duplicate_node_id'));
  assert.ok(codes(dag.validateGraph([], [])).includes('empty'));
});

test('a step not connected to Start is rejected rather than run immediately', () => {
  const problems = dag.validateGraph([start, inst('A'), inst('Orphan')], [e('start_node', 'A')]);
  const orphan = problems.find(p => p.code === 'unreachable');
  assert.ok(orphan, 'expected an unreachable problem, got ' + JSON.stringify(codes(problems)));
  assert.ok(orphan.message.includes('Orphan'));
});

test('a step with no target device is rejected', () => {
  assert.ok(codes(dag.validateGraph([start, inst('A', '')], [e('start_node', 'A')])).includes('no_device'));
  assert.ok(codes(dag.validateGraph([start, inst('A', '   ')], [e('start_node', 'A')])).includes('no_device'));
});

test('a failed step cancels everything downstream instead of stranding it', () => {
  const nodes = [start, inst('A'), inst('B')];
  const edges = [e('start_node', 'A'), e('A', 'B')];
  const advanced = dag.computeAdvance(nodes, edges, [
    { node_id: 'A', status: 'error' }, { node_id: 'B', status: 'blocked' },
  ]);
  assert.deepStrictEqual(advanced.unblock, []);
  assert.deepStrictEqual(advanced.cancel.map(c => c.nodeId), ['B']);
  assert.strictEqual(advanced.runStatus, 'error');
});

test('a run reaches a terminal status exactly when its tasks do', () => {
  const nodes = [start, inst('A'), inst('B')];
  const edges = [e('start_node', 'A'), e('A', 'B')];
  assert.strictEqual(dag.computeAdvance(nodes, edges, [
    { node_id: 'A', status: 'completed' }, { node_id: 'B', status: 'running' },
  ]).runStatus, 'running');
  assert.strictEqual(dag.computeAdvance(nodes, edges, [
    { node_id: 'A', status: 'completed' }, { node_id: 'B', status: 'completed' },
  ]).runStatus, 'completed');
  // A graph of nothing but Flow Control produces no tasks at all and is finished on arrival.
  assert.strictEqual(dag.computeAdvance([start], [], []).runStatus, 'completed');
});

test('a graph that got past validation stalls loudly rather than hanging', () => {
  // Not reachable through the run route any more, but computeAdvance must still terminate and
  // reach a terminal state if a cyclic graph ever turns up in the runs table.
  const nodes = [start, inst('A'), inst('B')];
  const edges = [e('start_node', 'A'), e('A', 'B'), e('B', 'A')];
  const advanced = dag.computeAdvance(nodes, edges, [
    { node_id: 'A', status: 'blocked' }, { node_id: 'B', status: 'blocked' },
  ]);
  assert.strictEqual(advanced.stalled, true);
  assert.strictEqual(advanced.runStatus, 'error');
});

// --- parameter completeness -------------------------------------------------------------------
// An empty box on a dispatched step sends "" to real hardware as if it were a value, and an
// unsubstituted "#temperature" sends that string. Both used to pass validation entirely.

// A step whose schema declares params, so "is this box empty" has something to be empty.
const withParams = (id, params, schemaParams, dev = 'dev1') => ({
  id,
  data: {
    targetDeviceId: dev,
    block: {
      instrument: 'Library Workflows',
      method: 'Suzuki coupling screen',
      params,
      schema: { parameters: schemaParams || Object.fromEntries(Object.keys(params).map(k => [k, { type: 'str', required: true }])) },
    },
  },
});

test('a step with an empty parameter box is refused', () => {
  const nodes = [start, withParams('A', { temperature_c: '65', vial_id: '' })];
  const problems = dag.validateGraph(nodes, [e('start_node', 'A')]);
  assert.ok(codes(problems).includes('empty_param'));
  assert.match(problems.find(p => p.code === 'empty_param').message, /vial_id/);
  // Only the blank one is named — a filled box next to it is not the problem.
  assert.doesNotMatch(problems.find(p => p.code === 'empty_param').message, /temperature_c/);
});

test('whitespace is empty, and a schema default is not', () => {
  const blank = [start, withParams('A', { vial_id: '   ' })];
  assert.ok(codes(dag.validateGraph(blank, [e('start_node', 'A')])).includes('empty_param'));

  // params leaves it unset, but the schema supplies a real default: the box shows a value, the
  // edge applies one, and refusing to run here would be wrong.
  const defaulted = [start, withParams('A', {}, { vial_id: { type: 'str', default: 'v1' } })];
  assert.deepStrictEqual(dag.validateGraph(defaulted, [e('start_node', 'A')]), []);
});

test('a #placeholder is a value while authoring, but never at dispatch', () => {
  const nodes = [start, withParams('A', { temperature_c: '#temp' })];
  const edges = [e('start_node', 'A')];

  // The canvas validates before substituting, where #temp is the normal authored state.
  assert.deepStrictEqual(dag.validateGraph(nodes, edges), []);

  // planRun is about to write run_tasks, so the same graph is refused there.
  const { errors, tasks } = dag.planRun('r', nodes, edges);
  assert.ok(codes(errors).includes('unresolved_placeholder'));
  assert.deepStrictEqual(tasks, [], 'nothing is planned when a placeholder survives');
});

test('Flow Control params are not policed — it is never dispatched', () => {
  // A blank field on a contracted-out node cannot reach an instrument, and treating it as an
  // error would reject graphs that run correctly today.
  const sleep = { id: 's1', data: { targetDeviceId: '', block: {
    instrument: 'Flow Control', method: 'Sleep', params: { duration: '' },
    schema: { parameters: { duration: { type: 'str' } } },
  } } };
  const nodes = [start, sleep, inst('A')];
  const edges = [e('start_node', 's1'), e('s1', 'A')];
  assert.deepStrictEqual(dag.validateGraph(nodes, edges), []);
});
