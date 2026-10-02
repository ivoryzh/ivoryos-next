"use client";
import { API_BASE } from '@/config';

/**
 * Editing a run that waits in the queue, on the page that made it (Once, Iterate, Optimize).
 *
 * A run carries `parameters._source`: what its page needs to show it again and that the run does
 * not already hold (the workflow as the page had it, fixed values; the optimizer settings and
 * existing-data choices for an optimization). Rows and batch size are already in the run's own
 * parameters. The queue drawer opens `<page>?edit=<id>`; the page loads the run instead of the
 * Designer's workflow, saves nothing over the person's current page, and "Save changes" sends the
 * whole run again to PUT /api/queue/runs/<id>, which checks it like a new one and keeps its place.
 */

export type QueuedEdit = { id: number; name: string };

/** The run being edited, from `?edit=<id>`, or null. */
export function editRunIdFromUrl(): number | null {
  if (typeof window === 'undefined') return null;
  const id = Number(new URLSearchParams(window.location.search).get('edit'));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Where a queued run is edited, or null when it has nothing to edit with (e.g. sent by Cloud). */
export function editHref(run: any): string | null {
  const page = run?.parameters?._source?.page;
  const path = page === 'optimize' ? '/optimize' : page === 'once' ? '/once' : page === 'iterate' ? '/execution' : null;
  return path ? `${path}?edit=${run.id}` : null;
}

/** A block as a run keeps it: what it does, without the schema (looked up again on load). */
export function sourceBlock(b: any) {
  return {
    instrument: b.instrument,
    method: b.method,
    params: b.params,
    ...(b.returnVar ? { returnVar: b.returnVar } : {}),
    ...(b.returnBindings?.length ? { returnBindings: b.returnBindings } : {}),
    ...(b.isBatchAction ? { isBatchAction: true } : {}),
    ...(b.ref ? { ref: b.ref } : {}),
    ...(Array.isArray(b.phases) ? { phases: b.phases } : {}),
    ...(b.group ? { group: b.group } : {}),
  };
}

/** Blocks from a run's source with their schema from the live deck, as a page expects them. */
export function hydrateBlocks(blocks: any[], instruments: Record<string, any>) {
  return (blocks || []).map((b, i) => ({
    ...b,
    id: `edit-${i}-${Math.random().toString(36).slice(2, 8)}`,
    schema: instruments?.[b.instrument]?.[b.method] || { parameters: {} },
  }));
}

/** The queued run and its source, or an error saying why it cannot be edited. */
export async function loadQueuedRun(id: number): Promise<{ run: any; source: any; instruments: Record<string, any> }> {
  const [run, status] = await Promise.all([
    fetch(`${API_BASE}/api/queue/runs/${id}`).then(r => (r.ok ? r.json() : null)),
    fetch(`${API_BASE}/api/status`).then(r => r.json()).catch(() => ({})),
  ]);
  if (!run) throw new Error('That run is no longer in the queue.');
  if (run.status !== 'pending') throw new Error(`"${run.name}" has already ${run.status === 'running' ? 'started' : 'finished'}, so it can no longer be changed.`);
  const source = run.parameters?._source;
  if (!source) throw new Error(`"${run.name}" was queued before runs kept their settings, so it cannot be edited here.`);
  return { run, source, instruments: status?.instruments || {} };
}

/** Replace the queued run with the edited one (the same body a new run is posted with). */
export async function saveQueuedRun(id: number, payload: any): Promise<void> {
  const res = await fetch(`${API_BASE}/api/queue/runs/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
}

/** Leave edit mode: the page again, without `?edit`, back on the person's own workflow. */
export function leaveEdit() {
  window.location.replace(window.location.pathname);
}
