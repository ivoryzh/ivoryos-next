'use strict';
// Notifications from the decks. Each running deck's queue socket (/api/ws/queue) carries
// `status.attention`: what needs a person now, decided by the edge (queue.py attention_items) --
// a User input waiting for an answer, or a failed step waiting for retry, skip or stop. This
// watches every running deck, with or without a tab open on it, and emits each item once (by its
// key). main.js turns them into system notifications that open the deck when clicked.
//
// No Electron here (the WebSocket is passed in), so it is tested on its own (test/attention.test.js).

const { EventEmitter } = require('node:events');

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
        this.decks = new Map(); // id -> {deck, socket, seen: Set<string>, timer}
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
        const entry = { deck, socket: null, seen: new Set(), timer: null };
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
    }
}

module.exports = { AttentionWatcher };
