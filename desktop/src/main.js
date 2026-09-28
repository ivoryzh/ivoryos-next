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

const { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, shell, net, protocol, clipboard, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { ProfileManager } = require('./manager');
const { PythonRuntime } = require('./runtime');
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
}

// --- menus ---------------------------------------------------------------------------------------

function buildMenu() {
    const isMac = process.platform === 'darwin';
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

    registerIpc();
    buildMenu();
    showLauncher();
    getRuntime().catch(() => {}); // warm Python up while the launcher draws

    if (SMOKE_TEST) return smokeTest();

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
        }
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
