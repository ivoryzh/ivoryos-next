'use strict';
// Runs the launcher's profiles: any number of them at once, each its own edge process on its own
// port, each with a supervisor (supervisor.js) that restarts it on request and reports a crash.
//
// No Electron here, so the logic is testable on its own; main.js connects it to windows, dialogs
// and IPC. All profiles share one Python environment (runtime.js): drivers installed for one deck
// are importable by every profile, which is simpler than a venv per profile and costs only the
// isolation between decks that, on one bench, are usually the same instruments anyway.

const { EventEmitter } = require('node:events');
const net = require('node:net');
const path = require('node:path');

const { EdgeSupervisor } = require('./supervisor');
const {
    loadProfiles, saveProfiles, withDefaults, validateProfile, commandFor, readDeckFile, writeDeckFile,
} = require('./profiles');
const { validateManifest, mergeIntoDeck } = require('./manifest');
const { updateInstrument, removeInstrument, setInstrumentEnabled } = require('./deckEdit');

function portIsFree(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '0.0.0.0');
    });
}

class ProfileManager extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.home                    the launcher's data folder
     * @param {() => Promise<import('./runtime').PythonRuntime>} opts.getRuntime  resolves once Python is ready
     * @param {string|null} [opts.frontendDir]      the web UI every edge should serve
     */
    constructor({ home, getRuntime, frontendDir = null }) {
        super();
        this.home = home;
        this.getRuntime = getRuntime;
        this.frontendDir = frontendDir;
        this.store = loadProfiles(home);
        this.running = new Map(); // id -> { supervisor }
        this.status = new Map(); // id -> { state, message, port, error }
        this.locks = new Map(); // id -> the tail of that profile's operation queue
    }

    /**
     * Run `fn` after every earlier operation on this profile has finished.
     *
     * Start, stop, restart, installs and deck edits all spawn or kill the profile's process, and
     * they used to be free to overlap. Two deck edits in quick succession each restarted the deck;
     * both starts passed the "already running?" check before either had registered its process, so
     * two edges were spawned, the manager kept one, and the other ran on untracked -- which Stop
     * could then never reach. Queuing per profile makes each operation see the state the previous
     * one left, while different profiles still start and stop independently.
     */
    _exclusive(id, fn) {
        const previous = this.locks.get(id) || Promise.resolve();
        const run = previous.catch(() => {}).then(fn);
        const tail = run.catch(() => {});
        this.locks.set(id, tail);
        tail.then(() => { if (this.locks.get(id) === tail) this.locks.delete(id); });
        return run;
    }

    // --- profiles ---------------------------------------------------------------------------

    _save() {
        saveProfiles(this.home, this.store);
        this.emit('changed');
    }

    get(id) {
        const profile = this.store.profiles.find((p) => p.id === id);
        if (!profile) throw new Error('That profile no longer exists.');
        return profile;
    }

    statusOf(id) {
        const s = this.status.get(id) || { state: 'stopped' };
        const port = s.port || this.get(id).port;
        return { ...s, port, url: s.state === 'running' ? `http://127.0.0.1:${port}` : null };
    }

    list() {
        return this.store.profiles.map((p) => ({ ...p, status: this.statusOf(p.id), problems: validateProfile(p) }));
    }

    create(fields) {
        const profile = withDefaults(this.home, { ...fields, id: undefined });
        this.store.profiles.push(profile);
        if (profile.kind === 'deck') writeDeckFile(profile.deck, readDeckFile(profile.deck));
        this._save();
        return profile;
    }

    update(id, patch) {
        const at = this.store.profiles.findIndex((p) => p.id === id);
        if (at === -1) throw new Error('That profile no longer exists.');
        // id and kind are identity: changing them would orphan the profile's deck and data.
        const { id: _i, kind: _k, ...rest } = patch || {};
        this.store.profiles[at] = withDefaults(this.home, { ...this.store.profiles[at], ...rest });
        this._save();
        return this.store.profiles[at];
    }

    remove(id) {
        return this._exclusive(id, () => this._remove(id));
    }

    async _remove(id) {
        await this._stop(id);
        this.store.profiles = this.store.profiles.filter((p) => p.id !== id);
        this.status.delete(id);
        this._save(); // the deck and data folders stay on disk; removing a profile loses no runs
    }

    get hubUrl() {
        return this.store.hubUrl || process.env.IVORYOS_HUB_URL || 'https://ivoryos.ai';
    }

    setHubUrl(url) {
        this.store.hubUrl = url ? String(url).replace(/\/+$/, '') : null;
        this._save();
    }

    logFile(id) {
        return path.join(this.home, 'logs', `${id}.log`);
    }

    logTail(id) {
        const run = this.running.get(id);
        return run ? run.supervisor.logTail : (this.status.get(id)?.logTail || '');
    }

    // --- running ----------------------------------------------------------------------------

    _setStatus(id, next) {
        this.status.set(id, { ...(this.status.get(id) || {}), ...next });
        this.emit('changed');
    }

    start(id) {
        return this._exclusive(id, () => this._start(id));
    }

    stop(id) {
        return this._exclusive(id, () => this._stop(id));
    }

    restart(id) {
        return this._exclusive(id, async () => {
            await this._stop(id);
            return this._start(id);
        });
    }

    async _start(id) {
        const profile = this.get(id);
        if (this.running.has(id)) return this.statusOf(id);
        const problems = validateProfile(profile);
        if (problems.length) {
            this._setStatus(id, { state: 'error', message: problems.join(' ') });
            throw new Error(problems.join(' '));
        }
        this._setStatus(id, { state: 'starting', message: 'Preparing Python…', error: null, port: profile.port });
        try {
            const runtime = await this.getRuntime();
            if (profile.kind === 'deck') {
                const deck = readDeckFile(profile.deck);
                await runtime.ensurePackages(deck.packages || [], {
                    key: id,
                    onProgress: (message) => this._setStatus(id, { message }),
                });
            }
            const other = [...this.running.keys()].map((rid) => this.get(rid)).find((p) => this.statusOf(p.id).port === profile.port);
            if (other) throw new Error(`Port ${profile.port} is already used by "${other.name}". Give this profile another port.`);
            if (!(await portIsFree(profile.port))) {
                throw new Error(`Port ${profile.port} is in use by another program. Stop it, or give this profile another port.`);
            }

            const cmd = commandFor(profile, { python: runtime.python, frontendDir: this.frontendDir });
            const supervisor = new EdgeSupervisor({ ...cmd, logFile: this.logFile(id) });
            this.running.set(id, { supervisor });
            supervisor.on('log', (line) => this.emit('log', id, line));
            supervisor.on('port', (port) => this._setStatus(id, { port }));
            supervisor.on('restart-requested', () => this._setStatus(id, { state: 'starting', message: 'Restarting…' }));
            supervisor.on('ready', () => this._setStatus(id, { state: 'running', message: 'Running', error: null }));
            supervisor.on('crashed', (info) => {
                this.running.delete(id);
                const message = info.error ? `Could not start: ${info.error.message}` : `Stopped unexpectedly (exit code ${info.code ?? info.signal}).`;
                this._setStatus(id, { state: 'crashed', message, error: message, logTail: info.logTail });
                this.emit('crashed', id, info);
            });
            this._setStatus(id, { message: 'Loading instruments…' });
            await supervisor.start();
            return this.statusOf(id);
        } catch (e) {
            const run = this.running.get(id);
            this.running.delete(id);
            this._setStatus(id, {
                state: 'error', message: e.message, error: e.message,
                logTail: [e.output, run && run.supervisor.logTail].filter(Boolean).join('\n'),
            });
            throw e;
        }
    }

    async _stop(id) {
        const run = this.running.get(id);
        if (!run) return;
        this._setStatus(id, { state: 'stopping', message: 'Stopping…' });
        await run.supervisor.stop();
        this.running.delete(id);
        this._setStatus(id, { state: 'stopped', message: 'Stopped', logTail: run.supervisor.logTail });
    }

    async stopAll() {
        await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
    }

    // --- the deck of a deck profile ---------------------------------------------------------

    _deckProfile(id) {
        const profile = this.get(id);
        if (profile.kind !== 'deck') throw new Error('Only deck profiles have a deck to edit. A script sets up its own instruments.');
        return profile;
    }

    readDeck(id) {
        return readDeckFile(this._deckProfile(id).deck);
    }

    /** Apply a deck edit and, if the profile is running, restart it so the edge loads it. */
    _editDeck(id, edit) {
        return this._exclusive(id, async () => {
            const profile = this._deckProfile(id);
            const next = edit(readDeckFile(profile.deck));
            writeDeckFile(profile.deck, next);
            this.emit('changed');
            if (this.running.has(id)) {
                await this._stop(id);
                await this._start(id);
            }
            return next;
        });
    }

    saveInstrument(id, originalName, entry) {
        return this._editDeck(id, (deck) => (originalName
            ? updateInstrument(deck, originalName, entry)
            : mergeIntoDeck(deck, { instruments: [entry] }).deck));
    }

    removeInstrument(id, name) {
        return this._editDeck(id, (deck) => removeInstrument(deck, name));
    }

    setInstrumentEnabled(id, name, enabled) {
        return this._editDeck(id, (deck) => setInstrumentEnabled(deck, name, enabled));
    }

    /**
     * Install a manifest's packages and merge it into this profile's deck. The edge is stopped
     * while packages install (a running interpreter holds their files open), and the deck is only
     * written once every package installed, so a failed install leaves the deck as it was.
     * @returns {{added: string[], replaced: string[]}}
     */
    install(id, manifestInput, options) {
        return this._exclusive(id, () => this._install(id, manifestInput, options));
    }

    async _install(id, manifestInput, { allowPaths = false } = {}) {
        const profile = this._deckProfile(id);
        const { manifest } = validateManifest(manifestInput, { allowPaths });
        const merged = mergeIntoDeck(readDeckFile(profile.deck), manifest);
        const wasRunning = this.running.has(id);
        await this._stop(id);
        try {
            this._setStatus(id, { state: 'installing', message: 'Installing drivers…' });
            const runtime = await this.getRuntime();
            await runtime.ensurePackages(merged.deck.packages || [], {
                key: id,
                onProgress: (message) => this._setStatus(id, { message }),
            });
            writeDeckFile(profile.deck, merged.deck);
            this._setStatus(id, { state: 'stopped', message: 'Installed' });
        } catch (e) {
            this._setStatus(id, { state: 'error', message: `Install failed: ${e.message}`, error: e.message, logTail: e.output || '' });
            if (wasRunning) await this._start(id).catch(() => {});
            throw e;
        }
        if (wasRunning) await this._start(id);
        return { added: merged.added, replaced: merged.replaced };
    }
}

module.exports = { ProfileManager, portIsFree };
