// Run with: node --experimental-strip-types --test frontend/src/launcherArgs.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFields, fromForm, toForm } from './launcherArgs.ts';

// The Hub's plr-ivoryos Hamilton Nimbus row: a backend built from nested arguments, with defaults.
const NIMBUS = [
  {
    name: 'backend', type: 'object', class_name: 'NimbusBackend',
    import_path: 'pylabrobot.liquid_handling.backends.hamilton.nimbus_backend',
    args: [
      { name: 'host', type: 'str' },
      { name: 'port', type: 'int', default: 2000 },
      { name: 'auto_reconnect', type: 'bool', default: true },
    ],
  },
  { name: 'deck_json', type: 'str', default: 'worktable.json' },
];

test('a checkbox nobody touched keeps the driver default, true included', () => {
  const form = toForm(NIMBUS);
  assert.equal((form.backend as Record<string, unknown>).auto_reconnect, true);
  assert.deepEqual(fromForm(NIMBUS, form), {
    backend: { $object: { import: 'pylabrobot.liquid_handling.backends.hamilton.nimbus_backend', class: 'NimbusBackend', args: { auto_reconnect: true } } },
  });
  // What a deck already says wins over the default.
  const saved = toForm(NIMBUS, { backend: { $object: { args: { auto_reconnect: false } } } });
  assert.equal((saved.backend as Record<string, unknown>).auto_reconnect, false);
});

test('only a field with no default is reported as left empty', () => {
  assert.deepEqual(emptyFields(NIMBUS, toForm(NIMBUS)), ['backend.host']);
});

// What desktop/src/scan_driver.py reads from `def __init__(self, port, address=1, label=None)`:
// no declared types, so each is a guess the person may change.
const UNTYPED = [
  { name: 'port', required: true, type: 'str', type_unknown: true },
  { name: 'address', required: false, default: 1, type: 'int', type_unknown: true },
  { name: 'label', required: false, default: null, type: 'str', type_unknown: true },
];

test("a driver's own constructor: values follow the type chosen, and only required ones are missing", () => {
  const form = toForm(UNTYPED);
  assert.deepEqual(emptyFields(UNTYPED, form), ['port'], 'label defaults to None, so leaving it empty is fine');
  form.port = '7';
  form.address = '3';
  assert.deepEqual(fromForm(UNTYPED, form), { port: '7', address: 3 });
  // The person says port is a number after all.
  const chosen = UNTYPED.map(d => (d.name === 'port' ? { ...d, type: 'int' } : d));
  assert.deepEqual(fromForm(chosen, form), { port: 7, address: 3 });
});
