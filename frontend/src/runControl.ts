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

export type Decision = 'retry' | 'skip' | 'stop';

/** Answer a failed step that is waiting: run it again, leave it and go on, or end the run. */
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
