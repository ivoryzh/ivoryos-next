"use client";
import { useEffect, useState } from 'react';
import { AlertOctagon, Eraser, FastForward, Minimize2, RefreshCcw, Square } from 'lucide-react';
import { WS_BASE } from '@/config';
import { choicesFor, choiceWords, decideFailure, type Decision, type PendingDecision } from '@/runControl';

type Waiting = { run: any; step: any; decision: PendingDecision | null };

const ICONS: Record<Decision, typeof RefreshCcw> = { retry: RefreshCcw, skip: FastForward, cleanup: Eraser, stop: Square };

/**
 * A run waiting for a decision, on whatever page the person is on: a failed step, the optimizer
 * failing to suggest or to record a round, or a trial that gave no result when the run asks
 * about those. The run and the queue pause and wait (queue.py _await_choice), and the edge says
 * which choices apply (`status.decision`). Nothing is retried, skipped or ended on its own, and
 * plain Stop leaves the cleanup out: whether the deck is fit for it is the person's call, which
 * is what "Stop, run cleanup" is for. "Decide later" puts the pop-up away for this decision; the
 * run stays paused and the run panel and the floating run card keep the same choices.
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
        const decision: PendingDecision | null = data.status.decision ?? null;
        const step = decision && decision.kind !== 'step' ? null : (run?.steps || []).find((s: any) => s.status === 'error');
        setWaiting(run ? { run, step, decision } : null);
      } catch { /* a malformed frame */ }
    };
    return () => ws.close();
  }, []);

  const key = waiting ? waiting.decision?.key ?? `${waiting.run.id}:${waiting.step?.id ?? ''}` : '';
  if (!waiting || later === key) return null;

  const decide = async (action: Decision) => {
    setBusy(true);
    await decideFailure(waiting.run.id, action);
    setBusy(false);
  };
  const kind = waiting.decision?.kind ?? 'step';
  const choices = choicesFor(waiting.decision, waiting.run.id);
  const error = String(waiting.step?.error || waiting.decision?.error || 'The step failed.');
  const headline = error.split('\n')[0];
  const button = 'flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50';
  const look: Record<Decision, string> = {
    retry: 'bg-accent text-on-accent hover:bg-accent-hover',
    skip: 'border border-gray-200 bg-white text-gray-800 hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10',
    cleanup: 'border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20',
    stop: 'bg-red-600 text-white hover:bg-red-700',
  };
  const columns = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4' }[choices.length] || 'grid-cols-2';

  return (
    // Above the floating run card (GlobalQueueBar, z-9999) and the queue drawer (z-10000), which
    // otherwise covered its buttons; below the shared dialogs (z-10100), so an error still shows.
    <div className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div role="alertdialog" aria-labelledby="run-decision-title" className="w-full max-w-xl bg-white dark:bg-[#1a1a1a] border border-red-200 dark:border-red-500/30 rounded-2xl shadow-2xl p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-red-50 dark:bg-red-500/10 flex items-center justify-center shrink-0">
            <AlertOctagon className="w-5 h-5 text-red-600 dark:text-red-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="run-decision-title" className="text-sm font-bold text-gray-900 dark:text-gray-100">{waiting.decision?.title || 'A step failed'}</h2>
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
        <div className={`grid ${columns} gap-2`}>
          {choices.map(choice => {
            const [label, title] = choiceWords(kind, choice);
            const Icon = ICONS[choice];
            return (
              <button key={choice} disabled={busy} onClick={() => decide(choice)} title={title} className={`${button} ${look[choice]}`}>
                <Icon className="w-4 h-4 shrink-0" /> {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
