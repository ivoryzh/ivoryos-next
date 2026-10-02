// Run with: node --experimental-strip-types --test frontend/src/hubCatalog.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { inScope, ownerLabel, preferV2, repointInstruments, templateFit, uniqueName, uniqueNames, unionPackages } from './hubCatalog.ts';

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
  assert.deepEqual(templateFit({ instruments: ['pump'] }, deck), { missing: [], sameDriver: {}, fits: true });
  assert.deepEqual(templateFit({ instruments: ['pump', 'balance', 'hplc'] }, deck), { missing: ['balance', 'hplc'], sameDriver: { balance: [], hplc: [] }, fits: false });
  assert.equal(templateFit({ instruments: [] }, null).fits, true);
});

test('a missing name whose Hub module is on the deck under another name is offered as the same driver', () => {
  const deck = { instruments: [
    { name: 'syringe_pump', import: 'p', class: 'P', hub: { moduleId: 12, name: 'SF10 Pump', init_args: [], connection: [] } },
    { name: 'scale', import: 'b', class: 'B', hub: { moduleId: 7, name: 'Balance', init_args: [], connection: [] } },
    { name: 'hplc', import: 'h', class: 'H' },
  ] };
  const fit = templateFit({ instruments: ['pump', 'hplc'], module_ids: [12, 99] }, deck);
  assert.deepEqual(fit.missing, ['pump']);
  // Only instruments of the template's modules, and never one a template name already claims.
  assert.deepEqual(fit.sameDriver, { pump: ['syringe_pump'] });
});

test('repointing renames only the instrument field of steps, in every phase', () => {
  const body = {
    name: 'w',
    prep: [{ instrument: 'pump', action: 'prime', args: { ml: 1 } }],
    script: [{ instrument: 'pump', action: 'dispense', args: { ml: '#v' } }, { instrument: 'Flow Control', action: 'Sleep', args: {} }],
    cleanup: [{ instrument: 'hplc', action: 'rinse', args: {} }],
  };
  const out = repointInstruments(body, { pump: 'syringe_pump', hplc: '' });
  assert.deepEqual(out.prep, [{ instrument: 'syringe_pump', action: 'prime', args: { ml: 1 } }]);
  assert.deepEqual(out.script, [{ instrument: 'syringe_pump', action: 'dispense', args: { ml: '#v' } }, { instrument: 'Flow Control', action: 'Sleep', args: {} }]);
  assert.deepEqual(out.cleanup, body.cleanup);
  assert.equal(repointInstruments(body, {}), body);
});

test('packages are merged once each, in order', () => {
  assert.deepEqual(unionPackages(['a', 'b'], ['b', 'c'], ['']), ['a', 'b', 'c']);
});
