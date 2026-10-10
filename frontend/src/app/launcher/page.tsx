"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Cloud, Code2, Copy, Download, ExternalLink, FileCode2, FlaskConical, FolderOpen, LayoutGrid, Layers, Loader2, Lock,
  LogIn, PanelLeftClose, PanelLeftOpen, Play, Plus, RotateCw, Save, Send, Settings, Sparkles, Square, Store, UserPlus, X,
} from 'lucide-react';
import { chooseDialog, notify, promptDialog } from '@ivoryos/shared-ui';
import { CLOUD_TAB, desktopApi, type AccountInfo, type CloudLink, type DesktopApi, type HubLinkRequest, type Profile, type Snapshot, type Tabs, type UpdateStatus } from '@/desktop';
import AccountPanel, { Avatar, type AuthMode } from '@/components/launcher/AccountPanel';
import CloudPanel, { useCloudLinks } from '@/components/launcher/CloudPanel';
import { openReport } from '@/components/launcher/ReportProblem';
import CloudEarlyAccess from '@/components/launcher/CloudEarlyAccess';
import { sharedIdentity } from '@/components/launcher/CloudConnection';
import DeckPanel from '@/components/launcher/DeckPanel';
import HubBrowser, { type HubKind } from '@/components/launcher/HubBrowser';
import type { InstrumentSeed } from '@/components/launcher/PrivateRepos';
import ProfileSettings from '@/components/launcher/ProfileSettings';
import SettingsPanel from '@/components/launcher/SettingsPanel';
import UpgradeDialog, { type UpgradeReason } from '@/components/launcher/UpgradeDialog';
import { Button, STATE_LABEL, StatusDot, cardClass } from '@/components/launcher/ui';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { BRAND_MARK, useDocumentTheme } from '@ivoryos/shared-ui';

type ProfileTab = 'main' | 'code' | 'log' | 'settings';

// The launcher sidebar's width in px: its default, the range a drag keeps to, and how far left a
// drag has to go to hide it instead.
const NAV_DEFAULT = 288;
const NAV_MIN = 200;
const NAV_MAX = 440;
const NAV_COLLAPSE = 140;
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
  // A release without Cloud: its row opens a sign-up for early access (CloudEarlyAccess).
  const [earlyAccess, setEarlyAccess] = useState(false);
  const [tab, setTab] = useState<ProfileTab>('main');
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [tabs, setTabs] = useState<Tabs>({ open: [], active: null });
  // The sidebar can be hidden to give the page the whole window. Remembered per browser, and read
  // after hydration like the theme (AGENTS.md section 11), never in the initializer.
  const [navHidden, setNavHidden] = useState(false);
  // The sidebar's width, dragged by its right edge within NAV_MIN..NAV_MAX (resizeNav below).
  const [navWidth, setNavWidth] = useState(NAV_DEFAULT);
  const [navDrag, setNavDrag] = useState<{ top: number; collapsing: boolean } | null>(null);
  const navDragging = useRef(false);
  // The Hub browser, owned here so the sidebar's Hub button can open it on a deck.
  const [hubOpen, setHubOpen] = useState(false);
  // Which part of the Hub to open on: the sidebar's "Add platform" starts on platforms.
  const [hubKind, setHubKind] = useState<HubKind | undefined>(undefined);
  // What an `ivoryos://install` link from the Hub website asks for: the browser opens on it.
  const [hubLink, setHubLink] = useState<HubLinkRequest | null>(null);
  const openHubRef = useRef<(kind?: HubKind, link?: HubLinkRequest | null) => void>(() => {});
  // The Hub opened from the sidebar with no deck to add to: the first add creates one
  // (`createdDeck`), and closing the browser lands on it. A class picked from a private
  // repository there is handed to that deck's panel, which opens its instrument form.
  const [standaloneHub, setStandaloneHub] = useState(false);
  const createdDeck = useRef<string | null>(null);
  const [handedSeed, setHandedSeed] = useState<InstrumentSeed | null>(null);
  // A Python file dragged over the window: shown as a drop target, and dropped, added as a
  // script profile. `dragDepth` counts enter/leave pairs, since every child fires its own.
  const [dragDepth, setDragDepth] = useState(0);
  const dragging = dragDepth > 0;
  // The row being dragged and the row it is over, for reordering the sidebar.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const barRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setNavHidden(localStorage.getItem('launcher.navHidden') === '1');
    const savedWidth = Number(localStorage.getItem('launcher.navWidth'));
    if (savedWidth >= NAV_MIN && savedWidth <= NAV_MAX) setNavWidth(savedWidth);
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
    const report = () => { if (!navDragging.current) api.setSidebarWidth(el.getBoundingClientRect().width).catch(() => {}); };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [api, navHidden, snap !== null]);

  /**
   * Drag the sidebar's right edge to resize it, within NAV_MIN..NAV_MAX; let go below
   * NAV_COLLAPSE and it hides (Ctrl+B or the bar's button brings it back at its last width);
   * double-click the edge for the default. An open deck or Cloud tab is a separate view laid
   * over the window beside the sidebar, and the mouse belongs to whichever view is under it,
   * so for the length of the drag the tab is moved out to NAV_MAX: the whole range stays this
   * page's, and a plain backdrop fills the gap until the tab comes back at the new width.
   */
  const resizeNav = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !navRef.current) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const { left, top } = navRef.current.getBoundingClientRect();
    const startWidth = navWidth;
    let width = startWidth;
    let collapsing = false;
    navDragging.current = true;
    setNavDrag({ top, collapsing: false });
    api?.setSidebarWidth(NAV_MAX).catch(() => {});
    const move = (ev: PointerEvent) => {
      const raw = ev.clientX - left;
      collapsing = raw < NAV_COLLAPSE;
      width = Math.round(Math.min(NAV_MAX, Math.max(NAV_MIN, raw)));
      setNavWidth(width);
      setNavDrag(d => (d && d.collapsing !== collapsing ? { ...d, collapsing } : d));
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      navDragging.current = false;
      setNavDrag(null);
      if (collapsing) {
        setNavWidth(startWidth);
        if (!navHidden) toggleNav();
        return;
      }
      try { localStorage.setItem('launcher.navWidth', String(width)); } catch { /* not remembered */ }
      api?.setSidebarWidth(width).catch(() => {});
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  const resetNavWidth = () => {
    setNavWidth(NAV_DEFAULT);
    try { localStorage.removeItem('launcher.navWidth'); } catch { /* nothing stored */ }
  };
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
  const clearSeed = useCallback(() => setHandedSeed(null), []);
  const newDeckFromHub = useMemo(() => ({
    create: async (suggested: string) => {
      if (!api) return null;
      const name = await promptDialog('The Hub adds to a deck, and there is none yet. Name the deck this will start.', { title: 'New deck', defaultValue: suggested });
      if (!name) return null;
      const p = await api.createProfile({ kind: 'deck', name });
      createdDeck.current = p.id;
      return { id: p.id, name: p.name };
    },
    discard: async (deck: { id: string }) => {
      if (createdDeck.current === deck.id) createdDeck.current = null;
      await api?.removeProfile(deck.id);
    },
  }), [api]);
  const cloudConnected = profiles.filter(p => cloudLinks[p.id]?.paired && cloudLinks[p.id]?.connection_state === 'connected').length;

  // A profile's log: what this session has streamed, seeded from the supervisor's tail.
  useEffect(() => {
    if (!api || !profile || logs[profile.id]) return;
    api.log(profile.id).then(text => setLogs(prev => (prev[profile.id] ? prev : { ...prev, [profile.id]: text ? text.split('\n') : [] }))).catch(() => {});
  }, [api, profile, logs]);

  // The upgrade dialog is drawn by this page, and an open deck or Cloud tab is a separate view laid
  // over it: opened from the sidebar while a deck was showing, the dialog sat underneath the deck
  // with only a sliver visible beside the sidebar. So whatever opens it, this page comes forward.
  useEffect(() => { if ((upgrade !== undefined || earlyAccess) && api) api.showTab(null); }, [upgrade, earlyAccess, api]);

  // The Hub adds to a deck: the selected one, or the first deck when a script is selected. With
  // no deck at all it opens anyway, and the first thing added creates the deck it lands on.
  const hubDeck = profile?.kind === 'deck' ? profile : profiles.find(p => p.kind === 'deck') || null;
  const openHub = (kind?: HubKind, link: HubLinkRequest | null = null) => {
    api?.showTab(null);
    setHubKind(kind);
    setHubLink(link);
    if (hubDeck) { setSelected(hubDeck.id); setView('profile'); setTab('main'); setHubOpen(true); return; }
    createdDeck.current = null;
    setStandaloneHub(true);
  };

  // A link from the Hub website opens the Hub on what it names. Taken once the profiles are in, so
  // it lands on a deck if there is one; that covers the link that started the app as well.
  const profilesLoaded = !!snap;
  // Opened with `?hub` (the tour's "Build My Lab", src/tour/), it starts in the Hub browser instead.
  useEffect(() => {
    if (!api || !profilesLoaded) return;
    const take = (atStart: boolean) => {
      api.takeHubLink().then(link => {
        if (link) openHubRef.current(undefined, link);
        else if (atStart && new URLSearchParams(window.location.search).has('hub')) openHubRef.current();
      }).catch(() => {});
    };
    take(true);
    return api.onHubLink(() => take(false));
  }, [api, profilesLoaded]);
  // openHub as of the last render, for a link that arrives later than the effect above was set up.
  useEffect(() => { openHubRef.current = openHub; });

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

  // One entry for both kinds: a deck is what most people want, and a script is the same thing
  // written by hand, so they are offered together rather than as two buttons to tell apart.
  const addDeck = async () => {
    api.showTab(null);
    const choice = await chooseDialog({
      title: 'Add a deck',
      message: 'A deck is one edge server: its instruments, its workflows and its data. Start it empty and add instruments from the Hub, or run a Python script you already have (you can also drop a .py file anywhere on this window).',
      actions: [{ id: 'deck', label: 'Empty deck', kind: 'primary' }, { id: 'script', label: 'From a Python script' }, { id: 'cancel', label: 'Cancel', kind: 'cancel' }],
    });
    if (choice === 'deck' || choice === 'script') await newProfile(choice);
  };
  // The simulated lab: created once, then started and opened, so "see it work" is one click.
  const tryExample = () => run(async () => {
    api.showTab(null);
    const p = await api.createExample();
    showDeck(p.id);
    if (p.status.state !== 'running') await api.start(p.id);
    await api.open(p.id);
  });
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragEnter = (e: React.DragEvent) => { if (hasFiles(e)) { e.preventDefault(); setDragDepth(d => d + 1); } };
  const onDragLeave = (e: React.DragEvent) => { if (hasFiles(e)) setDragDepth(d => Math.max(0, d - 1)); };
  const onDragOver = (e: React.DragEvent) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragDepth(0);
    const files = Array.from(e.dataTransfer.files);
    const scripts = files.filter(f => f.name.toLowerCase().endsWith('.py'));
    if (!scripts.length) { notify('Drop a Python file (.py) to add it as a deck.', { title: 'Not a Python script' }); return; }
    api.showTab(null);
    run(async () => {
      let last: Profile | null = null;
      for (const f of scripts) last = await api.createProfile({ kind: 'script', script: api.pathForFile(f) });
      if (last) { setSelected(last.id); setView('profile'); setTab('code'); }
    });
  };
  const newProfile = async (kind: 'deck' | 'script') => {
    // A deck's or Cloud's page is drawn by the app over this one, so the prompt and the new
    // profile's page were both hidden behind it until the tab was put away.
    api.showTab(null);
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
  const cloudComingSoon = !!snap?.cloudComingSoon;
  const openCloud = async () => {
    if (cloudComingSoon) { setEarlyAccess(true); return; }
    if (!pro) { setUpgrade('cloud'); return; }
    if (tabs.open.includes(CLOUD_TAB)) { api.showTab(CLOUD_TAB); return; }
    const check = await api.checkCloud().catch(() => null);
    if (check?.reachable && check.isCloud) run(() => api.openCloud());
    else showCloudPage();
  };

  // Only Cloud on this computer (Settings): no decks, no Hub, no Python; Cloud leads the sidebar.
  const cloudOnly = !!snap?.cloudOnly;
  const cloudRow = (
    <>
            {/* Same box as the add rows above (px-3 py-2, icon / two lines / trailing mark), so
                the highlight lines up with them; the gear sits over the trailing slot. */}
            <div className="group relative">
              <button
                type="button"
                onClick={openCloud}
                title={cloudComingSoon ? 'Cloud is coming soon: sign up for early access' : `Cloud: ${cloudConnected ? `${cloudConnected} deck${cloudConnected === 1 ? '' : 's'} connected` : 'manage decks from anywhere'}${pro ? '' : ' (a Pro feature)'}`}
                className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-3 transition-colors ${(tabs.active !== null ? tabs.active === CLOUD_TAB : view === 'cloud') ? 'bg-accent-soft text-accent-fg' : 'hover:bg-gray-100 dark:hover:bg-white/5'}`}
              >
                <Cloud className="w-4 h-4 shrink-0 text-gray-700 dark:text-gray-200 dark:text-white" />
                <span className="flex-1 min-w-0 truncate text-sm font-medium">Cloud</span>
                {/* Coming soon: a quiet tag. Otherwise the lock alone says it is not included. */}
                {cloudComingSoon
                  ? <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400">Soon</span>
                  : pro ? <span className="w-4 h-4 shrink-0" /> : <Lock className="w-4 h-4 shrink-0 text-gray-400" />}
              </button>
              {pro && !cloudComingSoon && (
                <button type="button" title="Cloud: connection and address" onClick={showCloudPage}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-white dark:hover:text-gray-200 dark:hover:bg-white/10 ${tabs.active === null && view === 'cloud' ? 'text-gray-700 dark:text-gray-200 dark:text-white' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}>
                  <Settings className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
    </>
  );

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
  const showDeck = (id: string) => { setSelected(id); setView('profile'); setTab('main'); };
  const closeStandaloneHub = () => {
    setStandaloneHub(false);
    if (createdDeck.current) showDeck(createdDeck.current);
  };

  const rt = snap?.runtime;
  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white" onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}>
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[150] flex items-center justify-center bg-gray-900/10 dark:bg-white/10 backdrop-blur-[1px]">
          <div className="rounded-2xl border-2 border-dashed border-gray-400 dark:border-white/30 bg-white/90 dark:bg-[#111]/90 px-8 py-6 text-center shadow-xl">
            <FileCode2 className="w-8 h-8 mx-auto text-gray-700 dark:text-gray-200" />
            <div className="mt-2 text-base font-semibold">Drop a Python script</div>
            <div className="text-sm text-gray-500 dark:text-gray-400">It becomes a deck you can start, edit and restart here.</div>
          </div>
        </div>
      )}
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
        {!navHidden && <nav ref={navRef} style={{ width: navWidth }} className={`relative shrink-0 border-r border-gray-200 dark:border-white/10 flex flex-col bg-white/60 dark:bg-white/[0.02] ${navDrag?.collapsing ? 'opacity-40' : ''}`}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the sidebar"
            title="Drag to resize; drag to the left edge to hide. Double-click for the default width."
            onPointerDown={resizeNav}
            onDoubleClick={resetNavWidth}
            className={`absolute -right-1 top-0 bottom-0 w-2 z-20 cursor-col-resize group/resize`}
          >
            <div className={`mx-auto h-full w-px transition-colors ${navDrag ? 'bg-gray-400 dark:bg-white/40' : 'bg-transparent group-hover/resize:bg-gray-300 dark:group-hover/resize:bg-white/20'}`} />
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-1">
            {cloudOnly && cloudRow}
            {!cloudOnly && profiles.map(p => {
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
                  className={`group flex items-stretch rounded-lg border transition-colors ${active ? 'bg-accent-soft text-accent-fg border-accent-tint/50' : 'border-transparent hover:bg-gray-100 dark:hover:bg-white/5'} ${dropOn === p.id ? '!border-gray-400 dark:border-white/30 border-dashed' : ''} ${dragId === p.id ? 'opacity-40' : ''}`}
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
                    className={`self-center mx-1.5 p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-white dark:hover:text-gray-200 dark:hover:bg-white/10 ${onPage ? 'text-gray-700 dark:text-gray-200 dark:text-white' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
                  >
                    <Settings className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
          {/* Adding sits with the decks it adds to; Cloud, below, is an addition, never a gate. */}
          {!cloudOnly && <div className="px-3 pt-1 space-y-0.5">
            <SideAction icon={<Plus className="w-4 h-4 shrink-0 text-gray-500 dark:text-gray-400" />} label="Add a deck" hint="Empty, or from a Python script" onClick={addDeck} />
            <SideAction
              icon={<Store className="w-4 h-4 shrink-0 text-gray-700 dark:text-gray-200 dark:text-white" />}
              label="Automation Hub"
              hint={hubDeck ? `Add to ${hubDeck.name}` : 'Drivers, platforms, plugins, workflows'}
              title={hubDeck ? `Add a platform, instruments, plugins or workflows from the Hub to ${hubDeck.name}` : 'Browse the Automation Hub; the first thing you add starts a new deck'}
              onClick={() => openHub('platforms')}
            />
          </div>}
          {/* No rule above Cloud: it is one more entry in the list, and the same space above and
              below keeps its highlight centred between the entries and the account row. */}
          {!cloudOnly && !snap?.noCloud && <div className="px-3 pt-0.5 pb-2 space-y-0.5">{cloudRow}</div>}
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
        {/* While the edge is dragged, an open tab waits at NAV_MAX (resizeNav); this fills the gap. */}
        {navDrag && !navHidden && tabs.active !== null && (
          <div aria-hidden className="fixed bottom-0 z-10 bg-gray-50 dark:bg-[#0a0a0a]"
            style={{ top: navDrag.top, left: navWidth, width: Math.max(0, NAV_MAX - navWidth) + 2 }} />
        )}

        <main className="flex-1 min-w-0 overflow-y-auto">
          {/* A Cloud-only install opens on Cloud, once per launch. A component rather than a hook
              here: this page returns early while the desktop bridge loads, and hooks after that
              return would change in number between renders. */}
          {cloudOnly && tabs.active === null && !cloudOpenedThisLaunch && <OpenOnce open={() => { cloudOpenedThisLaunch = true; openCloud(); }} />}
          {view === 'settings' && snap ? (
            <SettingsPanel api={api} snap={snap} />
          ) : view === 'account' ? (
            <AccountPanel api={api} account={account} secretsPersist={snap?.secretsPersist ?? true} mode={authMode} setMode={setAuthMode} onUpgrade={() => setUpgrade(null)} />
          ) : view === 'cloud' && pro ? (
            <CloudPanel api={api} profiles={profiles} links={cloudLinks} cloudUrl={snap?.cloudUrl || ''} run={run} />
          ) : cloudOnly ? (
            pro
              ? <CloudPanel api={api} profiles={profiles} links={cloudLinks} cloudUrl={snap?.cloudUrl || ''} run={run} />
              : <CloudOnlyUpgrade onUpgrade={() => setUpgrade('cloud')} onLeave={() => run(() => api.setCloudOnly(false))} />
          ) : profile ? (
            <ProfileView
              key={profile.id}
              api={api}
              cloudComingSoon={cloudComingSoon}
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
              onOpenProfile={showDeck}
              hubOpen={hubOpen}
              setHubOpen={setHubOpen}
              hubKind={hubKind}
              hubLink={hubLink}
              seed={handedSeed}
              onSeedTaken={clearSeed}
            />
          ) : (
            <Welcome account={account} cloudComingSoon={cloudComingSoon} onSignIn={() => openAuth('sign-in')} onSignUp={() => openAuth('sign-up')} onAddDeck={addDeck} onHub={() => openHub()} onExample={tryExample}
              onCloudOnly={() => run(async () => { await api.setCloudOnly(true); await openCloud(); })} />
          )}
        </main>
      </div>
      {standaloneHub && (
        <HubBrowser
          api={api}
          profile={null}
          newDeck={newDeckFromHub}
          initialKind={hubKind}
          initialLink={hubLink}
          hubUrl={snap?.hubUrl || ''}
          pro={pro}
          onUpgrade={() => setUpgrade('private')}
          onPrivatePicked={setHandedSeed}
          onClose={closeStandaloneHub}
          onAdded={() => {}}
          onOpenProfile={showDeck}
        />
      )}
      {earlyAccess && (
        <CloudEarlyAccess api={api} email={account.user?.email} name={account.user?.name} onClose={() => setEarlyAccess(false)} />
      )}
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
          className={`flex-1 min-w-0 flex items-center gap-2.5 px-1.5 py-1 -mx-1.5 rounded-lg text-left ${view === 'account' ? 'bg-accent-soft text-accent-fg' : 'hover:bg-gray-100 dark:hover:bg-white/5'}`}
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
        className={`relative p-1.5 rounded-lg ${view === 'settings' ? 'bg-accent-soft text-accent-fg' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5'}`}
      >
        <Settings className="w-4 h-4" />
        {updateWaiting && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-accent ring-2 ring-white dark:ring-[#111]" />}
      </button>
    </div>
  );
}

/** In the tab bar only when there is something to do about an update. */
function UpdateChip({ update, onClick }: { update: UpdateStatus; onClick: () => void }) {
  if (update.state !== 'ready' && update.state !== 'available') return null;
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-accent-soft text-accent-fg hover:bg-accent-tint/30">
      <Download className="w-3 h-3" />
      {update.state === 'ready' ? `Restart to update to ${update.version}` : `Update ${update.version} available`}
    </button>
  );
}

/**
 * Start (or restart) a deck, then open its page once it is ready: what someone who pressed Start
 * is waiting for. Not when they did anything else meanwhile (a click or a key anywhere in the
 * launcher, or another tab opened): they have moved on and are not pulled back. Opened without
 * bringing the window forward, so someone who went to another app stays there (the app tells
 * them the deck is ready). A deck with instruments that did not load shows those instead
 * (`showLoadErrors`), since its page would only look as if they were missing. A failed start
 * rejects as before, and the Log it is watched on stays.
 */
async function startThenOpen(api: DesktopApi, id: string, start: () => Promise<unknown>, showLoadErrors: () => void) {
  let movedOn = false;
  const moved = () => { movedOn = true; };
  document.addEventListener('pointerdown', moved, true);
  document.addEventListener('keydown', moved, true);
  const offTabs = api.onTabs(t => { if (t.active) movedOn = true; });
  try {
    await start();
    if (movedOn) return;
    const status = (await api.snapshot()).profiles.find(p => p.id === id)?.status;
    if (!status || status.state !== 'running' || !status.url) return;
    const notLoaded = await fetch(`${status.url}/api/status`).then(r => r.json())
      .then(s => (s.instrument_errors || []).length > 0).catch(() => false);
    if (movedOn) return;
    if (notLoaded) showLoadErrors();
    else await api.open(id, undefined, { raise: false });
  } finally {
    document.removeEventListener('pointerdown', moved, true);
    document.removeEventListener('keydown', moved, true);
    offTabs();
  }
}

function ProfileView({ api, profile, hubUrl, pro, onUpgrade, link, sharedWith, tab, setTab, log, run, onRemoved, onOpenProfile, hubOpen, setHubOpen, hubKind, hubLink, seed, onSeedTaken, cloudComingSoon }: {
  api: DesktopApi;
  profile: Profile;
  hubUrl: string;
  pro: boolean;
  onUpgrade: () => void;
  link?: CloudLink;
  sharedWith: Profile[];
  tab: ProfileTab;
  setTab: (t: ProfileTab) => void;
  log: string[];
  run: (fn: () => Promise<unknown>) => void;
  onRemoved: () => void;
  onOpenProfile: (id: string) => void;
  hubOpen: boolean;
  setHubOpen: (open: boolean) => void;
  hubKind?: HubKind;
  hubLink?: HubLinkRequest | null;
  seed?: InstrumentSeed | null;
  onSeedTaken?: () => void;
  cloudComingSoon?: boolean;
}) {
  const s = profile.status;
  const busy = ['starting', 'stopping', 'installing'].includes(s.state);
  const running = s.state === 'running';
  const failed = s.state === 'error' || s.state === 'crashed';
  // "Send to IvoryOS" with this session's log, as the Log tab shows it.
  const report = () => openReport(api, profile.id, { log: log.join('\n') });
  // A script written for IvoryOS Classic (`import ivoryos`) stops at that import here, so it is
  // offered the switch first: the import and run() call change, each original line kept,
  // commented out, so going back is uncommenting (edge classic.py).
  const startProfile = async () => {
    if (profile.kind === 'script') {
      const classic = await api.classicScript(profile.id).catch(() => null);
      if (classic) {
        const lines = classic.changes.flatMap(c => [...c.before.map(l => `- ${l.trim()}`), ...c.after.map(l => `+ ${l.trim()}`)]);
        const shown = lines.slice(0, 16).join('\n') + (lines.length > 16 ? `\n… and ${lines.length - 16} more lines` : '');
        const notes = classic.notes.length ? `\n\n${classic.notes.map(n => `• ${n}`).join('\n')}` : '';
        const choice = await chooseDialog({
          title: 'Written for IvoryOS Classic',
          message: `${(profile.script || '').split(/[\\/]/).pop()} imports ivoryos (IvoryOS Classic), which this app does not run. `
            + `Switched to IvoryOS NextGen, each changed line stays in the file, commented out, so switching back is uncommenting.\n\n${shown}${notes}`,
          actions: [
            { id: 'convert', label: 'Update the script and start', kind: 'primary' },
            { id: 'start', label: 'Start as it is' },
            { id: 'cancel', label: 'Cancel', kind: 'cancel' },
          ],
        });
        if (choice !== 'convert' && choice !== 'start') return;
        if (choice === 'convert') {
          try { await api.writeScript(profile.id, classic.converted); } catch (e: any) { notify(e.message, { title: 'Could not update the script', tone: 'error' }); return; }
        }
      }
    }
    setTab('log');
    run(() => startThenOpen(api, profile.id, () => api.start(profile.id), () => setTab('main')));
  };
  const restartProfile = () => {
    setTab('log');
    run(() => startThenOpen(api, profile.id, () => api.restart(profile.id), () => setTab('main')));
  };
  const tabs: { id: ProfileTab; label: string }[] = [
    { id: 'main', label: profile.kind === 'deck' ? 'Instruments' : 'Overview' },
    // A script is usually one short file; showing it here is what lets a change be tried without
    // leaving the app (edit, save, Restart).
    ...(profile.kind === 'script' ? [{ id: 'code' as const, label: 'Code' }] : []),
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
            <Button tone="stop" disabled={busy} onClick={() => run(() => api.stop(profile.id))}><Square className="w-4 h-4" /> Stop</Button>
          ) : (
            // Starting shows the Log: it is where a start is seen to happen (or to fail), line by line.
            <Button tone="go" disabled={profile.problems.length > 0} title={profile.problems.join(' ')} onClick={startProfile}><Play className="w-4 h-4" /> Start</Button>
          )}
          <Button disabled={!running} onClick={restartProfile} title="Stop and start again: reloads the deck or script"><RotateCw className="w-4 h-4" /> Restart</Button>
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
            <Button small tone="ghost" onClick={report} title="Send this session's log and the environment to the IvoryOS team; you see it all first"><Send className="w-3.5 h-3.5" /> Send to IvoryOS</Button>
          </div>
        </div>
      )}

      <div className="flex gap-1 border-b border-gray-200 dark:border-white/10">
        {tabs.map(t => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`px-3 py-2 text-sm -mb-px border-b-2 ${tab === t.id ? 'border-accent text-accent-fg font-medium' : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'main' && (profile.kind === 'deck'
        ? <DeckPanel api={api} profile={profile} hubUrl={hubUrl} pro={pro} onUpgrade={onUpgrade} onOpenProfile={onOpenProfile} browsing={hubOpen} setBrowsing={setHubOpen} hubKind={hubKind} hubLink={hubLink} seed={seed} onSeedTaken={onSeedTaken} />
        : <ScriptOverview api={api} profile={profile} openSettings={() => setTab('settings')} openCode={() => setTab('code')} />)}
      {tab === 'code' && profile.kind === 'script' && <CodePanel api={api} profile={profile} run={run} />}
      {tab === 'log' && <LogPanel api={api} profile={profile} lines={log} onReport={failed ? report : undefined} />}
      {tab === 'settings' && <ProfileSettings api={api} profile={profile} link={link} sharedWith={sharedWith} onRemoved={onRemoved} cloudOffered={!cloudComingSoon} />}
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

function ScriptOverview({ api, profile, openSettings, openCode }: { api: DesktopApi; profile: Profile; openSettings: () => void; openCode: () => void }) {
  const env = Object.entries(profile.env || {});
  return (
    <div className="space-y-4">
      <div className={`${cardClass} p-4 space-y-3 text-sm`}>
        <Row label="Script"><span className="font-mono break-all">{profile.script}</span>
          <Button small tone="ghost" title="Edit the script here" onClick={openCode}><Code2 className="w-3.5 h-3.5" /></Button>
          <Button small tone="ghost" title="Show in the file manager" onClick={() => api.reveal(profile.id, 'script').catch(e => notify(e.message))}><FolderOpen className="w-3.5 h-3.5" /></Button></Row>
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
          <div className="space-y-1">{env.map(([k, v]) => <div key={k} className="text-sm font-mono"><span className="text-gray-900 dark:text-white">{k}</span>={v}</div>)}</div>
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

/** A sidebar row that does something (add, browse), drawn like the profile rows above it. */
// One line each: the second line of explanation under every entry made the sidebar read as a
// wall of small text. What the entry does is in its tooltip.
function SideAction({ icon, label, hint, title, onClick }: { icon: React.ReactNode; label: string; hint: string; title?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title={title || `${label}: ${hint}`}
      className="w-full text-left px-3 py-2 rounded-lg flex items-center gap-3 transition-colors hover:bg-gray-100 dark:hover:bg-white/5">
      {icon}
      <span className="flex-1 min-w-0 truncate text-sm font-medium">{label}</span>
    </button>
  );
}

/**
 * The first thing a new install shows: nothing is configured, so instead of an empty page it
 * offers the three ways in and the account, none of them required. The Hub leads and the example
 * comes last: the example is the easy click, but a real deck from the Hub (or your own) is where
 * people should start.
 */
function Welcome({ account, cloudComingSoon, onSignIn, onSignUp, onAddDeck, onHub, onExample, onCloudOnly }: {
  account: AccountInfo; cloudComingSoon?: boolean; onSignIn: () => void; onSignUp: () => void; onAddDeck: () => void; onHub: () => void; onExample: () => void; onCloudOnly: () => void;
}) {
  const action = (icon: React.ReactNode, label: string, hint: string, onClick: () => void, accent = false) => (
    <button type="button" onClick={onClick}
      className={`${cardClass} p-5 text-left flex flex-col gap-3 transition hover:border-gray-300 dark:hover:border-white/20 hover:shadow-md dark:hover:border-white/30 ${accent ? 'border-gray-200 dark:border-white/15 dark:border-white/20' : ''}`}>
      <span className={`w-10 h-10 rounded-xl flex items-center justify-center ${accent ? 'bg-accent text-on-accent' : 'bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white dark:bg-white/10 dark:text-white'}`}>{icon}</span>
      <span>
        <span className="block text-base font-semibold text-gray-900 dark:text-gray-100">{label}</span>
        <span className="block mt-1 text-sm text-gray-500 dark:text-gray-400">{hint}</span>
      </span>
    </button>
  );
  return (
    <div className="min-h-full flex items-center justify-center p-10">
      <div className="w-full max-w-3xl space-y-8">
        <div className="flex items-center gap-4">
          <img src={BRAND_MARK} alt="" className="h-14 w-auto shrink-0" />
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Welcome to IvoryOS</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Run your lab&apos;s instruments from one place. Start with any of these.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {action(<Store className="w-5 h-5" />, 'Browse the Hub', 'Drivers, platforms and workflows shared by the community.', onHub, true)}
          {action(<Plus className="w-5 h-5" />, 'Add a deck', 'Your own instruments, or a Python script you already have.', onAddDeck)}
          {action(<FlaskConical className="w-5 h-5" />, 'Try the example', 'A simulated lab. Nothing to plug in.', onExample)}
        </div>
        {!cloudComingSoon && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Only working with decks that run elsewhere?{' '}
            <button type="button" onClick={onCloudOnly} className="font-medium text-gray-900 underline-offset-2 hover:underline dark:text-gray-100">Use Cloud only</button>
          </p>
        )}
        {!account.signedIn && (
          <div className={`${cardClass} p-4 flex items-center gap-4`}>
            <div className="flex-1 text-sm text-gray-600 dark:text-gray-300">
              <span className="font-medium text-gray-900 dark:text-gray-100">Have an account?</span> Signing in unlocks the private hub, your starred items{cloudComingSoon ? '' : ' and Cloud'}. Everything above works without one.
            </div>
            <Button tone="primary" onClick={onSignIn}><LogIn className="w-4 h-4" /> Sign in</Button>
            <Button onClick={onSignUp}><UserPlus className="w-4 h-4" /> Sign up</Button>
          </div>
        )}
      </div>
    </div>
  );
}

let cloudOpenedThisLaunch = false;

/** Calls `open` once, when it mounts. */
function OpenOnce({ open }: { open: () => void }) {
  useEffect(() => { open(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Cloud-only without Cloud in the plan: say so, and offer the way out. */
function CloudOnlyUpgrade({ onUpgrade, onLeave }: { onUpgrade: () => void; onLeave: () => void }) {
  return (
    <div className="min-h-full flex items-center justify-center p-10">
      <div className="max-w-md text-center space-y-4">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Cloud is part of Pro</h1>
        <div className="flex justify-center gap-2">
          <Button tone="primary" onClick={onUpgrade}>See plans</Button>
          <Button onClick={onLeave}>Run decks here instead</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * A script profile's file, editable in place: CodeMirror with Python highlighting, line numbers,
 * bracket matching and indentation, following the app's theme. Not a whole IDE: a deck script is
 * a few dozen lines, and the loop that matters is edit, save, Restart. Saving never touches the
 * running process; the Restart button is right beside it so the two are not confused.
 */
function CodePanel({ api, profile, run }: { api: DesktopApi; profile: Profile; run: (fn: () => Promise<unknown>) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const theme = useDocumentTheme();
  const load = useCallback(() => {
    api.readScript(profile.id).then(t => { setText(t); setSaved(t); setError(null); }).catch(e => setError(e.message));
  }, [api, profile.id]);
  useEffect(load, [load]);
  const dirty = text !== null && text !== saved;
  const running = profile.status.state === 'running';

  const save = async () => {
    if (text === null) return;
    setBusy(true);
    try { await api.writeScript(profile.id, text); setSaved(text); }
    catch (e: any) { await notify(e.message, { title: 'Could not save the script', tone: 'error' }); }
    finally { setBusy(false); }
  };
  const saveAndRestart = async () => {
    await save();
    // Opens the deck's page when it is back, unless the person went on editing meanwhile.
    run(() => startThenOpen(api, profile.id, () => (running ? api.restart(profile.id) : api.start(profile.id)), () => {}));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
  };

  if (error) return <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 rounded-lg p-3">{error}</div>;
  if (text === null) return <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading the script…</div>;
  return (
    <div className="space-y-2" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs text-gray-500 dark:text-gray-400 truncate flex-1 min-w-0" title={profile.script}>{(profile.script || '').split(/[\\/]/).pop()}{dirty ? ' · unsaved' : ''}</span>
        <Button small onClick={load} disabled={!dirty} title="Discard the unsaved changes">Revert</Button>
        <Button small onClick={save} disabled={!dirty || busy} title="Save (Ctrl/Cmd+S)"><Save className="w-3.5 h-3.5" /> Save</Button>
        <Button small tone="primary" onClick={saveAndRestart} disabled={busy} title={running ? 'Save, then stop and start the script again' : 'Save, then start the script'}>
          <RotateCw className="w-3.5 h-3.5" /> {running ? 'Save and restart' : 'Save and start'}
        </Button>
      </div>
      <div className={`${cardClass} overflow-hidden text-[13px]`}>
        <CodeMirror
          value={text}
          height="32rem"
          theme={theme === 'dark' ? oneDark : 'light'}
          extensions={[python()]}
          onChange={setText}
          basicSetup={{ tabSize: 4, foldGutter: false }}
        />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">Every module-level instrument object becomes a device, named after its variable. Changes apply when the script restarts.</p>
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

/** `onReport` only after a failed start, a crash or a failed install: that is what reports are for. */
function LogPanel({ api, profile, lines, onReport }: { api: DesktopApi; profile: Profile; lines: string[]; onReport?: () => void }) {
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines, follow]);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} className="accent-accent" /> Follow
        </label>
        <div className="ml-auto flex gap-2">
          <Button small onClick={() => api.copy(lines.join('\n'))}><Copy className="w-3.5 h-3.5" /> Copy</Button>
          <Button small onClick={() => api.reveal(profile.id, 'log').catch(e => notify(e.message))}><FolderOpen className="w-3.5 h-3.5" /> Log file</Button>
          {onReport && <Button small onClick={onReport} title="Send this session's log and the environment to the IvoryOS team; you see it all first"><Send className="w-3.5 h-3.5" /> Send to IvoryOS</Button>}
        </div>
      </div>
      <pre ref={ref} className="h-[28rem] overflow-auto rounded-xl bg-gray-900 text-gray-100 dark:bg-black text-[11px] leading-relaxed p-4 font-mono whitespace-pre-wrap break-words">
        {lines.length ? lines.join('\n') : 'Nothing logged yet. Start the profile to see its output here.'}
      </pre>
    </div>
  );
}
