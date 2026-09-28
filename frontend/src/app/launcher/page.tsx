"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ChevronRight, Cloud, Copy, ExternalLink, FileCode2, FolderOpen, Globe, LayoutGrid, Layers, Loader2, Moon, Play, Plus,
  RotateCw, Square, Sun, X,
} from 'lucide-react';
import { notify, promptDialog } from '@ivoryos/shared-ui';
import { CLOUD_TAB, desktopApi, type DesktopApi, type Profile, type Snapshot, type Tabs } from '@/desktop';
import CloudPanel, { useCloudLinks } from '@/components/launcher/CloudPanel';
import DeckPanel from '@/components/launcher/DeckPanel';
import ProfileSettings from '@/components/launcher/ProfileSettings';
import { Button, STATE_LABEL, StatusDot, cardClass } from '@/components/launcher/ui';

/**
 * The IvoryOS desktop launcher: every saved way of starting an edge (a deck, or a Python script
 * like demo.py), whether each is running, and the controls to start, stop, restart, open and
 * configure it. Served by the desktop app itself, so it works before any edge is running; it
 * talks to the app through `window.ivoryosDesktop` (see src/desktop.ts), never to an edge's API
 * except to read which instruments loaded.
 */
export default function LauncherPage() {
  const [api, setApi] = useState<DesktopApi | null | undefined>(undefined);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The main area shows the selected profile, or the Cloud page.
  const [view, setView] = useState<'profile' | 'cloud'>('profile');
  const [tab, setTab] = useState<'main' | 'log' | 'settings'>('main');
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [tabs, setTabs] = useState<Tabs>({ open: [], active: null });
  const barRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const saved = (localStorage.getItem('theme') as 'light' | 'dark') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setTheme(saved);
    document.documentElement.classList.toggle('dark', saved === 'dark');
    setApi(desktopApi());
  }, []);
  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    localStorage.setItem('theme', next);
    document.documentElement.classList.toggle('dark', next === 'dark');
  };

  const reload = useCallback(() => {
    api?.snapshot().then(s => { setSnap(s); if (s.tabs) setTabs(s.tabs); }).catch(() => {});
  }, [api]);

  // The app lays each open edge over this window, directly below the tab bar, so it needs to
  // know where the bar ends -- measured rather than hard-coded, so a font or zoom change cannot
  // leave a gap or cover the tabs.
  useEffect(() => {
    if (!api || !barRef.current) return;
    const el = barRef.current;
    const report = () => api.setTabBarHeight(el.getBoundingClientRect().height).catch(() => {});
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [api, snap !== null]);
  useEffect(() => {
    if (!api) return;
    reload();
    const offChanged = api.onChanged(reload);
    const offLog = api.onLog((id, line) => setLogs(prev => {
      const lines = [...(prev[id] || []), line];
      return { ...prev, [id]: lines.length > 600 ? lines.slice(-600) : lines };
    }));
    const offSelect = api.onSelect(id => { setSelected(id); setView('profile'); setTab('main'); api.showTab(null); });
    const offTabs = api.onTabs(setTabs);
    return () => { offChanged(); offLog(); offSelect(); offTabs(); };
  }, [api, reload]);

  const profiles = snap?.profiles || [];
  const profile = useMemo(() => profiles.find(p => p.id === selected) || profiles[0] || null, [profiles, selected]);
  const cloudLinks = useCloudLinks(profiles);
  const cloudConnected = profiles.filter(p => cloudLinks[p.id]?.paired && cloudLinks[p.id]?.connection_state === 'connected').length;

  // A profile's log: what this session has streamed, seeded from the supervisor's tail.
  useEffect(() => {
    if (!api || !profile || logs[profile.id]) return;
    api.log(profile.id).then(text => setLogs(prev => (prev[profile.id] ? prev : { ...prev, [profile.id]: text ? text.split('\n') : [] }))).catch(() => {});
  }, [api, profile, logs]);

  if (api === undefined) return null;
  if (api === null) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-[#0a0a0a] p-8">
        <div className={`${cardClass} max-w-md p-6 text-sm text-gray-600 dark:text-gray-300`}>
          <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">IvoryOS Launcher</h1>
          This page is part of the IvoryOS desktop app, where it starts and manages edge servers. Open the app to use it.
        </div>
      </main>
    );
  }

  const run = (fn: () => Promise<unknown>) => fn().catch((e: any) => notify(e.message, { title: 'Something went wrong', tone: 'error' }));

  const newProfile = async (kind: 'deck' | 'script') => {
    if (kind === 'script') {
      const script = await api.pick('script');
      if (!script) return;
      run(async () => { const p = await api.createProfile({ kind, script }); setSelected(p.id); setView('profile'); setTab('settings'); });
    } else {
      const name = await promptDialog('Name the new deck.', { title: 'New deck profile', defaultValue: 'New deck' });
      if (!name) return;
      run(async () => { const p = await api.createProfile({ kind, name }); setSelected(p.id); setView('profile'); setTab('main'); });
    }
  };

  const setHub = async () => {
    const url = await promptDialog('Where the launcher finds drivers. Use http://localhost:3000 while developing the Hub.', { title: 'Hub address', defaultValue: snap?.hubUrl || '' });
    if (url !== null && url !== undefined) run(() => api.setHubUrl(url.trim()));
  };

  const rt = snap?.runtime;
  return (
    <div className={`h-screen flex flex-col bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white ${theme}`}>
      {/* The window's one bar: the launcher, then a tab per open edge. An edge's own UI is drawn
          by the app over everything below this bar, so the launcher and every running deck live in
          one window instead of a window each. */}
      <header ref={barRef} className="h-11 shrink-0 flex items-stretch gap-1 pl-3 pr-2 border-b border-gray-200 dark:border-white/10 bg-white dark:bg-[#111]">
        <button
          type="button"
          onClick={() => api.showTab(null)}
          className={`flex items-center gap-2 px-3 text-sm border-b-2 ${tabs.active === null ? 'border-indigo-500 text-gray-900 dark:text-white font-semibold' : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
        >
          <LayoutGrid className="w-4 h-4" /> Launcher
        </button>
        {tabs.open.map(id => {
          const active = tabs.active === id;
          if (id === CLOUD_TAB) {
            return (
              <div key={id} className={`group flex items-center gap-2 pl-3 pr-1 text-sm border-b-2 ${active ? 'border-indigo-500 text-gray-900 dark:text-white font-medium' : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}>
                <button type="button" onClick={() => api.showTab(id)} className="flex items-center gap-2"><Cloud className="w-3.5 h-3.5 text-indigo-500" /> IvoryOS Cloud</button>
                <button type="button" title="Close the tab" onClick={() => api.closeTab(id)} className="p-0.5 rounded text-gray-400 opacity-60 group-hover:opacity-100 hover:bg-gray-100 dark:hover:bg-white/10">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          }
          const p = profiles.find(x => x.id === id);
          if (!p) return null;
          return (
            <div key={id} className={`group flex items-center gap-2 pl-3 pr-1 text-sm border-b-2 ${active ? 'border-indigo-500 text-gray-900 dark:text-white font-medium' : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}>
              <button type="button" onClick={() => api.showTab(id)} className="flex items-center gap-2 max-w-[14rem]">
                <StatusDot status={p.status} />
                <span className="truncate">{p.name}</span>
              </button>
              <button type="button" title="Close the tab (the edge keeps running)" onClick={() => api.closeTab(id)} className="p-0.5 rounded text-gray-400 opacity-60 group-hover:opacity-100 hover:bg-gray-100 dark:hover:bg-white/10">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
        <div className="ml-auto flex items-center gap-1">
          {rt && rt.state !== 'idle' && rt.state !== 'ready' && (
            <span title={rt.hint || rt.message} className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${rt.state === 'error' ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300' : 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300'}`}>
              {rt.state === 'preparing' && <Loader2 className="w-3 h-3 animate-spin" />}
              {rt.state === 'error' && <AlertTriangle className="w-3 h-3" />}
              {rt.message}
            </span>
          )}
          <Button small tone="ghost" onClick={setHub} title="The Hub the launcher installs drivers from"><Globe className="w-3.5 h-3.5" /> {snap?.hubUrl?.replace(/^https?:\/\//, '')}</Button>
          <Button small tone="ghost" onClick={toggleTheme} title="Light or dark">{theme === 'light' ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}</Button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <nav className="w-72 shrink-0 border-r border-gray-200 dark:border-white/10 flex flex-col bg-white/60 dark:bg-white/[0.02]">
          <div className="flex-1 overflow-y-auto p-3 space-y-1">
            {profiles.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => { setSelected(p.id); setView('profile'); setTab('main'); }}
                className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${view === 'profile' && profile?.id === p.id ? 'bg-indigo-50 border-indigo-200 dark:bg-indigo-500/10 dark:border-indigo-500/30' : 'border-transparent hover:bg-gray-100 dark:hover:bg-white/5'}`}
              >
                <div className="flex items-center gap-2">
                  <StatusDot status={p.status} />
                  <span className="text-sm font-medium truncate flex-1">{p.name}</span>
                  <span className="text-[11px] font-mono text-gray-400">:{p.status.port}</span>
                </div>
                <div className="mt-0.5 pl-4 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                  {p.kind === 'deck' ? <Layers className="w-3 h-3" /> : <FileCode2 className="w-3 h-3" />}
                  <span className="truncate">{p.kind === 'deck' ? 'Deck' : (p.script || '').split(/[\\/]/).pop()}</span>
                  <span className="text-gray-300 dark:text-gray-600">·</span>
                  <span className="truncate">{STATE_LABEL[p.status.state]}</span>
                </div>
              </button>
            ))}
          </div>
          {/* Cloud is an addition, never a gate: everything above works without it. */}
          <div className="px-3 pt-3">
            <button
              type="button"
              onClick={() => setView('cloud')}
              className={`w-full text-left px-3 py-2.5 rounded-xl border flex items-center gap-3 transition-colors ${view === 'cloud' ? 'bg-indigo-50 border-indigo-200 dark:bg-indigo-500/10 dark:border-indigo-500/30' : 'border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/5'}`}
            >
              <span className="w-8 h-8 shrink-0 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-white flex items-center justify-center"><Cloud className="w-4 h-4" /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium">IvoryOS Cloud</span>
                <span className="block text-xs text-gray-500 dark:text-gray-400 truncate">
                  {cloudConnected ? `${cloudConnected} deck${cloudConnected === 1 ? '' : 's'} connected` : 'Manage decks from anywhere'}
                </span>
              </span>
              <ChevronRight className="w-4 h-4 text-gray-400" />
            </button>
          </div>
          <div className="p-3 border-t border-gray-200 dark:border-white/10 mt-3 grid grid-cols-2 gap-2">
            <Button small onClick={() => newProfile('deck')}><Plus className="w-3.5 h-3.5" /> New deck</Button>
            <Button small onClick={() => newProfile('script')}><Plus className="w-3.5 h-3.5" /> Python script</Button>
          </div>
        </nav>

        <main className="flex-1 min-w-0 overflow-y-auto">
          {view === 'cloud' ? (
            <CloudPanel api={api} profiles={profiles} links={cloudLinks} cloudUrl={snap?.cloudUrl || ''} run={run} />
          ) : profile ? (
            <ProfileView
              key={profile.id}
              api={api}
              profile={profile}
              hubUrl={snap?.hubUrl || ''}
              tab={tab}
              setTab={setTab}
              log={logs[profile.id] || []}
              run={run}
              onRemoved={() => setSelected(null)}
            />
          ) : (
            <div className="p-10 text-sm text-gray-500">Create a profile to start an edge.</div>
          )}
        </main>
      </div>
    </div>
  );
}

function ProfileView({ api, profile, hubUrl, tab, setTab, log, run, onRemoved }: {
  api: DesktopApi;
  profile: Profile;
  hubUrl: string;
  tab: 'main' | 'log' | 'settings';
  setTab: (t: 'main' | 'log' | 'settings') => void;
  log: string[];
  run: (fn: () => Promise<unknown>) => void;
  onRemoved: () => void;
}) {
  const s = profile.status;
  const busy = ['starting', 'stopping', 'installing'].includes(s.state);
  const running = s.state === 'running';
  const failed = s.state === 'error' || s.state === 'crashed';
  const tabs: { id: 'main' | 'log' | 'settings'; label: string }[] = [
    { id: 'main', label: profile.kind === 'deck' ? 'Instruments' : 'Overview' },
    { id: 'log', label: 'Log' },
    { id: 'settings', label: profile.kind === 'deck' ? 'Settings' : 'Configuration' },
  ];

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold truncate">{profile.name}</h2>
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400">{profile.kind}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <StatusDot status={s} />
            <span>{busy ? s.message : STATE_LABEL[s.state]}</span>
            {running && s.url && <span className="font-mono text-xs">{s.url}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {running || busy ? (
            <Button disabled={busy} onClick={() => run(() => api.stop(profile.id))}><Square className="w-4 h-4" /> Stop</Button>
          ) : (
            <Button tone="primary" disabled={profile.problems.length > 0} title={profile.problems.join(' ')} onClick={() => run(() => api.start(profile.id))}><Play className="w-4 h-4" /> Start</Button>
          )}
          <Button disabled={!running} onClick={() => run(() => api.restart(profile.id))} title="Stop and start again: reloads the deck or script"><RotateCw className="w-4 h-4" /> Restart</Button>
          <Button tone={running ? 'primary' : 'default'} disabled={!running} title="Open this edge in a tab of this window" onClick={() => run(() => api.open(profile.id))}><LayoutGrid className="w-4 h-4" /> Open</Button>
          <Button disabled={!running} title="Open this edge in your web browser instead" onClick={() => run(() => api.openInBrowser(profile.id))}><ExternalLink className="w-4 h-4" /></Button>
        </div>
      </div>

      {profile.problems.length > 0 && (
        <div className="text-sm rounded-lg p-3 bg-amber-50 text-amber-800 dark:bg-amber-900/15 dark:text-amber-300">{profile.problems.join(' ')}</div>
      )}
      {failed && (
        <div className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50/60 dark:bg-red-900/10 p-3">
          <div className="flex items-start gap-2 text-sm text-red-700 dark:text-red-300">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="flex-1 break-words">{s.message}</span>
            <Button small tone="ghost" onClick={() => setTab('log')}>See log</Button>
          </div>
        </div>
      )}

      <div className="flex gap-1 border-b border-gray-200 dark:border-white/10">
        {tabs.map(t => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`px-3 py-2 text-sm -mb-px border-b-2 ${tab === t.id ? 'border-indigo-500 text-indigo-700 dark:text-indigo-300 font-medium' : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'main' && (profile.kind === 'deck'
        ? <DeckPanel api={api} profile={profile} hubUrl={hubUrl} />
        : <ScriptOverview api={api} profile={profile} openSettings={() => setTab('settings')} />)}
      {tab === 'log' && <LogPanel api={api} profile={profile} lines={log} />}
      {tab === 'settings' && <ProfileSettings api={api} profile={profile} onRemoved={onRemoved} />}
    </div>
  );
}

function ScriptOverview({ api, profile, openSettings }: { api: DesktopApi; profile: Profile; openSettings: () => void }) {
  const env = Object.entries(profile.env || {});
  return (
    <div className="space-y-4">
      <div className={`${cardClass} p-4 space-y-3 text-sm`}>
        <Row label="Script"><span className="font-mono break-all">{profile.script}</span>
          <Button small tone="ghost" onClick={() => api.reveal(profile.id, 'script').catch(e => notify(e.message))}><FolderOpen className="w-3.5 h-3.5" /></Button></Row>
        <Row label="Python"><span className="font-mono break-all">{profile.python || 'Launcher Python (edge + installed drivers)'}</span></Row>
        {!!profile.args?.length && <Row label="Arguments"><span className="font-mono">{profile.args.join(' ')}</span></Row>}
        <Row label="Data">{profile.dataDir ? <span className="font-mono break-all">{profile.dataDir}</span> : 'The script’s own runs and workflows'}</Row>
      </div>
      <div className={`${cardClass} p-4`}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Environment</h3>
          <Button small onClick={openSettings}>Edit</Button>
        </div>
        {env.length ? (
          <div className="space-y-1">{env.map(([k, v]) => <div key={k} className="text-sm font-mono"><span className="text-indigo-600 dark:text-indigo-400">{k}</span>={v}</div>)}</div>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            None yet. To change a COM port without editing the script, read it from a variable, e.g.
            <code className="font-mono"> SyringePump(port=os.environ.get(&quot;PUMP_PORT&quot;, &quot;COM3&quot;))</code>, and set it here.
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-24 shrink-0 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 pt-0.5">{label}</span>
      <span className="flex-1 min-w-0 flex items-start gap-2 text-gray-800 dark:text-gray-200">{children}</span>
    </div>
  );
}

function LogPanel({ api, profile, lines }: { api: DesktopApi; profile: Profile; lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines, follow]);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} className="accent-indigo-600" /> Follow
        </label>
        <div className="ml-auto flex gap-2">
          <Button small onClick={() => api.copy(lines.join('\n'))}><Copy className="w-3.5 h-3.5" /> Copy</Button>
          <Button small onClick={() => api.reveal(profile.id, 'log').catch(e => notify(e.message))}><FolderOpen className="w-3.5 h-3.5" /> Log file</Button>
        </div>
      </div>
      <pre ref={ref} className="h-[28rem] overflow-auto rounded-xl bg-gray-900 text-gray-100 dark:bg-black text-[11px] leading-relaxed p-4 font-mono whitespace-pre-wrap break-words">
        {lines.length ? lines.join('\n') : 'Nothing logged yet. Start the profile to see its output here.'}
      </pre>
    </div>
  );
}
