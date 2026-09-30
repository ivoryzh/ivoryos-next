"use client";
import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, FolderOpen, Globe, Loader2, Monitor, Moon, RefreshCw, RotateCw, Sun } from 'lucide-react';
import { confirmDialog, notify, promptDialog } from '@ivoryos/shared-ui';
import type { DesktopApi, Snapshot, UpdateStatus } from '@/desktop';
import PythonEnvironment from './PythonEnvironment';
import { Button, cardClass } from './ui';

/**
 * App-wide settings: everything the menu bar and the header used to hold, in one page reached
 * from the corner of the sidebar. Per-deck settings stay on each deck's own Settings tab.
 */
export default function SettingsPanel({ api, snap }: {
  api: DesktopApi;
  snap: Snapshot;
}) {
  const [rebuilding, setRebuilding] = useState(false);
  const isMac = snap.platform === 'darwin';
  const mod = isMac ? '⌘' : 'Ctrl';

  const setHub = async () => {
    const url = await promptDialog('The Hub website the launcher links to (your profile, contributing a driver). The Automation Hub catalog itself is read from its database, not from this address. Leave empty for ivoryos.ai.', { title: 'Hub address', defaultValue: snap.hubUrl });
    if (url !== null && url !== undefined) api.setHubUrl(url.trim()).catch(e => notify(e.message, { tone: 'error' }));
  };

  return (
    <div className="p-6 max-w-3xl space-y-5">
      <h2 className="text-xl font-semibold">Settings</h2>

      <Section title="Appearance">
        {/* One theme for the whole app: the launcher, every deck's page and Cloud follow it. */}
        <div className="flex gap-2">
          {([['system', Monitor, 'System'], ['light', Sun, 'Light'], ['dark', Moon, 'Dark']] as const).map(([value, Icon, label]) => (
            <button key={value} type="button" onClick={() => api.setTheme(value).catch(e => notify(e.message, { tone: 'error' }))} className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${(snap.theme || 'system') === value ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300 dark:border-indigo-500/40' : 'border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5'}`}>
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Every deck&apos;s page and Cloud use it too. System follows your computer.</p>
      </Section>

      {snap.tray?.available && !isMac && (
        <Section title="Window">
          <div className="space-y-2.5 text-sm text-gray-700 dark:text-gray-200">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="accent-indigo-600 mt-0.5" checked={snap.tray.minimizeToTray} onChange={e => api.setWindowPref('minimizeToTray', e.target.checked)} />
              <span>Minimize to the system tray<span className="block text-xs text-gray-500 dark:text-gray-400">The window leaves the taskbar; click the IvoryOS icon in the tray to bring it back.</span></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="accent-indigo-600 mt-0.5" checked={snap.tray.closeToTray} onChange={e => api.setWindowPref('closeToTray', e.target.checked)} />
              <span>Keep running in the tray when the window is closed<span className="block text-xs text-gray-500 dark:text-gray-400">Decks keep running. Quit from the tray icon&apos;s menu stops them. Off: closing the window quits IvoryOS and stops every deck.</span></span>
            </label>
          </div>
        </Section>
      )}

      <Section title="Updates">
        <UpdateRow api={api} update={snap.update} />
        {snap.update.state !== 'unsupported' && !snap.update.manual && (
          <label className="mt-3 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <input type="checkbox" checked={snap.autoUpdate} onChange={e => api.setAutoUpdate(e.target.checked)} className="accent-indigo-600" />
            Download new versions automatically (they install when you restart the app)
          </label>
        )}
      </Section>

      <Section title="Drivers">
        <div className="flex items-center gap-3 text-sm">
          <Globe className="w-4 h-4 text-gray-400" />
          <span className="flex-1">Hub website: <span className="font-mono">{snap.hubUrl}</span></span>
          <Button small onClick={setHub}>Change</Button>
        </div>
      </Section>

      <Section title="Python">
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">The environment deck profiles run in, with IvoryOS and every driver installed from the Hub.</p>
        <PythonEnvironment api={api} python={null} />
        <div className="mt-3">
          <Button small disabled={rebuilding} onClick={async () => {
            if (!(await confirmDialog('Stop every running profile, delete the Python environment and set it up again? Drivers are reinstalled from each deck the next time it starts.', { title: 'Rebuild Python?', confirmLabel: 'Rebuild', tone: 'danger' }))) return;
            setRebuilding(true);
            try { await api.rebuildPython(); } catch (e: any) { notify(e.message, { tone: 'error' }); } finally { setRebuilding(false); }
          }}>{rebuilding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />} Rebuild environment</Button>
        </div>
      </Section>

      <Section title="Data">
        <div className="flex items-center gap-3 text-sm">
          <span className="flex-1 font-mono text-gray-600 dark:text-gray-300 break-all">{snap.dataRoot}</span>
          <Button small onClick={() => api.revealData()}><FolderOpen className="w-3.5 h-3.5" /> Open folder</Button>
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Profiles, each deck&apos;s runs and workflows, logs, and the Python environment.</p>
      </Section>

      <Section title="Keyboard">
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          {[
            [`${mod}+L`, 'Back to the launcher'],
            [`${mod}+Tab`, 'Next tab'],
            [`${mod}+R`, 'Reload the page'],
            [`${mod}+ + / −`, 'Zoom in / out'],
            [isMac ? '⌥⌘I' : 'F12', 'Developer tools'],
          ].map(([k, what]) => (
            <div key={k} className="flex items-center gap-3"><kbd className="min-w-[4.5rem] text-center px-1.5 py-0.5 rounded border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 font-mono text-xs">{k}</kbd><span className="text-gray-600 dark:text-gray-300">{what}</span></div>
          ))}
        </div>
      </Section>

      <p className="text-xs text-gray-400 flex items-center gap-1"><Monitor className="w-3 h-3" /> IvoryOS {snap.version}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={`${cardClass} p-5`}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">{title}</h3>
      {children}
    </section>
  );
}

/** The app's version and what the updater is doing, with the one action that makes sense now. */
export function UpdateRow({ api, update }: { api: DesktopApi; update: UpdateStatus }) {
  const act = (fn: () => Promise<unknown>) => fn().catch((e: any) => notify(e.message, { title: 'Update', tone: 'error' }));
  const s = update.state;
  const line = {
    unsupported: update.message || 'Updates apply to installed builds.',
    idle: 'Not checked yet.',
    checking: 'Checking for updates…',
    'up-to-date': 'You have the newest version.',
    available: update.manual ? `Version ${update.version} is available.` : `Version ${update.version} is available.`,
    downloading: `Downloading version ${update.version || ''}… ${update.percent ?? 0}%`,
    ready: `Version ${update.version} is ready. Restart to finish updating.`,
    error: update.message || 'The update check failed.',
  }[s];
  return (
    <div className="flex items-center gap-3 text-sm">
      {s === 'checking' || s === 'downloading' ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
        : s === 'error' ? <AlertTriangle className="w-4 h-4 text-amber-500" />
          : s === 'ready' || s === 'available' ? <Download className="w-4 h-4 text-indigo-500" />
            : <CheckCircle2 className="w-4 h-4 text-gray-300 dark:text-gray-600" />}
      <div className="flex-1">
        <div>IvoryOS {update.current}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{line}</div>
        {s === 'downloading' && (
          <div className="mt-1 h-1 rounded bg-gray-100 dark:bg-white/10 overflow-hidden"><div className="h-full bg-indigo-500" style={{ width: `${update.percent ?? 0}%` }} /></div>
        )}
      </div>
      {s === 'ready' && <Button small tone="primary" onClick={async () => {
        if (await confirmDialog('Restart IvoryOS to install the update? Running decks are stopped first and start again when the app opens (if set to start automatically).', { title: 'Restart to update?', confirmLabel: 'Restart' })) act(() => api.installUpdate());
      }}><RotateCw className="w-3.5 h-3.5" /> Restart to update</Button>}
      {s === 'available' && (update.manual
        ? <Button small tone="primary" onClick={() => act(() => api.openUpdatePage())}><ExternalLink className="w-3.5 h-3.5" /> Download</Button>
        : <Button small tone="primary" onClick={() => act(() => api.downloadUpdate())}><Download className="w-3.5 h-3.5" /> Download</Button>)}
      {['idle', 'up-to-date', 'error'].includes(s) && <Button small onClick={() => act(() => api.checkForUpdate())}><RefreshCw className="w-3.5 h-3.5" /> Check now</Button>}
    </div>
  );
}
