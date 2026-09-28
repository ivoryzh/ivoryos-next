'use strict';
// IvoryOS desktop: a launcher for edge servers, and windows onto them.
//
// The launcher window lists saved profiles (profiles.js): decks and Python scripts, each started,
// stopped and watched from one place (manager.js). Opening a running profile shows that edge's
// own web UI in its own window. Drivers are installed from the Hub, from a deck file, or from an
// `ivoryos://install` link. The app never talks to an instrument itself.
//
// The launcher page is part of the IvoryOS frontend (frontend/src/app/launcher), served from the
// bundled build over the `ivoryos-app://` scheme, so it looks like the rest of IvoryOS and works
// before any edge is running. It reaches this process through preload.js; every launcher call is
// refused unless it comes from that page (see `fromLauncher`), so an edge's page or a plugin
// inside it cannot start processes or install packages.
//
//   <userData>/profiles.json         saved profiles + the Hub address
//   <userData>/profiles/<id>/        a deck profile's deck.json and data (runs, workflows)
//   <userData>/runtime/venv          the Python environment every profile runs in (uv-managed)
//   <userData>/logs/<id>.log         each profile's edge output, kept across restarts
//   <userData>/account.bin           the signed-in session (encrypted, secrets.js)
//   <userData>/git.bin               GitHub/GitLab tokens for private drivers (encrypted)
//   <userData>/private-packages/     private repositories downloaded at one commit each

const { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, shell, net, protocol, clipboard, nativeImage, safeStorage } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { ProfileManager } = require('./manager');
const { PythonRuntime, run: runProcess } = require('./runtime');
const { Account, pkcePair } = require('./account');
const { GitConnections } = require('./gitRepos');
const { secretFile } = require('./secrets');
const { Updates } = require('./updater');
const { resolveResources } = require('./resources');
const { validateManifest, mergeIntoDeck, describeInstall, ManifestError } = require('./manifest');
const { freeName } = require('./deckEdit');

const SMOKE_TEST = process.argv.includes('--smoke-test');
const LINK_SCHEME = 'ivoryos';
const APP_SCHEME = 'ivoryos-app';
const LAUNCHER_URL = `${APP_SCHEME}://ui/launcher/`;

// A separate profile for tests and side-by-side development: set before anything reads userData.
if (process.env.IVORYOS_DESKTOP_HOME) app.setPath('userData', path.resolve(process.env.IVORYOS_DESKTOP_HOME));

// Registered before `ready`: a privileged scheme is what lets the launcher page use fetch,
// localStorage and relative asset URLs like any web page.
protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const home = () => app.getPath('userData');
const resources = () => resolveResources({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });

let launcherWindow = null;
// Edges open as tabs inside the launcher window, not as windows of their own: each is a
// WebContentsView laid over the window below the launcher's tab bar, and switching tabs just
// changes which view is attached. One app, one window, however many decks are running.
const edgeTabs = new Map(); // profile id -> WebContentsView
let activeTab = null; // profile id, or null for the launcher itself
let tabBarHeight = 44; // reported by the launcher page, which draws the tab bar
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
let manager = null;
let account = null;
let git = null;
let updates = null;
let runtimePromise = null;
let runtimeStatus = { state: 'idle', message: '' };
let quitting = false;
const pendingLinks = [];

// --- Python ------------------------------------------------------------------------------------

function setRuntimeStatus(next) {
    runtimeStatus = { ...runtimeStatus, ...next };
    if (SMOKE_TEST && next.message) console.log(`[desktop] python: ${next.message}`);
    broadcast('launcher:changed');
}

/** The shared Python environment, set up once per launch (and again after a rebuild). */
function getRuntime() {
    if (!runtimePromise) {
        runtimePromise = (async () => {
            const res = resources();
            if (!res.uv) {
                throw Object.assign(new Error('uv was not found. The app needs it to manage Python.'), {
                    hint: 'Install uv from https://docs.astral.sh/uv/ (or set IVORYOS_UV to its path), then try again.',
                });
            }
            if (!res.edgeSource) throw new Error('This build does not include the edge server package.');
            const runtime = new PythonRuntime({ uv: res.uv, dir: path.join(home(), 'runtime'), edgeSource: res.edgeSource });
            setRuntimeStatus({ state: 'preparing', message: 'Checking Python…' });
            await runtime.ensure({ onProgress: (message) => setRuntimeStatus({ message }) });
            setRuntimeStatus({ state: 'ready', message: `Python ready (${res.edgeSource.kind === 'editable' ? 'development edge' : 'bundled edge'})` });
            return runtime;
        })().catch((e) => {
            runtimePromise = null; // let the next start try again
            setRuntimeStatus({ state: 'error', message: e.message, hint: e.hint, output: e.output });
            throw e;
        });
    }
    return runtimePromise;
}

// --- windows -------------------------------------------------------------------------------------

function broadcast(channel, ...args) {
    if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.webContents.send(channel, ...args);
}

const webPreferences = {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
};

/**
 * Links out of the app open in the real browser; a window only ever shows its own origin.
 *
 * The app never opens a second window of its own. A new window gets none of this window's
 * setup: opened on the launcher's own page it has no bridge to the app (and says "Open the app
 * to use it"), and on macOS, with the app full screen, it opens in a full-screen space of its
 * own with no way back. So a request for a new window becomes the system browser for web
 * addresses (an edge is an ordinary web server) and nothing for the app's own pages.
 */
function keepToOrigin(win, isOwn) {
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (isOwn(url)) return;
        event.preventDefault();
        if (/^https?:/.test(url)) shell.openExternal(url);
    });
}

function showLauncher() {
    if (launcherWindow && !launcherWindow.isDestroyed()) {
        if (launcherWindow.isMinimized()) launcherWindow.restore();
        launcherWindow.show();
        launcherWindow.focus();
        return launcherWindow;
    }
    launcherWindow = new BrowserWindow({
        width: 1400, height: 900, minWidth: 1080, minHeight: 600, title: 'IvoryOS',
        show: !SMOKE_TEST, webPreferences,
        ...(fs.existsSync(ICON) ? { icon: ICON } : {}),
    });
    keepToOrigin(launcherWindow, (url) => url.startsWith(`${APP_SCHEME}://`));
    addShortcuts(launcherWindow.webContents);
    if (resources().frontendDir) launcherWindow.loadURL(LAUNCHER_URL);
    else launcherWindow.loadFile(path.join(__dirname, 'status.html')); // a build without the UI
    launcherWindow.on('resize', layoutTabs);
    launcherWindow.on('closed', () => {
        launcherWindow = null;
        for (const view of edgeTabs.values()) view.webContents.close();
        edgeTabs.clear();
        activeTab = null;
    });
    return launcherWindow;
}

function tabState() {
    return { open: [...edgeTabs.keys()], active: activeTab };
}

/** Put the active edge's view under the tab bar; every other view is detached. */
function layoutTabs() {
    if (!launcherWindow || launcherWindow.isDestroyed()) return;
    const [width, height] = launcherWindow.getContentSize();
    for (const [id, view] of edgeTabs) {
        const attached = launcherWindow.contentView.children.includes(view);
        if (id === activeTab) {
            if (!attached) launcherWindow.contentView.addChildView(view);
            view.setBounds({ x: 0, y: tabBarHeight, width, height: Math.max(0, height - tabBarHeight) });
        } else if (attached) {
            launcherWindow.contentView.removeChildView(view);
        }
    }
}

function showTab(id) {
    activeTab = id && edgeTabs.has(id) ? id : null;
    layoutTabs();
    if (activeTab) edgeTabs.get(activeTab).webContents.focus();
    else if (launcherWindow) launcherWindow.webContents.focus();
    broadcast('launcher:tabs', tabState());
}

/** Open (or switch to) a profile's tab; `page` such as '/cloud/' opens that page of the edge. */
function openEdgeTab(id, page) {
    const status = manager.statusOf(id);
    if (status.state !== 'running') throw new Error('Start the profile first.');
    showLauncher();
    const origin = status.url;
    const target = page && /^\/[\w\-/]*$/.test(page) ? `${origin}${page}` : null;
    let view = edgeTabs.get(id);
    if (!view) {
        view = new WebContentsView({ webPreferences });
        keepToOrigin(view, (url) => url.startsWith(origin));
        addShortcuts(view.webContents);
        view.webContents.loadURL(target || origin);
        edgeTabs.set(id, view);
    } else if (target) {
        view.webContents.loadURL(target);
    }
    showTab(id);
}

function closeEdgeTab(id) {
    const view = edgeTabs.get(id);
    if (!view) return;
    if (launcherWindow && !launcherWindow.isDestroyed() && launcherWindow.contentView.children.includes(view)) {
        launcherWindow.contentView.removeChildView(view);
    }
    view.webContents.close();
    edgeTabs.delete(id);
    if (activeTab === id) activeTab = null;
    layoutTabs();
    broadcast('launcher:tabs', tabState());
}

/** The Cloud tab: IvoryOS Cloud in this window, beside the decks, under this id. */
const CLOUD_TAB = '@cloud';

function openCloudTab() {
    showLauncher();
    const url = manager.cloudUrl;
    let view = edgeTabs.get(CLOUD_TAB);
    if (view && !view.webContents.getURL().startsWith(url)) {
        closeEdgeTab(CLOUD_TAB); // the Cloud address changed since the tab was opened
        view = null;
    }
    if (!view) {
        view = new WebContentsView({ webPreferences });
        const origin = new URL(url).origin;
        keepToOrigin(view, (u) => u.startsWith(origin));
        addShortcuts(view.webContents);
        view.webContents.loadURL(url);
        edgeTabs.set(CLOUD_TAB, view);
    }
    showTab(CLOUD_TAB);
}

/** After a restart from the launcher, the tab's page points at a process that no longer exists. */
function reloadEdgeTab(id) {
    const view = edgeTabs.get(id);
    if (view) view.webContents.reload();
}

// --- installs from links and files ---------------------------------------------------------------

/** Decode an `ivoryos://install?deck=` payload (base64url JSON) or fetch `?manifest=`. */
async function manifestFromLink(url) {
    const deck = url.searchParams.get('deck');
    if (deck) {
        const json = Buffer.from(deck.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return { text: json, source: 'a link from the IvoryOS Hub' };
    }
    const manifestUrl = url.searchParams.get('manifest');
    if (!manifestUrl) throw new ManifestError('The link does not say what to install.');
    const parsed = new URL(manifestUrl);
    const local = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !local) throw new ManifestError('Manifests are only downloaded over https.');
    const res = await net.fetch(manifestUrl);
    if (!res.ok) throw new ManifestError(`Could not download the manifest (${res.status}).`);
    return { text: await res.text(), source: manifestUrl };
}

/**
 * Ask which deck profile to install into (or make a new one), show exactly what will change, and
 * install on "Install". Everything that reaches the machine from outside goes through here.
 */
async function confirmAndInstall(text, { source, fromFile = null }) {
    const parent = showLauncher();
    let checked;
    try {
        checked = validateManifest(text, { allowPaths: !!fromFile });
    } catch (e) {
        await dialog.showMessageBox(parent, { type: 'error', message: 'This install cannot be used', detail: e.message });
        return;
    }
    let { manifest } = checked;
    if (fromFile && manifest.paths) {
        manifest = { ...manifest, paths: manifest.paths.map((p) => path.resolve(path.dirname(fromFile), p)) };
    }

    const decks = manager.list().filter((p) => p.kind === 'deck');
    const choices = [...decks.map((p) => p.name), 'New deck profile', 'Cancel'];
    const { response: pick } = await dialog.showMessageBox(parent, {
        type: 'question', buttons: choices, cancelId: choices.length - 1, defaultId: 0,
        message: `Install ${manifest.name ? `"${manifest.name}"` : 'these drivers'} into which deck?`,
        detail: `From ${source}`,
    });
    if (pick === choices.length - 1) return;
    const target = pick < decks.length ? decks[pick] : manager.create({ kind: 'deck', name: manifest.name || 'New deck' });

    const preview = mergeIntoDeck(manager.readDeck(target.id), manifest);
    const { response } = await dialog.showMessageBox(parent, {
        type: 'question', buttons: ['Install', 'Cancel'], defaultId: 1, cancelId: 1,
        message: `Install into "${target.name}"?`,
        detail: [
            `From: ${source}`, '',
            ...describeInstall(manifest, preview),
            ...(checked.warnings.length ? ['', ...checked.warnings.map((w) => `⚠ ${w}`)] : []),
            '',
            'Drivers are programs that run on this computer with access to your instruments. '
                + 'Only install drivers from sources you trust. The deck restarts to load them.',
        ].join('\n'),
    });
    if (response !== 0) return;
    try {
        await manager.install(target.id, manifest, { allowPaths: !!fromFile });
        broadcast('launcher:select', target.id);
    } catch (e) {
        await dialog.showMessageBox(parent, {
            type: 'error', message: 'Installing failed. The deck was not changed.',
            detail: `${e.message}\n\n${String(e.output || '').split('\n').slice(-25).join('\n')}`,
        });
    }
}

async function handleLink(link) {
    let url;
    try { url = new URL(link); } catch { return; }
    if (url.protocol !== `${LINK_SCHEME}:`) return;
    if (!manager) { pendingLinks.push(link); return; }
    const action = url.hostname || url.pathname.replace(/^\/+/, '');
    if (action !== 'install') {
        await dialog.showMessageBox(showLauncher(), { type: 'warning', message: `Unknown IvoryOS link: ${action}` });
        return;
    }
    try {
        const { text, source } = await manifestFromLink(url);
        await confirmAndInstall(text, { source });
    } catch (e) {
        await dialog.showMessageBox(showLauncher(), { type: 'error', message: 'Could not install from this link', detail: e.message });
    }
}

async function installFromFile() {
    const { canceled, filePaths } = await dialog.showOpenDialog(showLauncher(), {
        title: 'Install drivers from a deck file', filters: [{ name: 'IvoryOS deck', extensions: ['json'] }], properties: ['openFile'],
    });
    if (!canceled && filePaths[0]) await confirmAndInstall(fs.readFileSync(filePaths[0], 'utf8'), { source: filePaths[0], fromFile: filePaths[0] });
}

// --- the Hub catalog -------------------------------------------------------------------------------

async function hubFetch(pathAndQuery, init) {
    const url = `${manager.hubUrl}${pathAndQuery}`;
    let res;
    try {
        res = await net.fetch(url, init);
    } catch (e) {
        throw new Error(`Could not reach the Hub at ${manager.hubUrl} (${e.message}).`);
    }
    // A Hub without the catalog does not 404: its login redirect answers every unknown path with
    // the sign-in *page*. Read as JSON that became `{}`, so the launcher showed an empty catalog
    // and no error at all. Say what happened instead.
    const type = res.headers.get('content-type') || '';
    if (res.ok && !type.includes('json')) {
        throw new Error(/\/(auth\/)?login/.test(res.url)
            ? `The Hub at ${manager.hubUrl} answered with its sign-in page, not the driver catalog: it does not serve /api/catalog yet.`
            : `The Hub at ${manager.hubUrl} did not answer with a driver catalog.`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `The Hub answered ${res.status}.`);
    return body;
}

// --- IvoryOS Cloud ---------------------------------------------------------------------------------

/** Cloud's own /api/health: whether it answers, and whether it is really an IvoryOS Cloud. */
async function probeCloud(url) {
    try {
        const res = await net.fetch(`${url}/api/health`, { signal: AbortSignal.timeout(4000) });
        const body = await res.json().catch(() => null);
        return { ok: true, status: res.status, body, isCloud: !!(body && 'daemon' in body && 'store' in body) };
    } catch (e) {
        return { ok: false, error: e.name === 'TimeoutError' ? 'no answer within 4 seconds' : e.message };
    }
}

// A computer on this machine or the lab's network, where a Cloud normally serves plain http.
const LOCAL_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$|.+\.local$)/;

/**
 * Whether the Cloud address answers, so the launcher can say so rather than open a page that
 * never loads (the hosted Cloud is not live yet). When it does not, look for the likely fix: the
 * commonest slip is https for a local Cloud that serves http (the TLS handshake just fails), and
 * a Cloud started on this computer is usually on port 3000 (`next start`) or 3002 (dev).
 */
async function checkCloud() {
    const url = manager.cloudUrl;
    const found = await probeCloud(url);
    if (found.ok) {
        return { url, reachable: true, isCloud: found.isCloud, problems: (found.body && found.body.problems) || [] };
    }
    const candidates = [];
    try {
        const u = new URL(url);
        if (u.protocol === 'https:' && LOCAL_HOST.test(u.hostname)) {
            candidates.push({ url: url.replace(/^https:/, 'http:'), reason: 'It answers over http, not https.' });
        }
    } catch { /* not a URL; the error below says so */ }
    for (const port of [3000, 3002]) {
        candidates.push({ url: `http://localhost:${port}`, reason: 'An IvoryOS Cloud is running on this computer.' });
    }
    for (const c of candidates) {
        if (c.url === url) continue;
        const probe = await probeCloud(c.url);
        if (probe.ok && probe.isCloud) return { url, reachable: false, error: found.error, suggestion: c };
    }
    return { url, reachable: false, error: found.error };
}

// --- account ------------------------------------------------------------------------------------

let pendingOAuth = null; // {cancel()} while a browser sign-in is waiting

const signedInPage = (error) => `<!doctype html><meta charset="utf-8"><title>IvoryOS</title>
<body style="font:15px system-ui;display:flex;align-items:center;justify-content:center;height:90vh;color:#222">
<div style="text-align:center"><h2 style="margin:0 0 8px">${error ? 'Sign-in did not finish' : 'Signed in to IvoryOS'}</h2>
<p style="color:#666">${error ? String(error).replace(/[<>&]/g, '') : 'You can close this tab and go back to the app.'}</p></div>`;

/**
 * "Continue with GitHub / Google": the sign-in happens in the system browser (where the person is
 * already signed in to those, and where a password manager works), and comes back here through a
 * one-off listener on 127.0.0.1. PKCE: the code that arrives is useless without the verifier this
 * process holds, so another program that sees the redirect cannot use it.
 *
 * The Hub's Supabase project must allow the redirect ("http://127.0.0.1:*" followed by "/**" in
 * Authentication -> URL Configuration -> Redirect URLs). Without it Supabase sends the browser to
 * the Hub's home page instead, and this waits until cancelled.
 */
async function signInWithProvider(provider) {
    if (pendingOAuth) pendingOAuth.cancel();
    const { verifier, challenge } = pkcePair();
    const server = http.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const redirect = `http://127.0.0.1:${server.address().port}/callback`;
    try {
        const code = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('The sign-in was not finished in the browser within 5 minutes.')), 5 * 60 * 1000);
            pendingOAuth = { cancel: () => { clearTimeout(timer); reject(new Error('Sign-in cancelled.')); } };
            server.on('request', (req, res) => {
                const url = new URL(req.url, redirect);
                if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
                const got = url.searchParams.get('code');
                const error = url.searchParams.get('error_description') || url.searchParams.get('error');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(signedInPage(got ? null : error || 'No sign-in code came back.'));
                clearTimeout(timer);
                if (got) resolve(got); else reject(new Error(error || 'The sign-in did not return a code.'));
            });
            shell.openExternal(account.oauthUrl(provider, redirect, challenge));
        });
        await account.exchangeCode(code, verifier);
        await account.profile().catch(() => {});
        showLauncher();
        return account.describe();
    } finally {
        pendingOAuth = null;
        server.close();
    }
}

/** Account calls that change who is signed in or what they see: tell the launcher afterwards. */
function accountCall(fn) {
    return async (...args) => {
        try { return await fn(...args); } finally { broadcast('launcher:changed'); }
    };
}

// --- private drivers from GitHub / GitLab -----------------------------------------------------------

/** The preview plan gate (account.js): importing private repositories is a Pro feature. */
function requirePro() {
    const me = account.describe();
    if (!me.signedIn) throw new Error('Sign in to use private repositories.');
    if (me.plan !== 'pro') throw new Error('Private repositories are part of IvoryOS Pro. Upgrade from the account menu.');
}

/**
 * Download a repository at its current commit, install it into a deck's Python like any driver
 * (the deck lists the downloaded archive, not the token), and list the classes it provides so
 * the person can pick the instrument.
 */
async function importFromGit(profileId, provider, repoId, ref) {
    requirePro();
    const got = await git.download(provider, repoId, ref);
    await manager.install(profileId, { packages: [got.file], instruments: [] });
    const runtime = await getRuntime();
    // Passed with -c rather than as a file: in a packaged build this folder is inside app.asar,
    // which Electron can read and Python cannot.
    const code = fs.readFileSync(path.join(__dirname, 'scan_driver.py'), 'utf8');
    let scan;
    try {
        const out = await runProcess(runtime.python, ['-c', code, path.basename(got.file)]);
        scan = JSON.parse(out.trim().split(/\r?\n/).pop());
    } catch (e) {
        scan = { error: `Installed, but its classes could not be listed: ${String(e.output || e.message).trim().split('\n').pop()}` };
    }
    return { ...got, scan };
}

// --- IPC: what the launcher page may ask for ----------------------------------------------------

function fromLauncher(event) {
    const url = event.senderFrame ? event.senderFrame.url : '';
    if (!url.startsWith(`${APP_SCHEME}://`)) throw new Error('Only the launcher can do that.');
}

function handle(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
        fromLauncher(event);
        try {
            return { ok: true, value: await fn(...args) };
        } catch (e) {
            // Errors are returned, not thrown: Electron would otherwise prefix every message with
            // "Error invoking remote method", which is not something to show a scientist.
            return { ok: false, error: e.message, output: e.output };
        }
    });
}

function snapshot() {
    return {
        profiles: manager.list().map((p) => ({ ...p, windowOpen: edgeTabs.has(p.id) })),
        tabs: tabState(),
        runtime: runtimeStatus,
        hubUrl: manager.hubUrl,
        cloudUrl: manager.cloudUrl,
        dataRoot: home(),
        version: app.getVersion(),
        platform: process.platform,
        account: account.describe(),
        update: updates.status(),
        autoUpdate: manager.autoUpdate,
        // False where the OS has no keychain: sign-ins then last until the app quits.
        secretsPersist: safeStorage.isEncryptionAvailable(),
    };
}

function registerIpc() {
    handle('launcher:snapshot', () => snapshot());
    handle('launcher:create', (fields) => manager.create(fields));
    handle('launcher:update', (id, patch) => manager.update(id, patch));
    handle('launcher:remove', async (id) => { closeEdgeTab(id); await manager.remove(id); });
    handle('launcher:start', (id) => manager.start(id));
    handle('launcher:stop', async (id) => { closeEdgeTab(id); await manager.stop(id); });
    handle('launcher:restart', async (id) => { const status = await manager.restart(id); reloadEdgeTab(id); return status; });
    handle('launcher:open', (id, page) => openEdgeTab(id, page));
    handle('launcher:show-tab', (id) => showTab(id || null));
    handle('launcher:close-tab', (id) => closeEdgeTab(id));
    handle('launcher:tab-bar-height', (px) => { tabBarHeight = Math.max(0, Math.round(Number(px) || 0)); layoutTabs(); });
    // The edge is an ordinary web server: its page opens in any browser, on this machine (and on
    // others when the profile listens on the network).
    handle('launcher:open-in-browser', (id) => {
        const status = manager.statusOf(id);
        if (status.state !== 'running') throw new Error('Start the profile first.');
        return shell.openExternal(status.url);
    });
    handle('launcher:log', (id) => manager.logTail(id));
    handle('launcher:copy', (text) => clipboard.writeText(String(text || '')));
    handle('launcher:reveal', (id, what) => {
        const p = manager.get(id);
        const target = what === 'log' ? manager.logFile(id)
            : what === 'deck' ? p.deck
                : what === 'script' ? p.script
                    : p.dataDir || p.cwd || home();
        if (!target || !fs.existsSync(target)) throw new Error('That file does not exist yet.');
        shell.showItemInFolder(target);
    });
    handle('launcher:pick', async (kind) => {
        const opts = {
            script: { title: 'Choose a Python script', filters: [{ name: 'Python', extensions: ['py'] }], properties: ['openFile'] },
            python: { title: 'Choose a Python interpreter', properties: ['openFile', 'showHiddenFiles'] },
            folder: { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] },
        }[kind];
        if (!opts) throw new Error(`Unknown picker: ${kind}`);
        const { canceled, filePaths } = await dialog.showOpenDialog(showLauncher(), opts);
        return canceled ? null : filePaths[0];
    });
    handle('launcher:deck', (id) => manager.readDeck(id));
    handle('launcher:instrument:save', (id, originalName, entry) => manager.saveInstrument(id, originalName, entry));
    handle('launcher:instrument:remove', (id, name) => manager.removeInstrument(id, name));
    handle('launcher:instrument:enable', (id, name, enabled) => manager.setInstrumentEnabled(id, name, enabled));
    handle('launcher:install', (id, manifest) => manager.install(id, manifest));
    handle('launcher:install-file', () => installFromFile());
    handle('launcher:free-name', (id, suggestion) => freeName(manager.readDeck(id), suggestion));
    handle('launcher:rebuild-python', async () => {
        await manager.stopAll();
        const runtime = await getRuntime().catch(() => null);
        if (runtime) runtime.reset();
        runtimePromise = null;
        await getRuntime();
    });
    handle('hub:set-url', (url) => manager.setHubUrl(url));
    handle('cloud:set-url', (url) => manager.setCloudUrl(url));
    handle('cloud:open', () => openCloudTab());
    handle('cloud:open-in-browser', () => shell.openExternal(manager.cloudUrl));
    handle('cloud:check', () => checkCloud());
    // Python environments the person also uses from their own editor.
    handle('python:launcher', async () => (await getRuntime()).python);
    handle('python:inspect', async (python) => (await getRuntime()).inspect(python || (await getRuntime()).python));
    handle('python:create-venv', async (folder) => {
        if (!folder || !fs.existsSync(folder)) throw new Error('Choose an existing folder first.');
        return (await getRuntime()).createProjectVenv(folder);
    });
    handle('python:install-edge', async (python) => { await (await getRuntime()).installEdgeInto(python); });
    handle('hub:search', (q) => hubFetch(`/api/catalog/modules?limit=60&q=${encodeURIComponent(q || '')}`));
    // The whole catalog as cards, for the category browser. A Hub from before /browse existed
    // answers 404; its search endpoint gives the same cards, capped at 200.
    handle('hub:browse', async () => {
        try {
            return await hubFetch('/api/catalog/browse');
        } catch (e) {
            if (!/404/.test(e.message)) throw e;
            return hubFetch('/api/catalog/modules?limit=200');
        }
    });
    handle('hub:module', (moduleId) => hubFetch(`/api/catalog/modules/${encodeURIComponent(moduleId)}`));
    handle('hub:entry', (payload) => hubFetch('/api/catalog/deck-entry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }));

    // Account: the Hub's accounts. The page gets `describe()` (who, which plan), never a token.
    handle('account:get', accountCall(async () => {
        if (account.describe().signedIn) {
            await account.refreshUser().catch(() => {});
            await account.profile().catch(() => {});
        }
        return account.describe();
    }));
    handle('account:sign-in', accountCall(async (email, password) => {
        await account.signIn(email, password);
        await account.profile().catch(() => {});
        return account.describe();
    }));
    handle('account:sign-up', accountCall((email, password, name) => account.signUp(email, password, name)));
    handle('account:reset-password', (email) => account.resetPassword(email));
    handle('account:oauth', accountCall((provider) => signInWithProvider(provider)));
    handle('account:oauth-cancel', () => { if (pendingOAuth) pendingOAuth.cancel(); });
    handle('account:sign-out', accountCall(() => account.signOut()));
    handle('account:update-profile', accountCall(async (fields) => { await account.updateProfile(fields || {}); return account.describe(); }));
    handle('account:change-password', (password) => account.changePassword(password));
    handle('account:set-plan', accountCall((plan) => account.setPlan(plan)));
    handle('account:open-hub', (page) => {
        const pages = { profile: '/hub/profile', signup: '/auth/sign-up', home: '' };
        return shell.openExternal(`${manager.hubUrl}${pages[page] ?? ''}`);
    });

    // Private repositories (Pro): tokens stay in this process, encrypted on disk.
    handle('git:list', () => git.list());
    handle('git:connect', (provider, token, host) => { requirePro(); return git.connect(provider, token, host); });
    handle('git:disconnect', (provider) => git.disconnect(provider));
    handle('git:repos', (provider, query) => { requirePro(); return git.repos(provider, query); });
    handle('git:import', (profileId, provider, repoId, ref) => importFromGit(profileId, provider, repoId, ref));
    handle('git:token-page', (provider) => {
        const c = git.list().find((x) => x.provider === provider);
        if (!c) throw new Error(`Unknown provider: ${provider}`);
        return shell.openExternal(c.tokenHelp);
    });

    // The app itself.
    handle('update:check', () => updates.check());
    handle('update:download', () => updates.download());
    handle('update:install', () => updates.install(async () => { quitting = true; await manager.stopAll(); }));
    handle('update:open-page', () => {
        const u = updates.status();
        return shell.openExternal(u.downloadUrl || u.releaseUrl || 'https://github.com/ivoryzh/ivoryos-next/releases');
    });
    handle('app:set-auto-update', (on) => { manager.setAutoUpdate(on); broadcast('launcher:changed'); });
    handle('app:reveal-data', () => shell.openPath(home()));
}

// --- menus ---------------------------------------------------------------------------------------

/**
 * On Windows and Linux the menu bar sits inside the window, above the launcher's own tab bar, and
 * everything in it is also in the launcher (Settings, the account corner, each deck's buttons).
 * So there is none; the useful keys are kept by `addShortcuts`. macOS keeps its menu: it lives at
 * the top of the screen, not in the window, and text fields need its Edit roles for copy/paste.
 */
function buildMenu() {
    const isMac = process.platform === 'darwin';
    if (!isMac) {
        Menu.setApplicationMenu(null);
        return;
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        ...(isMac ? [{ role: 'appMenu' }] : []),
        {
            label: 'File',
            submenu: [
                { label: 'Show Launcher', accelerator: 'CmdOrCtrl+L', click: () => { showLauncher(); showTab(null); } },
                { label: 'Install Drivers from Deck File…', click: () => installFromFile() },
                { type: 'separator' },
                isMac ? { role: 'close' } : { role: 'quit' },
            ],
        },
        // Without the Edit menu's roles, copy and paste do not work in text fields on macOS.
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
    ]));
}

/** Keyboard shortcuts the menu used to provide, for any page shown in the window (not macOS). */
function addShortcuts(contents) {
    if (process.platform === 'darwin') return;
    contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        const key = String(input.key || '').toLowerCase();
        const ctrl = input.control || input.meta;
        const act = (fn) => { event.preventDefault(); fn(); };
        if (ctrl && !input.shift && key === 'l') act(() => { showLauncher(); showTab(null); });
        else if ((ctrl && !input.shift && key === 'r') || key === 'f5') act(() => contents.reload());
        else if ((ctrl && input.shift && key === 'i') || key === 'f12') act(() => contents.toggleDevTools());
        else if (ctrl && (key === '=' || key === '+')) act(() => contents.setZoomLevel(contents.getZoomLevel() + 0.5));
        else if (ctrl && key === '-') act(() => contents.setZoomLevel(contents.getZoomLevel() - 0.5));
        else if (ctrl && key === '0') act(() => contents.setZoomLevel(0));
        else if (ctrl && key === 'tab') {
            act(() => {
                const order = [null, ...edgeTabs.keys()];
                const at = order.indexOf(activeTab);
                showTab(order[(at + (input.shift ? order.length - 1 : 1)) % order.length]);
            });
        }
    });
}

// --- app lifecycle -------------------------------------------------------------------------------

// ivoryos:// links. On macOS they arrive as 'open-url' (possibly before the app is ready); on
// Windows and Linux as the argv of a second instance, which is why only one may run.
if (!SMOKE_TEST) {
    if (!app.requestSingleInstanceLock()) {
        app.quit();
    } else {
        app.on('second-instance', (_event, argv) => {
            const link = argv.find((a) => a.startsWith(`${LINK_SCHEME}://`));
            if (link) handleLink(link); else showLauncher();
        });
    }
    if (process.defaultApp && process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
    } else {
        app.setAsDefaultProtocolClient(LINK_SCHEME);
    }
}
app.on('open-url', (event, link) => {
    event.preventDefault();
    if (app.isReady() && manager) handleLink(link); else pendingLinks.push(link);
});
const startupLink = process.argv.find((a) => a.startsWith(`${LINK_SCHEME}://`));
if (startupLink) pendingLinks.push(startupLink);

function serveFrontend() {
    // ivoryos-app://ui/<path> -> <frontend build>/<path>. The Next export uses trailing-slash
    // routes, so a folder means its index.html.
    protocol.handle(APP_SCHEME, async (request) => {
        const root = resources().frontendDir;
        if (!root) return new Response('The IvoryOS UI is not bundled with this build.', { status: 404 });
        const rel = decodeURIComponent(new URL(request.url).pathname);
        let file = path.normalize(path.join(root, rel));
        if (!file.startsWith(path.normalize(root))) return new Response('Not found', { status: 404 });
        try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { /* 404 below */ }
        if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(file).toString());
    });
}

app.whenReady().then(async () => {
    // Packaged builds take name and icon from electron-builder (build/icon.png, productName). A
    // development run is the stock Electron binary, so set the Dock icon by hand.
    if (process.platform === 'darwin' && app.dock && fs.existsSync(ICON)) app.dock.setIcon(nativeImage.createFromPath(ICON));
    serveFrontend();
    manager = new ProfileManager({ home: home(), getRuntime, frontendDir: resources().frontendDir });
    manager.on('changed', () => broadcast('launcher:changed'));
    manager.on('log', (id, line) => broadcast('launcher:log', id, line));
    manager.on('crashed', (id) => closeEdgeTab(id));
    account = new Account({ fetch: (...a) => net.fetch(...a), store: secretFile(path.join(home(), 'account.bin'), safeStorage) });
    git = new GitConnections({
        fetch: (...a) => net.fetch(...a),
        store: secretFile(path.join(home(), 'git.bin'), safeStorage),
        downloadDir: path.join(home(), 'private-packages'),
    });
    updates = new Updates({
        currentVersion: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        fetch: (...a) => net.fetch(...a),
        loadAutoUpdater: () => require('electron-updater').autoUpdater,
        autoDownload: () => manager.autoUpdate,
    });
    updates.on('changed', () => broadcast('launcher:changed'));

    registerIpc();
    buildMenu();
    showLauncher();
    getRuntime().catch(() => {}); // warm Python up while the launcher draws

    if (SMOKE_TEST) return smokeTest();
    updates.schedule();

    for (const p of manager.list().filter((x) => x.autoStart)) manager.start(p.id).catch(() => {});
    while (pendingLinks.length) await handleLink(pendingLinks.shift());
});

/**
 * `--smoke-test`: start Python, start the first profile (or IVORYOS_SMOKE_PROFILE), check the
 * launcher page rendered, print one JSON line, exit. For CI and for checking a packaged build on
 * a new machine.
 */
async function smokeTest() {
    const report = { ok: false };
    try {
        const profiles = manager.list();
        const target = profiles.find((p) => p.name === process.env.IVORYOS_SMOKE_PROFILE) || profiles[0];
        const status = await manager.start(target.id);
        const body = await (await net.fetch(`${status.url}/api/status`)).json();
        await new Promise((resolve) => {
            if (!launcherWindow.webContents.isLoading()) resolve();
            else launcherWindow.webContents.once('did-finish-load', resolve);
        });
        // Through the page's own bridge, as a click would: proves the scheme, the preload, and
        // that the launcher origin passes the IPC guard.
        const launcher = await launcherWindow.webContents.executeJavaScript(`(async () => {
            await new Promise(r => setTimeout(r, 1500));
            const api = window.ivoryosDesktop;
            const snap = api ? await api.snapshot() : null;
            let hub = null;
            if (api && ${JSON.stringify(!!process.env.IVORYOS_SMOKE_HUB)}) {
                try { hub = (await api.hubSearch(${JSON.stringify(process.env.IVORYOS_SMOKE_HUB || '')})).modules.length; } catch (e) { hub = 'error: ' + e.message; }
            }
            return { url: location.href, heading: (document.querySelector('h1') || {}).textContent || '',
                     profiles: snap ? snap.profiles.map(p => p.name + ':' + p.status.state) : null, hub };
        })()`);
        // Open the edge as a tab, as the Open button does, and check it is shown in this window.
        await launcherWindow.webContents.executeJavaScript(`window.ivoryosDesktop.open(${JSON.stringify(target.id)})`);
        const view = edgeTabs.get(target.id);
        await new Promise((resolve) => (view.webContents.isLoading() ? view.webContents.once('did-finish-load', resolve) : resolve()));
        await new Promise((r) => setTimeout(r, 1500));
        launcher.tab = { ...tabState(), url: view.webContents.getURL(), bounds: view.getBounds(), attached: launcherWindow.contentView.children.includes(view) };
        if (process.env.IVORYOS_SMOKE_SCREENSHOT) {
            const base = process.env.IVORYOS_SMOKE_SCREENSHOT.replace(/\.png$/, '');
            fs.writeFileSync(`${base}-window.png`, (await launcherWindow.webContents.capturePage()).toPNG());
            fs.writeFileSync(`${base}-tab.png`, (await view.webContents.capturePage()).toPNG());
            // Two launcher pages, reached by clicking as a person would: the Cloud page, then the
            // Hub browser on the target deck.
            showTab(null);
            const click = (text, scope = 'body') => launcherWindow.webContents.executeJavaScript(`(async () => {
                const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find(el => el.textContent.includes(${JSON.stringify(text)}));
                if (b) b.click();
                await new Promise(r => setTimeout(r, 2500));
                return !!b;
            })()`);
            launcher.cloudPage = await click('IvoryOS Cloud');
            fs.writeFileSync(`${base}-cloud.png`, (await launcherWindow.webContents.capturePage()).toPNG());
            // Accept a suggested Cloud address if one is offered, then open Cloud as a tab.
            launcher.cloudSuggestion = await click('Use ', 'main');
            launcher.cloudTab = await click('Open IvoryOS Cloud', 'main');
            const cloudView = edgeTabs.get(CLOUD_TAB);
            if (cloudView) {
                await new Promise((r) => setTimeout(r, 2500));
                launcher.cloudTabUrl = cloudView.webContents.getURL();
                fs.writeFileSync(`${base}-cloudtab.png`, (await cloudView.webContents.capturePage()).toPNG());
            }
            showTab(null);
            launcher.hubBrowser = (await click(target.name, 'nav')) && (await click('Add from Hub', 'main'));
            fs.writeFileSync(`${base}-hub.png`, (await launcherWindow.webContents.capturePage()).toPNG());
            launcher.privateRepos = await click('Private repositories');
            fs.writeFileSync(`${base}-private.png`, (await launcherWindow.webContents.capturePage()).toPNG());
            // The app-wide pages: Settings (the gear), the account form, and the plan dialog.
            const shoot = async (name, js) => {
                const found = await launcherWindow.webContents.executeJavaScript(`(async () => {
                    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
                    await new Promise(r => setTimeout(r, 300));
                    const el = ${js};
                    if (el) el.click();
                    await new Promise(r => setTimeout(r, 1500));
                    return !!el;
                })()`);
                fs.writeFileSync(`${base}-${name}.png`, (await launcherWindow.webContents.capturePage()).toPNG());
                return found;
            };
            launcher.settings = await shoot('settings', `document.querySelector('nav button[title^="Settings"]')`);
            launcher.signIn = await shoot('account', `[...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === 'Sign in')`);
            launcher.upgrade = await shoot('upgrade', `[...document.querySelectorAll('nav button')].find(b => b.textContent.includes('IvoryOS Cloud'))`);
            // The profile's own Configuration / Settings tab (its Cloud connection card).
            await shoot('profile', `[...document.querySelectorAll('nav button')].find(b => b.textContent.includes(${JSON.stringify(target.name)}))`);
            await new Promise((r) => setTimeout(r, 6000)); // a Cloud status poll or two
            launcher.profileSettings = await shoot('profile-settings', `[...document.querySelectorAll('main button')].find(b => ['Configuration', 'Settings'].includes(b.textContent.trim()))`);
            await shoot('profile-cloud', `(([...document.querySelectorAll('h3')].find(h => h.textContent.includes('Cloud connection')) || { scrollIntoView() {} }).scrollIntoView({ block: 'center' }), null)`);
        }
        launcher.menuBar = Menu.getApplicationMenu() ? 'present' : 'none';
        if (process.env.IVORYOS_SMOKE_UPDATE) launcher.update = await updates.check();
        Object.assign(report, {
            ok: true,
            profile: target.name,
            url: status.url,
            instruments: Object.keys(body.instruments || {}),
            instrument_errors: (body.instrument_errors || []).map((e) => `${e.name}: ${e.stage}`),
            launcher,
        });
    } catch (e) {
        report.error = e.message;
    }
    console.log(`SMOKE ${JSON.stringify(report)}`);
    await manager.stopAll();
    app.exit(report.ok ? 0 : 1);
}

app.on('activate', () => showLauncher());

// Closing the last window does not stop running decks on macOS (the Dock icon keeps the app, and
// its edges, alive); elsewhere it quits, which stops them.
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// Stop every edge before exiting, so each can close its serial ports and database cleanly rather
// than being orphaned or killed mid-write.
app.on('before-quit', (event) => {
    if (quitting || !manager || manager.running.size === 0) return;
    event.preventDefault();
    quitting = true;
    manager.stopAll().finally(() => app.quit());
});
