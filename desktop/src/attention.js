'use strict';
// Notifications from the decks. Each running deck's queue socket (/api/ws/queue) carries
// `status.attention`: what needs a person now, decided by the edge (queue.py attention_items) --
// a User input waiting for an answer, or a failed step waiting for retry, skip or stop -- and
// `status.notices`: runs that just ended (queue.py finished_notice). This watches every running
// deck, with or without a tab open on it, and emits each item once (by its key): 'attention' and
// 'notice'. main.js decides which become system notifications (notifyPrefs.js).
//
// It also keeps what is waiting right now (`waiting()`, for the Dock badge; 'changed' when that
// changes) and the run each deck was last on (`lastRun()`), which outlives the deck: a deck that
// crashes is dropped before main.js hears of the crash, and the notification names the run.
//
// No Electron here (the WebSocket is passed in), so it is tested on its own (test/attention.test.js).

const { EventEmitter } = require('node:events');

// A notice already in a deck's status when it is first heard from is announced only if it is
// this recent: the deck just finished a run as the app (re)started watching it.
const FRESH_S = 60;

class AttentionWatcher extends EventEmitter {
    /**
     * @param {object} opts
     * @param {typeof WebSocket} opts.WebSocket
     * @param {number} [opts.retryMs]  how long to wait before reconnecting to a deck that dropped
     */
    constructor({ WebSocket, retryMs = 3000 }) {
        super();
        this.WebSocket = WebSocket;
        this.retryMs = retryMs;
        this.decks = new Map(); // id -> {deck, socket, seen, notices, primed, items, timer}
        this.lastRuns = new Map(); // id -> {id, name} of the run it was on, or absent
    }

    /** Everything waiting for a person now, across decks, each with its deck. */
    waiting() {
        return [...this.decks.values()].flatMap((e) => e.items.map((i) => ({ ...i, deckId: e.deck.id, deckName: e.deck.name })));
    }

    /** The run a deck was on when last heard from ({id, name}), or null. */
    lastRun(id) {
        return this.lastRuns.get(id) || null;
    }

    /** Watch exactly these decks ({id, name, url}); close what is no longer among them. */
    sync(decks) {
        const wanted = new Map((decks || []).filter((d) => d && d.url).map((d) => [d.id, d]));
        for (const id of [...this.decks.keys()]) {
            const watched = this.decks.get(id);
            if (!wanted.has(id) || wanted.get(id).url !== watched.deck.url) this._drop(id);
        }
        for (const [id, deck] of wanted) {
            if (this.decks.has(id)) this.decks.get(id).deck = deck; // a rename keeps the socket
            else this._open(deck);
        }
    }

    close() {
        for (const id of [...this.decks.keys()]) this._drop(id);
    }

    _open(deck) {
        const entry = { deck, socket: null, seen: new Set(), notices: new Set(), primed: false, items: [], timer: null };
        this.decks.set(deck.id, entry);
        this._connect(entry);
    }

    _connect(entry) {
        let socket;
        try {
            socket = new this.WebSocket(entry.deck.url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/api/ws/queue');
        } catch {
            this._retry(entry);
            return;
        }
        entry.socket = socket;
        socket.onmessage = (event) => this._message(entry, event.data);
        socket.onclose = () => { if (this.decks.get(entry.deck.id) === entry && entry.socket === socket) this._retry(entry); };
        socket.onerror = () => { /* onclose follows */ };
    }

    _retry(entry) {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => { if (this.decks.get(entry.deck.id) === entry) this._connect(entry); }, this.retryMs);
    }

    _drop(id) {
        const entry = this.decks.get(id);
        if (!entry) return;
        this.decks.delete(id);
        clearTimeout(entry.timer);
        try { if (entry.socket) entry.socket.close(); } catch { /* already closed */ }
        if (entry.items.length) this.emit('changed');
    }

    /** One queue message: announce each attention item not announced yet. */
    _message(entry, data) {
        let message;
        try { message = JSON.parse(typeof data === 'string' ? data : String(data)); } catch { return; }
        if (!message || !message.status) return;
        const items = Array.isArray(message.status.attention) ? message.status.attention : [];
        for (const item of items) {
            if (!item || !item.key || entry.seen.has(item.key)) continue;
            this.emit('attention', { ...item, deckId: entry.deck.id, deckName: entry.deck.name });
        }
        // Only what is still waiting is remembered: once answered it may come back as a new moment.
        entry.seen = new Set(items.map((i) => i && i.key).filter(Boolean));
        const before = entry.items.map((i) => i.key).join('|');
        entry.items = items.filter((i) => i && i.key);
        if (entry.items.map((i) => i.key).join('|') !== before) this.emit('changed');

        // A run that ended. The edge keeps each for a few minutes, so one that ended while this
        // socket was reconnecting is still announced; on the first message from a deck, only what
        // just happened is (anything older ended before anyone was listening).
        const notices = Array.isArray(message.status.notices) ? message.status.notices : [];
        for (const notice of notices) {
            if (!notice || !notice.key || entry.notices.has(notice.key)) continue;
            if (entry.primed || Number(notice.age_s || 0) < FRESH_S) {
                this.emit('notice', { ...notice, deckId: entry.deck.id, deckName: entry.deck.name });
            }
        }
        // The edge's list only ever drops a key, so what it no longer sends never comes back.
        entry.notices = new Set(notices.map((n) => n && n.key).filter(Boolean));
        entry.primed = true;

        const active = message.status.active_workflow_id;
        if (active) this.lastRuns.set(entry.deck.id, { id: active, name: (message.active_run && message.active_run.name) || null });
        else this.lastRuns.delete(entry.deck.id);
    }
}

module.exports = { AttentionWatcher };
