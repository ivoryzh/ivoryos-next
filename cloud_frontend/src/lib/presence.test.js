'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_STALE_MS, PING_WAIT_MS, staleAfterMs, nextState, needsPing, asksForQuiet, hasLapsed, isUp, notReady } = require('./presence.js');

const T = 1_000_000;

test('an edge states how often it speaks; one that does not is the old 5s heartbeat', () => {
    assert.equal(staleAfterMs({ online: true }), DEFAULT_STALE_MS);
    assert.equal(staleAfterMs({ online: true, interval: 300 }), 900_000);
    assert.equal(staleAfterMs({ online: true, interval: 2 }), DEFAULT_STALE_MS, 'never tighter than before');
    assert.equal(staleAfterMs({ online: true, interval: 'soon' }), DEFAULT_STALE_MS);
});

test('a live status is proof; tasks may go once it is idle', () => {
    const s = nextState(undefined, { online: true, busy: false, session: 'a', interval: 300 }, { retained: false, now: T });
    assert.equal(s.confirmed, true);
    assert.equal(notReady(s, T + 1000), null);
    assert.equal(isUp(s, T + 899_000), true, 'silent for almost three intervals is still up');
    assert.equal(notReady(s, T + 901_000), 'status is stale');
    assert.equal(hasLapsed(s, T + 901_000), true);
    assert.equal(notReady(nextState(s, { online: true, busy: true, interval: 300 }, { retained: false, now: T }), T), 'busy');
});

test('a retained "online" is only the broker\'s memory: unconfirmed, pinged, then decided', () => {
    // What the broker replays when this daemon (re)subscribes. The device may have died since.
    let s = nextState(undefined, { online: true, busy: false, session: 'a', interval: 300 }, { retained: true, now: T });
    assert.equal(s.confirmed, false);
    assert.equal(notReady(s, T), 'not confirmed since reconnecting', 'nothing is sent on a memory');
    assert.equal(isUp(s, T), false);
    assert.equal(needsPing(s), true);
    s = { ...s, pingedAt: T };
    assert.equal(needsPing(s), false, 'asked once');
    assert.equal(hasLapsed(s, T + PING_WAIT_MS - 1), false);
    assert.equal(hasLapsed(s, T + PING_WAIT_MS + 1), true, 'no answer: it is gone');
    // It answers (or an old edge's next heartbeat arrives): a live status confirms it.
    const answered = nextState(s, { online: true, busy: false, session: 'a', interval: 300 }, { retained: false, now: T + 2000 });
    assert.equal(answered.confirmed, true);
    assert.equal(notReady(answered, T + 2000), null);
    assert.equal(hasLapsed(answered, T + PING_WAIT_MS + 1), false);
});

test('a second replay after the daemon reconnects starts a fresh question', () => {
    // Confirmed long ago, pinged back then. The daemon's own connection drops and comes back;
    // the broker replays the retained status again.
    const longAgo = { ...nextState(undefined, { online: true, busy: false, interval: 300 }, { retained: false, now: T }), pingedAt: T - 60_000 };
    const replay = nextState(longAgo, { online: true, busy: false, interval: 300 }, { retained: true, now: T + 100_000 });
    assert.equal(replay.pingedAt, null);
    assert.equal(needsPing(replay), true);
    assert.equal(hasLapsed(replay, T + 100_000), false, 'not judged by a ping from another era');
    // The same replay delivered twice while one ping is out keeps that one ping.
    const waiting = { ...replay, pingedAt: T + 100_000 };
    const again = nextState(waiting, { online: true, busy: false, interval: 300 }, { retained: true, now: T + 100_500 });
    assert.equal(again.pingedAt, T + 100_000);
    assert.equal(needsPing(again), false);
});

test('the last will, a pause and "offline" need no confirming', () => {
    const live = nextState(undefined, { online: true, busy: false }, { retained: false, now: T });
    const will = nextState(live, { online: false }, { retained: false, now: T + 5 });
    assert.equal(notReady(will, T + 5), 'offline');
    assert.equal(hasLapsed(will, T + 10_000_000), false, 'already offline');
    const paused = nextState(live, { online: false, paused: true }, { retained: true, now: T + 5 });
    assert.equal(notReady(paused, T + 5), 'paused');
    assert.equal(needsPing(paused), false);
});

test('idle time survives heartbeats and restarts when busy clears, for the lost-task check', () => {
    let s = nextState(undefined, { online: true, busy: false }, { retained: false, now: T });
    assert.equal(s.idleSince, T);
    s = nextState(s, { online: true, busy: false }, { retained: false, now: T + 5000 });
    assert.equal(s.idleSince, T, 'still the same idle stretch');
    s = nextState(s, { online: true, busy: true }, { retained: false, now: T + 6000 });
    assert.equal(s.idleSince, null);
    s = nextState(s, { online: true }, { retained: false, now: T + 7000 });
    assert.equal(s.idleSince, null, 'an edge that does not report busy is never assumed idle');
});

test('an edge that can go quiet is asked to; an older one is left to its heartbeat', () => {
    assert.equal(asksForQuiet({ online: true, busy: false, quiet: false }), true);
    assert.equal(asksForQuiet({ online: true, busy: false, quiet: true, interval: 300 }), false, 'already quiet');
    assert.equal(asksForQuiet({ online: true, busy: false }), false, 'from before the change: it cannot answer');
    assert.equal(asksForQuiet({ online: false, quiet: false }), false);
    // Until it switches it states no interval, so it is judged like the 5s heartbeat it still sends.
    assert.equal(staleAfterMs({ online: true, quiet: false }), DEFAULT_STALE_MS);
});

test('the answer to our own ping is proof, whatever the retain flag says', () => {
    // A broker that marks even a live copy of a retained publish as retained must not leave a
    // live device unconfirmed: the nonce it echoes is what counts.
    let s = nextState(undefined, { online: true, busy: false, quiet: true, interval: 300 }, { retained: true, now: T });
    s = { ...s, pingedAt: T, pingNonce: 'n1' };
    const wrong = nextState(s, { online: true, busy: false, pong: 'other' }, { retained: true, now: T + 50 });
    assert.equal(wrong.confirmed, false, 'someone else\'s nonce proves nothing');
    assert.equal(wrong.pingNonce, 'n1', 'still waiting on ours');
    const pong = nextState(s, { online: true, busy: false, pong: 'n1', interval: 300 }, { retained: true, now: T + 50 });
    assert.equal(pong.confirmed, true);
    assert.equal(notReady(pong, T + 50), null);
    assert.equal(pong.pingNonce, null, 'used once');
    // The broker replays that same answer later (this daemon reconnected): not proof any more.
    const replay = nextState(pong, { online: true, busy: false, pong: 'n1', interval: 300 }, { retained: true, now: T + 60_000 });
    assert.equal(replay.confirmed, false);
    assert.equal(needsPing(replay), true);
});
