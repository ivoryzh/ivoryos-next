"use client";
import { API_BASE, WS_BASE } from '@/config';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronUp, CircleDot, FastForward, Flag, HandHelping, ListTodo, Pause, Play, RefreshCcw, Square, X } from 'lucide-react';
import { decideFailure, stopGracefully } from '@/runControl';
import { setPromptMinimized } from '@/inputPrompt';
import RunProgress, { buildProgress, parseServerTime, type RunLike } from './RunProgress';
import { openQueue } from './QueueDrawer';

const FINISHED = ['completed', 'cancelled', 'error'];
/** The step view's height: remembered per browser, dragged with the handle along its top. */
const HEIGHT_KEY = 'ivoryos_liverun_height';
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 120;
const maxHeight = () => (typeof window === 'undefined' ? 600 : Math.round(window.innerHeight * 0.7));
/** After the person scrolls the steps themselves, leave their place alone for this long. */
const HANDS_OFF_MS = 5000;
/** A finished run stays on the page this long, so its result is seen without opening Data History. */
const LINGER_MS = 15 * 60 * 1000;

/**
 * The run in progress, on the page that started it (Once, Iterate, Optimize), at the bottom of
 * the page where the idle chip is. It is that chip: idle it reads "Idle" (or what waits in the
 * queue) and opens the queue; when a run starts the same element widens to the full width and
 * becomes the run bar, and shrinks back once the run is over. Before, the chip vanished from
 * the bottom while a separate panel appeared at the top, two places for one thing.
 *
 * The bar is one row, three zones, each always in the same place: what is running (name, one
 * status line), what you can do to it (icon controls), and the two views beside it (the queue,
 * the steps). Exactly one progress bar, the strip along its top; opening it shows the steps, not
 * a second bar. Controls are icons with tooltips because a row of labelled buttons crowded the
 * name off the line, with one exception: a failed step waiting for a decision spells out Retry
 * and Skip.
 *
 * It sits below the page's scrolling area, not inside it, so it is never a scroll away while the
 * spreadsheet scrolls above. Opened, the steps live in a box of their own height above the row
 * (drag the handle along its top; double-click it to reset) with the sample / iteration badges
 * pinned at its top, and the box follows the running step unless you have just scrolled it.
 */
export default function LiveRun() {
  const [run, setRun] = useState<RunLike | null>(null);
  const [queued, setQueued] = useState(0);
  // The run whose failed step waits for a decision, and whether a graceful stop is on its way.
  const [awaiting, setAwaiting] = useState<number | null>(null);
  const [graceful, setGraceful] = useState(false);
  // Held after a stop or a stopped failure, for the idle chip.
  const [paused, setPaused] = useState(false);
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState<number | null>(null);
  const finishedAt = useRef<Map<number, number>>(new Map());
  // Read in the initializer on purpose: this component renders nothing until a run arrives
  // from the client-side fetch, so the first (hydrated) render never depends on the value.
  const [height, setHeight] = useState<number>(() => {
    try { const v = Number(localStorage.getItem(HEIGHT_KEY)); if (v >= MIN_HEIGHT) return v; } catch { /* no storage */ }
    return DEFAULT_HEIGHT;
  });
  const steps = useRef<HTMLDivElement>(null);
  const touched = useRef(0);
  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const from = e.clientY;
    const start = steps.current?.offsetHeight ?? DEFAULT_HEIGHT;
    let latest = start;
    const move = (ev: PointerEvent) => {
      latest = Math.min(maxHeight(), Math.max(MIN_HEIGHT, start + from - ev.clientY));
      setHeight(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { localStorage.setItem(HEIGHT_KEY, String(latest)); } catch { /* no storage */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);
  const resetHeight = () => { setHeight(DEFAULT_HEIGHT); try { localStorage.removeItem(HEIGHT_KEY); } catch { /* no storage */ } };

  useEffect(() => {
    let gone = false;
    // A finished run is shown for LINGER_MS from when it ended (or from when this page first saw
    // it finished, if it has no end time). Decided here, as messages arrive, not while rendering.
    const fresh = (next: RunLike | null, waiting: number | null = null) => {
      // A run waiting on a failed step reads "error" but is not over: it stays until decided.
      if (!next || !FINISHED.includes(next.status) || next.id === waiting) return next;
      if (!finishedAt.current.has(next.id)) {
        const ended = parseServerTime(next.end_time);
        finishedAt.current.set(next.id, isFinite(ended) ? ended : Date.now());
      }
      return Date.now() - finishedAt.current.get(next.id)! > LINGER_MS ? null : next;
    };
    const apply = (data: any) => {
      if (data.runs) setQueued(data.runs.filter((r: RunLike) => r.status === 'pending').length);
      if (data.status) {
        setAwaiting(data.status.awaiting_decision ?? null);
        setGraceful(!!data.status.graceful_stop);
        setPaused(!!data.status.queue_paused);
      }
      setRun(fresh(data.active_run || data.recent_run || null, data.status?.awaiting_decision ?? null));
    };
    fetch(`${API_BASE}/api/queue/runs?recent=10`).then(r => r.json()).then(data => {
      if (gone) return;
      const runs: RunLike[] = data.runs || [];
      setQueued(runs.filter(r => r.status === 'pending').length);
      const live = runs.find(r => !FINISHED.includes(r.status) && r.status !== 'pending');
      if (live) fetch(`${API_BASE}/api/queue/runs/${live.id}`).then(r => r.json()).then(full => { if (!gone) setRun(full); }).catch(() => {});
    }).catch(() => {});
    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = e => { try { apply(JSON.parse(e.data)); } catch { /* a malformed frame */ } };
    return () => { gone = true; ws.close(); };
  }, []);

  // Keep the running step in view inside the step box: only that box scrolls, never the page.
  const runningId = (run?.steps || []).find(st => st.status === 'running' || st.status === 'waiting_input')?.id ?? null;
  useEffect(() => {
    const el = steps.current;
    if (!open || !el || runningId === null) return;
    if (Date.now() - touched.current < HANDS_OFF_MS) return;
    // After this render has painted the new "running" row.
    const frame = requestAnimationFrame(() => {
      const row = el.querySelector<HTMLElement>('[data-run-active]');
      if (!row) return;
      const pinned = el.querySelector<HTMLElement>('[data-run-pinned]')?.offsetHeight ?? 0;
      const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const room = el.clientHeight - pinned;
      el.scrollTo({ top: Math.max(0, top - pinned - Math.max(0, (room - row.offsetHeight) / 2)), behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, runningId]);

  // One element, idle chip or run bar. It widens from its content's width to the full width, and
  // back (interpolate-size; a browser without it switches without the animation).
  const shell = (active: boolean, children: React.ReactNode) => (
    <div className="shrink-0 px-8 pb-4 pt-2 flex justify-end">
      <section
        className={`[interpolate-size:allow-keywords] transition-[width] duration-500 ease-out overflow-hidden border bg-white dark:bg-[#151515] ${
          active ? 'w-full rounded-xl border-gray-200 dark:border-white/10 shadow-sm' : 'w-fit rounded-full border-gray-200 dark:border-white/10 shadow-lg'}`}
      >
        {children}
      </section>
    </div>
  );

  if (!run || run.id === closed) {
    return shell(false, (
      <button
        type="button"
        onClick={openQueue}
        title={queued > 0 ? `Idle; ${queued} run${queued === 1 ? '' : 's'} waiting in the queue` : 'Idle'}
        className="flex items-center gap-2 whitespace-nowrap px-3 py-2 text-xs font-medium text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
      >
        {queued > 0 && paused ? (
          <><Pause className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" /><span className="text-amber-700 dark:text-amber-300">Queue paused · {queued} waiting</span></>
        ) : queued > 0 ? (
          <><ListTodo className="w-3.5 h-3.5 text-gray-700 dark:text-gray-200" /><span>{queued} queued</span></>
        ) : (
          <><CircleDot className="w-3.5 h-3.5 text-gray-400" /><span>Idle</span></>
        )}
      </button>
    ));
  }
  const finished = FINISHED.includes(run.status);

  const control = async (action: 'pause' | 'resume' | 'cancel') => {
    setRun(r => (r ? { ...r, status: action === 'pause' ? 'pausing' : action === 'cancel' ? 'cancelling' : 'running' } : r));
    await fetch(`${API_BASE}/api/queue/runs/${run.id}/${action}`, { method: 'POST' }).catch(() => {});
  };
  // Retry, skip and stop answer a failure only while it is waiting; a run that ended on an error
  // and still shows here has nothing left to answer.
  const waitingDecision = run.status === 'error' && awaiting === run.id;

  const s = run.status;
  const kind = s === 'waiting_input' ? 'ask' : ['paused', 'pausing'].includes(s) ? 'hold' : ['error', 'cancelling', 'cancelled'].includes(s) ? 'bad' : s === 'completed' ? 'done' : 'go';
  const dot = { ask: 'bg-pink-500', hold: 'bg-yellow-500', bad: 'bg-red-500', done: 'bg-green-500', go: 'bg-accent' }[kind];
  const bar = dot;
  const progress = buildProgress(run);
  const percent = s === 'completed' ? 100 : progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const current = (run.steps || []).find(st => st.status === 'running');
  const failed = (run.steps || []).find(st => st.status === 'error');
  const state = s === 'cancelling' ? 'stopping after this step'
    : s === 'pausing' ? 'pausing after this step'
    : s === 'waiting_input' ? 'waiting for your input'
    : waitingDecision ? 'a step failed: retry, skip or stop'
    : s === 'error' ? 'stopped on an error'
    : graceful && !finished ? 'finishing this iteration, then stopping'
    : s.replace(/_/g, ' ');

  const icon = 'p-1.5 rounded-md transition-colors text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-white dark:hover:bg-white/10';
  const word = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors';

  return shell(true, (
    <>
      {/* The one progress bar. */}
      <div className="h-1 w-full bg-gray-100 dark:bg-white/5"><div className={`h-full ${bar} transition-all duration-500`} style={{ width: `${percent}%` }} /></div>

      {open && (
        <>
          <div
            onPointerDown={startDrag}
            onDoubleClick={resetHeight}
            title="Drag to resize the steps; double-click to reset"
            className="group h-2.5 cursor-row-resize flex items-center justify-center border-b border-gray-100 dark:border-white/5 hover:bg-gray-100 dark:hover:bg-white/5 touch-none"
          >
            <span className="w-10 h-1 rounded-full bg-gray-300 dark:bg-white/20 group-hover:bg-gray-500" />
          </div>
          {failed?.error && (
            <div className="px-4 pt-3">
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-500/30 text-xs font-mono text-red-700 dark:text-red-400 whitespace-pre-wrap max-h-24 overflow-y-auto">{failed.error}</div>
            </div>
          )}
          {/* The steps, in a box of their own above the row: it scrolls, the page does not. */}
          <div
            ref={steps}
            style={{ height: Math.min(height, maxHeight()) }}
            onWheel={() => { touched.current = Date.now(); }}
            onTouchMove={() => { touched.current = Date.now(); }}
            onPointerDown={() => { touched.current = Date.now(); }}
            className="border-b border-gray-100 dark:border-white/5 px-4 pb-4 overflow-y-auto overscroll-contain"
          >
            <RunProgress run={run} live={!finished && s !== 'pending'} hideOverall pinSummary />
          </div>
        </>
      )}

      <div className="pl-4 pr-2 py-2 flex items-center gap-3">
        {/* What is running */}
        <span className={`shrink-0 w-2.5 h-2.5 rounded-full ${dot} ${kind === 'go' || kind === 'ask' ? 'animate-pulse' : ''}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate" title={run.name}>{run.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {state} · {progress.done} of {progress.total}
            {current && <> · <span className="font-mono">{current.instrument}.{current.method}</span></>}
          </div>
        </div>

        {/* What you can do to it */}
        <div className="flex items-center gap-1 shrink-0">
          {s === 'waiting_input' && (
            <button onClick={() => setPromptMinimized(null)} className={`${word} bg-pink-600 border-pink-600 text-white hover:bg-pink-700`}><HandHelping className="w-3.5 h-3.5" /> Answer</button>
          )}
          {waitingDecision && (
            <>
              <button onClick={() => decideFailure(run.id, 'retry')} title="Run the failed step again" className={`${word} bg-accent-soft text-accent-fg border-accent-tint/60 hover:bg-accent-tint/30`}><RefreshCcw className="w-3.5 h-3.5" /> Retry</button>
              <button onClick={() => decideFailure(run.id, 'skip')} title="Leave the failed step and carry on" className={`${word} bg-white text-gray-700 border-gray-200 hover:bg-gray-50 dark:bg-white/5 dark:text-gray-200 dark:border-white/10`}><FastForward className="w-3.5 h-3.5" /> Skip</button>
            </>
          )}
          {s === 'paused' && <button onClick={() => control('resume')} title="Resume" className={`${icon} !text-green-600 dark:!text-green-400`}><Play className="w-4 h-4" /></button>}
          {!finished && !['paused', 'pausing', 'cancelling', 'error'].includes(s) && <button onClick={() => control('pause')} title="Pause after the current step" className={icon}><Pause className="w-4 h-4" /></button>}
          {!finished && !waitingDecision && !graceful && !['cancelling', 'error'].includes(s) && (
            <button onClick={() => stopGracefully(run, queued)} title="Stop after this iteration (a row, a batch or an optimization trial), with or without cleanup" className={icon}><Flag className="w-4 h-4" /></button>
          )}
          {waitingDecision ? (
            <button onClick={() => decideFailure(run.id, 'stop')} title="Stop this run (the queue stays held)" className={`${icon} !text-red-500 hover:!bg-red-50 dark:hover:!bg-red-900/20`}><Square className="w-4 h-4" /></button>
          ) : !finished && s !== 'cancelling' && s !== 'error' && (
            <button onClick={() => control('cancel')} title="Stop now (the queue stays held until you resume it)" className={`${icon} !text-red-500 hover:!bg-red-50 dark:hover:!bg-red-900/20`}><Square className="w-4 h-4" /></button>
          )}
        </div>

        {/* The views beside it: always these, always here. */}
        <div className="flex items-center gap-0.5 shrink-0 pl-2 border-l border-gray-200 dark:border-white/10">
          <button onClick={openQueue} title={queued ? `Queue: ${queued} waiting` : 'Queue'} className={`${icon} relative`}>
            <ListTodo className="w-4 h-4" />
            {queued > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-accent text-on-accent text-[10px] font-bold flex items-center justify-center">{queued}</span>}
          </button>
          <button onClick={() => setOpen(o => !o)} title={open ? 'Hide the steps' : 'Show the steps'} className={icon}>
            <ChevronUp className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {finished && s !== 'error' && <button onClick={() => setClosed(run.id)} title="Close" className={icon}><X className="w-4 h-4" /></button>}
        </div>
      </div>

    </>
  ));
}
