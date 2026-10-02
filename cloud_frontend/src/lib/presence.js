'use strict';
// Whether a device is there, without asking it to say so every five seconds.
//
// The edge used to publish a status heartbeat every 5s and the daemon called a device offline
// after 15s of silence. On a metered broker that heartbeat was nearly all of the bill (about
// 17,000 messages per device per day) to carry a fact MQTT already tracks: the broker knows when
// a client is gone (keep-alive) and says so with the client's Last Will. So presence now rests on
// what every MQTT broker does, local or AWS:
//
//   - the edge publishes a retained status when it connects and whenever `busy` changes;
//   - the broker publishes the edge's Last Will ({online: false}) when it drops;
//   - a slow heartbeat remains as a backstop, at the interval the edge states in its status
//     (`interval`, seconds), and a device is stale after three of those.
//
// One gap is left by the Last Will not being retained (AWS IoT refuses a retained will): a device
// that died while this daemon was not connected still reads "online" in the retained status the
// broker replays. So a *retained* "online" is only the broker's memory, not proof: it is held as
// unconfirmed, the device is pinged, and it counts as online once a live status arrives. An edge
// too old to answer a ping still sends its 5s heartbeat, which is a live status too.
//
// Pure functions over a small state object, so the rules are tested without a broker.

const DEFAULT_STALE_MS = 15000; // an edge that states no interval is the old 5s heartbeat
const PING_WAIT_MS = 10000;

/** How long this device may be silent before it is called offline. */
function staleAfterMs(payload) {
    const seconds = Number(payload && payload.interval);
    return Number.isFinite(seconds) && seconds > 0 ? Math.max(DEFAULT_STALE_MS, Math.round(seconds * 3000)) : DEFAULT_STALE_MS;
}

/**
 * The device's state after a status message.
 * @param {object|undefined} prev   its state before
 * @param {object} payload          {online, busy, session, paused, interval}
 * @param {{retained: boolean, now: number}} how
 */
function nextState(prev, payload, { retained, now }) {
    if (payload && payload.paused) {
        return { online: false, paused: true, session: null, busy: false, at: now, idleSince: null, staleAfter: DEFAULT_STALE_MS, confirmed: true, pingedAt: null, pingNonce: null };
    }
    const online = !!(payload && payload.online);
    // The answer to the ping this daemon sent: live by construction, whatever the retain flag
    // says. (Brokers differ on that flag for a live copy of a retained publish; a nonce does not
    // depend on it.) Used once: a later replay of the same message proves nothing.
    const answered = !!(payload && payload.pong && prev && prev.pingNonce && payload.pong === prev.pingNonce);
    const confirmed = !online || !retained || answered;
    // An edge too old to report `busy` is never assumed idle, or its tasks could be failed as
    // lost while they wait in its queue.
    const idle = online && payload && 'busy' in payload && !payload.busy;
    return {
        online,
        paused: false,
        session: (payload && payload.session) || null,
        busy: !!(payload && payload.busy),
        at: now,
        // When it last became idle, for spotting a task that was sent and never arrived.
        idleSince: idle ? (prev && prev.idleSince) || now : null,
        staleAfter: staleAfterMs(payload),
        // A retained "online" is the broker's memory of the last thing the edge said.
        confirmed,
        // Still waiting on a ping already sent for this same memory: do not ask (or wait) again.
        // A ping answered long ago must not carry over, or the next replay would look unanswered.
        pingedAt: !confirmed && prev && prev.online && !prev.confirmed ? prev.pingedAt || null : null,
        pingNonce: !confirmed && prev && prev.online && !prev.confirmed ? prev.pingNonce || null : null,
    };
}

/**
 * Whether this status is from an edge that can go quiet and has not been asked to (`quiet:
 * false`). It keeps a 5-second heartbeat until Cloud pings it, because an older Cloud needs one;
 * the ping is how it learns this Cloud does not. An edge from before the change sends no `quiet`
 * at all and is left to its heartbeat.
 */
function asksForQuiet(payload) {
    return !!payload && !!payload.online && payload.quiet === false;
}

/** Whether to ask this device to speak up: an unconfirmed "online" not yet pinged. */
function needsPing(state) {
    return !!state && state.online && !state.confirmed && !state.pingedAt;
}

/** Whether the device has gone quiet for too long, or never answered its ping. */
function hasLapsed(state, now) {
    if (!state || !state.online) return false;
    if (!state.confirmed) return !!state.pingedAt && now - state.pingedAt > PING_WAIT_MS;
    return now - state.at > state.staleAfter;
}

/** Whether tasks and decisions may be sent to it now. */
function isUp(state, now) {
    return !!state && state.online && state.confirmed && now - state.at <= state.staleAfter;
}

/** Why a task for this device must wait, or null when it may go now. */
function notReady(state, now) {
    if (!state) return 'no status yet';
    if (!state.online) return state.paused ? 'paused' : 'offline';
    if (!state.confirmed) return 'not confirmed since reconnecting';
    if (now - state.at > state.staleAfter) return 'status is stale';
    if (state.busy) return 'busy';
    return null;
}

module.exports = { DEFAULT_STALE_MS, PING_WAIT_MS, staleAfterMs, nextState, needsPing, asksForQuiet, hasLapsed, isUp, notReady };
