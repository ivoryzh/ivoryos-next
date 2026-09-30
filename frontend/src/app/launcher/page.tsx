"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ChevronRight, Cloud, Copy, Download, ExternalLink, FileCode2, FolderOpen, LayoutGrid, Layers, Loader2, Lock,
  PanelLeftClose, PanelLeftOpen, Play, Plus, RotateCw, Settings, Sparkles, Square, Store, X,
} from 'lucide-react';
import { notify, promptDialog } from '@ivoryos/shared-ui';
import { CLOUD_TAB, desktopApi, type AccountInfo, type CloudLink, type DesktopApi, type Profile, type Snapshot, type Tabs, type UpdateStatus } from '@/desktop';
import AccountPanel, { Avatar, type AuthMode } from '@/components/launcher/AccountPanel';
import CloudPanel, { useCloudLinks } from '@/components/launcher/CloudPanel';
import { sharedIdentity } from '@/components/launcher/CloudConnection';
import DeckPanel from '@/components/launcher/DeckPanel';
import ProfileSettings from '@/components/launcher/ProfileSettings';
import SettingsPanel from '@/components/launcher/SettingsPanel';
import UpgradeDialog, { type UpgradeReason } from '@/components/launcher/UpgradeDialog';
import { Button, STATE_LABEL, StatusDot, cardClass } from '@/components/launcher/ui';

type View = 'profile' | 'cloud' | 'settings' | 'account';

// Electron's window-dragging regions: the title bar drags the window, its buttons stay clickable.
const DRAG = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

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
  // The main area shows the selected profile, the Cloud page, Settings, or the account.
  const [view, setView] = useState<View>('profile');
  const [authMode, setAuthMode] = useState<AuthMode>('sign-in');
  // undefined: the plan dialog is closed; otherwise what it was opened for.
  const [upgrade, setUpgrade] = useState<UpgradeReason | undefined>(undefined);
  const [tab, setTab] = useState<'main' | 'log' | 'settings'>('main');
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [tabs, setTabs] = useState<Tabs>({ open: [], active: null });
  // The sidebar can be hidden to give the page the whole window. Remembered per browser, and read
  // after hydration like the theme (AGENTS.md section 11), never in the initializer.
  const [navHidden, setNavHidden] = useState(false);
  // The Hub browser, owned here so the sidebar's Hub button can open it on a deck.
  const [hubOpen, setHubOpen] = useState(false);
  // The row being dragged and the row it is over, for reordering the sidebar.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const barRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setNavHidden(localStorage.getItem('launcher.navHidden') === '1');
    setApi(desktopApi());
  }, []);
  const toggleNav = useCallback(() => setNavHidden(hidden => {
    try { localStorage.setItem('launcher.navHidden', hidden ? '0' : '1'); } catch { /* not remembered */ }
    return !hidden;
  }), []);
  useEffect(() => {
    // Ctrl+B / Cmd+B, as in most editors.
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleNav(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleNav]);

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
  // Likewise the sidebar's width, so an edge or Cloud tab is laid out beside it rather than over
  // it, and the decks stay one click away from inside any of them.
  useEffect(() => {
    if (!api) return;
    const el = navRef.current;
    if (!el || navHidden) { api.setSidebarWidth(0).catch(() => {}); return; }
    const report = () => api.setSidebarWidth(el.getBoundingClientRect().width).catch(() => {});
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [api, navHidden, snap !== null]);
  useEffect(() => (api ? api.onToggleSidebar(toggleNav) : undefined), [api, toggleNav]);
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
    // Re-read the account once per launch: the plan or the Hub profile may have changed elsewhere.
    api.account().catch(() => {});
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

  const account: AccountInfo = snap?.account || { signedIn: false, plan: 'free' };
  const pro = account.plan === 'pro';
  const openAuth = (mode: AuthMode) => { setAuthMode(mode); setView('account'); api.showTab(null); };
  // Cloud is a Pro feature in the preview plans; without it the button offers the upgrade.
  // The sidebar is the tab list: a running deck opens its own page, a stopped one its launcher page
  // (to start it). The gear on each row is always the launcher page: instruments, log, settings.
  const showProfilePage = (id: string) => { setSelected(id); setView('profile'); api.showTab(null); };
  const openProfile = (p: Profile) => {
    setSelected(p.id);
    if (p.status.state === 'running') run(() => api.open(p.id));
    else showProfilePage(p.id);
  };
  // Cloud likewise: straight to Cloud when it answers, its launcher page (status, address) when not.
  const showCloudPage = () => { api.showTab(null); if (pro) setView('cloud'); else setUpgrade('cloud'); };
  const openCloud = async () => {
    if (!pro) { setUpgrade('cloud'); return; }
    if (tabs.open.includes(CLOUD_TAB)) { api.showTab(CLOUD_TAB); return; }
    const check = await api.checkCloud().catch(() => null);
    if (check?.reachable && check.isCloud) run(() => api.openCloud());
    else showCloudPage();
  };

  // Dragging a row onto another puts it there; the order is kept in profiles.json.
  const moveProfile = (from: string, to: string) => {
    const ids = profiles.map(p => p.id);
    const at = ids.indexOf(from);
    const target = ids.indexOf(to);
    if (at === -1 || target === -1 || at === target) return;
    ids.splice(at, 1);
    ids.splice(target, 0, from);
    setSnap(prev => (prev ? { ...prev, profiles: ids.map(id => prev.profiles.find(p => p.id === id)!).filter(Boolean) } : prev));
    run(() => api.reorderProfiles(ids));
  };
  const activeProfile = tabs.active && tabs.active !== CLOUD_TAB ? profiles.find(p => p.id === tabs.active) || null : null;
  // The Hub adds to a deck: the selected one, or the first deck when a script is selected.
  const hubDeck = profile?.kind === 'deck' ? profile : profiles.find(p => p.kind === 'deck') || null;
  const openHub = () => {
    if (!hubDeck) return;
    setSelected(hubDeck.id); setView('profile'); setTab('main'); api.showTab(null); setHubOpen(true);
  };

  const rt = snap?.runtime;
  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white">
      {/* The window's title bar (desktop/src/main.js hides the system one): drag it to move the
          window; the system's window buttons are drawn over its right end (left on macOS), hence
          the padding. The sidebar is the tab list and says which page is showing, so the bar holds
          only the sidebar toggle and, while a deck's or Cloud's page shows, reload and close. That
          page is drawn by the app below this bar and right of the sidebar. */}
      <header
        ref={barRef}
        style={DRAG}
        className={`h-9 shrink-0 flex items-center gap-1 border-b border-gray-200 dark:border-white/10 bg-white dark:bg-[#111] ${snap?.platform === 'darwin' ? 'pl-20 pr-2' : 'pl-2 pr-36'}`}
      >
        <button
          type="button"
          onClick={toggleNav}
          style={NO_DRAG}
          title={navHidden ? 'Show the sidebar (Ctrl+B)' : 'Hide the sidebar (Ctrl+B)'}
          className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-white/10"
        >
          {navHidden ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>
        {tabs.active !== null && (
          <>
            <button type="button" style={NO_DRAG} title="Reload this page (Ctrl+R)" onClick={() => run(() => api.reloadTab())}
              className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-white/10">
              <RotateCw className="w-3.5 h-3.5" />
            </button>
            <button type="button" style={NO_DRAG} title={activeProfile ? 'Close this page (the deck keeps running)' : 'Close Cloud'} onClick={() => run(() => api.closeTab(tabs.active!))}
              className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-white/10">
              <X className="w-3.5 h-3.5" />
            </button>
          </>
        )}
        <div className="ml-auto flex items-center gap-1" style={NO_DRAG}>
          {rt && rt.state !== 'idle' && rt.state !== 'ready' && (
            <span title={rt.hint || rt.message} className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${rt.state === 'error' ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300' : 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300'}`}>
              {rt.state === 'preparing' && <Loader2 className="w-3 h-3 animate-spin" />}
              {rt.state === 'error' && <AlertTriangle className="w-3 h-3" />}
              {rt.message}
            </span>
          )}
          {snap?.update && <UpdateChip update={snap.update} onClick={() => { setView('settings'); api.showTab(null); }} />}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        {!navHidden && <nav ref={navRef} className="w-72 shrink-0 border-r border-gray-200 dark:border-white/10 flex flex-col bg-white/60 dark:bg-white/[0.02]">
          <div className="flex-1 overflow-y-auto p-3 space-y-1">
            {profiles.map(p => {
              const active = tabs.active !== null ? tabs.active === p.id : view === 'profile' && profile?.id === p.id;
              const onPage = tabs.active === null && view === 'profile' && profile?.id === p.id;
              return (
                <div
                  key={p.id}
                  draggable
                  onDragStart={e => { setDragId(p.id); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={e => { if (dragId && dragId !== p.id) { e.preventDefault(); setDropOn(p.id); } }}
                  onDragLeave={() => setDropOn(on => (on === p.id ? null : on))}
                  onDrop={e => { e.preventDefault(); if (dragId) moveProfile(dragId, p.id); setDragId(null); setDropOn(null); }}
                  onDragEnd={() => { setDragId(null); setDropOn(null); }}
                  className={`group flex items-stretch rounded-lg border transition-colors ${active ? 'bg-indigo-50 border-indigo-200 dark:bg-indigo-500/10 dark:border-indigo-500/30' : 'border-transparent hover:bg-gray-100 dark:hover:bg-white/5'} ${dropOn === p.id ? '!border-indigo-400 border-dashed' : ''} ${dragId === p.id ? 'opacity-40' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => openProfile(p)}
                    title={p.status.state === 'running' ? `Open ${p.name}` : `${p.name}: ${STATE_LABEL[p.status.state].toLowerCase()}`}
                    className="flex-1 min-w-0 text-left pl-3 py-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <StatusDot status={p.status} />
                      <span className={`text-sm truncate flex-1 ${active ? 'font-semibold' : 'font-medium'}`}>{p.name}</span>
                      <span
                        title={p.status.portNote ? `Started on ${p.status.portNote.actual}, not the profile's ${p.status.portNote.requested}` : undefined}
                        className={`text-[11px] font-mono ${p.status.portNote ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400'}`}
                      >
                        {p.status.portNote && <AlertTriangle className="inline w-3 h-3 mr-0.5 -mt-0.5" />}:{p.status.port}
                      </span>
                    </div>
                    <div className="mt-0.5 pl-4 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                      {p.kind === 'deck' ? <Layers className="w-3 h-3" /> : <FileCode2 className="w-3 h-3" />}
                      <span className="truncate">{p.kind === 'deck' ? 'Deck' : (p.script || '').split(/[\\/]/).pop()}</span>
                      <span className="text-gray-300 dark:text-gray-600">·</span>
                      <span className="truncate">{STATE_LABEL[p.status.state]}</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    title={`${p.name}: instruments, log and settings`}
                    onClick={() => showProfilePage(p.id)}
                    className={`self-center mx-1.5 p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-white dark:hover:text-gray-200 dark:hover:bg-white/10 ${onPage ? 'text-indigo-500 dark:text-indigo-300' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
                  >
                    <Settings className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
          {/* Cloud and the Hub are additions, never gates: everything above works without them. */}
          <div className="px-3 pt-3 space-y-0.5">
            <div className={`group flex items-center rounded-lg transition-colors ${(tabs.active !== null ? tabs.active === CLOUD_TAB : view === 'cloud') ? 'bg-indigo-50 dark:bg-indigo-500/10' : 'hover:bg-gray-100 dark:hover:bg-white/5'}`}>
            <button
              type="button"
              onClick={openCloud}
              className="flex-1 min-w-0 text-left pl-3 py-2 flex items-center gap-3"
            >
              <Cloud className="w-4 h-4 shrink-0 text-indigo-500 dark:text-indigo-400" />
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium">Cloud{!pro && <span className="text-[9px] font-bold uppercase tracking-wider px-1 rounded bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">Pro</span>}</span>
                <span className="block text-xs text-gray-500 dark:text-gray-400 truncate">
                  {cloudConnected ? `${cloudConnected} deck${cloudConnected === 1 ? '' : 's'} connected` : 'Manage decks from anywhere'}
                </span>
              </span>
              {!pro && <Lock className="w-3.5 h-3.5 text-gray-400" />}
            </button>
            {pro && (
              <button type="button" title="Cloud: connection and address" onClick={showCloudPage}
                className={`mx-1.5 p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-white dark:hover:text-gray-200 dark:hover:bg-white/10 ${tabs.active === null && view === 'cloud' ? 'text-indigo-500 dark:text-indigo-300' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}>
                <Settings className="w-3.5 h-3.5" />
              </button>
            )}
            </div>
            <button
              type="button"
              onClick={openHub}
              disabled={!hubDeck}
              title={hubDeck ? `Add instruments, platforms, plugins or workflows to ${hubDeck.name}` : 'Create a deck first: the Hub adds to a deck'}
              className="w-full text-left px-3 py-2 rounded-lg flex items-center gap-3 transition-colors hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <Store className="w-4 h-4 shrink-0 text-indigo-500 dark:text-indigo-400" />
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium">Automation Hub</span>
                <span className="block text-xs text-gray-500 dark:text-gray-400 truncate">{hubDeck ? `Add to ${hubDeck.name}` : 'Drivers, platforms, plugins'}</span>
              </span>
              <ChevronRight className="w-4 h-4 text-gray-400" />
            </button>
          </div>
          <div className="p-3 border-t border-gray-200 dark:border-white/10 mt-3 grid grid-cols-2 gap-2">
            <Button small onClick={() => newProfile('deck')}><Plus className="w-3.5 h-3.5" /> New deck</Button>
            <Button small onClick={() => newProfile('script')}><Plus className="w-3.5 h-3.5" /> Python script</Button>
          </div>
          <AccountCorner
            account={account}
            update={snap?.update}
            view={view}
            onAccount={() => { setView('account'); api.showTab(null); }}
            onSettings={() => { setView('settings'); api.showTab(null); }}
            onAuth={openAuth}
            onUpgrade={() => setUpgrade(null)}
          />
        </nav>}

        <main className="flex-1 min-w-0 overflow-y-auto">
          {view === 'settings' && snap ? (
            <SettingsPanel api={api} snap={snap} />
          ) : view === 'account' ? (
            <AccountPanel api={api} account={account} secretsPersist={snap?.secretsPersist ?? true} mode={authMode} setMode={setAuthMode} onUpgrade={() => setUpgrade(null)} />
          ) : view === 'cloud' && pro ? (
            <CloudPanel api={api} profiles={profiles} links={cloudLinks} cloudUrl={snap?.cloudUrl || ''} run={run} />
          ) : profile ? (
            <ProfileView
              key={profile.id}
              api={api}
              profile={profile}
              hubUrl={snap?.hubUrl || ''}
              pro={pro}
              onUpgrade={() => setUpgrade('private')}
              link={cloudLinks[profile.id]}
              sharedWith={sharedIdentity(profile, profiles, cloudLinks)}
              tab={tab}
              setTab={setTab}
              log={logs[profile.id] || []}
              run={run}
              onRemoved={() => setSelected(null)}
              onOpenProfile={id => { setSelected(id); setView('profile'); setTab('main'); }}
              hubOpen={hubOpen}
              setHubOpen={setHubOpen}
            />
          ) : (
            <div className="p-10 text-sm text-gray-500">Create a profile to start an edge.</div>
          )}
        </main>
      </div>
      {upgrade !== undefined && (
        <UpgradeDialog
          api={api}
          account={account}
          reason={upgrade}
          onClose={() => setUpgrade(undefined)}
          onSignIn={() => openAuth('sign-in')}
        />
      )}
    </div>
  );
}

/**
 * The bottom-left corner: who is signed in and on which plan, or the way to sign in; and the
 * app's settings. What the old menu bar and header buttons did now lives behind these two.
 */
function AccountCorner({ account, update, view, onAccount, onSettings, onAuth, onUpgrade }: {
  account: AccountInfo;
  update?: UpdateStatus;
  view: View;
  onAccount: () => void;
  onSettings: () => void;
  onAuth: (mode: AuthMode) => void;
  onUpgrade: () => void;
}) {
  const updateWaiting = update && (update.state === 'ready' || update.state === 'available');
  return (
    <div className="px-3 py-2.5 border-t border-gray-200 dark:border-white/10 flex items-center gap-2">
      {account.signedIn ? (
        <button
          type="button"
          onClick={onAccount}
          title="Your account"
          className={`flex-1 min-w-0 flex items-center gap-2.5 px-1.5 py-1 -mx-1.5 rounded-lg text-left ${view === 'account' ? 'bg-indigo-50 dark:bg-indigo-500/10' : 'hover:bg-gray-100 dark:hover:bg-white/5'}`}
        >
          <Avatar account={account} size={30} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium truncate">{account.user?.name || account.user?.email}</span>
            <span className="block text-[11px] text-gray-500 dark:text-gray-400">
              {account.plan === 'pro' ? <span className="text-violet-600 dark:text-violet-300 font-medium">Pro</span> : 'Free'}
            </span>
          </span>
        </button>
      ) : (
        <div className="flex-1 flex gap-1.5">
          <Button small tone="primary" onClick={() => onAuth('sign-in')}>Sign in</Button>
          <Button small onClick={() => onAuth('sign-up')}>Sign up</Button>
        </div>
      )}
      {account.signedIn && account.plan !== 'pro' && (
        <Button small tone="ghost" title="See the Pro plan" onClick={onUpgrade} className="!text-violet-600 dark:!text-violet-300"><Sparkles className="w-3.5 h-3.5" /> Upgrade</Button>
      )}
      <button
        type="button"
        onClick={onSettings}
        title={updateWaiting ? 'Settings (an update is available)' : 'Settings'}
        className={`relative p-1.5 rounded-lg ${view === 'settings' ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5'}`}
      >
        <Settings className="w-4 h-4" />
        {updateWaiting && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-indigo-500 ring-2 ring-white dark:ring-[#111]" />}
      </button>
    </div>
  );
}

/** In the tab bar only when there is something to do about an update. */
function UpdateChip({ update, onClick }: { update: UpdateStatus; onClick: () => void }) {
  if (update.state !== 'ready' && update.state !== 'available') return null;
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-500/15 dark:text-indigo-300">
      <Download className="w-3 h-3" />
      {update.state === 'ready' ? `Restart to update to ${update.version}` : `Update ${update.version} available`}
    </button>
  );
}

function ProfileView({ api, profile, hubUrl, pro, onUpgrade, link, sharedWith, tab, setTab, log, run, onRemoved, onOpenProfile, hubOpen, setHubOpen }: {
  api: DesktopApi;
  profile: Profile;
  hubUrl: string;
  pro: boolean;
  onUpgrade: () => void;
  link?: CloudLink;
  sharedWith: Profile[];
  tab: 'main' | 'log' | 'settings';
  setTab: (t: 'main' | 'log' | 'settings') => void;
  log: string[];
  run: (fn: () => Promise<unknown>) => void;
  onRemoved: () => void;
  onOpenProfile: (id: string) => void;
  hubOpen: boolean;
  setHubOpen: (open: boolean) => void;
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

      {s.portNote && <PortNote profile={profile} note={s.portNote} openSettings={() => setTab('settings')} />}
      {running && (sharedWith.length > 0 || link?.connection_state === 'conflict') && tab !== 'settings' && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50/60 dark:bg-red-900/10 p-3 text-sm text-red-800 dark:text-red-300">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1">
            {sharedWith.length
              ? <><b>{sharedWith.map(p => p.name).join(', ')}</b> is paired as the same Cloud device and running too, so the two keep kicking each other off Cloud.</>
              : <>Another edge is using this Cloud identity (<span className="font-mono">{link?.client_id}</span>), probably a second copy of this {profile.kind === 'script' ? 'script' : 'deck'}. Both keep dropping off Cloud.</>}
          </span>
          <Button small tone="ghost" onClick={() => setTab('settings')}>Details</Button>
        </div>
      )}
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
        ? <DeckPanel api={api} profile={profile} hubUrl={hubUrl} pro={pro} onUpgrade={onUpgrade} onOpenProfile={onOpenProfile} browsing={hubOpen} setBrowsing={setHubOpen} />
        : <ScriptOverview api={api} profile={profile} openSettings={() => setTab('settings')} />)}
      {tab === 'log' && <LogPanel api={api} profile={profile} lines={log} />}
      {tab === 'settings' && <ProfileSettings api={api} profile={profile} link={link} sharedWith={sharedWith} onRemoved={onRemoved} />}
    </div>
  );
}

/**
 * The edge is not on the port this profile asked for. The launcher follows it (the tab and links
 * use the real port), but says so: otherwise the Port setting looks like it does nothing, and a
 * second profile on the "free" port collides with this one.
 */
function PortNote({ profile, note, openSettings }: { profile: Profile; note: { requested: number; actual: number }; openSettings: () => void }) {
  const script = profile.kind === 'script';
  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-900/10 p-3 text-sm text-amber-900 dark:text-amber-200">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="flex-1 space-y-1.5">
          <div>
            <b>Started on port {note.actual}, not {note.requested}.</b> This profile&apos;s port setting was not used.
          </div>
          {script ? (
            <div className="text-amber-800 dark:text-amber-300/90">
              The script picks its own port: either it passes one to <code className="font-mono">ivoryos_edge.run()</code>, or the IvoryOS it imports is older than the launcher and ignores it.
              End the script with
              <code className="block my-1 px-2 py-1 rounded bg-white/70 dark:bg-black/30 font-mono text-xs">ivoryos_edge.run(__name__, port=int(os.environ.get(&quot;IVORYOS_PORT&quot;, 8080)))</code>
              or set this profile&apos;s port to {note.actual}.
            </div>
          ) : (
            <div className="text-amber-800 dark:text-amber-300/90">The edge chose another port. Set this profile&apos;s port to {note.actual}, or restart it.</div>
          )}
        </div>
        <Button small tone="ghost" onClick={openSettings}>{script ? 'Configuration' : 'Settings'}</Button>
      </div>
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
