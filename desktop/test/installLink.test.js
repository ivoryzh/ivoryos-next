'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInstallLink, InstallLinkError, MAX_IDS } = require('../src/installLink');

const link = (query) => parseInstallLink(new URL(`ivoryos://install?${query}`));

test('a Hub link names ids: drivers keep order and repeats, the rest are de-duplicated', () => {
    assert.deepEqual(link('modules=4,7,4&plugins=3,3&templates=9&optimizers=ax-platform,baybe,ax'), {
        platform: null, modules: [4, 7, 4], plugins: [3], templates: [9], optimizers: ['ax', 'baybe'],
    });
    assert.deepEqual(link('platform=12'), { platform: 12, modules: [], plugins: [], templates: [], optimizers: [] });
    assert.deepEqual(link('platform=12&optimizers=nimo').optimizers, ['nimo']);
});

test('a link that is not a Hub id link is left to the manifest path', () => {
    assert.equal(link('manifest=https://example.com/deck.json'), null);
});

test('a deck carried in the link itself is refused', () => {
    // Any page could build one naming any package or importable class (see installLink.js).
    assert.throws(() => link('deck=eyJmb3JtYXQiOiJpdm9yeW9zLWRlY2svMSJ9'), InstallLinkError);
    assert.throws(() => link('deck=x&modules=4'), /no longer accepts/);
});

test('anything but plain Hub ids is refused', () => {
    assert.throws(() => link('modules=4,pumps'), /not Hub ids/);
    assert.throws(() => link('modules=-1'), /not Hub ids/);
    assert.throws(() => link('modules=0'), /not Hub ids/);
    assert.throws(() => link('plugins=1.5'), /not Hub ids/);
    assert.throws(() => link('optimizers=evil-package'), /not an optimizer/);
    assert.throws(() => link('platform=1,2'), /one platform/);
    assert.throws(() => link('platform=1&modules=2'), /not both/);
    assert.throws(() => link('modules='), /does not say what to install/);
    assert.throws(() => link('optimizers=ax'), /does not say what to install/);
    const tooMany = Array.from({ length: MAX_IDS + 1 }, (_, i) => i + 1).join(',');
    assert.throws(() => link(`modules=${tooMany}`), /more than/);
});
