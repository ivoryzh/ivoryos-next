'use strict';
// The bridge between pages and the app. Every call is checked again in main.js: launcher calls
// are refused unless they come from the launcher page itself, so exposing the names here to an
// edge's page gives that page nothing it can use.
const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
    const res = await ipcRenderer.invoke(channel, ...args);
    if (res && res.ok === false) throw Object.assign(new Error(res.error), { output: res.output });
    return res ? res.value : undefined;
};

contextBridge.exposeInMainWorld('ivoryosDesktop', {
    isDesktop: true,
    snapshot: () => call('launcher:snapshot'),
    onChanged: (cb) => { const f = () => cb(); ipcRenderer.on('launcher:changed', f); return () => ipcRenderer.off('launcher:changed', f); },
    onLog: (cb) => { const f = (_e, id, line) => cb(id, line); ipcRenderer.on('launcher:log', f); return () => ipcRenderer.off('launcher:log', f); },
    onSelect: (cb) => { const f = (_e, id) => cb(id); ipcRenderer.on('launcher:select', f); return () => ipcRenderer.off('launcher:select', f); },

    createProfile: (fields) => call('launcher:create', fields),
    updateProfile: (id, patch) => call('launcher:update', id, patch),
    removeProfile: (id) => call('launcher:remove', id),
    start: (id) => call('launcher:start', id),
    stop: (id) => call('launcher:stop', id),
    restart: (id) => call('launcher:restart', id),
    open: (id, page) => call('launcher:open', id, page),
    openInBrowser: (id) => call('launcher:open-in-browser', id),
    showTab: (id) => call('launcher:show-tab', id),
    closeTab: (id) => call('launcher:close-tab', id),
    setTabBarHeight: (px) => call('launcher:tab-bar-height', px),
    setSidebarWidth: (px) => call('launcher:sidebar-width', px),
    onToggleSidebar: (cb) => { const f = () => cb(); ipcRenderer.on('launcher:toggle-sidebar', f); return () => ipcRenderer.off('launcher:toggle-sidebar', f); },
    onTabs: (cb) => { const f = (_e, tabs) => cb(tabs); ipcRenderer.on('launcher:tabs', f); return () => ipcRenderer.off('launcher:tabs', f); },
    log: (id) => call('launcher:log', id),
    copy: (text) => call('launcher:copy', text),
    reveal: (id, what) => call('launcher:reveal', id, what),
    pick: (kind) => call('launcher:pick', kind),
    rebuildPython: () => call('launcher:rebuild-python'),

    deck: (id) => call('launcher:deck', id),
    saveInstrument: (id, originalName, entry) => call('launcher:instrument:save', id, originalName, entry),
    removeInstrument: (id, name) => call('launcher:instrument:remove', id, name),
    setInstrumentEnabled: (id, name, enabled) => call('launcher:instrument:enable', id, name, enabled),
    install: (id, manifest) => call('launcher:install', id, manifest),
    installFromFile: () => call('launcher:install-file'),
    freeName: (id, suggestion) => call('launcher:free-name', id, suggestion),

    setHubUrl: (url) => call('hub:set-url', url),
    setCloudUrl: (url) => call('cloud:set-url', url),
    launcherPython: () => call('python:launcher'),
    inspectPython: (python) => call('python:inspect', python),
    createVenv: (folder) => call('python:create-venv', folder),
    installEdgeInto: (python) => call('python:install-edge', python),
    openCloud: () => call('cloud:open'),
    openCloudInBrowser: () => call('cloud:open-in-browser'),
    checkCloud: () => call('cloud:check'),
    hubSearch: (q) => call('hub:search', q),
    hubBrowse: () => call('hub:browse'),
    hubModule: (moduleId) => call('hub:module', moduleId),
    hubEntry: (payload) => call('hub:entry', payload),
    hubPlatforms: () => call('hub:platforms'),
    hubPlatform: (id) => call('hub:platform', id),
    hubPlugins: () => call('hub:plugins'),
    hubPlugin: (id) => call('hub:plugin', id),
    hubTemplates: () => call('hub:templates'),
    hubTemplate: (id) => call('hub:template', id),
    hubStarred: () => call('hub:starred'),
    hubStar: (key, on) => call('hub:star', key, on),
    addWorkflows: (id, workflows) => call('launcher:add-workflows', id, workflows),

    account: () => call('account:get'),
    signIn: (email, password) => call('account:sign-in', email, password),
    signUp: (email, password, name) => call('account:sign-up', email, password, name),
    resetPassword: (email) => call('account:reset-password', email),
    signInWith: (provider) => call('account:oauth', provider),
    cancelSignIn: () => call('account:oauth-cancel'),
    signOut: () => call('account:sign-out'),
    updateAccount: (fields) => call('account:update-profile', fields),
    changePassword: (password) => call('account:change-password', password),
    setPlan: (plan) => call('account:set-plan', plan),
    openHub: (page) => call('account:open-hub', page),

    gitList: () => call('git:list'),
    gitConnect: (provider, token, host) => call('git:connect', provider, token, host),
    gitSignInStart: (provider, host) => call('git:sign-in-start', provider, host),
    gitSignInFinish: (provider) => call('git:sign-in-finish', provider),
    gitSignInCancel: (provider) => call('git:sign-in-cancel', provider),
    gitDisconnect: (provider) => call('git:disconnect', provider),
    gitRepos: (provider, query) => call('git:repos', provider, query),
    gitImport: (profileId, provider, repoId, ref) => call('git:import', profileId, provider, repoId, ref),
    gitTokenPage: (provider) => call('git:token-page', provider),

    checkForUpdate: () => call('update:check'),
    downloadUpdate: () => call('update:download'),
    installUpdate: () => call('update:install'),
    openUpdatePage: () => call('update:open-page'),
    setAutoUpdate: (on) => call('app:set-auto-update', on),
    setWindowPref: (key, on) => call('app:set-window-pref', key, on),
    revealData: () => call('app:reveal-data'),
    setTheme: (theme) => call('app:set-theme', theme),
    reorderProfiles: (ids) => call('launcher:reorder', ids),
    reloadTab: () => call('launcher:reload-tab'),
});
