"use client";
import { API_BASE, WS_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { ListTodo, Play, Pause, XCircle, Edit3, Check, X, ArrowUp, ArrowDown, Trash2, Cloud } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import RunProgress, { type RunStep } from '@/components/RunProgress';
import { confirmDialog, notify } from '@ivoryos/shared-ui';

// The edge server runs pending work in (queue_position, id) order — a run only has a
// queue_position once someone has moved it — so the list has to sort the same way or the
// "Up Next" order would disagree with what actually runs next.
const orderPending = (runs: any[] | undefined, activeId?: number) =>
  (runs || [])
    .filter((r: any) => r.status === 'pending' && r.id !== activeId)
    .slice()
    .sort((a: any, b: any) => {
      const pos = (r: any) => {
        const p = r.parameters?.queue_position;
        return typeof p === 'number' ? p : r.id;
      };
      return pos(a) - pos(b) || a.id - b.id;
    });

// 'error' on a run means two different things, and telling them apart is the whole problem:
//
//  - The execution loop stopped on a failed step and is waiting for a retry / skip / cancel
//    decision. The run is marked 'error' with no end_time, but it is still live and still needs
//    its controls.
//  - The run failed and is over. It belongs in Data History.
//
// The panel used to treat every 'error' run as the current one, so a run that failed days ago
// permanently occupied it — and there is no shortage of those, because that wait for a decision
// lives in memory and does not survive a restart, stranding runs as 'error' with no end_time.
// Clearing the panel then took one Cancel click per stale run: the cancel endpoint accepts
// 'error' and flips it to 'cancelled', so each click retired exactly one and the next took its
// place.
//
// status and end_time both lie about a stranded run, so liveness comes from the queue manager's
// own active_workflow_id instead.
// 'waiting_input' belongs here too: without it a run paused on a User Input prompt -- the one
// moment the page most needs to show it -- read as "Queue is empty".
const ACTIVE_STATUSES = ['running', 'paused', 'cancelling', 'error', 'waiting_input', 'pending'];
const TERMINAL_STATUSES = ['completed', 'error', 'cancelled'];

/** Just the fields the selection below reads; run payloads carry plenty more. */
type QueueRun = { id: number; status: string; end_time?: string | null };

// A run that just finished stays up briefly, so a failure is readable instead of vanishing the
// instant it ends. The server applies the same window to the `recent_run` it pushes over the
// websocket (see broadcast_global_queue); mirroring it here keeps a page load consistent with a
// live update rather than blanking a failure that a connected client would still be showing.
const RECENT_FINISH_MS = 10_000;

// Run times arrive as naive UTC — datetime.utcnow().isoformat(), no offset — and JS parses a
// string like that as *local* time. Anywhere west of UTC that puts every finished run in the
// future, so "did this just end?" would answer yes forever and re-create the bug above. Pin it.
const parseServerTime = (value?: string | null) => {
  if (!value) return NaN;
  return Date.parse(/([zZ]|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
};

const justFinished = (runs: QueueRun[] | undefined) => {
  const recent = (runs || [])
    .filter(r => TERMINAL_STATUSES.includes(r.status) && r.end_time)
    .sort((a, b) => parseServerTime(b.end_time) - parseServerTime(a.end_time))[0];
  if (!recent) return undefined;
  const age = Date.now() - parseServerTime(recent.end_time);
  return age >= 0 && age < RECENT_FINISH_MS ? recent : undefined;
};

/**
 * The run the Currently Executing panel should show, if any.
 *
 * `activeId` is the queue manager's active_workflow_id. When it is known, it alone decides which
 * run is live — a run the server isn't executing cannot be executing, whatever its stored status
 * says. Passing `undefined` (server didn't report one) means nothing is running.
 */
const pickActive = (runs: QueueRun[] | undefined, activeId?: number | null) =>
  (activeId ? (runs || []).find(r => r.id === activeId && ACTIVE_STATUSES.includes(r.status)) : undefined)
  || justFinished(runs)
  || (runs || []).slice().reverse().find(r => r.status === 'pending');

/** Whether this run can still be paused, cancelled or resolved — i.e. the server is on it. */
const isLive = (run: QueueRun | null | undefined, activeId?: number | null) =>
  !!run && !!activeId && run.id === activeId;

export default function QueuePage() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [activeWorkflowId, setActiveWorkflowId] = useState<number | null>(null);
  const [workflow, setWorkflow] = useState<any>(null);
  const [editingStep, setEditingStep] = useState<number | null>(null);
  const [editParams, setEditParams] = useState<string>("");
  const [activeRun, setActiveRun] = useState<any>(null);
  const [pendingRuns, setPendingRuns] = useState<any[]>([]);
  const [renamingRunId, setRenamingRunId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Which run the right-hand side shows; null follows whatever is executing.
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  // What Cloud is holding for this device. Cloud never queues work here -- it keeps tasks until
  // the device is free -- so without this the bench could not tell that more was coming.
  const [cloudQueue, setCloudQueue] = useState<any>(null);

  useEffect(() => {
    // Theme init
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, []);

  const fetchQueue = async () => {
      try {
        // /api/queue/runs carries no notion of which run the server is actually on, and a stored
        // status can't be trusted to say so (see ACTIVE_STATUSES), so ask /api/status too. The
        // websocket delivers the same id inline as `status.active_workflow_id`.
        const [res, statusRes] = await Promise.all([
          fetch(`${API_BASE}/api/queue/runs`),
          fetch(`${API_BASE}/api/status`),
        ]);
        const data = await res.json();
        const statusData = await statusRes.json();
        const liveId = statusData?.active_workflow_id ?? null;
        setActiveWorkflowId(liveId);
        setCloudQueue(statusData?.cloud_queue ?? null);
        const active = pickActive(data.runs, liveId);

        if (active) {
            const runDetails = await fetch(`${API_BASE}/api/queue/runs/${active.id}`);
            const detailsData = await runDetails.json();
            setActiveRun(detailsData);
            setWorkflow(detailsData);
        } else {
            setActiveRun(null);
            setWorkflow(null);
        }
        
        // Populate Up Next list
        setPendingRuns(orderPending(data.runs, active?.id));
      } catch (e) {
        console.error("Failed to fetch queue status:", e);
      }
  };

  useEffect(() => {
    fetchQueue();
    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.runs) {
                const liveId = data.status?.active_workflow_id ?? null;
                setActiveWorkflowId(liveId);
                if (data.status && 'cloud_queue' in data.status) setCloudQueue(data.status.cloud_queue ?? null);
                const active = pickActive(data.runs, liveId);

                if (active) {
                    if (data.active_run && data.active_run.id === active.id) {
                        setActiveRun(data.active_run);
                        setWorkflow(data.active_run);
                    } else if (data.recent_run && data.recent_run.id === active.id) {
                        setActiveRun(data.recent_run);
                        setWorkflow(data.recent_run);
                    } else {
                        // Use the run data directly since it already contains steps from the DB
                        setActiveRun(active);
                        setWorkflow(active);
                    }
                } else {
                    setActiveRun(null);
                    setWorkflow(null);
                }
                
                // Populate Up Next list
                setPendingRuns(orderPending(data.runs, active?.id));
            }
        } catch(e) {}
    };
    
    return () => {
        ws.close();
    };
  }, []);

  // Nothing re-runs the selection on its own — the panel only updates on a websocket message or a
  // manual fetch, and a server with nothing to do sends neither. Without this, a run shown in its
  // brief post-finish window just stays up: the same lingering this change set out to remove, only
  // with a nicer reason. Schedule one re-check for the moment that window closes.
  useEffect(() => {
    if (!activeRun?.end_time || !TERMINAL_STATUSES.includes(activeRun.status)) return;
    const remaining = RECENT_FINISH_MS - (Date.now() - parseServerTime(activeRun.end_time));
    const timer = setTimeout(fetchQueue, Math.max(remaining, 0) + 250);
    return () => clearTimeout(timer);
  }, [activeRun?.id, activeRun?.status, activeRun?.end_time]);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const handleRunControl = async (action: 'pause' | 'resume' | 'cancel', runId?: number) => {
    const targetId = runId || activeRun?.id;
    if (!targetId) return;

    // Optimistic UI update
    if (activeRun && targetId === activeRun.id) {
        if (action === 'pause') setActiveRun({ ...activeRun, status: 'pausing' });
        else if (action === 'resume') setActiveRun({ ...activeRun, status: 'running' });
        else if (action === 'cancel') setActiveRun({ ...activeRun, status: 'cancelling' });
    }

    try {
      await fetch(`${API_BASE}/api/queue/runs/${targetId}/${action}`, { method: 'POST' });
      fetchQueue();
    } catch (e) {
      await notify(`Failed to ${action} run`, { tone: 'error' });
    }
  };

  // When a step fails the execution loop stops and waits for one of these. The endpoint has always
  // existed; nothing called it, so a stopped run's only visible option was Cancel — which is why
  // a failure looked like something you had to dismiss rather than decide about.
  const resolveRunError = async (action: 'retry' | 'skip' | 'abort') => {
    const targetId = activeRun?.id;
    if (!targetId) return;
    try {
      await fetch(`${API_BASE}/api/queue/runs/${targetId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      fetchQueue();
    } catch {
      await notify(`Failed to ${action} the failed step`, { tone: 'error' });
    }
  };

  // Queue housekeeping, ported from legacy IvoryOS: a long queue is only manageable if you can
  // label runs, push an urgent one forward, and drop one you no longer want.
  // (Native alert/confirm do nothing in the desktop app's webview -- see AGENTS.md section 13.)
  const renameRun = async (runId: number, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const res = await fetch(`${API_BASE}/api/queue/runs/${runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        await notify(data.error || res.statusText, { title: 'Could not rename', tone: 'error' });
        return;
      }
      setRenamingRunId(null);
      fetchQueue();
    } catch (e: any) {
      await notify(e.message, { title: 'Could not rename', tone: 'error' });
    }
  };

  const moveRun = async (runId: number, direction: 'up' | 'down') => {
    // Reorder locally first so the list doesn't visibly lag a click behind the round trip.
    setPendingRuns(prev => {
      const idx = prev.findIndex(r => r.id === runId);
      const target = direction === 'up' ? idx - 1 : idx + 1;
      if (idx === -1 || target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
    try {
      const res = await fetch(`${API_BASE}/api/queue/runs/${runId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        await notify(data.error || res.statusText, { title: 'Could not reorder', tone: 'error' });
      }
    } catch (e: any) {
      await notify(e.message, { title: 'Could not reorder', tone: 'error' });
    } finally {
      fetchQueue();
    }
  };

  const deleteRun = async (run: any) => {
    const ok = await confirmDialog('This cannot be undone.', {
      title: `Remove "${run.name}" from the queue?`, confirmLabel: 'Remove', tone: 'danger',
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API_BASE}/api/queue/runs/${run.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        await notify(data.error || res.statusText, { title: 'Could not remove', tone: 'error' });
        return;
      }
      if (selectedRunId === run.id) setSelectedRunId(null);
      fetchQueue();
    } catch (e: any) {
      await notify(e.message, { title: 'Could not remove', tone: 'error' });
    }
  };

  const startEdit = (step: any) => {
      setEditingStep(step.id);
      setEditParams(JSON.stringify(step.parameters, null, 2));
  };

  const saveEdit = async (stepId: number) => {
      try {
          const parsed = JSON.parse(editParams);
          const res = await fetch(`${API_BASE}/api/steps/${stepId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ parameters: parsed })
          });
          const data = await res.json();
          if (data.error) {
              await notify(data.error, { title: 'Could not save', tone: 'error' });
          } else {
              setEditingStep(null);
              fetchQueue();
          }
      } catch (e: any) {
          await notify(e.message, { title: 'Invalid JSON parameters', tone: 'error' });
      }
  };

  const stepEditor = (step: RunStep) => {
    if (step.status !== 'pending') return null;
    if (editingStep !== step.id) {
      return (
        <button onClick={() => startEdit(step)} className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-300">
          <Edit3 className="w-3 h-3" /> edit
        </button>
      );
    }
    return (
      <div className="mt-1.5 space-y-1.5">
        <textarea
          className="w-full text-xs font-mono p-2 bg-gray-100 dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded resize-y outline-none focus:border-indigo-500"
          rows={3}
          value={editParams}
          onChange={(e) => setEditParams(e.target.value)}
        />
        <div className="flex gap-2">
          <button onClick={() => saveEdit(step.id)} className="flex items-center gap-1 px-2.5 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700"><Check className="w-3 h-3" />Save</button>
          <button onClick={() => setEditingStep(null)} className="flex items-center gap-1 px-2.5 py-1 bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded text-xs"><X className="w-3 h-3" />Cancel</button>
        </div>
      </div>
    );
  };

  const live = isLive(activeRun, activeWorkflowId);
  // The right-hand side shows the run picked on the left; by default, the one executing now.
  const shownRun = (selectedRunId !== null
    ? pendingRuns.find(r => r.id === selectedRunId) || (activeRun?.id === selectedRunId ? activeRun : null)
    : null) || activeRun;
  const shownIsActive = !!shownRun && shownRun.id === activeRun?.id;

  const buttonBase = 'flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors';
  const tone = {
    green: 'bg-green-50 text-green-700 hover:bg-green-100 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-500/30',
    yellow: 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-500/30',
    red: 'bg-red-50 text-red-700 hover:bg-red-100 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-500/30',
  };

  // Controls only while the server is actually on this run. A run shown here in its brief
  // post-finish window, or a stranded one from a previous session, is over — offering
  // "Cancel" on it is what made a failed run look like it needed dismissing.
  const controls = !activeRun ? null : live && activeRun.status === 'error' ? (
    // Stopped on a failed step: the useful choices are about that step, not the run.
    <div className="grid grid-cols-3 gap-2">
      <button onClick={() => resolveRunError('retry')} className={`${buttonBase} ${tone.green}`}><Play className="w-4 h-4" />Retry</button>
      <button onClick={() => resolveRunError('skip')} className={`${buttonBase} ${tone.yellow}`}><ArrowDown className="w-4 h-4" />Skip</button>
      <button onClick={() => handleRunControl('cancel')} className={`${buttonBase} ${tone.red}`}><XCircle className="w-4 h-4" />Abort</button>
    </div>
  ) : live || activeRun.status === 'pending' ? (
    <div className="grid grid-cols-2 gap-2">
      {activeRun.status === 'pausing' ? (
        <div className={`${buttonBase} ${tone.yellow} animate-pulse`}><Pause className="w-4 h-4" />Pausing…</div>
      ) : activeRun.status === 'paused' ? (
        <button onClick={() => handleRunControl('resume')} className={`${buttonBase} ${tone.green}`}><Play className="w-4 h-4" />Resume</button>
      ) : (
        <button onClick={() => handleRunControl('pause')} className={`${buttonBase} ${tone.yellow}`}><Pause className="w-4 h-4" />Pause</button>
      )}
      {activeRun.status === 'cancelling' ? (
        <div className={`${buttonBase} ${tone.red} animate-pulse`}><XCircle className="w-4 h-4" />Cancelling…</div>
      ) : (
        <button onClick={() => handleRunControl('cancel')} className={`${buttonBase} ${tone.red}`}><XCircle className="w-4 h-4" />Cancel</button>
      )}
    </div>
  ) : null;

  const statusPill = (status: string) => (
    <span className={`shrink-0 px-2.5 py-0.5 rounded-full text-xs font-bold ${
      status === 'running' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
        : ['paused', 'pausing', 'waiting_input'].includes(status) ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300'
        : ['error', 'cancelling'].includes(status) ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
        : status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
        : 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300'
    }`}>
      {status.replace(/_/g, ' ')}
    </span>
  );

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      <div className="flex-1 flex flex-col relative z-0 min-w-0">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300 flex items-center space-x-2">
            <ListTodo className="w-5 h-5" />
            <span>Execution Queue</span>
          </h2>
        </header>

        <div className="flex-1 flex min-h-0">
          {/* Left: the queue itself — what is running, what comes next, and the controls for both. */}
          <aside className="w-[340px] shrink-0 border-r border-gray-200 dark:border-white/10 bg-white/60 dark:bg-black/10 overflow-y-auto p-4 space-y-6">
            <section>
              <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-2 flex items-center gap-1.5">
                <Play className="w-3.5 h-3.5 text-indigo-500" /> now
              </h3>
              {activeRun ? (
                <div
                  onClick={() => setSelectedRunId(null)}
                  className={`rounded-xl border p-3 space-y-3 cursor-pointer transition-colors ${
                    shownIsActive
                      ? 'border-indigo-300 bg-indigo-50/60 dark:border-indigo-500/40 dark:bg-indigo-500/10'
                      : 'border-gray-200 bg-white hover:border-gray-300 dark:border-white/10 dark:bg-white/5'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="text-base font-bold text-gray-900 dark:text-white break-words">{activeRun.name}</h4>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        #{activeRun.id}
                        {activeRun.start_time ? ` · started ${new Date(parseServerTime(activeRun.start_time)).toLocaleTimeString()}` : ''}
                      </p>
                    </div>
                    {statusPill(activeRun.status)}
                  </div>
                  {controls && <div onClick={(e) => e.stopPropagation()}>{controls}</div>}
                </div>
              ) : (
                <p className="text-sm text-gray-400 dark:text-gray-500 px-1">Nothing running.</p>
              )}
            </section>

            <section>
              <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-2 flex items-center gap-1.5">
                <ListTodo className="w-3.5 h-3.5" /> up next · {pendingRuns.length}
              </h3>
              {pendingRuns.length === 0 ? (
                <p className="text-sm text-gray-400 dark:text-gray-500 px-1">Nothing queued.</p>
              ) : (
                <div className="space-y-1.5">
                  {pendingRuns.map((run: any, idx: number) => (
                    <div
                      key={run.id}
                      onClick={() => setSelectedRunId(run.id)}
                      className={`group rounded-lg border px-2.5 py-2 cursor-pointer transition-colors ${
                        shownRun?.id === run.id
                          ? 'border-indigo-300 bg-indigo-50/60 dark:border-indigo-500/40 dark:bg-indigo-500/10'
                          : 'border-gray-200 bg-white hover:border-gray-300 dark:border-white/10 dark:bg-white/5'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 w-6 h-6 rounded-full bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 text-xs font-bold flex items-center justify-center">
                          {idx + 1}
                        </span>
                        {renamingRunId === run.id ? (
                          <div className="flex items-center gap-1 min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={e => setRenameValue(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') renameRun(run.id, renameValue);
                                if (e.key === 'Escape') setRenamingRunId(null);
                              }}
                              className="min-w-0 flex-1 bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded px-2 py-0.5 text-sm font-semibold focus:outline-none focus:border-indigo-500"
                            />
                            <button onClick={() => renameRun(run.id, renameValue)} title="Save name" className="p-1 rounded text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30"><Check className="w-4 h-4" /></button>
                            <button onClick={() => setRenamingRunId(null)} title="Cancel" className="p-1 rounded text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10"><X className="w-4 h-4" /></button>
                          </div>
                        ) : (
                          <span className="min-w-0 flex-1 text-sm font-semibold text-gray-900 dark:text-white truncate" title={run.name}>{run.name}</span>
                        )}
                      </div>
                      <div className="mt-1 pl-8 flex items-center justify-between gap-2">
                        <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          #{run.id} · {run.steps?.length || 0} steps
                        </span>
                        {/* Housekeeping, on hover so a long queue stays scannable. */}
                        <div className="flex items-center shrink-0 opacity-40 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => { setRenamingRunId(run.id); setRenameValue(run.name); }} title="Rename this run" className="p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10"><Edit3 className="w-3.5 h-3.5" /></button>
                          <button onClick={() => moveRun(run.id, 'up')} disabled={idx === 0} title="Run this sooner" className="p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"><ArrowUp className="w-3.5 h-3.5" /></button>
                          <button onClick={() => moveRun(run.id, 'down')} disabled={idx === pendingRuns.length - 1} title="Run this later" className="p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"><ArrowDown className="w-3.5 h-3.5" /></button>
                          <button onClick={() => deleteRun(run)} title="Remove from queue" className="p-1 rounded text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:text-red-300 dark:hover:bg-red-900/30"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {cloudQueue && (cloudQueue.waiting > 0 || cloudQueue.nextSchedule) && (
              <section>
                <h3
                  className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-2 flex items-center gap-1.5"
                  title="Cloud sends these one at a time, when this device is free. Nothing here is queued on the device."
                >
                  <Cloud className="w-3.5 h-3.5 text-sky-500" /> waiting in cloud · {cloudQueue.waiting}
                </h3>
                <div className="space-y-1">
                  {(cloudQueue.items || []).map((item: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-dashed border-sky-200 dark:border-sky-500/30 bg-sky-50/40 dark:bg-sky-500/5">
                      <span className="min-w-0 flex-1 text-xs text-gray-700 dark:text-gray-200 truncate" title={item.label}>{item.label}</span>
                      <span
                        className={`shrink-0 text-[10px] font-semibold ${item.status === 'ready' ? 'text-sky-700 dark:text-sky-300' : 'text-gray-400'}`}
                        title={item.status === 'ready' ? 'Ready; sent when this device is free' : 'Waiting on another step to finish first'}
                      >
                        {item.due && Date.parse(item.due) > Date.now()
                          ? `at ${new Date(item.due).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                          : item.status}
                      </span>
                    </div>
                  ))}
                  {cloudQueue.waiting > (cloudQueue.items || []).length && (
                    <p className="text-[11px] text-gray-400 px-1">+{cloudQueue.waiting - cloudQueue.items.length} more</p>
                  )}
                  {cloudQueue.nextSchedule && (
                    <p className="text-[11px] text-gray-500 dark:text-gray-400 px-1 pt-0.5">
                      next scheduled: <span className="font-semibold">{cloudQueue.nextSchedule.name}</span>{' '}
                      at {new Date(cloudQueue.nextSchedule.at).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}
                    </p>
                  )}
                </div>
              </section>
            )}
          </aside>

          {/* Right: where the selected run is up to. */}
          <main className="flex-1 min-w-0 overflow-y-auto p-6">
            {!shownRun ? (
              <div className="flex flex-col items-center justify-center h-[50vh] text-gray-500 dark:text-gray-400">
                <ListTodo className="w-16 h-16 mb-4 opacity-20" />
                <h3 className="text-lg font-medium">Queue is empty</h3>
                <p className="text-sm mt-2">Start a workflow from the Designer or Configure.</p>
              </div>
            ) : (
              <div className="max-w-4xl mx-auto">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="min-w-0">
                    <h3 className="text-xl font-bold text-gray-900 dark:text-white break-words">{shownRun.name}</h3>
                    {!shownIsActive && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">queued — this is what it will run</p>
                    )}
                  </div>
                  {statusPill(shownRun.status)}
                </div>
                <RunProgress run={shownRun} live={shownIsActive && live} stepEditor={stepEditor} />
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
