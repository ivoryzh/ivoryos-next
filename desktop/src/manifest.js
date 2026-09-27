'use strict';
// Install manifests: what the Hub hands the desktop app to add drivers to a deck.
//
// A manifest is a deck file (edge_server/ivoryos_edge/deck_config.py documents the format) that
// describes only what to add. Installing one means: pip-install its `packages` into the edge's
// Python, then merge its `instruments` into the local deck. One format for both, so a deck file
// saved by one lab is also something another lab can install.
//
// Everything here is pure and synchronous, so it is tested without Electron or Python.

const DECK_FORMAT = 'ivoryos-deck/1';
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const PY_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
    'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
    'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while',
    'with', 'yield']);

class ManifestError extends Error {}

/**
 * The key two requirements are "the same package" under. `vendor-pumps==1.2` and
 * `Vendor_Pumps>=1.3` are one package (PEP 503 normalisation), so installing the second replaces
 * the first in the deck rather than listing both. A VCS or URL requirement is keyed by its URL
 * without the ref, so moving a git pin from one commit to another replaces it too.
 */
function packageKey(requirement) {
    const req = String(requirement).trim();
    const named = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*@\s*/.exec(req);
    if (named) return named[1].toLowerCase().replace(/[-_.]+/g, '-');
    if (/^[a-z]+\+|^[a-z]+:\/\//i.test(req)) return req.replace(/@[^@/]*$/, '').replace(/#.*$/, '');
    const bare = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(req);
    return bare ? bare[1].toLowerCase().replace(/[-_.]+/g, '-') : req;
}

/**
 * Whether a requirement names exactly one version of the code. An unpinned one installs whatever
 * the index or branch holds at that moment, which for code that drives lab hardware is worth
 * telling the person before they accept it.
 */
function isPinned(requirement) {
    const req = String(requirement).trim();
    if (/==\s*[^,*\s]+$/.test(req)) return true;
    if (/^git\+|@\s*git\+/.test(req)) return /@[0-9a-f]{7,40}(#.*)?$/i.test(req);
    if (/\.(whl|tar\.gz|zip)(#sha256=[0-9a-f]{64})?$/i.test(req)) return /#sha256=/i.test(req);
    return false;
}

/** Check a manifest's shape. Returns {manifest, warnings}; throws ManifestError when unusable. */
function validateManifest(raw, { allowPaths = false } = {}) {
    let manifest = raw;
    if (typeof raw === 'string') {
        try { manifest = JSON.parse(raw); } catch (e) { throw new ManifestError(`Not valid JSON: ${e.message}`); }
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new ManifestError('A manifest must be a JSON object');
    }
    const fmt = manifest.format || DECK_FORMAT;
    if (fmt !== DECK_FORMAT) throw new ManifestError(`Unsupported format '${fmt}' (expected '${DECK_FORMAT}')`);

    const packages = manifest.packages || [];
    const instruments = manifest.instruments || [];
    if (!Array.isArray(packages) || packages.some((p) => typeof p !== 'string' || !p.trim())) {
        throw new ManifestError("'packages' must be a list of pip requirements");
    }
    if (!Array.isArray(instruments)) throw new ManifestError("'instruments' must be a list");
    // A pip option smuggled in as a "requirement" (`--index-url evil`, `-e /path`) changes what
    // everything else installs from. A manifest names packages; it does not configure pip.
    const option = packages.find((p) => p.trim().startsWith('-'));
    if (option) throw new ManifestError(`'${option}' is a pip option, not a package`);

    const names = new Set();
    for (const [i, inst] of instruments.entries()) {
        const where = `instrument #${i + 1}`;
        if (!inst || typeof inst !== 'object') throw new ManifestError(`${where} is not an object`);
        if (typeof inst.name !== 'string' || !NAME_RE.test(inst.name) || PY_KEYWORDS.has(inst.name)) {
            throw new ManifestError(`${where} needs a 'name' made of letters, digits and underscores, starting with a letter`);
        }
        if (names.has(inst.name)) throw new ManifestError(`Two instruments are named '${inst.name}'`);
        names.add(inst.name);
        if (typeof inst.import !== 'string' || typeof inst.class !== 'string') {
            throw new ManifestError(`'${inst.name}' needs 'import' (a module path) and 'class'`);
        }
        if (inst.args !== undefined && (typeof inst.args !== 'object' || Array.isArray(inst.args))) {
            throw new ManifestError(`'${inst.name}': 'args' must be an object of keyword arguments`);
        }
    }

    const warnings = [];
    const unpinned = packages.filter((p) => !isPinned(p));
    if (unpinned.length) {
        warnings.push(`Not pinned to one version, so what installs can change later: ${unpinned.join(', ')}`);
    }
    // `paths` adds folders to the edge's import path, relative to the deck file. From a file the
    // person picked that is their own folder; from a download it would be a folder the sender
    // chose on this machine, so it is dropped rather than trusted.
    if (manifest.paths && !allowPaths) {
        warnings.push("Ignored 'paths': only a deck file opened from this computer may add import folders");
        manifest = { ...manifest, paths: undefined };
    }
    return { manifest, warnings };
}

/**
 * The deck after installing a manifest into it. Instruments are matched by name (the manifest's
 * version wins) and packages by `packageKey`; everything else in the deck is kept. Returns
 * {deck, added, replaced} so the confirmation can say what will change.
 */
function mergeIntoDeck(deck, manifest) {
    const base = deck && typeof deck === 'object' ? deck : {};
    const packages = [...(base.packages || [])];
    for (const req of manifest.packages || []) {
        const key = packageKey(req);
        const at = packages.findIndex((p) => packageKey(p) === key);
        if (at === -1) packages.push(req); else packages[at] = req;
    }

    const instruments = [...(base.instruments || [])];
    const added = [];
    const replaced = [];
    for (const inst of manifest.instruments || []) {
        const at = instruments.findIndex((i) => i && i.name === inst.name);
        if (at === -1) { instruments.push(inst); added.push(inst.name); } else { instruments[at] = inst; replaced.push(inst.name); }
    }

    const paths = [...(base.paths || [])];
    for (const p of manifest.paths || []) if (!paths.includes(p)) paths.push(p);

    return {
        deck: {
            format: DECK_FORMAT,
            name: base.name || manifest.name || 'My deck',
            ...base,
            packages,
            ...(paths.length ? { paths } : {}),
            instruments,
        },
        added,
        replaced,
    };
}

/** Human-readable summary lines for a confirmation dialog. */
function describeInstall(manifest, { added, replaced }) {
    const lines = [];
    if ((manifest.packages || []).length) lines.push(`Install: ${manifest.packages.join(', ')}`);
    if (added.length) lines.push(`Add to the deck: ${added.join(', ')}`);
    if (replaced.length) lines.push(`Replace on the deck: ${replaced.join(', ')}`);
    if (!lines.length) lines.push('Nothing to install or add.');
    return lines;
}

module.exports = { DECK_FORMAT, ManifestError, validateManifest, mergeIntoDeck, describeInstall, packageKey, isPinned };
