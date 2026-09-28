'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Updates } = require('../src/updater');

/** electron-updater's autoUpdater, reduced to what Updates uses. */
function fakeAutoUpdater(onCheck) {
    const u = new EventEmitter();
    u.checkForUpdates = async () => onCheck(u);
    u.downloadUpdate = async () => { u.emit('download-progress', { percent: 50 }); u.emit('update-downloaded', { version: '0.2.0' }); };
    u.quitAndInstall = () => { u.installed = true; };
    return u;
}

test('a development run never updates', async () => {
    const up = new Updates({ currentVersion: '0.1.0', packaged: false, platform: 'win32', fetch: null });
    assert.equal((await up.check()).state, 'unsupported');
});

test('no release published yet reads as up to date, not as an error', async () => {
    const auto = fakeAutoUpdater((u) => { throw new Error('No published versions on GitHub'); });
    const up = new Updates({ currentVersion: '0.1.0', packaged: true, platform: 'win32', fetch: null, loadAutoUpdater: () => auto });
    assert.equal((await up.check()).state, 'up-to-date');
});

test('Windows/Linux: available -> downloaded automatically -> installs after stopping the edges', async () => {
    const auto = fakeAutoUpdater((u) => u.emit('update-available', { version: '0.2.0' }));
    const up = new Updates({ currentVersion: '0.1.0', packaged: true, platform: 'win32', fetch: null, loadAutoUpdater: () => auto, autoDownload: () => true });
    await up.check();
    await new Promise((r) => setImmediate(r));
    assert.equal(up.status().state, 'ready');
    assert.equal(up.status().version, '0.2.0');
    let stopped = false;
    await up.install(async () => { stopped = true; });
    assert.ok(stopped && auto.installed, 'edges stopped before quitting into the installer');
});

test('with automatic downloads off, an update waits to be downloaded', async () => {
    const auto = fakeAutoUpdater((u) => u.emit('update-available', { version: '0.2.0' }));
    const up = new Updates({ currentVersion: '0.1.0', packaged: true, platform: 'linux', fetch: null, loadAutoUpdater: () => auto, autoDownload: () => false });
    await up.check();
    assert.equal(up.status().state, 'available');
    await assert.rejects(up.install(), /No update is ready/);
});

test('macOS (unsigned) only checks, and links to the .dmg', async () => {
    const fetch = async () => new Response(JSON.stringify({
        tag_name: 'desktop-v0.3.0', html_url: 'https://github.com/o/r/releases/tag/desktop-v0.3.0',
        assets: [{ name: 'IvoryOS-0.3.0-arm64.dmg', browser_download_url: 'https://dl/IvoryOS.dmg' }],
    }));
    const up = new Updates({ currentVersion: '0.2.0', packaged: true, platform: 'darwin', fetch, loadAutoUpdater: () => { throw new Error('must not load'); } });
    const s = await up.check();
    assert.equal(s.state, 'available');
    assert.equal(s.manual, true);
    assert.equal(s.downloadUrl, 'https://dl/IvoryOS.dmg');
    const same = new Updates({ currentVersion: '0.3.0', packaged: true, platform: 'darwin', fetch });
    assert.equal((await same.check()).state, 'up-to-date');
});
