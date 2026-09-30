// Run with: node --experimental-strip-types --test frontend/src/hubCatalog.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { inScope, ownerLabel, templateFit, uniqueName, uniqueNames, unionPackages } from './hubCatalog.ts';

test('public and private hub split rows by visibility; old Hubs send none and are public', () => {
  assert.equal(inScope({}, 'public'), true);
  assert.equal(inScope({ visibility: 'public' }, 'private'), false);
  assert.equal(inScope({ visibility: 'private' }, 'private'), true);
  assert.equal(inScope({ visibility: 'org' }, 'public'), false);
  assert.equal(ownerLabel({ visibility: 'org', organizations: { name: 'Hein Lab' } }), 'Hein Lab');
  assert.equal(ownerLabel({ visibility: 'private' }), 'Only you');
  assert.equal(ownerLabel({ visibility: 'public' }), null);
});

test('a platform\'s drivers get distinct deck names, clear of the deck\'s own', () => {
  assert.equal(uniqueName('SF10 Pump', []), 'sf10_pump');
  assert.equal(uniqueName('2-axis stage', []), 'device_2_axis_stage');
  assert.deepEqual(uniqueNames(['Pump', 'Pump', 'Balance'], ['pump']), ['pump_2', 'pump_3', 'balance']);
});

test('a template fits a deck by the instrument names its steps call; switched-off ones do not count', () => {
  const deck = { instruments: [
    { name: 'pump', import: 'p', class: 'P' },
    { name: 'balance', import: 'b', class: 'B', enabled: false },
  ] };
  assert.deepEqual(templateFit({ instruments: ['pump'] }, deck), { missing: [], fits: true });
  assert.deepEqual(templateFit({ instruments: ['pump', 'balance', 'hplc'] }, deck), { missing: ['balance', 'hplc'], fits: false });
  assert.equal(templateFit({ instruments: [] }, null).fits, true);
});

test('packages are merged once each, in order', () => {
  assert.deepEqual(unionPackages(['a', 'b'], ['b', 'c'], ['']), ['a', 'b', 'c']);
});
