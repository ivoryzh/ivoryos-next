'use strict';
// What a person chooses to be notified about (launcher Settings -> Notifications), and the one rule
// that decides whether a moment is announced. Kept apart from main.js so it is tested on its own
// (test/notifyPrefs.test.js).
//
// A moment comes from one of three places:
//   - the edge's `status.attention` (attention.js 'attention'): needs a person now, kind input|error
//   - the edge's `status.notices` (attention.js 'notice'): a run ended, kind finished|stopped
//   - the app itself: a deck crashed, became ready, could not start, an install ended
// Each maps to one switch below. "Needs you" moments are urgent: sound and a Dock bounce that keeps
// going until the app is looked at. The rest are quiet.

const EVENTS = {
    input: { group: 'needs', label: 'A run waits for your input', default: true },
    failed: { group: 'needs', label: 'A step failed and waits for retry, skip or stop', default: true },
    crashed: { group: 'needs', label: 'A deck stopped unexpectedly', default: true },
    finished: { group: 'done', label: 'A run finished', default: true },
    stopped: { group: 'done', label: 'A run was stopped or ended with an error', default: false },
    ready: { group: 'heads', label: 'A deck you started is ready, or could not start', default: true },
    installed: { group: 'heads', label: 'An install finished or failed', default: true },
};

const DEFAULT_MIN_RUN_MINUTES = 5;

/** Stored settings -> complete settings: every switch present, unknown keys dropped. */
function normalizeNotifications(stored) {
    const s = stored && typeof stored === 'object' ? stored : {};
    const events = {};
    for (const [key, spec] of Object.entries(EVENTS)) {
        events[key] = s.events && typeof s.events[key] === 'boolean' ? s.events[key] : spec.default;
    }
    const minutes = Number(s.minRunMinutes);
    return {
        events,
        // A run shorter than this is not announced as finished: trying a workflow is not news.
        minRunMinutes: Number.isFinite(minutes) && minutes >= 0 ? Math.min(minutes, 24 * 60) : DEFAULT_MIN_RUN_MINUTES,
        // Sound for "needs you" only; everything else is silent either way.
        sound: s.sound !== false,
    };
}

/** Merge a partial change ({events: {finished: false}}, {minRunMinutes: 10}) into settings. */
function changeNotifications(current, patch) {
    const now = normalizeNotifications(current);
    const p = patch && typeof patch === 'object' ? patch : {};
    return normalizeNotifications({
        events: { ...now.events, ...(p.events && typeof p.events === 'object' ? p.events : {}) },
        minRunMinutes: p.minRunMinutes !== undefined ? p.minRunMinutes : now.minRunMinutes,
        sound: p.sound !== undefined ? !!p.sound : now.sound,
    });
}

/** The switch a moment belongs to, or null for one this app does not know. */
function eventOf(moment) {
    if (!moment) return null;
    switch (moment.kind) {
        case 'input': return 'input';
        case 'error': return 'failed';
        case 'finished': return 'finished';
        case 'stopped': return 'stopped';
        case 'crashed': return 'crashed';
        case 'ready': case 'start-failed': return 'ready';
        case 'installed': case 'install-failed': return 'installed';
        default: return null;
    }
}

function isUrgent(moment) {
    const event = eventOf(moment);
    return !!event && EVENTS[event].group === 'needs';
}

/**
 * Whether to announce a moment: its switch is on, its deck is not muted, and a finished run was
 * long enough to be worth saying (a stopped one is said whatever its length, if switched on).
 */
function shouldAnnounce(prefs, moment, { muted = false } = {}) {
    const event = eventOf(moment);
    if (!event || muted) return false;
    const p = normalizeNotifications(prefs);
    if (!p.events[event]) return false;
    if (event === 'finished' && Number(moment.duration_s || 0) < p.minRunMinutes * 60) return false;
    return true;
}

module.exports = { EVENTS, DEFAULT_MIN_RUN_MINUTES, normalizeNotifications, changeNotifications, eventOf, isUrgent, shouldAnnounce };
