"use client";
import { API_BASE, WS_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { ListTodo, Play, Pause, XCircle, Settings2, Edit3, Check, X, Sun, Moon, Copy, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

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
const ACTIVE_STATUSES = ['running', 'paused', 'cancelling', 'error'];
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
        const liveId = (await statusRes.json())?.active_workflow_id ?? null;
        setActiveWorkflowId(liveId);
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
    if (workflow && targetId === workflow.id) {
        if (action === 'pause') setWorkflow({ ...workflow, status: 'pausing' });
        else if (action === 'resume') setWorkflow({ ...workflow, status: 'running' });
        else if (action === 'cancel') setWorkflow({ ...workflow, status: 'cancelling' });
    }

    try {
      await fetch(`${API_BASE}/api/queue/runs/${targetId}/${action}`, { method: 'POST' });
      fetchQueue();
    } catch (e) {
      alert(`Failed to ${action} run`);
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
      alert(`Failed to ${action} the failed step`);
    }
  };

  // Queue housekeeping, ported from legacy IvoryOS: a long queue is only manageable if you can
  // label runs, push an urgent one forward, and drop one you no longer want.
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
        alert(`Failed to rename run: ${data.error || res.statusText}`);
        return;
      }
      setRenamingRunId(null);
      fetchQueue();
    } catch (e: any) {
      alert(`Failed to rename run: ${e.message}`);
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
        alert(`Failed to reorder queue: ${data.error || res.statusText}`);
      }
    } catch (e: any) {
      alert(`Failed to reorder queue: ${e.message}`);
    } finally {
      fetchQueue();
    }
  };

  const deleteRun = async (run: any) => {
    if (!confirm(`Remove "${run.name}" from the queue? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${API_BASE}/api/queue/runs/${run.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`Failed to delete run: ${data.error || res.statusText}`);
        return;
      }
      fetchQueue();
    } catch (e: any) {
      alert(`Failed to delete run: ${e.message}`);
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
              alert("Error saving: " + data.error);
          } else {
              setEditingStep(null);
          }
      } catch (e: any) {
          alert("Invalid JSON parameters: " + e.message);
      }
  };

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      <div className="flex-1 flex flex-col relative z-0">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300  flex items-center space-x-2">
            <ListTodo className="w-5 h-5" />
            <span>Execution Queue</span>
          </h2>
          
          {/* Controls only while the server is actually on this run. A run shown here in its brief
              post-finish window, or a stranded one from a previous session, is over — offering
              "Cancel Run" on it is what made a failed run look like it needed dismissing. */}
          {isLive(activeRun, activeWorkflowId) && activeRun.status === 'error' ? (
            // Stopped on a failed step: the useful choices are about that step, not the run.
            <div className="flex items-center space-x-3">
              <button onClick={() => resolveRunError('retry')} className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-green-50 text-green-700 hover:bg-green-100 border border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-500/30">
                  <Play className="w-4 h-4" /><span>Retry Step</span>
              </button>
              <button onClick={() => resolveRunError('skip')} className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-yellow-50 text-yellow-700 hover:bg-yellow-100 border border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-500/30">
                  <ArrowDown className="w-4 h-4" /><span>Skip Step</span>
              </button>
              <button onClick={() => handleRunControl('cancel')} className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-500/30">
                  <XCircle className="w-4 h-4" /><span>Abort Run</span>
              </button>
            </div>
          ) : isLive(activeRun, activeWorkflowId) || (activeRun && activeRun.status === 'pending') ? (
            <div className="flex items-center space-x-3">
              {activeRun.status === 'pausing' ? (
                <div className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-yellow-50 text-yellow-600 border border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-500/30 animate-pulse">
                    <Pause className="w-4 h-4" /><span>Pausing...</span>
                </div>
              ) : activeRun.status === 'paused' ? (
                <button onClick={() => handleRunControl('resume')} className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-green-50 text-green-700 hover:bg-green-100 border border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-500/30">
                    <Play className="w-4 h-4" /><span>Resume</span>
                </button>
              ) : (
                <button onClick={() => handleRunControl('pause')} className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-yellow-50 text-yellow-700 hover:bg-yellow-100 border border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-500/30">
                    <Pause className="w-4 h-4" /><span>Pause</span>
                </button>
              )}
              {activeRun.status === 'cancelling' ? (
                <div className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-red-50 text-red-500 border border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-500/30 animate-pulse">
                    <XCircle className="w-4 h-4" /><span>Cancelling...</span>
                </div>
              ) : (
                <button onClick={() => handleRunControl('cancel')} className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-500/30">
                    <XCircle className="w-4 h-4" /><span>Cancel Run</span>
                </button>
              )}
            </div>
          ) : null}
        </header>

        <div className="flex-1 overflow-y-auto p-8">
            {!activeRun || !workflow ? (
                <div className="flex flex-col items-center justify-center h-[50vh] text-gray-500 dark:text-gray-400">
                    <ListTodo className="w-16 h-16 mb-4 opacity-20" />
                    <h3 className="text-lg font-medium">Queue is Empty</h3>
                    <p className="text-sm mt-2">Start a workflow from the Designer or Spreadsheet.</p>
                </div>
            ) : (
                <div className="max-w-4xl mx-auto space-y-10">
                    {/* Currently Executing Section */}
                    <div>
                        <h2 className="text-xs  tracking-wider font-bold text-gray-500 mb-4 ml-1 flex items-center space-x-2">
                           <Play className="w-4 h-4 text-indigo-500" /> <span>Currently Executing</span>
                        </h2>
                    <div className="bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-2xl p-6 shadow-sm">
                        <div className="flex items-center justify-between mb-4">
                            <div>
                                <h3 className="text-xl font-bold">{workflow.name}</h3>
                                <div className="text-sm text-gray-500 dark:text-gray-400 mt-1 flex items-center space-x-3">
                                    <span>Run ID: {workflow.id}</span>
                                    <span>•</span>
                                    <span>Started: {new Date(workflow.start_time).toLocaleTimeString()}</span>
                                </div>
                            </div>
                            <div className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                                workflow.status === 'running' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' :
                                ['paused', 'pausing'].includes(workflow.status) ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                                workflow.status === 'cancelling' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 animate-pulse' :
                                workflow.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                                'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                            }`}>
                                {workflow.status === 'cancelling' ? 'CANCELLING...' : workflow.status === 'pausing' ? 'PAUSING...' : workflow.status}
                            </div>
                        </div>

                        <div className="space-y-3">
                            {(() => {
                                let currentPhase: string | null = null;
                                let currentWorkflowGroup: string | null = null;
                                const isOptimization = workflow.parameters?.type === 'Optimization';
                                let hasRenderedOptimizerBanner = false;
                                
                                return workflow.steps?.map((step: any, idx: number) => {
                                    const phase = step.parameters?._phase || 'main';
                                    const parentWorkflow = step.parameters?._parent_workflow || null;
                                    // Two uses of one saved workflow are two groups. Keyed on the
                                    // expansion, not the name, or the second one silently
                                    // continues the first's header.
                                    const workflowGroupKey = parentWorkflow
                                        ? `${step.parameters?._expansion_id ?? 'n'}:${parentWorkflow}`
                                        : null;
                                    
                                    const elements = [];
                                    
                                    // 1. Check if phase changed
                                    if (phase !== currentPhase) {
                                        currentPhase = phase;
                                        currentWorkflowGroup = null; // Reset group on phase change
                                        elements.push(
                                            <div key={`phase-${phase}-${idx}`} className="flex items-center space-x-2 pt-4 pb-1">
                                                <div className="h-px bg-gray-300 dark:bg-white/20 flex-1"></div>
                                                <span className="text-xs font-bold text-gray-500 uppercase tracking-widest">{phase} PHASE</span>
                                                <div className="h-px bg-gray-300 dark:bg-white/20 flex-1"></div>
                                            </div>
                                        );
                                    }
                                    
                                    // 2. Check Optimization (Repetitive Task)
                                    if (isOptimization && phase === 'main') {
                                        if (!hasRenderedOptimizerBanner) {
                                            hasRenderedOptimizerBanner = true;
                                            // Find the last completed/running step in the main phase to guess the iteration
                                            const mainSteps = workflow.steps.filter((s: any) => s.parameters?._phase === 'main');
                                            const completedMain = mainSteps.filter((s: any) => s.status === 'completed' || s.status === 'running');
                                            const stepsPerIteration = workflow.parameters?.sequence_template?.length || 1;
                                            const currentIter = Math.min(workflow.parameters?.budget || 1, Math.floor(completedMain.length / stepsPerIteration) + 1);
                                            
                                            elements.push(
                                                <div key={`opt-banner-${idx}`} className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-xl border border-purple-200 dark:border-purple-500/30 flex items-center justify-between">
                                                    <div>
                                                        <h4 className="font-bold text-purple-700 dark:text-purple-400">Optimization Loop (Repetitive Task)</h4>
                                                        <p className="text-xs text-purple-600 dark:text-purple-500 mt-1">Executing parameter search over {workflow.parameters?.budget} iterations.</p>
                                                    </div>
                                                    <div className="text-sm font-bold text-purple-700 dark:text-purple-400 bg-purple-100 dark:bg-purple-900/50 px-3 py-1 rounded-full">
                                                        Iteration {currentIter} / {workflow.parameters?.budget}
                                                    </div>
                                                </div>
                                            );
                                        }
                                        // Do not render the individual steps for optimization main phase
                                        return elements;
                                    }
                                    
                                    // 3. Check Library Workflow Grouping
                                    if (workflowGroupKey !== currentWorkflowGroup) {
                                        currentWorkflowGroup = workflowGroupKey;
                                        if (parentWorkflow) {
                                            elements.push(
                                                <div key={`wf-group-${parentWorkflow}-${idx}`} className="pt-2 pb-1 flex items-center space-x-2">
                                                    <ListTodo className="w-4 h-4 text-gray-400" />
                                                    <span className="text-xs font-bold text-gray-600 dark:text-gray-300">Workflow: {parentWorkflow}</span>
                                                </div>
                                            );
                                        }
                                    }
                                    
                                    // Filter out internal parameters for display
                                    const displayParams = { ...step.parameters };
                                    delete displayParams._phase;
                                    delete displayParams._parent_workflow;
                                    delete displayParams._expansion_id;

                                    // Return pointers read better as "name <- field" than as raw
                                    // JSON, and the flat _return_var list is redundant beside them.
                                    const bindings = displayParams._return_bindings;
                                    if (Array.isArray(bindings) && bindings.length > 0) {
                                        delete displayParams._return_bindings;
                                        delete displayParams._return_var;
                                        displayParams.saves = bindings
                                            .map((b: any) => (b.path ? `${b.var} \u2190 ${b.path}` : b.var))
                                            .join(', ');
                                    }

                                    elements.push(
                                        <div key={step.id} className={`p-4 rounded-xl border ${
                                            step.status === 'running' ? 'bg-indigo-50 border-indigo-200 dark:bg-indigo-900/10 dark:border-indigo-500/30' :
                                            step.status === 'completed' ? 'bg-gray-50 border-gray-200 dark:bg-white/[0.02] dark:border-white/5 opacity-70' :
                                            step.status === 'error' ? 'bg-red-50 border-red-200 dark:bg-red-900/10 dark:border-red-500/30' :
                                            'bg-white border-gray-200 dark:bg-white/5 dark:border-white/10'
                                        } ${parentWorkflow ? 'ml-6 border-l-4 border-l-gray-300 dark:border-l-gray-700' : ''}`}>
                                            <div className="flex items-start justify-between">
                                                <div className="flex items-center space-x-4">
                                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                                                        step.status === 'running' ? 'bg-indigo-500 text-white' :
                                                        step.status === 'completed' ? 'bg-green-500 text-white' :
                                                        step.status === 'error' ? 'bg-red-500 text-white' :
                                                        'bg-gray-200 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                                                    }`}>
                                                        {idx + 1}
                                                    </div>
                                                    <div>
                                                        <h4 className="font-semibold text-gray-800 dark:text-gray-200">
                                                            {(step.instrument === 'Flow_Control' || step.instrument === 'Flow Control') ? (
                                                                <span className="text-indigo-600 dark:text-indigo-400">{step.method}</span>
                                                            ) : (
                                                                <>{step.instrument} <span className="text-gray-400 dark:text-gray-500 font-normal">.</span> <span className="text-indigo-600 dark:text-indigo-400">{step.method}</span></>
                                                            )}
                                                        </h4>
                                                        
                                                        {editingStep === step.id ? (
                                                            <div className="mt-2 space-y-2">
                                                                <textarea 
                                                                    className="w-full text-xs font-mono p-2 bg-gray-100 dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded resize-y outline-none focus:border-indigo-500"
                                                                    rows={3}
                                                                    value={editParams}
                                                                    onChange={(e) => setEditParams(e.target.value)}
                                                                />
                                                                <div className="flex space-x-2">
                                                                    <button onClick={() => saveEdit(step.id)} className="flex items-center space-x-1 px-3 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700 transition-colors"><Check className="w-3 h-3" /><span>Save</span></button>
                                                                    <button onClick={() => setEditingStep(null)} className="flex items-center space-x-1 px-3 py-1 bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded text-xs hover:bg-gray-300 dark:hover:bg-gray-700 transition-colors"><X className="w-3 h-3" /><span>Cancel</span></button>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div className="mt-1 flex flex-wrap gap-2">
                                                                {Object.entries(displayParams || {}).map(([k, v]) => (
                                                                    <span key={k} className="text-[10px] font-mono px-2 py-0.5 rounded bg-gray-100 dark:bg-black/40 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-white/5">
                                                                        <span className="text-gray-400">{k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}:</span> {JSON.stringify(v)}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>

                                                {step.status === 'pending' && editingStep !== step.id && (
                                                    <button 
                                                        onClick={() => startEdit(step)}
                                                        className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded transition-colors"
                                                    >
                                                        <Edit3 className="w-4 h-4" />
                                                    </button>
                                                )}
                                            </div>
                                            {step.error && (
                                                <div className="mt-3 p-3 text-xs font-mono bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 rounded-lg border border-red-100 dark:border-red-500/20 relative group">
                                                    {step.error}
                                                    <button
                                                        onClick={() => navigator.clipboard.writeText(step.error)}
                                                        className="absolute top-2 right-2 p-1.5 bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-200 dark:hover:bg-red-900/60"
                                                        title="Copy Error"
                                                    >
                                                        <Copy className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                    
                                    return elements;
                                });
                            })()}
                        </div>
                    </div>
                    </div>
                    
                    {/* Up Next Section */}
                    {pendingRuns.length > 0 && (
                        <div>
                            <h2 className="text-xs  tracking-wider font-bold text-gray-500 mb-4 ml-1 flex items-center space-x-2">
                               <ListTodo className="w-4 h-4 text-gray-400" /> <span>Up Next</span>
                            </h2>
                            <div className="space-y-3">
                                {pendingRuns.map((run: any, idx: number) => (
                                    <div key={run.id} className="bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl p-4 flex items-center justify-between shadow-sm">
                                        <div className="flex items-center min-w-0 flex-1 gap-3">
                                            <span className="shrink-0 w-7 h-7 rounded-full bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 text-xs font-bold flex items-center justify-center">
                                                {idx + 1}
                                            </span>
                                            <div className="min-w-0">
                                                {renamingRunId === run.id ? (
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            autoFocus
                                                            value={renameValue}
                                                            onChange={e => setRenameValue(e.target.value)}
                                                            onKeyDown={e => {
                                                                if (e.key === 'Enter') renameRun(run.id, renameValue);
                                                                if (e.key === 'Escape') setRenamingRunId(null);
                                                            }}
                                                            className="bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded px-2 py-1 text-sm font-bold focus:outline-none focus:border-indigo-500"
                                                        />
                                                        <button onClick={() => renameRun(run.id, renameValue)} title="Save name" className="p-1 rounded text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30">
                                                            <Check className="w-4 h-4" />
                                                        </button>
                                                        <button onClick={() => setRenamingRunId(null)} title="Cancel" className="p-1 rounded text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10">
                                                            <X className="w-4 h-4" />
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <h4 className="font-bold text-gray-900 dark:text-white truncate">{run.name}</h4>
                                                )}
                                                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 flex items-center space-x-3">
                                                    <span>Run ID: {run.id}</span>
                                                    <span>•</span>
                                                    <span>Queued: {new Date(run.start_time || run.id).toLocaleTimeString()}</span>
                                                    <span>•</span>
                                                    <span>{run.steps?.length || 0} Steps</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1 shrink-0 ml-3">
                                            <button
                                                onClick={() => { setRenamingRunId(run.id); setRenameValue(run.name); }}
                                                title="Rename this run"
                                                className="p-1.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
                                            >
                                                <Edit3 className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => moveRun(run.id, 'up')}
                                                disabled={idx === 0}
                                                title="Run this sooner"
                                                className="p-1.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                            >
                                                <ArrowUp className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => moveRun(run.id, 'down')}
                                                disabled={idx === pendingRuns.length - 1}
                                                title="Run this later"
                                                className="p-1.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                            >
                                                <ArrowDown className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => deleteRun(run)}
                                                title="Remove from queue"
                                                className="p-1.5 rounded text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:text-red-300 dark:hover:bg-red-900/30 transition-colors"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
      </div>
    </div>
  );
}
