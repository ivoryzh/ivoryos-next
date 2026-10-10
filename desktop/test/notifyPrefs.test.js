'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeNotifications, changeNotifications, shouldAnnounce, isUrgent, eventOf } = require('../src/notifyPrefs');

test('nothing stored means the defaults: what needs you and finished runs, not stopped ones', () => {
    const p = normalizeNotifications(undefined);
    assert.deepEqual(p.events, { input: true, failed: true, crashed: true, finished: true, stopped: false, ready: true, installed: true });
    assert.equal(p.minRunMinutes, 5);
    assert.equal(p.sound, true);
    // Garbage is replaced, unknown keys dropped, a negative threshold refused.
    const odd = normalizeNotifications({ events: { input: 'yes', bogus: true, stopped: true }, minRunMinutes: -3, sound: 0 });
    assert.equal(odd.events.input, true);
    assert.equal(odd.events.stopped, true);
    assert.equal('bogus' in odd.events, false);
    assert.equal(odd.minRunMinutes, 5);
});

test('a change touches only what it names', () => {
    const p = changeNotifications(undefined, { events: { finished: false } });
    assert.equal(p.events.finished, false);
    assert.equal(p.events.input, true);
    const q = changeNotifications(p, { minRunMinutes: 0, sound: false });
    assert.equal(q.events.finished, false);
    assert.equal(q.minRunMinutes, 0);
    assert.equal(q.sound, false);
});

test('a finished run is announced only when it was long enough', () => {
    const prefs = normalizeNotifications({});
    const run = (s) => ({ kind: 'finished', duration_s: s });
    assert.equal(shouldAnnounce(prefs, run(30)), false);      // trying a workflow is not news
    assert.equal(shouldAnnounce(prefs, run(5 * 60)), true);
    assert.equal(shouldAnnounce({ minRunMinutes: 0 }, run(2)), true);
    // A stopped run has no threshold, but is off unless chosen.
    assert.equal(shouldAnnounce(prefs, { kind: 'stopped', duration_s: 1 }), false);
    assert.equal(shouldAnnounce({ events: { stopped: true } }, { kind: 'stopped', duration_s: 1 }), true);
});

test('a switch off, or a muted deck, silences a moment; unknown moments are never announced', () => {
    const input = { kind: 'input' };
    assert.equal(shouldAnnounce({}, input), true);
    assert.equal(shouldAnnounce({ events: { input: false } }, input), false);
    assert.equal(shouldAnnounce({}, input, { muted: true }), false);
    assert.equal(shouldAnnounce({}, { kind: 'something-new' }), false);
    assert.equal(eventOf({ kind: 'error' }), 'failed');
    assert.equal(eventOf({ kind: 'start-failed' }), 'ready');
});

test('only what needs a person is urgent', () => {
    assert.equal(isUrgent({ kind: 'input' }), true);
    assert.equal(isUrgent({ kind: 'error' }), true);
    assert.equal(isUrgent({ kind: 'crashed' }), true);
    assert.equal(isUrgent({ kind: 'finished' }), false);
    assert.equal(isUrgent({ kind: 'ready' }), false);
});
