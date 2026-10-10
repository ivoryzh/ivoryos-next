'use strict';
// Runs the launcher's profiles: any number of them at once, each its own edge process on its own
// port, each with a supervisor (supervisor.js) that restarts it on request and reports a crash.
//
// No Electron here, so the logic is testable on its own; main.js connects it to windows, dialogs
// and IPC. All profiles share one Python environment (runtime.js): drivers installed for one deck
// are importable by every profile, which is simpler than a venv per profile and costs only the
// isolation between decks that, on one bench, are usually the same instruments anyway.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { EdgeSupervisor } = require('./supervisor');
const {
    loadProfiles, saveProfiles, withDefaults, validateProfile, commandFor, readDeckFile, writeDeckFile,
} = require('./profiles');
const { normalizeNotifications, changeNotifications } = require('./notifyPrefs');
const { validateManifest, mergeIntoDeck } = require('./manifest');
const { updateInstrument, removeInstrument, setInstrumentEnabled } = require('./deckEdit');
const { addWorkflows } = require('./library');
const { selectionOf, withSelection } = require('./optimizers');

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
    /**
     * @param {boolean} [opts.cloudComingSoon]  a release build where Cloud is not offered yet: its
     *   decks hide their Cloud pages (IVORYOS_CLOUD_COMING_SOON) and Cloud-only mode is off.
     */
    constructor({ home, getRuntime, frontendDir = null, cloudComingSoon = false }) {
        super();
        this.cloudComingSoon = !!cloudComingSoon;
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
        // A new profile takes the first port no other profile has: two on 8080 cannot run at once,
        // and a deck made from a Hub platform is meant to run beside the one it was made from.
        const used = new Set(this.store.profiles.map((p) => Number(p.port)));
        let port = Number(fields && fields.port) || 8080;
        if (!(fields && fields.port)) while (used.has(port)) port += 1;
        const profile = withDefaults(this.home, { ...fields, port, id: undefined });
        this.store.profiles.push(profile);
        // A new deck file carries the profile's name (readDeckFile's default is "My deck").
        if (profile.kind === 'deck') {
            writeDeckFile(profile.deck, fs.existsSync(profile.deck) ? readDeckFile(profile.deck) : { ...readDeckFile(profile.deck), name: profile.name });
        }
        this._save();
        return profile;
    }

    /**
     * The first port from 8080 that no profile uses and nothing on this computer is listening on,
     * for a new profile. `create` alone only avoids other profiles, since it cannot wait; a port
     * another program holds would otherwise surface only when the new deck fails to start.
     */
    async freePort(from = 8080) {
        const used = new Set(this.store.profiles.map((p) => Number(p.port)));
        for (let port = from; port < from + 200; port += 1) {
            if (!used.has(port) && (await portIsFree(port))) return port;
        }
        return from;
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

    /** Whether a new version of the app downloads by itself (it still installs only on restart). */
    get autoUpdate() {
        return this.store.autoUpdate !== false;
    }

    setAutoUpdate(on) {
        this.store.autoUpdate = !!on;
        this._save();
    }

    /** Window preferences: 'minimizeToTray' and 'closeToTray' (default on), 'trayHintShown'. */
    windowPref(key) {
        return key === 'trayHintShown' ? !!this.store.trayHintShown : this.store[key] !== false;
    }

    setWindowPref(key, on) {
        if (!['minimizeToTray', 'closeToTray', 'trayHintShown'].includes(key)) throw new Error(`Unknown setting: ${key}`);
        this.store[key] = !!on;
        this._save();
    }

    /** Where decks pair with IvoryOS Cloud: the hosted service unless a lab runs its own. */
    /** 'system' | 'light' | 'dark': the app's one theme, applied to every page it shows. */
    get theme() {
        return this.store.theme || 'system';
    }

    setTheme(theme) {
        if (!['system', 'light', 'dark'].includes(theme)) throw new Error(`Unknown theme: ${theme}`);
        this.store.theme = theme;
        this._save();
    }

    /**
     * Someone who only uses Cloud: the launcher shows Cloud and the account, not decks or the Hub,
     * and the app never prepares Python (a download of its own on first launch, for nothing).
     * Decks already set up are kept, just hidden and not started, until this is turned off.
     */
    get cloudOnly() {
        // Kept as saved, but not in force while Cloud is not offered.
        return !this.cloudComingSoon && !!this.store.cloudOnly;
    }

    setCloudOnly(on) {
        this.store.cloudOnly = !!on;
        this._save();
    }

    /** What the person is notified about (notifyPrefs.js): one switch per kind of moment. */
    get notifications() {
        return normalizeNotifications(this.store.notifications);
    }

    setNotifications(patch) {
        this.store.notifications = changeNotifications(this.store.notifications, patch);
        this._save();
        return this.store.notifications;
    }

    /**
     * Automation Hub items this account starred ('module:12', 'platform:4', 'plugin:3',
     * 'template:9'), for the browser's Starred view. Kept per account on this computer: two people
     * sharing a bench PC each get their own, and signing out shows the signed-out list.
     */
    starred(account) {
        const all = this.store.starred || {};
        return Array.isArray(all[account]) ? all[account] : [];
    }

    setStarred(account, key, on) {
        if (!/^(module|platform|plugin|template):\d+$/.test(String(key))) throw new Error(`Not a Hub item: ${key}`);
        const all = { ...(this.store.starred || {}) };
        const list = (Array.isArray(all[account]) ? all[account] : []).filter((k) => k !== key);
        all[account] = on ? [...list, key] : list;
        this.store.starred = all;
        this._save();
        return all[account];
    }

    /**
     * Put the profiles in this order (the launcher's sidebar, dragged). Ids not listed keep their
     * relative order after the listed ones, so a profile created meanwhile is never dropped.
     */
    reorder(ids) {
        const byId = new Map(this.store.profiles.map((p) => [p.id, p]));
        const listed = (Array.isArray(ids) ? ids : []).filter((id) => byId.has(id));
        const rest = this.store.profiles.filter((p) => !listed.includes(p.id));
        this.store.profiles = [...listed.map((id) => byId.get(id)), ...rest];
        this._save();
    }

    get cloudUrl() {
        return this.store.cloudUrl || process.env.IVORYOS_CLOUD_URL || 'https://cloud.ivoryos.ai';
    }

    /** Takes effect for each edge the next time it starts, since the edge reads it at startup. */
    setCloudUrl(url) {
        let value = url ? String(url).trim().replace(/\/+$/, '') : '';
        // "localhost:3002" or "cloud.mylab.org": http for this computer or the lab network, where
        // a Cloud normally serves plain http, https for anything else.
        if (value && !/^https?:\/\//.test(value)) {
            const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^/:]+\.local)/.test(value);
            value = `${local ? 'http' : 'https'}://${value}`;
        }
        this.store.cloudUrl = value || null;
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
        this._setStatus(id, { state: 'starting', message: 'Preparing Python…', error: null, port: profile.port, portNote: null });
        try {
            const runtime = await this.getRuntime();
            if (profile.kind === 'deck') {
                const deck = readDeckFile(profile.deck);
                // The first profile loadProfiles makes on a fresh install has no folder yet (only
                // create() writes one), and the edge runs with dataDir as its cwd: spawning into a
                // missing cwd fails as "spawn python.exe ENOENT", naming the wrong file.
                fs.mkdirSync(profile.dataDir, { recursive: true });
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

            const cmd = commandFor(profile, { python: runtime.python, frontendDir: this.frontendDir, cloudUrl: this.store.cloudUrl || null, cloudComingSoon: this.cloudComingSoon });
            const supervisor = new EdgeSupervisor({ ...cmd, logFile: this.logFile(id) });
            this.running.set(id, { supervisor });
            supervisor.on('log', (line) => this.emit('log', id, line));
            // The edge chose another port than the profile's: follow it, and keep why for the
            // launcher to show (the script sets its own port, or its IvoryOS ignores IVORYOS_PORT).
            supervisor.on('port', (port, requested) => this._setStatus(id, { port, portNote: { requested, actual: port } }));
            supervisor.on('restart-requested', () => this._setStatus(id, { state: 'starting', message: 'Restarting…' }));
            supervisor.on('ready', () => this._setStatus(id, { state: 'running', message: 'Running', error: null }));
            supervisor.on('crashed', (info) => {
                // Running until now, or a start that never got there (the Start that asked says so).
                const wasRunning = this.statusOf(id).state === 'running';
                this.running.delete(id);
                const message = info.error ? `Could not start: ${info.error.message}` : `Stopped unexpectedly (exit code ${info.code ?? info.signal}).`;
                this._setStatus(id, { state: 'crashed', message, error: message, logTail: info.logTail });
                this.emit('crashed', id, { ...info, wasRunning });
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
        return { added: merged.added, replaced: merged.replaced, pluginsAdded: merged.pluginsAdded };
    }

    /**
     * Choose a deck's optimizer backends (optimizers.js): `selection` is {id: version | null}.
     * Installed the way the Hub's drivers are: the deck's whole package list in one resolution
     * (a conflict is refused before anything changes), the deck written only once it installed,
     * and a running deck restarted to load it. Taking one out of the deck leaves it installed,
     * since the decks share one environment.
     */
    setOptimizers(id, selection) {
        return this._exclusive(id, async () => {
            const profile = this._deckProfile(id);
            const deck = readDeckFile(profile.deck);
            const packages = withSelection(deck.packages || [], selection);
            const wasRunning = this.running.has(id);
            await this._stop(id);
            try {
                this._setStatus(id, { state: 'installing', message: 'Installing optimizers…' });
                const runtime = await this.getRuntime();
                await runtime.ensurePackages(packages, { key: id, onProgress: (message) => this._setStatus(id, { message }) });
                writeDeckFile(profile.deck, { ...deck, packages });
                this._setStatus(id, { state: 'stopped', message: 'Installed' });
            } catch (e) {
                this._setStatus(id, { state: 'error', message: `Install failed: ${e.message}`, error: e.message, logTail: e.output || '' });
                if (wasRunning) await this._start(id).catch(() => {});
                throw e;
            }
            if (wasRunning) await this._start(id);
            return selectionOf(packages);
        });
    }

    // --- the workflow library ---------------------------------------------------------------

    /**
     * Add workflows ({name, body}) to this profile's library (library.js): through the edge's API
     * while it runs, as files it adopts otherwise. Returns [{requested, saved}].
     */
    addWorkflows(id, workflows) {
        // Queued with the profile's other operations: a file written while the edge restarts
        // after an install would otherwise race the edge reading its library at startup.
        return this._exclusive(id, () => {
            const status = this.statusOf(id);
            return addWorkflows(this.get(id), workflows, { url: status.state === 'running' ? status.url : null });
        });
    }
}

module.exports = { ProfileManager, portIsFree };
