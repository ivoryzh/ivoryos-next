'use strict';
// Edits the launcher makes to a deck file: change an instrument (its COM port, say), rename it,
// switch it off, remove it. Adding goes through manifest.js's mergeIntoDeck, the same path an
// install from the Hub takes. Pure functions over the parsed deck; the caller writes the file.

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

class DeckEditError extends Error {}

function instrumentsOf(deck) {
    return Array.isArray(deck && deck.instruments) ? deck.instruments : [];
}

/**
 * Replace the instrument called `name` with `entry`. `entry.name` may differ, which renames it;
 * the new name must be free. Workflows refer to instruments by name, so the caller should say
 * that a rename breaks the saved workflows that use the old one.
 */
function updateInstrument(deck, name, entry) {
    const list = instrumentsOf(deck);
    const at = list.findIndex((i) => i && i.name === name);
    if (at === -1) throw new DeckEditError(`There is no instrument called '${name}' on this deck.`);
    if (!entry || !NAME_RE.test(entry.name || '')) {
        throw new DeckEditError('Instrument names use letters, digits and underscores, and start with a letter.');
    }
    if (entry.name !== name && list.some((i) => i && i.name === entry.name)) {
        throw new DeckEditError(`There is already an instrument called '${entry.name}'.`);
    }
    const instruments = list.slice();
    instruments[at] = entry;
    return { ...deck, instruments };
}

function removeInstrument(deck, name) {
    return { ...deck, instruments: instrumentsOf(deck).filter((i) => !i || i.name !== name) };
}

/** Keep an instrument in the deck but skip it at startup: an unplugged device, a spare. */
function setInstrumentEnabled(deck, name, enabled) {
    return {
        ...deck,
        instruments: instrumentsOf(deck).map((i) => {
            if (!i || i.name !== name) return i;
            const next = { ...i };
            if (enabled) delete next.enabled; else next.enabled = false;
            return next;
        }),
    };
}

/** A name not yet used on the deck, from a suggestion: `pump` -> `pump`, `pump_2`, ... */
function freeName(deck, suggestion) {
    let base = String(suggestion || 'device').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) base = 'device';
    if (!/^[a-z]/.test(base)) base = `device_${base}`;
    const used = new Set(instrumentsOf(deck).map((i) => i && i.name));
    if (!used.has(base)) return base;
    let n = 2;
    while (used.has(`${base}_${n}`)) n += 1;
    return `${base}_${n}`;
}

module.exports = { DeckEditError, updateInstrument, removeInstrument, setInstrumentEnabled, freeName };
