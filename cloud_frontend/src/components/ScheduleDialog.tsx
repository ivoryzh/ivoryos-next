"use client";

import React, { useState } from 'react';
import { X, CalendarClock } from 'lucide-react';

/**
 * Turn the configured graph into a recurring trigger.
 *
 * Kept deliberately small. Everything about *what* runs was already decided on the canvas and in
 * the run configuration panel; the only open questions here are when it starts, how often it
 * repeats, and when it stops. A schedule that could also edit the run would be a second place to
 * configure one, and the two would drift.
 */

interface Props {
  defaultName: string;
  onCancel: () => void;
  onCreate: (spec: { name: string; everyMinutes: number; maxRuns: number; startAt?: string }) => Promise<any>;
}

const field = 'w-full rounded border border-gray-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-gray-600';
const label = 'text-[10px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400';

export default function ScheduleDialog({ defaultName, onCancel, onCreate }: Props) {
  const [name, setName] = useState(defaultName);
  const [everyMinutes, setEveryMinutes] = useState('60');
  const [maxRuns, setMaxRuns] = useState('');
  const [startNow, setStartNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const minutes = Number(everyMinutes);
  const valid = !!name.trim() && Number.isFinite(minutes) && minutes >= 1;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await onCreate({
        name: name.trim(),
        everyMinutes: minutes,
        maxRuns: Math.max(0, Math.floor(Number(maxRuns) || 0)),
        // Omitted means "one interval from now" — creating a schedule should not itself set
        // hardware moving, which is the surprise someone gets if "every 30 minutes" begins by
        // running immediately.
        ...(startNow ? { startAt: new Date().toISOString() } : {}),
      });
    } catch (e: any) {
      setError(e.message || 'Could not create the schedule.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl dark:bg-[#1a1a1a]">
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <CalendarClock size={18} /> Schedule this run
            </h2>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              The graph is planned now and replayed on each firing, exactly as configured.
            </p>
          </div>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="flex flex-col gap-1">
            <label className={label} htmlFor="schedule-name">Name</label>
            <input id="schedule-name" className={field} value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-1">
              <label className={label} htmlFor="schedule-every">Every (minutes)</label>
              <input
                id="schedule-every" type="number" min={1} className={field}
                value={everyMinutes} onChange={(e) => setEveryMinutes(e.target.value)}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <label className={label} htmlFor="schedule-max" title="Leave blank to keep firing until it is paused">
                Stop after
              </label>
              <input
                id="schedule-max" type="number" min={1} placeholder="never" className={field}
                value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)}
              />
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
            <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
            <span>Fire the first run immediately</span>
          </label>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button onClick={onCancel} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!valid || busy}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Creating…' : 'Create schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
