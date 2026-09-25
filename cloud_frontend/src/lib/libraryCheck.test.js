const test = require('node:test');
const assert = require('node:assert');
const { graphProblems } = require('./libraryCheck');

const start = { id: 'start_node', data: { targetDeviceId: '', block: { instrument: 'Flow Control', method: 'Start' } } };
const step = (id, block, dev = 'dev1') => ({ id, data: { targetDeviceId: dev, block } });

const devices = [{
  id: 'dev1',
  schema: {
    instruments: {
      pump: {
        dispense: { parameters: { volume_ml: { required: true }, rate: { required: false } } },
        configure: { parameters: {}, accepts_kwargs: true },
      },
    },
  },
}];

const sequences = [
  { device_id: 'dev1', name: 'good', body: { compatibility: { status: 'ok', error_count: 0 } } },
  { device_id: 'dev1', name: 'rotten', body: { compatibility: { status: 'broken', error_count: 2 } } },
];

const messages = (nodes) => graphProblems(nodes, devices, sequences).map((p) => `${p.where}: ${p.message}`);

test('a graph that matches its devices has no problems', () => {
  assert.deepStrictEqual(messages([
    start,
    step('a', { instrument: 'pump', method: 'dispense', params: { volume_ml: '#v' } }),
    step('b', { instrument: 'pump', method: 'configure', params: { anything: 1 } }),
    step('c', { instrument: 'Library Workflows', method: 'good', params: {} }),
  ]), []);
});

test('a step whose device, instrument or method has gone is reported', () => {
  assert.deepStrictEqual(messages([
    step('a', { instrument: 'pump', method: 'dispense', params: { volume_ml: 1 } }, 'ghost'),
    step('b', { instrument: 'stirrer', method: 'spin', params: {} }),
    step('c', { instrument: 'pump', method: 'prime', params: {} }),
  ]), [
    'pump.dispense: targets ghost, which is not a registered device',
    "stirrer.spin: dev1 has no instrument 'stirrer'",
    "pump.prime: 'pump' on dev1 has no method 'prime'",
  ]);
});

test('a renamed argument and an empty required one are both reported', () => {
  assert.deepStrictEqual(messages([
    step('a', { instrument: 'pump', method: 'dispense', params: { volume: 1, volume_ml: '', _row: 0 } }),
  ]), [
    "pump.dispense: argument 'volume' no longer exists",
    "pump.dispense: required argument 'volume_ml' is empty",
  ]);
});

test("a linked workflow carries the device's own verdict", () => {
  assert.deepStrictEqual(messages([
    step('a', { instrument: 'Library Workflows', method: 'rotten', params: {} }),
    step('b', { instrument: 'Library Workflows', method: 'deleted', params: {} }),
  ]), [
    "rotten: won't run on dev1 (2 problems in that workflow)",
    'deleted: dev1 has no saved workflow by this name',
  ]);
});
