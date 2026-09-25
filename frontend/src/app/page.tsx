"use client";
import { API_BASE } from '@/config';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Download, Workflow, Library, Gauge, ListTodo, ArrowRight,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { notify, serverDate } from '@ivoryos/shared-ui';

/**
 * The page someone lands on. It answers "what state is this bench in, and where do I go next":
 * what is plugged in, whether anything is running or queued, what is saved and what ran recently
 * -- each a link to the page that acts on it. Cloud status lives in the sidebar, and the deck's
 * details on Instruments, so neither is repeated here. The cards it
 * replaced ("Connected Devices: 1 Local") were constants; a Core instance is always exactly one
 * local edge, so they never told anyone anything.
 */

const STATUS_DOT: Record<string, string> = {
  completed: 'bg-green-500',
  error: 'bg-red-500',
  running: 'bg-indigo-500 animate-pulse',
  waiting_input: 'bg-amber-500 animate-pulse',
  pending: 'bg-gray-300 dark:bg-gray-600',
};

const timeAgo = (iso?: string) => {
  if (!iso) return '';
  const ms = Date.now() - serverDate(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return serverDate(iso).toLocaleDateString();
};

export default function Home() {
  const [edgeStatus, setEdgeStatus] = useState<any>(null);
  const [runs, setRuns] = useState<any[] | null>(null);
  const [workflows, setWorkflows] = useState<any[] | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');

    const load = () => {
      fetch(`${API_BASE}/api/status`).then(r => r.json()).then(setEdgeStatus).catch(() => setEdgeStatus(null));
      fetch(`${API_BASE}/api/queue/runs?recent=8`).then(r => r.json()).then(d => setRuns(d.runs || [])).catch(() => setRuns([]));
    };
    load();
    fetch(`${API_BASE}/api/workflows`).then(r => r.json()).then(d => setWorkflows(d.workflows || [])).catch(() => setWorkflows([]));
    // Status and queue move while you look at them; the workflow library does not.
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const downloadSchema = async () => {
    // Straight from the server rather than the Designer's localStorage cache, which only existed
    // after someone had opened the Designer.
    try {
      const schema = edgeStatus?.instruments ?? (await fetch(`${API_BASE}/api/status`).then(r => r.json())).instruments;
      const blob = new Blob([JSON.stringify(schema, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ivoryos_schema.json';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      await notify('Could not reach the edge server to read the instrument schema.', { title: 'Download failed', tone: 'error' });
    }
  };

  const instruments = Object.entries(edgeStatus?.instruments || {}) as [string, Record<string, any>][];
  const online = edgeStatus !== null;
  const active = (runs || []).filter(r => r.status === 'running' || r.status === 'waiting_input');
  const queued = (runs || []).filter(r => r.status === 'pending');
  const recent = (runs || []).filter(r => r.status !== 'pending').slice(0, 6);
  const latestWorkflow = [...(workflows || [])].sort((x, y) => (y.updated_at || 0) - (x.updated_at || 0))[0];

  const card = 'rounded-2xl bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 shadow-sm dark:shadow-none';

  const stats = [
    {
      href: '/instruments', icon: Gauge, label: 'Instruments',
      value: online ? String(instruments.length) : '—',
      note: online ? `${instruments.reduce((n, [, methods]) => n + Object.keys(methods || {}).length, 0)} methods` : 'edge server unreachable',
    },
    {
      href: '/queue', icon: ListTodo, label: 'Queue',
      value: active.length ? 'Running' : edgeStatus?.queue_paused ? 'Paused' : 'Idle',
      note: `${queued.length} waiting${recent[0] ? ` · last run ${timeAgo(recent[0].start_time)}` : ''}`,
      tone: active.length ? 'text-indigo-600 dark:text-indigo-400' : undefined,
    },
    {
      href: '/library', icon: Library, label: 'Saved workflows',
      value: workflows ? String(workflows.length) : '—',
      note: latestWorkflow ? `last saved: ${latestWorkflow.name}` : 'none saved yet',
    },
  ];

  const actions = [
    { href: '/designer', icon: Workflow, label: 'Design a workflow', note: 'Build a sequence from the deck' },
    { href: '/library', icon: Library, label: 'Open from library', note: 'Load, copy or run a saved one' },
  ];

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      <main className="flex-1 flex flex-col relative overflow-hidden bg-gray-100 dark:bg-transparent">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300 ">Dashboard</h2>
          <button
            onClick={downloadSchema}
            title="The instrument schema this edge server introspected, as JSON"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Schema JSON
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-8 bg-gray-100 dark:bg-transparent">
          <div className="max-w-6xl mx-auto space-y-6">
            {/* A run in progress is the one thing worth putting above everything else. */}
            {active.map(run => (
              <Link
                key={run.id}
                href="/queue"
                className="flex items-center gap-3 px-5 py-3 rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/30 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 transition-colors"
              >
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${STATUS_DOT[run.status]}`} />
                <span className="text-sm font-semibold text-indigo-700 dark:text-indigo-300 truncate">{run.name.split(' - ')[0]}</span>
                <span className="text-xs text-indigo-600/80 dark:text-indigo-300/70 shrink-0">
                  {run.status === 'waiting_input' ? 'waiting for your input' : `running · started ${timeAgo(run.start_time)}`}
                </span>
                <ArrowRight className="w-4 h-4 ml-auto text-indigo-400 shrink-0" />
              </Link>
            ))}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {stats.map(stat => (
                <Link key={stat.label} href={stat.href} className={`${card} p-5 hover:bg-gray-50 dark:hover:bg-white/10 transition-colors group`}>
                  <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
                    <stat.icon className="w-4 h-4" />
                    {stat.label}
                    <ArrowRight className="w-3.5 h-3.5 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  <div className={`text-2xl font-bold ${stat.tone || 'text-gray-800 dark:text-white'}`}>{stat.value}</div>
                  <div className={`text-xs mt-1 text-gray-500 dark:text-gray-400`}>{stat.note}</div>
                </Link>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {actions.map(a => (
                <Link key={a.href} href={a.href} className={`${card} p-4 flex items-start gap-3 hover:border-indigo-300 dark:hover:border-indigo-500/40 transition-colors`}>
                  <div className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 shrink-0">
                    <a.icon className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">{a.label}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{a.note}</div>
                  </div>
                </Link>
              ))}
            </div>

              <section className={`${card} overflow-hidden`}>
                <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-white/5">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Recent runs</h3>
                  <Link href="/data" className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline">Data History</Link>
                </div>
                {runs === null ? (
                  <div className="px-5 py-6 text-sm text-gray-400">Loading…</div>
                ) : recent.length === 0 ? (
                  <div className="px-5 py-6 text-sm text-gray-500 dark:text-gray-400">
                    Nothing has run yet. <Link href="/designer" className="text-indigo-600 dark:text-indigo-400 hover:underline">Design a workflow</Link> to get started.
                  </div>
                ) : (
                  <ul className="divide-y divide-gray-100 dark:divide-white/5">
                    {recent.map(run => (
                      <li key={run.id}>
                        <Link href="/data" className="flex items-center gap-3 px-5 py-2.5 hover:bg-gray-50 dark:hover:bg-white/[0.03]">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[run.status] || 'bg-gray-300'}`} title={run.status} />
                          <span className="text-sm text-gray-800 dark:text-gray-200 truncate min-w-0 flex-1">{run.name.split(' - ')[0]}</span>
                          <span className="text-[11px] text-gray-400 shrink-0">{run.parameters?.type || ''}</span>
                          {run.status === 'error' && <span className="text-[11px] font-medium text-red-500 shrink-0">failed</span>}
                          <span className="text-[11px] text-gray-400 w-20 text-right shrink-0">{timeAgo(run.start_time)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
          </div>
        </div>
      </main>
    </div>
  );
}
