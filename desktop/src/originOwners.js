'use strict';
// Which deck an edge address last belonged to.
//
// A deck's page keeps its state in the browser storage of its address (`http://127.0.0.1:8080`):
// the Designer's unsaved canvas, the cached instrument schema, each page's remembered settings.
// Storage belongs to the address, not to the deck, so a deck started on a port another deck used
// before (one removed, its port free again) opened on that deck's canvas and schema. The launcher
// remembers whose each address was and, when a different deck shows up there, the page's storage
// is cleared before its page loads (main.js `openEdgeTab`).
//
// An address seen for the first time is only recorded, never cleared: what it holds then belongs
// to whichever deck was there before this was kept, which cannot be known, and clearing it could
// throw away the canvas of the deck that is still the one using it.
//
// Pure apart from reading and writing one JSON file, so it is tested without Electron
// (test/originOwners.test.js).

const fs = require('node:fs');
const path = require('node:path');

class OriginOwners {
    /** @param {string} file  where the record is kept, e.g. `<userData>/edge-origins.json` */
    constructor(file) {
        this.file = file;
    }

    _read() {
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
        } catch {
            return {};
        }
    }

    /**
     * Record that `profileId`'s page is opening at `origin`. True when the address last belonged
     * to a different deck, i.e. its storage holds that deck's state and should be cleared first.
     */
    claim(origin, profileId) {
        const owners = this._read();
        const previous = owners[origin];
        if (previous === profileId) return false;
        owners[origin] = profileId;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(owners, null, 2));
        return previous !== undefined;
    }
}

module.exports = { OriginOwners };
