'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateManifest, mergeIntoDeck, packageKey, isPinned, ManifestError } = require('../src/manifest');

const pump = { name: 'pump_1', import: 'vendor_pumps', class: 'SyringePump', args: { port: 'COM3' } };

test('packageKey treats spellings and pins of one package as the same package', () => {
    assert.equal(packageKey('Vendor_Pumps==1.2'), packageKey('vendor-pumps>=1.3'));
    assert.equal(packageKey('vendor.pumps[serial]'), 'vendor-pumps');
    assert.equal(packageKey('vendor-pumps @ git+https://github.com/x/pumps@abc1234'), 'vendor-pumps');
    assert.equal(packageKey('git+https://github.com/x/pumps@abc1234'), packageKey('git+https://github.com/x/pumps@def5678'));
});

test('isPinned only accepts requirements that name one version of the code', () => {
    assert.ok(isPinned('vendor-pumps==1.2.0'));
    assert.ok(isPinned('git+https://github.com/x/pumps@3f2a9c1'));
    assert.ok(isPinned('https://x.org/p-1.0-py3-none-any.whl#sha256=' + 'a'.repeat(64)));
    assert.ok(!isPinned('vendor-pumps'));
    assert.ok(!isPinned('vendor-pumps>=1.2'));
    assert.ok(!isPinned('git+https://github.com/x/pumps'));
    assert.ok(!isPinned('git+https://github.com/x/pumps@main'));
});

test('validateManifest rejects what could not be a deck, and pip options posing as packages', () => {
    assert.throws(() => validateManifest('{nope'), ManifestError);
    assert.throws(() => validateManifest({ format: 'other/2' }), /Unsupported format/);
    assert.throws(() => validateManifest({ instruments: [{ ...pump, name: '1pump' }] }), /needs a 'name'/);
    assert.throws(() => validateManifest({ instruments: [{ ...pump, name: 'class' }] }), /needs a 'name'/);
    assert.throws(() => validateManifest({ instruments: [pump, pump] }), /Two instruments/);
    assert.throws(() => validateManifest({ instruments: [{ name: 'x', import: 'm' }] }), /needs 'import'/);
    assert.throws(() => validateManifest({ packages: ['--index-url=https://evil.example/simple'] }), /pip option/);
    assert.throws(() => validateManifest({ packages: ['-e /tmp/x'] }), /pip option/);
});

test('unpinned packages and downloaded paths come back as warnings', () => {
    const { manifest, warnings } = validateManifest({ packages: ['vendor-pumps', 'hplc-sdk==2.0'], paths: ['../../etc'], instruments: [pump] });
    assert.equal(manifest.paths, undefined);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /vendor-pumps/);
    assert.doesNotMatch(warnings[0], /hplc-sdk/);
    assert.equal(validateManifest({ paths: ['drivers'] }, { allowPaths: true }).manifest.paths[0], 'drivers');
});

test('mergeIntoDeck replaces by name and by package, and keeps everything else', () => {
    const deck = {
        format: 'ivoryos-deck/1', name: 'Bench 3', packages: ['vendor-pumps==1.0', 'balance-sdk==3.1'],
        instruments: [pump, { name: 'balance', import: 'balance_sdk', class: 'Balance' }],
    };
    const { deck: next, added, replaced } = mergeIntoDeck(deck, {
        packages: ['Vendor_Pumps==1.1', 'hplc-sdk==2.0'],
        instruments: [{ ...pump, args: { port: 'COM4' } }, { name: 'hplc', import: 'hplc_sdk', class: 'HPLC' }],
    });
    assert.equal(next.name, 'Bench 3');
    assert.deepEqual(next.packages, ['Vendor_Pumps==1.1', 'balance-sdk==3.1', 'hplc-sdk==2.0']);
    assert.deepEqual(next.instruments.map((i) => i.name), ['pump_1', 'balance', 'hplc']);
    assert.equal(next.instruments[0].args.port, 'COM4');
    assert.deepEqual(added, ['hplc']);
    assert.deepEqual(replaced, ['pump_1']);
});

test('plugins are validated as "module:attribute" references and merged without duplicates', () => {
    assert.throws(() => validateManifest({ plugins: ['not a ref'] }), /not a plugin reference/);
    assert.throws(() => validateManifest({ plugins: ['pkg.mod:attr; import os'] }), /not a plugin reference/);
    assert.throws(() => validateManifest({ plugins: 'pkg.mod:plugin' }), /must be a list/);
    const { manifest } = validateManifest({ packages: ['view-kit==1.0'], plugins: ['view_kit.plugin:plugin'] });
    const deck = { name: 'Bench', packages: [], instruments: [pump], plugins: ['other.plugin:plugin'] };
    const first = mergeIntoDeck(deck, manifest);
    assert.deepEqual(first.deck.plugins, ['other.plugin:plugin', 'view_kit.plugin:plugin']);
    assert.deepEqual(first.pluginsAdded, ['view_kit.plugin:plugin']);
    const again = mergeIntoDeck(first.deck, manifest);
    assert.deepEqual(again.deck.plugins, first.deck.plugins);
    assert.deepEqual(again.pluginsAdded, []);
    // A deck without plugins does not gain an empty list.
    assert.equal('plugins' in mergeIntoDeck({ instruments: [] }, { instruments: [pump] }).deck, false);
});
