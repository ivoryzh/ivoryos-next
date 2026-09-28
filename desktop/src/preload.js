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
});
