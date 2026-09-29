'use strict';
// Keeping the app itself up to date, from the GitHub releases CI publishes
// (.github/workflows/desktop.yml, a `desktop-v*` tag).
//
// Windows and Linux use electron-updater: it reads latest.yml / latest-linux.yml from the newest
// release, downloads in the background, and installs on restart. Unsigned builds are fine there.
//
// macOS cannot: Squirrel.Mac refuses to install an update into an app that is not code-signed,
// and these builds are not signed yet (desktop/README.md, "Not done yet"). So on macOS the app
// only *checks*, against the GitHub API, and offers the download page. When a Developer ID is in
// CI, macOS can switch to the same path as the others.
//
// A development run (`npm start`) is not an installed app and never updates.

const { EventEmitter } = require('node:events');

const REPO = 'ivoryzh/ivoryos-next';
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
// electron-updater's ways of saying the repository has no release yet.
const NO_RELEASE = /No published versions|Unable to find latest version|production release exists/i;

/** Compare dotted versions numerically: '0.10.0' > '0.9.3'. A pre-release sorts before its release. */
function compareVersions(a, b) {
    const parse = (v) => {
        const [core, pre] = String(v).replace(/^[^\d]*/, '').split('-', 2);
        return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || null };
    };
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
        const d = (x.nums[i] || 0) - (y.nums[i] || 0);
        if (d) return Math.sign(d);
    }
    if (x.pre === y.pre) return 0;
    if (!x.pre) return 1;
    if (!y.pre) return -1;
    return x.pre < y.pre ? -1 : 1;
}

class Updates extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.currentVersion
     * @param {boolean} opts.packaged
     * @param {string} opts.platform
     * @param {typeof fetch} opts.fetch
     * @param {() => any} [opts.loadAutoUpdater]  returns electron-updater's autoUpdater (lazy: it
     *                                            reads app-update.yml, which only packaged builds have)
     * @param {() => boolean} [opts.autoDownload]
     */
    constructor({ currentVersion, packaged, platform, fetch, loadAutoUpdater, autoDownload = () => true }) {
        super();
        this.current = currentVersion;
        this.fetch = fetch;
        this.autoDownload = autoDownload;
        this.manual = platform === 'darwin';
        this.state = packaged
            ? { state: 'idle', current: currentVersion, manual: this.manual }
            : { state: 'unsupported', current: currentVersion, message: 'Updates apply to installed builds, not a development run.' };
        this.updater = null;
        if (packaged && !this.manual && loadAutoUpdater) {
            this.updater = loadAutoUpdater();
            this.updater.autoDownload = false; // decided per check, from the setting
            this.updater.autoInstallOnAppQuit = true;
            this.updater.on('checking-for-update', () => this._set({ state: 'checking', message: null }));
            this.updater.on('update-not-available', () => this._set({ state: 'up-to-date', checkedAt: Date.now() }));
            this.updater.on('update-available', (info) => {
                this._set({ state: 'available', version: info.version, checkedAt: Date.now(), releaseUrl: `${RELEASES_PAGE}/tag/desktop-v${info.version}` });
                if (this.autoDownload()) this.download().catch(() => {});
            });
            this.updater.on('download-progress', (p) => this._set({ state: 'downloading', percent: Math.round(p.percent || 0) }));
            this.updater.on('update-downloaded', (info) => this._set({ state: 'ready', version: info.version, percent: 100 }));
            this.updater.on('error', (e) => this._set(NO_RELEASE.test(String(e && e.message))
                ? { state: 'up-to-date', checkedAt: Date.now() } // nothing published yet is not a failure
                : { state: 'error', message: friendly(e) }));
        }
    }

    _set(next) {
        this.state = { ...this.state, ...next };
        this.emit('changed', this.state);
    }

    status() { return this.state; }

    /** Check now; with auto-download on, an available update starts downloading straight away. */
    async check() {
        if (this.state.state === 'unsupported') return this.state;
        if (['checking', 'downloading'].includes(this.state.state)) return this.state;
        if (this.updater) {
            try {
                await this.updater.checkForUpdates();
            } catch (e) {
                this._set(NO_RELEASE.test(String(e && e.message)) ? { state: 'up-to-date', checkedAt: Date.now() } : { state: 'error', message: friendly(e) });
            }
            return this.state;
        }
        // macOS: look, and point at the download.
        this._set({ state: 'checking', message: null });
        try {
            const res = await this.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
            if (res.status === 404) { this._set({ state: 'up-to-date', checkedAt: Date.now() }); return this.state; }
            if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
            const release = await res.json();
            const version = String(release.tag_name || '').replace(/^desktop-v/, '').replace(/^v/, '');
            if (version && compareVersions(version, this.current) > 0) {
                const dmg = (release.assets || []).find((a) => /\.dmg$/i.test(a.name));
                this._set({ state: 'available', version, checkedAt: Date.now(), releaseUrl: release.html_url, downloadUrl: dmg ? dmg.browser_download_url : release.html_url });
            } else {
                this._set({ state: 'up-to-date', checkedAt: Date.now() });
            }
        } catch (e) {
            this._set({ state: 'error', message: friendly(e) });
        }
        return this.state;
    }

    async download() {
        if (!this.updater) throw new Error('This version downloads updates from the release page.');
        this._set({ state: 'downloading', percent: 0 });
        await this.updater.downloadUpdate();
    }

    /** Restart into the downloaded version. `beforeQuit` stops the edges first. */
    async install(beforeQuit) {
        if (!this.updater || this.state.state !== 'ready') throw new Error('No update is ready to install.');
        if (beforeQuit) await beforeQuit();
        this.updater.quitAndInstall(false, true);
    }

    /** Check shortly after launch, then every few hours. */
    schedule() {
        if (this.state.state === 'unsupported') return;
        setTimeout(() => this.check(), 15000).unref?.();
        setInterval(() => this.check(), CHECK_EVERY_MS).unref?.();
    }
}

/** electron-updater's errors are long and technical; the first line is what helps. */
function friendly(e) {
    const text = String((e && e.message) || e);
    if (/ENOTFOUND|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(text)) return 'Could not reach GitHub to check for updates.';
    if (/404/.test(text) && /latest.*\.yml/i.test(text)) return 'The newest release has no update information for this system yet.';
    return text.split('\n')[0].slice(0, 300);
}

module.exports = { Updates, compareVersions, RELEASES_PAGE };
