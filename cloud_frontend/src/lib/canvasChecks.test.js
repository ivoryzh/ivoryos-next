'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parallelOnSameDevice } = require('./canvasChecks.js');

const start = { id: 'start_node', data: { block: { instrument: 'Flow Control', method: 'Start' } } };
const inst = (id, dev = 'dev1') => ({ id, data: { targetDeviceId: dev, block: { instrument: 'Pump', method: 'dose' } } });
const ifNode = (id) => ({ id, data: { block: { instrument: 'Flow Control', method: 'If' } } });
const e = (source, target, sourceHandle) => ({ source, target, sourceHandle });

test('two branches on one device are flagged; a chain is not', () => {
  const nodes = [start, inst('A'), inst('B'), inst('C')];
  assert.deepStrictEqual(
    parallelOnSameDevice(nodes, [e('start_node', 'A'), e('start_node', 'B'), e('A', 'C')]),
    [{ deviceId: 'dev1', nodeIds: ['A', 'B', 'C'] }],
    'B is parallel to both A and C',
  );
  assert.deepStrictEqual(parallelOnSameDevice(nodes, [e('start_node', 'A'), e('A', 'B'), e('B', 'C')]), []);
});

test('parallel branches on different devices are fine', () => {
  const nodes = [start, inst('A', 'dev1'), inst('B', 'dev2')];
  assert.deepStrictEqual(parallelOnSameDevice(nodes, [e('start_node', 'A'), e('start_node', 'B')]), []);
});

test("the two sides of an If never both run, so they are not parallel", () => {
  const nodes = [start, ifNode('if'), inst('T'), inst('F')];
  const edges = [e('start_node', 'if'), e('if', 'T', 'true'), e('if', 'F', 'false')];
  assert.deepStrictEqual(parallelOnSameDevice(nodes, edges), []);
});

test('an unwired step is left to validation, not reported here', () => {
  const nodes = [start, inst('A'), inst('B')];
  assert.deepStrictEqual(parallelOnSameDevice(nodes, [e('start_node', 'A')]), []);
});
