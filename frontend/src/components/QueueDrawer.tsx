"use client";
import { API_BASE, WS_BASE, withBase } from '@/config';
import CloudRepeats from '@/components/CloudRepeats';
import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ArrowDown, ArrowUp, Check, Cloud, Edit3, ListTodo, Pause, Play, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { confirmDialog, notify } from '@ivoryos/shared-ui';
import { runSizeLabel } from '@/runSize';
import { resumeQueue } from '@/runControl';
import { editHref } from '@/queuedEdit';

const OPEN_EVENT = 'ivoryos-open-queue';

/** Open the queue beside whatever page is showing. Every "queue" control in the app calls this. */
export function openQueue() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Pending runs in the order they will run (`queue_position`, then id), without the live one. */
export const orderPending = (runs: any[] | undefined, activeId?: number | null) =>
  (runs || [])
    .filter((r: any) => r.status === 'pending' && r.id !== activeId)
    .slice()
    .sort((a: any, b: any) => {
      const pos = (r: any) => (typeof r.parameters?.queue_position === 'number' ? r.parameters.queue_position : r.id);
      return pos(a) - pos(b) || a.id - b.id;
    });

/** One read of the queue: the live run, what waits behind it, and what Cloud is holding. */
async function loadQueue() {
  const [status, queue] = await Promise.all([
    fetch(`${API_BASE}/api/status`).then(r => r.json()),
    fetch(`${API_BASE}/api/queue/runs?recent=10`).then(r => r.json()),
  ]);
  const runs = queue.runs || [];
  const active = runs.find((r: any) => r.id === status.active_workflow_id) || null;
  return { active, pending: orderPending(runs, active?.id), cloudQueue: status?.cloud_queue ?? null, paused: !!status?.queue_paused };
}

/**
 * The queue, as a drawer over the right edge of any page rather than a page of its own. The run
 * in progress is shown where it was started (LiveRun, on the Run page); what is left to manage
 * is what waits behind it: rename, move sooner or later, remove. Going to a separate page for
 * that meant leaving the spreadsheet you were queueing from. Mounted once in the root layout
 * and opened with `openQueue()`. It holds a socket only while open.
 */
export default function QueueDrawer() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<any[]>([]);
  const [active, setActive] = useState<any>(null);
  const [cloudQueue, setCloudQueue] = useState<any>(null);
  // Held after a stop, a stopped failure, or a graceful stop told to: nothing starts until resumed.
  const [paused, setPaused] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const onLauncher = (usePathname() || '').startsWith('/launcher');

  useEffect(() => {
    const show = () => setOpen(true);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener(OPEN_EVENT, show);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener(OPEN_EVENT, show); window.removeEventListener('keydown', key); };
  }, []);

  // The edge may be restarting when this is asked; the socket catches up, so a failure is silent.
  const refresh = useCallback(() => {
    loadQueue().then(q => { setActive(q.active); setPending(q.pending); setCloudQueue(q.cloudQueue); setPaused(q.paused); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open || onLauncher) return;
    let gone = false;
    loadQueue().then(q => { if (!gone) { setActive(q.active); setPending(q.pending); setCloudQueue(q.cloudQueue); setPaused(q.paused); } }).catch(() => {});
    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const live = data.active_run || null;
        if ('active_run' in data || data.status) setActive(live);
        if (data.runs) setPending(orderPending(data.runs, live?.id));
        if (data.status && 'cloud_queue' in data.status) setCloudQueue(data.status.cloud_queue ?? null);
        if (data.status && 'queue_paused' in data.status) setPaused(!!data.status.queue_paused);
      } catch { /* a malformed frame */ }
    };
    return () => { gone = true; ws.close(); };
  }, [open, onLauncher]);

  if (onLauncher || !open) return null;

  const fail = async (res: Response, title: string) => {
    const data = await res.json().catch(() => ({}));
    await notify(data.error || res.statusText, { title, tone: 'error' });
  };
  const rename = async (id: number) => {
    const name = renameValue.trim();
    if (!name) return;
    const res = await fetch(`${API_BASE}/api/queue/runs/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => null);
    if (res && !res.ok) { await fail(res, 'Could not rename'); return; }
    setRenamingId(null);
    refresh();
  };
  const move = async (id: number, direction: 'up' | 'down') => {
    // Reorder here first so the list does not lag a click behind the round trip.
    setPending(prev => {
      const i = prev.findIndex(r => r.id === id);
      const j = direction === 'up' ? i - 1 : i + 1;
      if (i === -1 || j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    const res = await fetch(`${API_BASE}/api/queue/runs/${id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }) }).catch(() => null);
    if (res && !res.ok) await fail(res, 'Could not reorder');
    refresh();
  };
  const remove = async (run: any) => {
    const ok = await confirmDialog('This cannot be undone.', { title: `Remove "${run.name}" from the queue?`, confirmLabel: 'Remove', tone: 'danger' });
    if (!ok) return;
    const res = await fetch(`${API_BASE}/api/queue/runs/${run.id}`, { method: 'DELETE' }).catch(() => null);
    if (res && !res.ok) await fail(res, 'Could not remove');
    refresh();
  };

  const iconBtn = 'p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed';
  const heading = 'text-[11px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2 flex items-center gap-1.5';

  return (
    <>
      <div className="fixed inset-0 z-[10000] bg-black/20 dark:bg-black/40" onClick={() => setOpen(false)} />
      <aside
        className="fixed inset-y-0 z-[10001] w-[22rem] max-w-[90vw] flex flex-col bg-white dark:bg-[#141414] border-l border-gray-200 dark:border-white/10 shadow-2xl"
        style={{ right: 'var(--ivoryos-dock-right, 0px)' }}
      >
        <div className="h-12 shrink-0 px-4 flex items-center gap-2 border-b border-gray-200 dark:border-white/10">
          <ListTodo className="w-4 h-4 text-gray-400" />
          <h2 className="text-sm font-semibold flex-1">Queue</h2>
          <button onClick={() => setOpen(false)} title="Close (Esc)" className={iconBtn}><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {/* Held with runs waiting (and no failure to decide, which is answered on the run). */}
          {paused && pending.length > 0 && !(active && active.status === 'error') && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              <Pause className="w-4 h-4 shrink-0" />
              <span className="flex-1">Queue paused. Nothing below starts until you resume.</span>
              <button onClick={() => resumeQueue()} className="shrink-0 inline-flex items-center gap-1 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700">
                <Play className="w-3.5 h-3.5" /> Resume
              </button>
            </div>
          )}
          <section>
            <h3 className={heading}>now</h3>
            {active ? (
              <div className="rounded-lg border border-gray-200 dark:border-white/15 dark:border-white/20 bg-gray-100/60 dark:bg-white/10 px-3 py-2">
                <div className="text-sm font-semibold truncate" title={active.name}>{active.name}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{String(active.status || '').replace(/_/g, ' ')}</div>
              </div>
            ) : <p className="text-sm text-gray-400 dark:text-gray-500">Nothing running.</p>}
          </section>

          <section>
            <h3 className={heading}>up next · {pending.length}</h3>
            {pending.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-gray-500">Nothing queued. Press Run on the Run page while something is running and it waits here.</p>
            ) : (
              <ol className="space-y-1.5">
                {pending.map((run, idx) => (
                  <li key={run.id} className="group rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 text-xs font-bold flex items-center justify-center">{idx + 1}</span>
                      {renamingId === run.id ? (
                        <div className="flex items-center gap-1 min-w-0 flex-1">
                          <input
                            autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') rename(run.id); if (e.key === 'Escape') { e.stopPropagation(); setRenamingId(null); } }}
                            className="min-w-0 flex-1 bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded px-2 py-0.5 text-sm font-semibold focus:outline-none focus:border-accent"
                          />
                          <button onClick={() => rename(run.id)} title="Save name" className="p-1 rounded text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30"><Check className="w-4 h-4" /></button>
                          <button onClick={() => setRenamingId(null)} title="Cancel" className={iconBtn}><X className="w-4 h-4" /></button>
                        </div>
                      ) : <span className="min-w-0 flex-1 text-sm font-semibold truncate" title={run.name}>{run.name}</span>}
                    </div>
                    <div className="mt-1 pl-8 flex items-center justify-between gap-2">
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {/* One stage of a design queued as several runs (src/stages.ts). */}
                        {run.parameters?.group && <span title={run.parameters.group.name}>stage {run.parameters.group.index}/{run.parameters.group.total} · </span>}
                        {runSizeLabel(run)}
                      </span>
                      <div className="flex items-center shrink-0 opacity-50 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => { setRenamingId(run.id); setRenameValue(run.name); }} title="Rename" className={iconBtn}><Edit3 className="w-3.5 h-3.5" /></button>
                        {/* Its spreadsheet or optimization settings, on the page that made it. A full
                            load, not a client-side route: the page reads ?edit=<id> when it mounts. */}
                        {editHref(run) && (
                          <button onClick={() => { window.location.href = withBase(editHref(run)!); }} title="Change its values or settings before it runs" className={iconBtn}><SlidersHorizontal className="w-3.5 h-3.5" /></button>
                        )}
                        <button onClick={() => move(run.id, 'up')} disabled={idx === 0} title="Run this sooner" className={iconBtn}><ArrowUp className="w-3.5 h-3.5" /></button>
                        <button onClick={() => move(run.id, 'down')} disabled={idx === pending.length - 1} title="Run this later" className={iconBtn}><ArrowDown className="w-3.5 h-3.5" /></button>
                        <button onClick={() => remove(run)} title="Remove from the queue" className="p-1 rounded text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:text-red-300 dark:hover:bg-red-900/30"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {cloudQueue && (cloudQueue.waiting > 0 || cloudQueue.nextSchedule || (cloudQueue.repeats || []).length > 0) && (
            <section>
              <h3 className={heading} title="Cloud sends these one at a time, when this device is free. Nothing here is queued on the device."><Cloud className="w-3.5 h-3.5 text-sky-500" /> waiting in cloud · {cloudQueue.waiting}</h3>
              <div className="space-y-1">
                <CloudRepeats repeats={cloudQueue.repeats} />
                {(cloudQueue.items || []).map((item: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-dashed border-sky-200 dark:border-sky-500/30 bg-sky-50/40 dark:bg-sky-500/5">
                    <span className="min-w-0 flex-1 text-xs truncate" title={item.label}>{item.label}</span>
                    <span className={`shrink-0 text-[10px] font-semibold ${item.status === 'ready' ? 'text-sky-700 dark:text-sky-300' : 'text-gray-400'}`}>{item.status}</span>
                  </div>
                ))}
                {cloudQueue.waiting > (cloudQueue.items || []).length && <p className="text-[11px] text-gray-400 px-1">+{cloudQueue.waiting - (cloudQueue.items || []).length} more</p>}
                {cloudQueue.nextSchedule && (
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 px-1 pt-0.5">
                    next scheduled: <span className="font-semibold">{cloudQueue.nextSchedule.name}</span>{' '}
                    at {new Date(cloudQueue.nextSchedule.at).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}
                  </p>
                )}
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
