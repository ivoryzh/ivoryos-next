"use client";
import { useEffect, useState } from 'react';
import { AlertOctagon, FastForward, Minimize2, RefreshCcw, Square } from 'lucide-react';
import { WS_BASE } from '@/config';
import { decideFailure, type Decision } from '@/runControl';

type Waiting = { run: any; step: any };

/**
 * A failed step, on whatever page the person is on. The run and the queue pause and wait (queue.py
 * _wait_for_error_decision): retry the step, skip it, or stop the run. Nothing is retried or skipped
 * on its own, an optimization included. "Decide later" puts the pop-up away for this failure; the
 * run stays paused and the run panel and the floating run card keep the same three choices.
 * Mounted by the Sidebar beside the User input prompt, which works the same way.
 */
export default function RunDecision() {
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [later, setLater] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (!data.status) return;
        const id = data.status.awaiting_decision ?? null;
        if (id === null) { setWaiting(null); return; }
        const run = data.active_run?.id === id ? data.active_run : (data.runs || []).find((r: any) => r.id === id);
        const step = (run?.steps || []).find((s: any) => s.status === 'error');
        setWaiting(run ? { run, step } : null);
      } catch { /* a malformed frame */ }
    };
    return () => ws.close();
  }, []);

  const key = waiting ? `${waiting.run.id}:${waiting.step?.id ?? ''}` : '';
  if (!waiting || later === key) return null;

  const decide = async (action: Decision) => {
    setBusy(true);
    await decideFailure(waiting.run.id, action);
    setBusy(false);
  };
  const error = String(waiting.step?.error || 'The step failed.');
  const headline = error.split('\n')[0];
  const button = 'flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50';

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div role="alertdialog" aria-labelledby="run-decision-title" className="w-full max-w-lg bg-white dark:bg-[#1a1a1a] border border-red-200 dark:border-red-500/30 rounded-2xl shadow-2xl p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-red-50 dark:bg-red-500/10 flex items-center justify-center shrink-0">
            <AlertOctagon className="w-5 h-5 text-red-600 dark:text-red-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="run-decision-title" className="text-sm font-bold text-gray-900 dark:text-gray-100">A step failed</h2>
            <p className="text-[11px] text-gray-500 dark:text-gray-400">The run and the queue are paused until you decide.</p>
          </div>
          <button onClick={() => setLater(key)} title="Decide later: the run stays paused; the run panel has the same choices"
            className="shrink-0 p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-white/10">
            <Minimize2 className="w-4 h-4" />
          </button>
        </div>
        <div className="mb-1 text-xs text-gray-500 dark:text-gray-400 truncate" title={waiting.run.name}>{waiting.run.name}</div>
        {/* Method names have no spaces to break at; let them break anywhere rather than run off. */}
        {waiting.step && <div className="mb-3 font-mono text-[13px] text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">{waiting.step.instrument}.{waiting.step.method}</div>}
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 dark:border-red-500/30 dark:bg-red-500/10">
          <p className="text-sm leading-snug text-red-700 dark:text-red-300 whitespace-pre-wrap [overflow-wrap:anywhere]">{headline}</p>
          {error.includes('\n') && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-red-700/80 dark:text-red-300/80">Details</summary>
              <pre className="mt-1.5 max-h-40 overflow-auto rounded-md bg-white/70 dark:bg-black/40 p-2 font-mono text-[11px] text-gray-700 dark:text-gray-300 whitespace-pre-wrap [overflow-wrap:anywhere]">{error}</pre>
            </details>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <button disabled={busy} onClick={() => decide('retry')} title="Run the failed step again"
            className={`${button} bg-accent text-on-accent hover:bg-accent-hover`}>
            <RefreshCcw className="w-4 h-4" /> Retry step
          </button>
          <button disabled={busy} onClick={() => decide('skip')} title="Leave the failed step and carry on with the run"
            className={`${button} border border-gray-200 bg-white text-gray-800 hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10`}>
            <FastForward className="w-4 h-4" /> Skip step
          </button>
          <button disabled={busy} onClick={() => decide('stop')} title="End the run here; the queue stays paused until you resume it"
            className={`${button} bg-red-600 text-white hover:bg-red-700`}>
            <Square className="w-4 h-4" /> Stop run
          </button>
        </div>
      </div>
    </div>
  );
}
