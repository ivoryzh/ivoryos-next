"use client";

/**
 * What Cloud still has to come for a step set to run several times.
 *
 * Cloud sends one run at a time and holds the rest, so the device only ever has the current one;
 * this is how the bench knows nineteen more are coming and roughly when they end. Awareness only:
 * nothing here is queued on the device. One component, used by the Queue page and the queue
 * drawer, so the two cannot come to describe the same thing differently.
 */
export type CloudRepeat = {
  label: string;
  /** The run on the device now (or, between runs, the next one), and how many in total. */
  run: number;
  of: number;
  /** Runs still to come after that one. */
  remaining: number;
  state: 'running' | 'waiting';
  everyMs?: number;
  nextAt?: string;
  /** Rough: the rest at the pace of the last run. Absent until one has finished. */
  doneBy?: string;
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function repeatLine(r: CloudRepeat): string {
  const parts = [r.state === 'running' ? `run ${r.run} of ${r.of} is here now` : `run ${r.run} of ${r.of} is next${r.nextAt ? ` at ${clock(r.nextAt)}` : ''}`];
  if (r.remaining > 0) parts.push(`${r.remaining} more after it`);
  if (r.everyMs) parts.push(`one every ${+(r.everyMs / 60000).toFixed(1)} min`);
  if (r.doneBy) parts.push(`all done around ${clock(r.doneBy)}`);
  return parts.join(' · ');
}

export default function CloudRepeats({ repeats }: { repeats?: CloudRepeat[] | null }) {
  if (!repeats?.length) return null;
  return (
    <>
      {repeats.map((r, i) => (
        <div key={i} className="px-2.5 py-1.5 rounded-lg border border-dashed border-sky-200 dark:border-sky-500/30 bg-sky-50/40 dark:bg-sky-500/5">
          <div className="text-xs text-gray-700 dark:text-gray-200 truncate" title={r.label}>{r.label}</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">{repeatLine(r)}</div>
        </div>
      ))}
    </>
  );
}
