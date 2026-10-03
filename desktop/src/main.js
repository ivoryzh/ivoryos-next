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

const { app, BrowserWindow, WebContentsView, Menu, Notification, Tray, dialog, ipcMain, shell, net, protocol, clipboard, nativeImage, nativeTheme, safeStorage } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { ProfileManager } = require('./manager');
const { PythonRuntime, run: runProcess } = require('./runtime');
const { Account, pkcePair } = require('./account');
const { HubCatalog } = require('./hubCatalog');
const { GitConnections } = require('./gitRepos');
const { secretFile } = require('./secrets');
const { Updates } = require('./updater');
const { resolveResources, REPO_ROOT } = require('./resources');
const { exampleSource, materializeExample } = require('./example');
const { validateManifest, mergeIntoDeck, describeInstall, ManifestError } = require('./manifest');
const { freeName } = require('./deckEdit');
const report = require('./problemReport');
const { AttentionWatcher } = require('./attention');
const { OPTIMIZERS, selectionOf } = require('./optimizers');
const { parseInstallLink } = require('./installLink');
const os = require('node:os');
const crypto = require('node:crypto');

const SMOKE_TEST = process.argv.includes('--smoke-test');
// A release build does not offer Cloud yet: its sidebar row asks for early access instead, and the
// decks it starts hide their Cloud pages. Nothing Cloud is removed. IVORYOS_ENABLE_CLOUD=1 turns it
// back on in a packaged app; IVORYOS_CLOUD_COMING_SOON=1 shows the release behaviour in development.
const CLOUD_COMING_SOON = (app.isPackaged && process.env.IVORYOS_ENABLE_CLOUD !== '1') || process.env.IVORYOS_CLOUD_COMING_SOON === '1';
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
// The launcher's sidebar stays usable beside an edge or Cloud tab: the page reports its width (0
// when hidden) and tabs are laid out to the right of it.
let sidebarWidth = 0;
// macOS icons are a tile; Windows and Linux icons are their own shape (scripts/make-icon.py).
const ICON = path.join(__dirname, '..', 'build', process.platform === 'darwin' ? 'icon.png' : 'icon-win.png');
let manager = null;
let account = null;
let catalog = null; // the Automation Hub, read from its database (hubCatalog.js)
let git = null;
let updates = null;
let runtimePromise = null;
let runtimeStatus = { state: 'idle', message: '' };
let quitting = false;
// Set as soon as the app is really quitting (tray Quit, an update install, the OS logging off),
// so closing the window then closes it instead of hiding it in the tray.
let exiting = false;
let tray = null;
let trayMenuLabels = []; // what the tray menu last showed, for the smoke test to report
const pendingLinks = [];
// An `ivoryos://install` link from the Hub, waiting for the launcher to open its install screen on
// it (installLink.js). The page takes it when told, or on load if the link started the app.
let pendingHubLink = null;

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

// --- notifications --------------------------------------------------------------------------------

// Every running deck is watched for what needs a person (attention.js): a User input waiting for an
// answer, or a failed step waiting for retry, skip or stop. Each becomes one system notification
// that opens the deck, so a run waiting on someone is noticed with the app in the background, or
// with no tab open on that deck at all.
let attention = null;
const shownNotifications = new Set(); // held until clicked or closed: macOS drops a collected one's click

function watchRunningDecks() {
    if (!attention) return;
    attention.sync(manager.list()
        .filter((p) => p.status.state === 'running' && p.status.url)
        .map((p) => ({ id: p.id, name: p.name, url: p.status.url })));
}

function notifyAttention(item) {
    if (!Notification.isSupported()) return;
    // Looking at that deck already: its own pop-up says it.
    if (launcherWindow && !launcherWindow.isDestroyed() && launcherWindow.isFocused() && activeTab === item.deckId) return;
    const note = new Notification({
        title: `${item.title} · ${item.deckName}`,
        body: item.run_name ? `${item.run_name}: ${item.body}` : item.body,
    });
    shownNotifications.add(note);
    const forget = () => shownNotifications.delete(note);
    note.on('click', () => {
        forget();
        showLauncher();
        openEdgeTab(item.deckId);
    });
    note.on('close', forget);
    note.show();
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
        // No separate title bar: the launcher's own slim bar is the window's title bar (draggable,
        // with the sidebar toggle), and the system's window buttons sit on it -- an overlay on
        // Windows/Linux, the inset traffic lights on macOS.
        ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay() }),
        ...(fs.existsSync(ICON) ? { icon: ICON } : {}),
    });
    keepToOrigin(launcherWindow, (url) => url.startsWith(`${APP_SCHEME}://`));
    addShortcuts(launcherWindow.webContents);
    if (resources().frontendDir) launcherWindow.loadURL(LAUNCHER_URL);
    else launcherWindow.loadFile(path.join(__dirname, 'status.html')); // a build without the UI
    launcherWindow.on('resize', layoutTabs);
    // The tray (Windows/Linux): minimizing, and closing, hide the window instead, so running
    // decks are not one misclick away from being stopped. macOS keeps its own conventions:
    // minimize goes to the Dock, and closing the window already leaves the app running.
    launcherWindow.on('minimize', (event) => {
        if (!tray || process.platform === 'darwin' || !manager || !manager.windowPref('minimizeToTray')) return;
        event.preventDefault();
        launcherWindow.hide();
    });
    launcherWindow.on('close', (event) => {
        if (exiting || !tray || process.platform === 'darwin' || !manager || !manager.windowPref('closeToTray')) return;
        event.preventDefault();
        launcherWindow.hide();
        // Once, so "I closed it but it is still running" is never a surprise.
        if (!manager.windowPref('trayHintShown')) {
            manager.setWindowPref('trayHintShown', true);
            const running = manager.running.size;
            tray.displayBalloon?.({
                iconType: 'info',
                title: 'IvoryOS is still running',
                content: `${running ? `${running} deck${running === 1 ? ' keeps' : 's keep'} running. ` : ''}Open it from the tray icon, or Quit there. Settings can change this.`,
            });
        }
    });
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
            view.setBounds({ x: sidebarWidth, y: tabBarHeight, width: Math.max(0, width - sidebarWidth), height: Math.max(0, height - tabBarHeight) });
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

// An edge that was restarted (a deck edit, an install, Restart) comes back as a new process on
// the same address; its open tab still shows the old page, or a connection error. Reload the tab
// the moment the edge reports ready, so what the tab shows is always the edge that is running.
const lastState = new Map();
function reloadReturnedTabs() {
    for (const p of manager.list()) {
        const was = lastState.get(p.id);
        lastState.set(p.id, p.status.state);
        if (p.status.state === 'running' && was && was !== 'running' && edgeTabs.has(p.id)) {
            edgeTabs.get(p.id).webContents.reload();
        }
    }
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

/**
 * The app's one theme, on every page it shows. `nativeTheme` is what each page sees as
 * `prefers-color-scheme`, and every IvoryOS page follows that inside the app (shared-ui theme.tsx)
 * -- the launcher, each deck's UI and Cloud alike, whatever each once stored for itself.
 */
/** The window buttons' strip, in the launcher bar's colours (page.tsx header) for the theme. */
const TITLE_BAR_HEIGHT = 36;
function titleBarOverlay() {
    const dark = nativeTheme.shouldUseDarkColors;
    return { color: dark ? '#111111' : '#ffffff', symbolColor: dark ? '#d1d5db' : '#4b5563', height: TITLE_BAR_HEIGHT };
}

function refreshTitleBar() {
    if (launcherWindow && !launcherWindow.isDestroyed() && process.platform !== 'darwin') {
        try { launcherWindow.setTitleBarOverlay(titleBarOverlay()); } catch { /* no overlay on this window */ }
    }
}

function applyTheme() {
    nativeTheme.themeSource = manager.theme;
    refreshTitleBar();
    const view = edgeTabs.get(CLOUD_TAB);
    if (view) setCloudThemeCookie(view, manager.cloudUrl);
}

/**
 * Cloud renders `<html>` in the theme its `theme` cookie names, so without this its first paint is
 * its default (dark) even inside a light app, and corrects only once its page script runs.
 */
function setCloudThemeCookie(view, url) {
    view.webContents.session.cookies.set({
        url, name: 'theme', value: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
        path: '/', expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
    }).catch(() => { /* a bad address: the tab says so itself */ });
}

/**
 * Sign the Cloud tab in with the account the app is signed in to, so one sign-in covers both. The
 * app's main process sends its IvoryOS tokens to Cloud (`/api/auth/exchange`, which checks them
 * with the IvoryOS account service) and puts the session cookie that comes back into the tab; no
 * page ever holds a token. Only to an https Cloud, or one on this computer or the lab's network:
 * a Cloud address is a setting, and the tokens are the person's login. Otherwise, and whenever
 * anything fails, the tab simply shows Cloud's own sign-in page.
 */
async function signInCloudTab(view, url) {
    try {
        if (!account.describe().signedIn) return;
        const u = new URL(url);
        if (u.protocol !== 'https:' && !LOCAL_HOST.test(u.hostname)) return;
        const jar = view.webContents.session.cookies;
        const [kept] = await jar.get({ url, name: 'ivoryos_session' });
        if (kept) {
            // A cookie is not a session: Cloud may have ended it (expired, signed out there, its
            // database replaced). Keeping a dead one left the tab signed out for good, every page
            // loading and every call answering 401, since a new one was only made when none existed.
            const check = await net.fetch(`${u.origin}/api/auth/session`, {
                headers: { Cookie: `ivoryos_session=${kept.value}` }, signal: AbortSignal.timeout(5_000),
            }).catch(() => null);
            if (!check || check.status !== 401) return; // valid, or Cloud unreachable: leave it be
            await jar.remove(u.origin, 'ivoryos_session');
        }
        const token = await account.token();
        if (!token) return;
        const res = await net.fetch(`${u.origin}/api/auth/exchange`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: account.session && account.session.refresh_token }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return;
        const { session } = await res.json();
        if (!session) return;
        await jar.set({
            url: u.origin, name: 'ivoryos_session', value: session, path: '/', httpOnly: true,
            secure: u.protocol === 'https:', sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        });
    } catch { /* the tab shows Cloud's own sign-in */ }
}

/** Signing out of the app signs the Cloud tab out too, and ends the sessions kept for pairing. */
async function signOutCloudTab() {
    for (const [origin, s] of cloudSessions) {
        net.fetch(`${origin}/api/auth/sign-out`, { method: 'POST', headers: { Cookie: `ivoryos_session=${s.id}` } }).catch(() => {});
    }
    cloudSessions.clear();
    const view = edgeTabs.get(CLOUD_TAB);
    if (!view) return;
    const url = manager.cloudUrl;
    try {
        await net.fetch(`${new URL(url).origin}/api/auth/sign-out`, { method: 'POST' }).catch(() => {});
        await view.webContents.session.cookies.remove(new URL(url).origin, 'ivoryos_session');
    } catch { /* best effort */ }
    view.webContents.reload();
}

async function openCloudTab() {
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
        edgeTabs.set(CLOUD_TAB, view);
        await setCloudThemeCookie(view, url);
        await signInCloudTab(view, url);
        view.webContents.loadURL(url);
    }
    showTab(CLOUD_TAB);
}

/** After a restart from the launcher, the tab's page points at a process that no longer exists. */
function reloadEdgeTab(id) {
    const view = edgeTabs.get(id);
    if (view) view.webContents.reload();
}

// --- installs from links and files ---------------------------------------------------------------

/** Fetch the manifest an `ivoryos://install?manifest=https://…` link points at. */
async function manifestFromLink(url) {
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
    const target = pick < decks.length ? decks[pick]
        : manager.create({ kind: 'deck', name: manifest.name || 'New deck', port: await manager.freePort() });

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
        // Hub ids: shown on the launcher's own install screen, read from the Hub; nothing installs
        // until the person chooses Install there.
        const request = parseInstallLink(url);
        if (request) {
            pendingHubLink = request;
            showLauncher();
            broadcast('launcher:hub-link');
            return;
        }
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

/**
 * A Cloud session for this process, made from the app's IvoryOS sign-in (`/api/auth/exchange`,
 * the same door the Cloud tab uses) and kept per Cloud address. The same rules as signInCloudTab:
 * the tokens are the person's login, so they only go to an https Cloud or one on the lab network.
 */
const cloudSessions = new Map(); // origin -> { id, workspaces }
async function mainCloudSession(origin, { fresh = false } = {}) {
    if (!fresh && cloudSessions.has(origin)) return cloudSessions.get(origin);
    const u = new URL(origin);
    if (u.protocol !== 'https:' && !LOCAL_HOST.test(u.hostname)) return null;
    if (!account.describe().signedIn) return null;
    const token = await account.token();
    if (!token) return null;
    const res = await net.fetch(`${origin}/api/auth/exchange`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: account.session && account.session.refresh_token }),
        signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.session) throw new Error(body.error || `Cloud refused the sign-in (${res.status}).`);
    const session = { id: body.session, workspaces: body.workspaces || (body.workspace ? [body.workspace] : []) };
    cloudSessions.set(origin, session);
    return session;
}

/**
 * Connect a running deck to Cloud in one step. The deck starts pairing (it shows a code and keeps
 * the secret that collects its credentials; the app never sees the token), and the app approves
 * that code on Cloud with its own sign-in, through the same route a person uses on Cloud's page.
 *
 * Answers `choose-workspace` when the account has several and none was given, and `sign-in-needed`
 * (with the code) when the app is not signed in, so the person approves it on Cloud themselves.
 * The deck pairs under its own lasting id, so a deck paired before simply reconnects.
 */
async function pairWithCloud(profileId, { workspace, name } = {}) {
    const profile = manager.get(profileId);
    const status = manager.statusOf(profileId);
    if (!profile || status.state !== 'running' || !status.url) throw new Error('Start the deck first.');
    const origin = new URL(manager.cloudUrl).origin;

    let session = await mainCloudSession(origin);
    if (session && !workspace && session.workspaces.length > 1) {
        return { status: 'choose-workspace', workspaces: session.workspaces };
    }

    const deckName = (name || profile.name || '').trim();
    const started = await net.fetch(`${status.url}/api/cloud-settings/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloud_url: manager.cloudUrl, name: deckName }),
        signal: AbortSignal.timeout(30_000),
    });
    const pairing = await started.json().catch(() => ({}));
    if (!started.ok || !pairing.code) throw new Error(pairing.error || 'The deck could not start pairing.');
    const pairingCode = pairing.code;
    const approveUrl = pairing.approve_url;
    if (!session) return { status: 'sign-in-needed', code: pairingCode, approveUrl };

    const approve = (s) => net.fetch(`${origin}/api/pair/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `ivoryos_session=${s.id}` },
        body: JSON.stringify({ code: pairingCode, decision: 'approve', name: deckName, workspace }),
        signal: AbortSignal.timeout(15_000),
    });
    let res = await approve(session);
    if (res.status === 401) { // the kept session ended (signed out on Cloud, expired): make a new one
        session = await mainCloudSession(origin, { fresh: true });
        if (!session) return { status: 'sign-in-needed', code: pairingCode, approveUrl };
        res = await approve(session);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        await cancelCloudPairing(profileId); // leave nothing waiting on the deck for a refused request
        throw new Error(body.error || `Cloud did not approve the deck (${res.status}).`);
    }
    return { status: 'approved', code: pairingCode, name: body.name, workspace: body.workspace && body.workspace.name };
}

/** Stop a deck's pairing in progress (it stops showing its code and stops asking Cloud). */
async function cancelCloudPairing(profileId) {
    const status = manager.statusOf(profileId);
    if (status.state !== 'running' || !status.url) return;
    await net.fetch(`${status.url}/api/cloud-settings/pair`, { method: 'DELETE' }).catch(() => {});
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

const REPORT_REPO = 'ivoryzh/ivoryos-next';
const app_version = () => app.getVersion();
/** What problem reports mask: the home folder (usually the person's name) and the user name. */
function reportContext() {
    let username = null;
    try { username = os.userInfo().username; } catch { /* no passwd entry */ }
    return { home: os.homedir(), username };
}

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
        tray: { available: !!tray, minimizeToTray: manager.windowPref('minimizeToTray'), closeToTray: manager.windowPref('closeToTray') },
        theme: manager.theme,
        cloudOnly: manager.cloudOnly,
        cloudComingSoon: CLOUD_COMING_SOON,
        // False where the OS has no keychain: sign-ins then last until the app quits.
        secretsPersist: safeStorage.isEncryptionAvailable(),
    };
}

function registerIpc() {
    handle('launcher:snapshot', () => snapshot());
    handle('launcher:create', async (fields) => manager.create({ ...fields, port: (fields && fields.port) || await manager.freePort() }));
    handle('launcher:update', (id, patch) => manager.update(id, patch));
    handle('launcher:remove', async (id) => { closeEdgeTab(id); await manager.remove(id); });
    handle('launcher:start', (id) => manager.start(id));
    handle('launcher:stop', async (id) => { closeEdgeTab(id); await manager.stop(id); });
    handle('launcher:restart', async (id) => { const status = await manager.restart(id); reloadEdgeTab(id); return status; });
    handle('launcher:open', (id, page) => openEdgeTab(id, page));
    handle('launcher:show-tab', (id) => showTab(id || null));
    handle('launcher:close-tab', (id) => closeEdgeTab(id));
    handle('launcher:tab-bar-height', (px) => { tabBarHeight = Math.max(0, Math.round(Number(px) || 0)); layoutTabs(); });
    handle('launcher:sidebar-width', (px) => { sidebarWidth = Math.max(0, Math.round(Number(px) || 0)); layoutTabs(); });
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
    // A script profile's code, for the Code tab: the one file, read and written in place. A
    // script is what the person wrote, so nothing here reformats it or checks it -- Restart does.
    handle('launcher:script:read', (id) => {
        const p = manager.get(id);
        if (p.kind !== 'script' || !p.script) throw new Error('This profile does not run a script.');
        return fs.readFileSync(p.script, 'utf8');
    });
    handle('launcher:script:write', (id, text) => {
        const p = manager.get(id);
        if (p.kind !== 'script' || !p.script) throw new Error('This profile does not run a script.');
        if (typeof text !== 'string') throw new Error('Expected the script text.');
        fs.writeFileSync(p.script, text);
    });
    // "Try the example": the simulated lab as a script profile of its own (example.js).
    handle('launcher:example', () => {
        const src = exampleSource({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: REPO_ROOT });
        if (!src) throw new Error('The example is not bundled with this build.');
        const existing = manager.list().find((p) => p.kind === 'script' && p.script === path.join(home(), 'example', 'example_lab.py'));
        if (existing) return existing;
        const profile = manager.create(materializeExample(home(), src));
        broadcast('launcher:changed');
        return manager.list().find((p) => p.id === profile.id);
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
    handle('cloud:pair', (profileId, opts) => pairWithCloud(profileId, opts || {}));
    handle('cloud:pair-cancel', (profileId) => cancelCloudPairing(profileId));
    // Python environments the person also uses from their own editor.
    handle('python:launcher', async () => (await getRuntime()).python);
    handle('python:inspect', async (python) => (await getRuntime()).inspect(python || (await getRuntime()).python));
    handle('python:create-venv', async (folder) => {
        if (!folder || !fs.existsSync(folder)) throw new Error('Choose an existing folder first.');
        return (await getRuntime()).createProjectVenv(folder);
    });
    handle('python:install-edge', async (python) => { await (await getRuntime()).installEdgeInto(python); });
    // The Automation Hub, straight from its database: public rows for everyone, the person's own and
    // their organizations' too when signed in (row-level security; hubCatalog.js).
    handle('hub:search', (q) => catalog.search(q));
    handle('hub:browse', () => catalog.browse());
    handle('hub:module', (moduleId) => catalog.module(moduleId));
    handle('hub:entry', (payload) => catalog.deckEntry(payload || {}));
    handle('hub:platforms', () => catalog.platforms());
    handle('hub:platform', (id) => catalog.platform(id));
    handle('hub:plugins', () => catalog.plugins());
    handle('hub:plugin', (id) => catalog.plugin(id));
    handle('hub:templates', () => catalog.templates());
    handle('hub:template', (id) => catalog.template(id));
    handle('hub:selection', (request) => catalog.selection(request || {}));
    handle('hub:take-link', () => { const request = pendingHubLink; pendingHubLink = null; return request; });
    // Stars for quick access, per signed-in account ('signed-out' when nobody is).
    const starAccount = () => (account.describe().user ? account.describe().user.id : 'signed-out');
    handle('hub:starred', () => manager.starred(starAccount()));
    handle('hub:star', (key, on) => manager.setStarred(starAccount(), String(key), !!on));
    handle('launcher:add-workflows', async (id, workflows) => {
        if (!Array.isArray(workflows) || workflows.some((w) => !w || typeof w.name !== 'string' || !w.body || typeof w.body !== 'object')) {
            throw new Error('Expected a list of {name, body} workflows.');
        }
        try { return await manager.addWorkflows(id, workflows); } finally { broadcast('launcher:changed'); }
    });

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
    handle('account:sign-out', accountCall(async () => { await account.signOut(); await signOutCloudTab(); }));
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
    // Signing in from the browser: show the code, open the approval page, then wait for it.
    handle('git:sign-in-start', async (provider, host) => {
        requirePro();
        const flow = await git.startSignIn(provider, host);
        shell.openExternal(flow.verificationUri);
        return flow;
    });
    handle('git:sign-in-finish', (provider) => git.finishSignIn(provider));
    handle('git:sign-in-cancel', (provider) => git.cancelSignIn(provider));
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
    handle('update:install', () => updates.install(async () => { exiting = true; quitting = true; await manager.stopAll(); }));
    handle('update:open-page', () => {
        const u = updates.status();
        return shell.openExternal(u.downloadUrl || u.releaseUrl || 'https://github.com/ivoryzh/ivoryos-next/releases');
    });
    handle('app:set-auto-update', (on) => { manager.setAutoUpdate(on); broadcast('launcher:changed'); });
    handle('app:set-window-pref', (key, on) => {
        if (!['minimizeToTray', 'closeToTray'].includes(key)) throw new Error(`Unknown setting: ${key}`);
        manager.setWindowPref(key, on);
        broadcast('launcher:changed');
    });
    handle('app:reveal-data', () => shell.openPath(home()));
    handle('app:set-theme', (theme) => { manager.setTheme(theme); applyTheme(); broadcast('launcher:changed'); });
    handle('app:set-cloud-only', (on) => { manager.setCloudOnly(on); broadcast('launcher:changed'); });
    // "Send to IvoryOS" (problemReport.js): prepare gathers and redacts, the person reads and edits
    // it, send files exactly that (redacted again) in the Hub. Nothing is sent by prepare.
    // `failure` is what the page knows and the main process may not: this session's log as the
    // Log tab shows it (not the log file, which holds every earlier session too), and, for a Hub
    // install that failed, the message and pip output (a new deck that failed is already gone).
    handle('launcher:report:prepare', async (id, failure = {}) => {
        let profile = null;
        try { profile = id ? manager.get(id) : null; } catch { /* removed since */ }
        const status = profile ? manager.statusOf(id) : { state: 'error', message: failure.message || '' };
        const runtime = runtimeStatus.state === 'error' ? null : await getRuntime().catch(() => null);
        const python = profile && profile.kind === 'script' && profile.python ? profile.python : runtime && runtime.python;
        const [environment, check] = runtime && python
            ? await Promise.all([runtime.describe(python), runtime.check(python)])
            : [{ error: runtimeStatus.message || 'The Python environment is not set up.' }, null];
        const log = typeof failure.log === 'string' ? failure.log : (profile ? manager.logTail(id) : '');
        // pip's output is not in the edge's log: it is kept on the status (manager.install).
        const installOutput = failure.output || (/^Install failed/.test(status.message || '') ? status.logTail : null);
        let deck = null;
        try { deck = profile && profile.kind === 'deck' ? manager.readDeck(id) : null; } catch { /* no deck file */ }
        const app = { version: app_version(), platform: process.platform, arch: process.arch, os: os.release() };
        return {
            details: report.buildDetails({ app, profile: profile || { kind: 'deck' }, status, log, installOutput, deck, environment, check }, reportContext()),
            kind: failure.kind || report.kindOf(status),
            email: (account.describe().user || {}).email || null,
        };
    });
    handle('launcher:report:send', async ({ description, details, kind, contactEmail }) => {
        const row = report.buildRow({
            id: crypto.randomUUID(), description, details, contactEmail, kind,
            app: { version: app_version(), platform: process.platform, arch: process.arch },
        }, reportContext());
        try {
            return await catalog.fileReport(row);
        } catch (e) {
            // The person still has a way to send it: a prefilled (public) GitHub issue.
            throw Object.assign(new Error(e.message), { output: report.githubIssueUrl(REPORT_REPO, row) });
        }
    });

    // A deck's optimizer backends (optimizers.js): the tested versions, the deck's choice, and
    // what the shared environment has installed now.
    handle('launcher:optimizers', async (id) => {
        // No id: a deck that does not exist yet (the Hub making a new one) has chosen nothing.
        const deck = id ? manager.readDeck(id) : { packages: [] };
        const runtime = await getRuntime().catch(() => null);
        const env = runtime ? await runtime.describe(runtime.python) : { error: runtimeStatus.message };
        return { catalog: OPTIMIZERS, selected: selectionOf(deck.packages || []), installed: env.optimizers || {}, error: env.error || null };
    });
    handle('launcher:optimizers:set', (id, selection) => manager.setOptimizers(id, selection));

    // "Cloud early access" while Cloud is not offered: a message to the team through the Hub's
    // contact inquiries. Fails with `output` set to the Hub's contact page as the way round.
    handle('launcher:early-access', async ({ email, name }) => {
        const address = String(email || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('Enter an email address to be told when it opens.');
        try {
            await catalog.contactInquiry({
                name: String(name || '').trim() || 'IvoryOS app user',
                email: address,
                message: `Cloud early access (from the IvoryOS app ${app_version()} on ${process.platform}).`,
            });
        } catch (e) {
            throw Object.assign(new Error(e.message), { output: `${manager.hubUrl}/contact` });
        }
        return true;
    });

    handle('launcher:reorder', (ids) => manager.reorder(ids));
    // The active edge or Cloud tab, reloaded: for a page that did not pick up a change.
    handle('launcher:reload-tab', () => {
        const view = activeTab ? edgeTabs.get(activeTab) : null;
        if (view) view.webContents.reload();
    });
}

// --- tray ----------------------------------------------------------------------------------------

/** The icon at tray size; the 1024px app icon scaled down (a separate small asset is not needed). */
function trayImage() {
    if (!fs.existsSync(ICON)) return nativeImage.createEmpty();
    const size = process.platform === 'darwin' ? 18 : 16;
    const img = nativeImage.createFromPath(ICON);
    const small = img.resize({ width: size, height: size, quality: 'best' });
    small.addRepresentation({ scaleFactor: 2, width: size * 2, height: size * 2, buffer: img.resize({ width: size * 2, height: size * 2, quality: 'best' }).toPNG() });
    return small;
}

function openFromTray(profileId) {
    showLauncher();
    if (profileId && manager.statusOf(profileId).state === 'running') openEdgeTab(profileId);
    else showTab(null);
}

/** The tray's menu and tooltip, rebuilt whenever a profile changes state. */
function refreshTray() {
    if (!tray || !manager) return;
    const profiles = manager.list();
    const running = profiles.filter((p) => p.status.state === 'running');
    tray.setToolTip(running.length ? `IvoryOS: ${running.length} running` : 'IvoryOS');
    const label = { running: 'Running', starting: 'Starting', stopping: 'Stopping', installing: 'Installing', crashed: 'Stopped unexpectedly', error: 'Could not start', stopped: 'Stopped' };
    const act = (fn) => () => fn().catch((e) => dialog.showMessageBox(showLauncher(), { type: 'error', message: e.message }));
    const template = [
        { label: 'Open IvoryOS', click: () => openFromTray(null) },
        { type: 'separator' },
        ...profiles.map((p) => {
            const state = p.status.state;
            const busy = ['starting', 'stopping', 'installing'].includes(state);
            return {
                label: `${state === 'running' ? '\u25CF' : '\u25CB'}  ${p.name}   ${label[state] || state}${state === 'running' ? ` :${p.status.port}` : ''}`,
                submenu: [
                    { label: 'Open', enabled: state === 'running', click: () => openFromTray(p.id) },
                    state === 'running' || busy
                        ? { label: 'Stop', enabled: !busy, click: act(async () => { closeEdgeTab(p.id); await manager.stop(p.id); }) }
                        : { label: 'Start', enabled: p.problems.length === 0, click: act(() => manager.start(p.id)) },
                    { label: 'Restart', enabled: state === 'running', click: act(async () => { await manager.restart(p.id); reloadEdgeTab(p.id); }) },
                ],
            };
        }),
        ...(profiles.length ? [{ type: 'separator' }] : []),
        { label: running.length ? `Quit IvoryOS (stops ${running.length} running)` : 'Quit IvoryOS', click: () => app.quit() },
    ];
    trayMenuLabels = template.filter((i) => i.label).map((i) => i.label);
    tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
    try {
        tray = new Tray(trayImage());
    } catch (e) {
        // Some Linux desktops have no tray; the window then minimizes and closes as usual.
        console.warn(`No system tray: ${e.message}`);
        tray = null;
        return;
    }
    // Windows and Linux: a click opens the window (the menu is on right-click). macOS shows the
    // menu on click, which is its convention for menu bar icons.
    if (process.platform !== 'darwin') tray.on('click', () => openFromTray(null));
    refreshTray();
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
                { label: 'Show or Hide Sidebar', accelerator: 'CmdOrCtrl+B', click: () => broadcast('launcher:toggle-sidebar') },
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
        // The sidebar belongs to the launcher page, so a key pressed in an edge or Cloud tab is
        // passed to it; the page does the toggling and reports its new width back.
        else if (ctrl && !input.shift && key === 'b') act(() => broadcast('launcher:toggle-sidebar'));
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
// One IvoryOS per profile folder, always: a second would start the same decks again, on the same
// instruments. The lock is per userData folder, so a test run with IVORYOS_DESKTOP_HOME set gets
// its own and can run beside the real app.
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance && SMOKE_TEST) {
    console.log(`SMOKE ${JSON.stringify({ ok: false, error: 'IvoryOS is already running with this profile folder' })}`);
    app.exit(1);
}
if (!SMOKE_TEST) {
    if (!singleInstance) {
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
    manager = new ProfileManager({ home: home(), getRuntime, frontendDir: resources().frontendDir, cloudComingSoon: CLOUD_COMING_SOON });
    manager.on('changed', () => { broadcast('launcher:changed'); refreshTray(); reloadReturnedTabs(); watchRunningDecks(); });
    attention = new AttentionWatcher({ WebSocket: globalThis.WebSocket });
    attention.on('attention', notifyAttention);
    manager.on('log', (id, line) => broadcast('launcher:log', id, line));
    manager.on('crashed', (id) => closeEdgeTab(id));
    account = new Account({ fetch: (...a) => net.fetch(...a), store: secretFile(path.join(home(), 'account.bin'), safeStorage) });
    // Same project as the accounts, so a signed-in session is also what the catalog's RLS reads.
    catalog = new HubCatalog({
        fetch: (...a) => net.fetch(...a), url: account.url, key: account.key,
        token: async () => (account.describe().signedIn ? account.token() : null),
        userId: () => (account.describe().user ? account.describe().user.id : null),
    });
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
    applyTheme();
    // "System" follows the OS, which can switch at any time (a schedule, the person).
    nativeTheme.on('updated', refreshTitleBar);
    if (!SMOKE_TEST) createTray();
    showLauncher();
    // Warm Python up while the launcher draws, unless this is a Cloud-only install, which never runs it.
    if (!manager.cloudOnly) getRuntime().catch(() => {});

    if (SMOKE_TEST) return smokeTest();
    updates.schedule();

    if (!manager.cloudOnly) for (const p of manager.list().filter((x) => x.autoStart)) manager.start(p.id).catch(() => {});
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
            launcher.cloudPage = await click('Cloud', 'nav');
            fs.writeFileSync(`${base}-cloud.png`, (await launcherWindow.webContents.capturePage()).toPNG());
            // Accept a suggested Cloud address if one is offered, then open Cloud as a tab.
            launcher.cloudSuggestion = await click('Use ', 'main');
            launcher.cloudTab = await click('Open Cloud', 'main');
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
            launcher.upgrade = await shoot('upgrade', `[...document.querySelectorAll('nav button')].find(b => b.textContent.startsWith('Cloud'))`);
            // The profile's own Configuration / Settings tab (its Cloud connection card).
            await shoot('profile', `[...document.querySelectorAll('nav button')].find(b => b.textContent.includes(${JSON.stringify(target.name)}))`);
            await new Promise((r) => setTimeout(r, 6000)); // a Cloud status poll or two
            launcher.profileSettings = await shoot('profile-settings', `[...document.querySelectorAll('main button')].find(b => ['Configuration', 'Settings'].includes(b.textContent.trim()))`);
            await shoot('profile-cloud', `(([...document.querySelectorAll('h3')].find(h => h.textContent.includes('Cloud connection')) || { scrollIntoView() {} }).scrollIntoView({ block: 'center' }), null)`);
        }
        launcher.menuBar = Menu.getApplicationMenu() ? 'present' : 'none';
        if (process.env.IVORYOS_SMOKE_TRAY) {
            // The tray, as a person would use it: minimize and close must hide, not quit.
            createTray();
            launcherWindow.show();
            const settle = () => new Promise((r) => setTimeout(r, 800));
            const t = { created: !!tray };
            launcherWindow.minimize(); await settle();
            t.minimizeHides = !launcherWindow.isVisible() && !launcherWindow.isDestroyed();
            showLauncher(); await settle();
            t.showsAgain = launcherWindow.isVisible();
            launcherWindow.close(); await settle();
            t.closeHides = !!launcherWindow && !launcherWindow.isDestroyed() && !launcherWindow.isVisible();
            t.hintShown = manager.windowPref('trayHintShown');
            refreshTray();
            t.menu = trayMenuLabels;
            launcher.tray = t;
        }
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
// its edges, alive); elsewhere it quits, which stops them. (With the tray, closing only hides the
// window, so this is reached when the tray is off or unavailable.)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// Stop every edge before exiting, so each can close its serial ports and database cleanly rather
// than being orphaned or killed mid-write.
app.on('before-quit', (event) => {
    exiting = true;
    if (attention) attention.close();
    if (quitting || !manager || manager.running.size === 0) return;
    event.preventDefault();
    quitting = true;
    manager.stopAll().finally(() => app.quit());
});
