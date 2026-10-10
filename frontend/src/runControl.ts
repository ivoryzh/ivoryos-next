"use client";
import { API_BASE } from '@/config';
import { chooseDialog, confirmDialog, notify } from '@ivoryos/shared-ui';

/**
 * What a person can do to a run beyond pause and stop, in one place for the run panel
 * (LiveRun), the floating run card (GlobalQueueBar) and the failure pop-up (RunDecision).
 *
 * A failed step waits for a decision: nothing is retried or skipped on its own, in a normal run or
 * an optimization (queue.py _wait_for_error_decision). A stop, a failure someone stopped, and a
 * graceful stop told to, hold the queue until Resume queue.
 */

export type Decision = 'retry' | 'skip' | 'cleanup' | 'stop';

/**
 * What the run stopped for, as the edge publishes it in the queue status (`status.decision`,
 * queue.py _await_choice): a failed step, the optimizer failing to suggest or to record a round,
 * or a trial that gave no result (when the run asks about those). `choices` are the ones that
 * apply: there is nothing to skip when the optimizer cannot suggest, and "cleanup" (end the run
 * after its cleanup) only when there is a cleanup still to run. Plain stop leaves cleanup out.
 */
export type PendingDecision = {
  run_id: number;
  kind: 'step' | 'suggest' | 'observe' | 'no_result';
  title: string;
  error: string;
  choices: Decision[];
  key: string;
};

/** The choices for this run's decision; a failed step's three when the edge says nothing more. */
export function choicesFor(decision: PendingDecision | null | undefined, runId: number): Decision[] {
  return decision && decision.run_id === runId ? decision.choices : ['retry', 'skip', 'stop'];
}

/** How each choice reads, for each kind of decision: [button label, what it does]. */
export function choiceWords(kind: PendingDecision['kind'] | undefined, choice: Decision): [string, string] {
  const words: Record<string, Partial<Record<Decision, [string, string]>>> = {
    step: {
      retry: ['Retry step', 'Run the failed step again'],
      skip: ['Skip step', 'Leave the failed step and carry on with the run'],
    },
    suggest: {
      retry: ['Ask again', 'Ask the optimizer for the next trials again'],
    },
    observe: {
      retry: ['Record again', "Give the optimizer this round's results again"],
      skip: ['Go on without it', 'Carry on; the optimizer does not learn from this round'],
    },
    no_result: {
      skip: ['Leave it out', 'Carry on; the optimizer leaves this trial out of its model'],
    },
  };
  const common: Record<Decision, [string, string]> = {
    retry: ['Retry', 'Try again'],
    skip: ['Skip', 'Carry on'],
    cleanup: ['Stop, run cleanup', 'End the run here, after its cleanup steps; the queue stays paused'],
    stop: ['Stop run', 'End the run here without cleanup: the deck stays as it is, and the queue stays paused'],
  };
  return words[kind || 'step']?.[choice] || common[choice];
}

/**
 * Whether the person put the decision pop-up aside ("Decide later"). Remembered per decision in
 * sessionStorage, as the User input prompt is (inputPrompt.ts): every page renders the Sidebar,
 * and with it the pop-up, afresh, so component state brought it back on every navigation. A new
 * decision (another failure, a retry failing again) has a new key and opens by itself.
 */
const DECISION_LATER_KEY = 'ivoryos_decision_minimized';

export function isDecisionMinimized(key: string): boolean {
  try { return sessionStorage.getItem(DECISION_LATER_KEY) === key; } catch { return false; }
}

export function setDecisionMinimized(key: string) {
  try { sessionStorage.setItem(DECISION_LATER_KEY, key); } catch { /* storage blocked: it stays put away on this page only */ }
}

/** Answer a run waiting for a decision (see PendingDecision). */
export async function decideFailure(runId: number, action: Decision): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/queue/runs/${runId}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  } catch (e: any) {
    await notify(e.message, { title: 'The edge did not take the decision', tone: 'error' });
  }
}

/** Whether a run has cleanup steps: a run's cleanup phase, or an optimization's cleanup template. */
export function hasCleanup(run: any): boolean {
  if ((run?.parameters?.cleanup_template || []).length) return true;
  return (run?.steps || []).some((s: any) => s?.parameters?._phase === 'cleanup');
}

/**
 * Graceful stop: the run finishes the iteration it is on (a spreadsheet row or batch, an
 * optimization trial; the current step for a plain run) and then stops. Asks whether to run the
 * cleanup, when there is one, and whether the queued runs should go on, when any wait. Resolves
 * false if the person backed out.
 */
export async function stopGracefully(run: any, queued: number): Promise<boolean> {
  let cleanup = true;
  let continueQueue = true;
  const cleanupAsked = hasCleanup(run);
  if (cleanupAsked) {
    const choice = await chooseDialog({
      title: 'Stop after this iteration',
      message: 'The run finishes the iteration it is on (a row or batch, or an optimization trial; for a plain run, the current step) and then stops. Run the cleanup steps after it?',
      actions: [
        { id: 'cleanup', label: 'Run cleanup', kind: 'primary' },
        { id: 'skip', label: 'Skip cleanup' },
        { id: 'cancel', label: 'Cancel', kind: 'cancel' },
      ],
    });
    if (!choice || choice === 'cancel') return false;
    cleanup = choice === 'cleanup';
  }
  if (queued > 0) {
    const choice = await chooseDialog({
      title: 'Then the queue',
      message: `${queued} run${queued === 1 ? '' : 's'} waiting behind this one. Start ${queued === 1 ? 'it' : 'them'} when this run ends, or hold the queue until you resume it?`,
      actions: [
        { id: 'continue', label: 'Continue the queue', kind: 'primary' },
        { id: 'hold', label: 'Hold the queue' },
        { id: 'cancel', label: 'Cancel', kind: 'cancel' },
      ],
    });
    if (!choice || choice === 'cancel') return false;
    continueQueue = choice === 'continue';
  }
  if (!cleanupAsked && queued === 0 && !await confirmDialog(
    'The run finishes the iteration it is on (a row or batch, or an optimization trial; for a plain run, the current step) and then stops.',
    { title: 'Stop after this iteration?', confirmLabel: 'Stop after this iteration' },
  )) return false;
  try {
    const res = await fetch(`${API_BASE}/api/queue/runs/${run.id}/graceful-stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cleanup, continue_queue: continueQueue }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return true;
  } catch (e: any) {
    await notify(e.message, { title: 'Could not stop gracefully', tone: 'error' });
    return false;
  }
}

/** Let a held queue go on (after a pause, a stop or a stopped failure). */
export async function resumeQueue(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/queue/resume`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  } catch (e: any) {
    await notify(e.message, { title: 'Could not resume the queue', tone: 'error' });
  }
}
