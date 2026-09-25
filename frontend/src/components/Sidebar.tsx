"use client";
import { API_BASE, WS_BASE } from '@/config';

import { useEffect, useRef, useState } from 'react';
import { Sun, Moon, LayoutDashboard, Library, Workflow, Play, History, Database, ListTodo, PanelLeftClose, PanelLeftOpen, Settings2, Plug, Gauge, Menu, Cloud, HandHelping, Minimize2 } from 'lucide-react';
import { INPUT_PROMPT_EVENT, isPromptMinimized, promptKey, setPromptMinimized } from '@/inputPrompt';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { lastRunTabHref, runTabForPath, samePath } from './RunTabs';

interface SidebarProps {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

export default function Sidebar({ theme, toggleTheme }: SidebarProps) {
  const [edgeStatus, setEdgeStatus] = useState<any>(null);
  const [plugins, setPlugins] = useState<any[]>([]);
  // Starts at the same default on server and client, then corrects from localStorage in an
  // effect (client-only, runs after hydration) — reading localStorage inside the useState
  // initializer would make the client's first render disagree with the server-rendered HTML
  // whenever the saved preference differs from the default, causing a hydration mismatch.
  const [isExpanded, setIsExpanded] = useState(true);
  // Configure and Optimize share one entry; it returns you to whichever you were last on. Same
  // hydration constraint as isExpanded above — start at the default, correct after mount.
  const [runHref, setRunHref] = useState('/execution');
  const pathname = usePathname();

  useEffect(() => {
    const saved = localStorage.getItem('ivoryos_sidebar_expanded');
    if (saved !== null) setIsExpanded(saved === 'true');
  }, []);

  // Re-read on every navigation: landing on /optimize updates the memory, and the entry should
  // point there from then on without needing a reload.
  useEffect(() => {
    setRunHref(lastRunTabHref());
  }, [pathname]);

  // While you are *on* one of the two, the entry points at that one directly rather than at the
  // remembered value. RunTabs writes the memory from its own effect, and sibling effects fire in
  // tree order — Sidebar renders first, so it would otherwise read the previous tab for one
  // navigation and lag a step behind.
  const currentRunTab = runTabForPath(pathname);
  const runEntryHref = currentRunTab ? currentRunTab.href : runHref;

  const [waitingRun, setWaitingRun] = useState<{ id: number; stepId?: number; prompt: string; inputType: string } | null>(null);
  // Put aside by the operator (see inputPrompt.ts); the status bar brings it back.
  const [promptMinimized, setPromptMinimizedState] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [submittingInput, setSubmittingInput] = useState(false);
  const lastWaitingRunId = useRef<number | null>(null);

  const toggleExpanded = () => {
    const next = !isExpanded;
    setIsExpanded(next);
    localStorage.setItem('ivoryos_sidebar_expanded', String(next));
  };

  useEffect(() => {
    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => setEdgeStatus(data))
      .catch(err => console.error(err));

    fetch(`${API_BASE}/api/plugins`)
      .then(res => res.json())
      .then(data => {
          if (data.plugins) {
              setPlugins(data.plugins);
          }
      })
      .catch(err => console.error(err));
  }, []);

  // Human-in-the-loop: watch every page for a run paused on a 'User_Input' step and
  // pop up a global prompt, so the operator sees it no matter where they're browsing.
  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const runs = data.runs || [];
        const active = runs.find((r: any) => r.status === 'waiting_input');
        if (active) {
          const step = (active.steps || []).find((s: any) => s.status === 'waiting_input');
          const prompt = step?.outputs?.prompt || 'Input required';
          // The step declares what kind of value it wants, so the prompt can show the matching
          // control rather than making the operator hand-type 'true' or a number into a text box.
          const inputType = step?.outputs?.input_type || 'str';
          if (lastWaitingRunId.current !== active.id) {
            lastWaitingRunId.current = active.id;
            setInputValue(inputType === 'bool' ? 'false' : '');
          }
          setWaitingRun({ id: active.id, stepId: step?.id, prompt, inputType });
          setPromptMinimizedState(isPromptMinimized(promptKey(active.id, step?.id)));
        } else {
          lastWaitingRunId.current = null;
          setWaitingRun(null);
        }
      } catch (e) { }
    };
    return () => ws.close();
  }, []);

  useEffect(() => {
    if (!waitingRun) return;
    const key = promptKey(waitingRun.id, waitingRun.stepId);
    const sync = () => setPromptMinimizedState(isPromptMinimized(key));
    sync();
    window.addEventListener(INPUT_PROMPT_EVENT, sync);
    return () => window.removeEventListener(INPUT_PROMPT_EVENT, sync);
  }, [waitingRun?.id, waitingRun?.stepId]);

  const submitWaitingInput = async () => {
    if (!waitingRun) return;
    let value: any = inputValue;
    if (waitingRun.inputType === 'int' || waitingRun.inputType === 'float') {
      if (inputValue.trim() === '' || isNaN(Number(inputValue))) {
        alert(`This step expects a ${waitingRun.inputType === 'int' ? 'whole number' : 'number'}.`);
        return;
      }
      value = waitingRun.inputType === 'int' ? parseInt(inputValue, 10) : parseFloat(inputValue);
    } else if (waitingRun.inputType === 'bool') {
      value = inputValue === 'true';
    }
    setSubmittingInput(true);
    try {
      await fetch(`${API_BASE}/api/queue/runs/${waitingRun.id}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value })
      });
      setWaitingRun(null);
      lastWaitingRunId.current = null;
    } catch (e) {
      console.error(e);
    } finally {
      setSubmittingInput(false);
    }
  };

  const navItem = (href: string, label: string, icon: React.ReactNode, alsoActiveOn: string[] = []) => {
    // samePath, not ===: with trailingSlash the pathname is "/library/" and every href here is
    // written "/library", so no entry had ever highlighted as current.
    const isActive = samePath(href, pathname) || alsoActiveOn.some(p => samePath(p, pathname));
    return (
      <Link 
        href={href} 
        title={!isExpanded ? label : undefined}
        className={`flex items-center py-3 rounded-lg overflow-hidden mx-3 ${
          isActive 
            ? 'bg-indigo-50 dark:bg-white/10 text-indigo-600 dark:text-white' 
            : 'hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-white'
        }`}
      >
        <div className="w-5 h-5 flex justify-center shrink-0 ml-3">
          {icon}
        </div>
        {isExpanded && <span className="ml-4 whitespace-nowrap">{label}</span>}
      </Link>
    );
  };

  return (
    <>
    {waitingRun && !promptMinimized && (
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
        <div className="w-full max-w-md bg-white dark:bg-[#1a1a1a] border border-pink-200 dark:border-pink-500/30 rounded-2xl shadow-2xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg bg-pink-50 dark:bg-pink-500/10 flex items-center justify-center shrink-0">
              <HandHelping className="w-5 h-5 text-pink-600 dark:text-pink-400" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">Input needed to continue</h2>
              <p className="text-[11px] text-gray-400 dark:text-gray-500">The workflow is paused and waiting for you</p>
            </div>
            {/* Answering can need a look at the workflow, the data, or the bench first. The run
                stays paused; the status bar's "answer" button brings this back. */}
            <button
              onClick={() => setPromptMinimized(promptKey(waitingRun.id, waitingRun.stepId))}
              title="Answer later: minimize to the status bar (the run stays paused)"
              className="shrink-0 p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-white/10"
            >
              <Minimize2 className="w-4 h-4" />
            </button>
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">{waitingRun.prompt}</p>
          {waitingRun.inputType === 'bool' ? (
            <label className="flex items-center gap-2 mb-4 text-sm text-gray-700 dark:text-gray-300 select-none cursor-pointer">
              <input
                type="checkbox"
                autoFocus
                checked={inputValue === 'true'}
                onChange={e => setInputValue(e.target.checked ? 'true' : 'false')}
                className="w-4 h-4 accent-pink-600"
              />
              <span>{inputValue === 'true' ? 'Yes / True' : 'No / False'}</span>
            </label>
          ) : (
            <input
              type={waitingRun.inputType === 'int' || waitingRun.inputType === 'float' ? 'number' : 'text'}
              step={waitingRun.inputType === 'float' ? 'any' : waitingRun.inputType === 'int' ? '1' : undefined}
              autoFocus
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitWaitingInput(); }}
              placeholder={waitingRun.inputType === 'int' ? 'Enter a whole number...' : waitingRun.inputType === 'float' ? 'Enter a number...' : 'Type your answer...'}
              className="w-full bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-pink-400 dark:focus:border-pink-500 mb-4"
            />
          )}
          <button
            onClick={submitWaitingInput}
            disabled={submittingInput}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-pink-600 hover:bg-pink-700 disabled:opacity-50 text-white transition-colors"
          >
            {submittingInput ? 'Submitting...' : 'Continue Workflow'}
          </button>
        </div>
      </div>
    )}
    <aside className={`shrink-0 bg-white dark:bg-white/5 backdrop-blur-md border-r border-gray-200 dark:border-white/10 flex flex-col py-6 space-y-6 z-10 overflow-hidden ${isExpanded ? 'w-64' : 'w-[72px]'}`}>
      <div className="flex items-center w-full px-3">
        <button onClick={toggleExpanded} className="w-[44px] h-[44px] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 flex items-center justify-center rounded-lg transition-colors">
          <Menu className="w-5 h-5 shrink-0" />
        </button>
        {isExpanded && (
          <div className="flex items-center space-x-3 ml-2">
            <img src="/favicon.ico" alt="Logo" className="w-8 h-8 shrink-0" />
            <h1 className="text-xl font-bold tracking-wider">IvoryOS</h1>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-2 text-sm font-medium text-gray-600 dark:text-gray-400 overflow-y-auto w-full">
        {navItem('/', 'Dashboard', <LayoutDashboard className="w-5 h-5 shrink-0" />)}
        {navItem('/library', 'Library', <Library className="w-5 h-5 shrink-0" />)}
        {navItem('/designer', 'Designer', <Workflow className="w-5 h-5 shrink-0" />)}
        {/* One entry for two routes. Both are "fill in this workflow's open parameters"; the tab
            strip in the page header is what switches between filling them yourself and letting
            the optimizer do it. */}
        {navItem(runEntryHref, 'Configure', <Settings2 className="w-5 h-5 shrink-0" />, ['/execution', '/optimize'])}
        {navItem('/queue', 'Queue', <ListTodo className="w-5 h-5 shrink-0" />)}
        {navItem('/data', 'Data History', <Database className="w-5 h-5 shrink-0" />)}
        {navItem('/instruments', 'Instruments', <Gauge className="w-5 h-5 shrink-0" />)}
        {plugins.length > 0 && (
            <div className="pt-4 border-t border-gray-200 dark:border-white/10 mt-4">
                {isExpanded && <div className="px-4 mb-2 text-[10px] font-bold tracking-wider uppercase text-gray-400">Plugins</div>}
                <div className="space-y-2">
                    {plugins.map(p => (
                        <div key={p.id}>
                            {navItem(`/plugin?id=${p.id}`, p.name, <Plug className="w-5 h-5 shrink-0" />)}
                        </div>
                    ))}
                </div>
            </div>
        )}
      </nav>

      <div className="flex flex-col space-y-4 w-full">
        <div className="mx-3">
          {/* The whole card opens the cloud settings, so a collapsed sidebar (where only the dot
              shows) still gets there in one click instead of expand-then-click. */}
          <Link
            href="/cloud"
            title={isExpanded ? 'Cloud settings' : `Cloud Connect: ${edgeStatus?.cloud_connected ? 'Connected' : 'Offline'} (open settings)`}
            className={`flex items-center justify-between py-2 px-3 rounded-lg bg-gray-50 dark:bg-black/20 border border-gray-100 dark:border-white/5 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors group`}
          >
            <div className="flex items-center min-w-0">
              <div className={`w-2 h-2 rounded-full shrink-0 ${edgeStatus?.cloud_connected ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'}`}></div>
              {isExpanded && (
                  <div className="flex flex-col ml-3 min-w-0">
                    <span className="text-xs font-bold text-gray-700 dark:text-gray-300">Cloud Connect</span>
                    <span className="text-[10px] text-gray-500 truncate">{edgeStatus?.cloud_connected ? 'Connected' : 'Offline'}</span>
                  </div>
              )}
            </div>
            {isExpanded && (
              <Settings2 className="w-4 h-4 ml-2 shrink-0 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-200 transition-colors" />
            )}
          </Link>
        </div>

        <button 
            onClick={toggleTheme}
            className={`mx-3 flex items-center py-3 px-3 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors overflow-hidden`}
        >
            <div className="w-5 h-5 flex justify-center shrink-0">
                {theme === 'light' ? <Moon className="w-5 h-5 shrink-0" /> : <Sun className="w-5 h-5 shrink-0" />}
            </div>
            {isExpanded && <span className="ml-4 text-sm font-medium whitespace-nowrap">{theme === 'light' ? 'Dark Mode' : 'Light Mode'}</span>}
        </button>
      </div>
    </aside>
    </>
  );
}
