'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OPTIMIZERS, selectionOf, withSelection } = require('../src/optimizers');

test('every optimizer offers tested, pinned versions, newest first', () => {
    assert.deepEqual(OPTIMIZERS.map((o) => o.id), ['ax', 'baybe', 'nimo']);
    for (const o of OPTIMIZERS) {
        assert.ok(o.versions.length > 0);
        for (const v of o.versions) assert.match(v, /^\d+\.\d+\.\d+$/);
    }
    // BayBE before 0.14 lacks NumericalTarget(minimize=...), which the adapter uses.
    assert.ok(OPTIMIZERS.find((o) => o.id === 'baybe').versions.every((v) => !v.startsWith('0.13')));
});

test("a deck's choice is read from its packages, whatever the spelling", () => {
    assert.deepEqual(selectionOf(['pyserial==3.5', 'Ax_Platform==1.2.4', 'baybe']), { ax: '1.2.4', baybe: 'any', nimo: null });
    assert.deepEqual(selectionOf([]), { ax: null, baybe: null, nimo: null });
});

test('changing the choice replaces only the optimizers and keeps every other package', () => {
    const packages = ['pyserial==3.5', 'baybe', 'vendor-pumps==1.0'];
    assert.deepEqual(withSelection(packages, { ax: '1.3.1', baybe: '0.15.0' }),
        ['pyserial==3.5', 'vendor-pumps==1.0', 'ax-platform==1.3.1', 'baybe==0.15.0']);
    // Untouched entries stay as they were, including an unpinned one from the Hub.
    assert.deepEqual(withSelection(packages, { ax: '1.3.1' }), ['pyserial==3.5', 'vendor-pumps==1.0', 'ax-platform==1.3.1', 'baybe']);
    // null takes it out of the deck.
    assert.deepEqual(withSelection(['ax-platform==1.3.1', 'numpy'], { ax: null }), ['numpy']);
    assert.throws(() => withSelection([], { ax: '0.4.0' }), /not a version IvoryOS has tested/);
});
