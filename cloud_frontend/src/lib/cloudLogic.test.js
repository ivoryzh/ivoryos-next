'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { namedOutputsOfStep, runContext } = require('./cloudLogic.js');

test('explicit return pointers read their own field of the result', () => {
  const step = {
    parameters: { _return_bindings: [{ path: 'composition.yield_percent', var: 'yield_percent' }, { path: 'method', var: 'm' }] },
    outputs: { result: { composition: { yield_percent: 71.2 }, method: 'hplc' } },
  };
  assert.deepStrictEqual(namedOutputsOfStep(step), { yield_percent: 71.2, m: 'hplc' });
});

test('legacy names: one is the whole result, several map positionally', () => {
  assert.deepStrictEqual(namedOutputsOfStep({ parameters: { _return_var: 'a' }, outputs: { result: [1, 2] } }), { a: [1, 2] });
  assert.deepStrictEqual(namedOutputsOfStep({ parameters: { _return_var: 'a, b' }, outputs: { result: [1, 2] } }), { a: 1, b: 2 });
});

test('run context: later tasks win, errors and unfinished tasks add nothing, answers count', () => {
  const step = (v) => ({ parameters: { _return_var: 'y' }, outputs: { result: v } });
  const ctx = runContext([
    { status: 'completed', updated_at: '2026-01-01T00:00:02Z', result: { steps: [step(2)] } },
    { status: 'completed', updated_at: '2026-01-01T00:00:01Z', result: { steps: [step(1)] } },
    { status: 'error', updated_at: '2026-01-01T00:00:03Z', result: { steps: [step(99)] } },
    { status: 'completed', updated_at: '2026-01-01T00:00:04Z', progress: { save_as: '#ok', answer: 'yes' } },
  ]);
  assert.deepStrictEqual(ctx, { y: 2, ok: 'yes' });
});
