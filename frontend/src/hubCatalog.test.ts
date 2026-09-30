// Run with: node --experimental-strip-types --test frontend/src/hubCatalog.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { inScope, ownerLabel, preferV2, templateFit, uniqueName, uniqueNames, unionPackages } from './hubCatalog.ts';

test('a plugin published as v1 and v2 shows once, as v2; a v1-only plugin stays', () => {
  const rows = [
    { id: 2, name: 'Color Matcher Visualization Plugin', pip_name: 'colour-match-sdl', plugin_api: 'v1' as const },
    { id: 5, name: 'Color Matcher Visualization Plugin', pip_name: 'colour-match-sdl>=0.1.7', plugin_api: 'v2' as const },
    { id: 4, name: 'Education Plugin Barista', pip_name: 'https://github.com/ivoryos-ai/ivoryos-barista.git', plugin_api: 'v1' as const },
    { id: 7, name: 'Same name, other package', pip_name: 'another-package', plugin_api: 'v1' as const },
    { id: 8, name: 'SAME NAME, OTHER PACKAGE', pip_name: 'yet_another', plugin_api: 'v2' as const },
  ];
  assert.deepEqual(preferV2(rows).map(r => r.id), [5, 4, 7, 8]);
  // Private v2, public v1: filtered to the public hub first, the v1 row must still show there.
  assert.deepEqual(preferV2(rows.filter(r => r.id !== 5)).map(r => r.id), [2, 4, 7, 8]);
});

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
