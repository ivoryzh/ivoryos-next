'use strict';
// The Bayesian optimizer backends IvoryOS supports, and the releases tested against its adapters
// (edge_server/ivoryos_edge/optimizer/). A deck chooses them in its Settings; the choice is
// written to the deck's `packages` as `<package>==<version>`, so the deck file carries it and
// installs it on another computer like any driver package. The first version listed is the one
// offered by default.
//
// "Tested" means tests/manual/optimizer_smoke.py passed in a fresh Python 3.11 environment with
// all three installed together and CPU-only PyTorch, as the launcher installs them: seeded with
// existing data, random start, then model-based rounds through suggest/observe. Re-run it before
// adding a version. BayBE before 0.14 is left out on purpose: the adapter's
// NumericalTarget(minimize=...) does not exist there.
//
// Pure, so it is tested without Electron (test/optimizers.test.js).

const { packageKey, isPinned } = require('./manifest');

const OPTIMIZERS = [
    { id: 'ax', name: 'Ax', package: 'ax-platform', versions: ['1.3.1', '1.2.4', '1.1.2'] },
    { id: 'baybe', name: 'BayBE', package: 'baybe', versions: ['0.15.0', '0.14.3'] },
    { id: 'nimo', name: 'NIMO', package: 'nimo', versions: ['2.1.5', '2.1.0', '2.0.5'] },
];

const byKey = new Map(OPTIMIZERS.map((o) => [packageKey(o.package), o]));

/** The pinned version in a requirement (`baybe==0.15.0`), or null for any other form. */
function pinnedVersion(requirement) {
    const m = /==\s*([^\s,;]+)\s*$/.exec(String(requirement || '').trim());
    return m && isPinned(requirement) ? m[1] : null;
}

/**
 * What a deck has chosen, per optimizer id: a version, 'any' for an unpinned entry (a deck built
 * by the Hub lists `baybe`), or null when the deck does not list it.
 */
function selectionOf(packages = []) {
    const out = Object.fromEntries(OPTIMIZERS.map((o) => [o.id, null]));
    for (const req of packages) {
        const opt = byKey.get(packageKey(req));
        if (opt) out[opt.id] = pinnedVersion(req) || 'any';
    }
    return out;
}

/**
 * A deck's package list with its optimizers replaced by `selection` ({id: version | 'any' |
 * null}). Every other package, and its order, is kept; a version IvoryOS has not tested is
 * refused rather than written.
 */
function withSelection(packages = [], selection = {}) {
    const kept = packages.filter((req) => !byKey.has(packageKey(req)));
    const current = selectionOf(packages);
    for (const opt of OPTIMIZERS) {
        const want = selection[opt.id] === undefined ? current[opt.id] : selection[opt.id];
        if (!want) continue;
        if (want === 'any') {
            // Left as the deck had it (only reachable by not changing an unpinned entry).
            const existing = packages.find((req) => packageKey(req) === packageKey(opt.package));
            kept.push(existing || opt.package);
        } else if (opt.versions.includes(want)) {
            kept.push(`${opt.package}==${want}`);
        } else {
            throw new Error(`${opt.name} ${want} is not a version IvoryOS has tested (${opt.versions.join(', ')}).`);
        }
    }
    return kept;
}

module.exports = { OPTIMIZERS, selectionOf, withSelection, pinnedVersion };
