"use client";

/**
 * A run's progress, in the same shape as the "Full sequence preview": Prep once, Main drawn once
 * inside a loop frame, Cleanup once.
 *
 * The run itself is a flat list of every call (a 6-row screen with 11 main steps is 66+ rows), and
 * the Queue page used to list all of them — so the one question it exists to answer, "how far
 * along is this?", sat at the bottom of a long scroll. Here each authored main step appears once,
 * with how many of its calls are done, and the loop's progress (samples, batches, or optimizer
 * iterations) is a strip above it. Every call is still available, collapsed, for editing.
 */

import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Layers, Link2, Loader2, Repeat } from 'lucide-react';

export type RunStep = {
  id: number;
  sequence_index?: number;
  instrument: string;
  method: string;
  parameters?: Record<string, any> | null;
  outputs?: any;
  status: string;
  error?: string | null;
  start_time?: string | null;
  end_time?: string | null;
};

export type RunLike = {
  id: number;
  name: string;
  status: string;
  start_time?: string | null;
  end_time?: string | null;
  parameters?: Record<string, any> | null;
  steps?: RunStep[];
};

const DONE = new Set(['completed', 'skipped']);
const ACTIVE = new Set(['running', 'waiting_input']);

// Run and step times are naive UTC (datetime.utcnow().isoformat()); JS would read them as local.
export const parseServerTime = (value?: string | null) => {
  if (!value) return NaN;
  return Date.parse(/([zZ]|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
};

const phaseOf = (s: RunStep) => s.parameters?._phase || 'main';
const rowOf = (s: RunStep): number | null =>
  typeof s.parameters?._row === 'number' ? s.parameters._row : null;

const label = (text: string) => String(text || '').replace(/_/g, ' ');

/** One authored main step and every call it became. */
type TemplateStep = {
  key: string;
  instrument: string;
  method: string;
  parent: string | null;
  calls: RunStep[];
  total: number;
  done: number;
  perBatch: boolean;
};

type Group = { index: number; rows: number[] };

export type Progress = {
  prep: RunStep[];
  cleanup: RunStep[];
  template: TemplateStep[];
  kind: 'optimization' | 'rows' | 'once';
  rows: number[];
  groups: Group[];
  rowState: Map<number, string>;
  iterations: { total: number; done: number };
  total: number;
  done: number;
};

const aggregate = (steps: RunStep[]) => {
  if (steps.some(s => s.status === 'error')) return 'error';
  if (steps.some(s => ACTIVE.has(s.status))) return 'running';
  if (steps.length && steps.every(s => DONE.has(s.status))) return 'done';
  if (steps.some(s => DONE.has(s.status))) return 'partial';
  return 'pending';
};

export function buildProgress(run: RunLike): Progress {
  const steps = (run.steps || []).slice().sort((a, b) => (a.sequence_index ?? 0) - (b.sequence_index ?? 0) || a.id - b.id);
  const prep = steps.filter(s => phaseOf(s) === 'prep');
  const cleanup = steps.filter(s => phaseOf(s) === 'cleanup');
  const main = steps.filter(s => phaseOf(s) === 'main');
  const params = run.parameters || {};
  const isOptimization = params.type === 'Optimization';

  const byKey = new Map<string, TemplateStep>();
  const order: string[] = [];
  const add = (key: string, s: RunStep) => {
    let t = byKey.get(key);
    if (!t) {
      t = {
        key, instrument: s.instrument, method: s.method,
        parent: s.parameters?._parent_workflow || null,
        calls: [], total: 0, done: 0, perBatch: false,
      };
      byKey.set(key, t);
      order.push(key);
    }
    t.calls.push(s);
  };

  let kind: Progress['kind'] = 'once';
  const budget = Number(params.budget) || 0;
  const templateLength = (params.sequence_template || []).length || 1;

  if (isOptimization) {
    // Trial steps are generated one iteration at a time, so the template, not the step list, says
    // what one iteration is, and the budget says how many there will be.
    kind = 'optimization';
    main.forEach((s, i) => add(`t${i % templateLength}`, s));
  } else if (main.some(s => typeof s.parameters?._block === 'number')) {
    // `_block` is the authored step a call came from; a linked workflow expands one block into
    // several steps, so number the calls within each (row, block) to keep them apart.
    kind = main.some(s => rowOf(s) !== null && rowOf(s)! > 0) ? 'rows' : 'once';
    const seen = new Map<string, number>();
    const keyed = main.map(s => {
      const pair = `${rowOf(s)}:${s.parameters?._block}`;
      const k = seen.get(pair) ?? 0;
      seen.set(pair, k + 1);
      return { s, block: s.parameters?._block ?? 0, k };
    });
    keyed
      .slice()
      .sort((a, b) => a.block - b.block || a.k - b.k)
      .forEach(({ s, block, k }) => add(`${block}:${k}`, s));
    // Keep each template step's calls in execution order.
    byKey.forEach(t => t.calls.sort((a, b) => (a.sequence_index ?? 0) - (b.sequence_index ?? 0)));
  } else {
    main.forEach((s, i) => add(`s${i}`, s));
  }

  const rows = kind === 'rows'
    ? Array.from(new Set(main.map(rowOf).filter((r): r is number => r !== null))).sort((a, b) => a - b)
    : [];

  const template = order.map(k => byKey.get(k)!);
  for (const t of template) {
    t.done = t.calls.filter(s => DONE.has(s.status)).length;
    t.total = isOptimization ? Math.max(budget, t.calls.length) : t.calls.length;
    t.perBatch = kind === 'rows' && t.calls.length < rows.length;
  }

  // Batch groups: recorded at submit since this change; inferred for older runs from how often a
  // batch step ran (once per group).
  let groupSize = Number(params.batch_size) || 0;
  if (!groupSize && rows.length) {
    const batchCounts = template.filter(t => t.perBatch).map(t => t.calls.length);
    const groupsCount = batchCounts.length ? Math.max(1, Math.min(...batchCounts)) : 1;
    groupSize = Math.ceil((rows[rows.length - 1] + 1) / groupsCount);
  }
  const groups: Group[] = [];
  for (const r of rows) {
    const index = Math.floor(r / Math.max(1, groupSize));
    const last = groups[groups.length - 1];
    if (last && last.index === index) last.rows.push(r);
    else groups.push({ index, rows: [r] });
  }

  const rowState = new Map<number, string>();
  for (const r of rows) rowState.set(r, aggregate(main.filter(s => rowOf(s) === r)));

  const iterations = isOptimization
    ? { total: budget, done: Math.floor(main.filter(s => DONE.has(s.status)).length / templateLength) }
    : { total: rows.length, done: rows.filter(r => rowState.get(r) === 'done').length };

  const plannedMain = isOptimization ? Math.max(budget * templateLength, main.length) : main.length;
  return {
    prep, cleanup, template, kind, rows, groups, rowState, iterations,
    total: prep.length + plannedMain + cleanup.length,
    done: steps.filter(s => DONE.has(s.status)).length,
  };
}

const formatSeconds = (s: number) => {
  if (!isFinite(s) || s < 0) return '';
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
};

function StatusIcon({ state, size = 'md' }: { state: string; size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5';
  const icon = size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3';
  if (state === 'done' || state === 'completed') {
    return <span className={`${box} shrink-0 rounded-full bg-green-500 text-white flex items-center justify-center`}><Check className={icon} /></span>;
  }
  if (state === 'skipped') {
    return <span className={`${box} shrink-0 rounded-full border-2 border-dashed border-gray-300 dark:border-white/20`} title="skipped" />;
  }
  if (state === 'running' || state === 'waiting_input') {
    return <span className={`${box} shrink-0 rounded-full bg-indigo-500 text-white flex items-center justify-center`}><Loader2 className={`${icon} animate-spin`} /></span>;
  }
  if (state === 'error') {
    return <span className={`${box} shrink-0 rounded-full bg-red-500 text-white flex items-center justify-center`}><AlertTriangle className={icon} /></span>;
  }
  if (state === 'partial') {
    return <span className={`${box} shrink-0 rounded-full border-2 border-indigo-400 bg-indigo-100 dark:bg-indigo-500/20`} />;
  }
  return <span className={`${box} shrink-0 rounded-full border-2 border-gray-300 dark:border-white/20`} />;
}

const argsText = (step: RunStep | undefined) => {
  if (!step) return '';
  const entries = Object.entries(step.parameters || {}).filter(([k]) => !k.startsWith('_'));
  return entries.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ');
};

function ErrorBox({ step, where }: { step: RunStep; where?: string }) {
  return (
    <div className="group/err relative mt-1.5 ml-7 p-2.5 pr-9 text-xs font-mono rounded-lg bg-red-50 text-red-700 border border-red-100 dark:bg-red-900/20 dark:text-red-300 dark:border-red-500/20 break-words">
      {where ? <span className="font-sans font-semibold">{where}: </span> : null}
      {step.error}
      <button
        onClick={() => navigator.clipboard.writeText(step.error || '')}
        title="Copy error"
        className="absolute top-1.5 right-1.5 p-1 rounded text-red-500 opacity-0 group-hover/err:opacity-100 hover:bg-red-100 dark:hover:bg-red-900/40 transition-opacity"
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/** A plain step that runs once (Prep, Cleanup, or a Main that doesn't loop). */
function OnceRow({ step }: { step: RunStep }) {
  const args = argsText(step);
  return (
    <div>
      <div className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg border ${
        ACTIVE.has(step.status) ? 'bg-indigo-50 border-indigo-200 dark:bg-indigo-500/10 dark:border-indigo-500/30'
          : 'bg-white border-gray-100 dark:bg-white/[0.03] dark:border-white/5'
      }`}>
        <StatusIcon state={step.status} />
        <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300 shrink-0">
          {label(step.instrument)}
        </span>
        <span className="text-sm font-medium text-gray-800 dark:text-gray-100 shrink-0">{label(step.method)}</span>
        {args && <span className="text-xs font-mono text-gray-400 dark:text-gray-500 truncate min-w-0">{args}</span>}
      </div>
      {step.status === 'error' && step.error && <ErrorBox step={step} />}
    </div>
  );
}

function PhaseHeader({ name, count, badge, extra }: { name: string; count: number; badge: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 mb-2">
      <span className="text-sm font-bold text-gray-800 dark:text-gray-100">{name}</span>
      <span className="text-xs text-gray-400 dark:text-gray-500">{count} step{count === 1 ? '' : 's'}</span>
      {badge}
      <div className="h-px bg-gray-200 dark:bg-white/10 flex-1 min-w-[1rem]" />
      {extra}
    </div>
  );
}

const OncePill = () => (
  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300">once</span>
);

export default function RunProgress({ run, live, stepEditor }: {
  run: RunLike;
  /** Whether the server is executing this run right now (drives elapsed/remaining time). */
  live: boolean;
  /** Renders the per-call list's edit affordance for a pending step; the page owns the API call. */
  stepEditor?: (step: RunStep) => React.ReactNode;
}) {
  const [showCalls, setShowCalls] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const p = buildProgress(run);
  const percent = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const loops = p.kind !== 'once';
  const hasBatches = p.groups.length > 1 || p.template.some(t => t.perBatch);
  const currentGroup = p.groups.find(g => g.rows.some(r => p.rowState.get(r) !== 'done'));

  const started = parseServerTime(run.start_time);
  const ended = parseServerTime(run.end_time);
  const elapsed = isFinite(started) ? ((isFinite(ended) ? ended : now) - started) / 1000 : NaN;
  // A rough "time left": the mean of calls finished so far, times the calls still to go. Calls
  // that waited on a person skew it, so they are left out of the mean.
  const timed = (run.steps || []).filter(s => s.status === 'completed' && s.method !== 'User_Input' && s.start_time && s.end_time);
  const mean = timed.length
    ? timed.reduce((n, s) => n + (parseServerTime(s.end_time) - parseServerTime(s.start_time!)) / 1000, 0) / timed.length
    : NaN;
  const remaining = live && timed.length >= 3 ? mean * (p.total - p.done) : NaN;

  const barColor = run.status === 'error' ? 'bg-red-500' : run.status === 'completed' ? 'bg-green-500' : 'bg-indigo-500';

  return (
    <div className="space-y-5">
      {/* Overall */}
      <div>
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          <span className="text-lg font-bold text-gray-900 dark:text-white">
            {p.done} <span className="text-gray-400 dark:text-gray-500 font-medium">of</span> {p.total} steps
          </span>
          <span className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">{percent}%</span>
        </div>
        <div className="h-2.5 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
          <div className={`h-full ${barColor} transition-all duration-500`} style={{ width: `${percent}%` }} />
        </div>
        {(isFinite(elapsed) || isFinite(remaining)) && (
          <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
            {isFinite(elapsed) && <>{formatSeconds(elapsed)} elapsed</>}
            {isFinite(remaining) && <> · ≈ {formatSeconds(remaining)} left</>}
          </p>
        )}
      </div>

      {/* Loop progress: which samples / batches / iterations are done */}
      {p.kind === 'rows' && p.rows.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.03] p-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-2.5">
            <span className="text-sm font-bold text-gray-800 dark:text-gray-100">
              samples {p.iterations.done}/{p.iterations.total}
            </span>
            {hasBatches && (
              <span className="text-sm font-bold text-teal-700 dark:text-teal-300">
                batch {currentGroup ? p.groups.indexOf(currentGroup) + 1 : p.groups.length}/{p.groups.length}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {p.groups.map((g, gi) => (
              <div
                key={g.index}
                className={`flex items-center gap-1 ${hasBatches ? `rounded-lg border p-1 pr-1.5 ${g === currentGroup ? 'border-teal-300 bg-teal-50/60 dark:border-teal-500/40 dark:bg-teal-500/10' : 'border-gray-200 dark:border-white/10'}` : ''}`}
              >
                {hasBatches && <span className="text-[10px] font-bold text-teal-700 dark:text-teal-300 px-1">b{gi + 1}</span>}
                {g.rows.map(r => {
                  const state = p.rowState.get(r);
                  return (
                    <span
                      key={r}
                      title={`row ${r + 1}: ${state}`}
                      className={`min-w-7 h-7 px-1 rounded-md text-xs font-bold flex items-center justify-center ${
                        state === 'done' ? 'bg-green-500 text-white'
                          : state === 'running' ? 'bg-indigo-500 text-white animate-pulse'
                          : state === 'error' ? 'bg-red-500 text-white'
                          : state === 'partial' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
                          : 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400'
                      }`}
                    >
                      {r + 1}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {p.kind === 'optimization' && p.iterations.total > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.03] p-3">
          <span className="block text-sm font-bold text-gray-800 dark:text-gray-100 mb-2.5">
            iteration {Math.min(p.iterations.done + (run.status === 'completed' ? 0 : 1), p.iterations.total)}/{p.iterations.total}
          </span>
          <div className="flex flex-wrap gap-1">
            {Array.from({ length: p.iterations.total }, (_, i) => (
              <span
                key={i}
                className={`min-w-7 h-7 px-1 rounded-md text-xs font-bold flex items-center justify-center ${
                  i < p.iterations.done ? 'bg-green-500 text-white'
                    : i === p.iterations.done && live ? 'bg-indigo-500 text-white animate-pulse'
                    : 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400'
                }`}
              >
                {i + 1}
              </span>
            ))}
          </div>
        </div>
      )}

      {p.prep.length > 0 && (
        <section>
          <PhaseHeader name="Prep" count={p.prep.length} badge={<OncePill />} />
          <div className="space-y-1">{p.prep.map(s => <OnceRow key={s.id} step={s} />)}</div>
        </section>
      )}

      {p.template.length > 0 && (
        <section>
          <PhaseHeader
            name="Main"
            count={p.template.length}
            badge={loops ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-indigo-600 text-white">
                <Repeat className="w-3 h-3" />
                {p.kind === 'optimization'
                  ? `${p.iterations.total} iterations`
                  : hasBatches ? `${p.groups.length} batches` : `${p.rows.length} samples`}
              </span>
            ) : <OncePill />}
          />
          {!loops ? (
            <div className="space-y-1">{p.template.map(t => <OnceRow key={t.key} step={t.calls[0]} />)}</div>
          ) : (
            <div className="rounded-xl border-2 border-dashed border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/30 dark:bg-indigo-500/[0.04] p-2 space-y-1">
              {p.template.map(t => {
                const state = aggregate(t.calls);
                const current = t.calls.find(s => ACTIVE.has(s.status))
                  || t.calls.find(s => s.status === 'error')
                  || t.calls.find(s => !DONE.has(s.status))
                  || t.calls[t.calls.length - 1];
                const failed = t.calls.find(s => s.status === 'error');
                const args = argsText(current);
                const pct = t.total ? (t.done / t.total) * 100 : 0;
                return (
                  <div key={t.key}>
                    <div className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg border ${
                      state === 'running' ? 'bg-indigo-50 border-indigo-200 dark:bg-indigo-500/10 dark:border-indigo-500/30'
                        : 'bg-white border-gray-100 dark:bg-white/[0.03] dark:border-white/5'
                    }`}>
                      <StatusIcon state={state} />
                      {t.parent && <span title={`from ${t.parent}`}><Link2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" /></span>}
                      <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300 shrink-0">
                        {label(t.instrument)}
                      </span>
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-100 shrink-0">{label(t.method)}</span>
                      {/* The args of the call that is running (or next), so a per-sample step shows
                          this sample's values rather than the first row's. */}
                      {args && (
                        <span className="text-xs font-mono text-gray-400 dark:text-gray-500 truncate min-w-0">{args}</span>
                      )}
                      <div className="ml-auto flex items-center gap-2 shrink-0">
                        {p.kind === 'rows' && (
                          t.perBatch ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-700 dark:text-teal-300">
                              <Layers className="w-3 h-3" /> per batch
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 dark:text-indigo-300">
                              <Repeat className="w-3 h-3" /> per sample
                            </span>
                          )
                        )}
                        <div className="w-16 h-1.5 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
                          <div
                            className={`h-full ${state === 'error' ? 'bg-red-500' : state === 'done' ? 'bg-green-500' : 'bg-indigo-500'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-sm font-bold tabular-nums text-gray-700 dark:text-gray-200 w-12 text-right">
                          {t.done}/{t.total}
                        </span>
                      </div>
                    </div>
                    {failed?.error && (
                      <ErrorBox step={failed} where={rowOf(failed) !== null ? `row ${rowOf(failed)! + 1}` : undefined} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {p.cleanup.length > 0 && (
        <section>
          <PhaseHeader name="Cleanup" count={p.cleanup.length} badge={<OncePill />} />
          <div className="space-y-1">{p.cleanup.map(s => <OnceRow key={s.id} step={s} />)}</div>
        </section>
      )}

      {/* Every call, for the rare case you need one in particular — collapsed, since the summary
          above is what the page is for. Pending calls can still be edited here. */}
      {(run.steps?.length ?? 0) > 0 && (
        <section>
          <button
            onClick={() => setShowCalls(v => !v)}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
          >
            {showCalls ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            every call ({run.steps!.length})
          </button>
          {showCalls && (
            <div className="mt-2 space-y-1">
              {(run.steps || []).slice().sort((a, b) => (a.sequence_index ?? 0) - (b.sequence_index ?? 0)).map((s, i) => (
                <div key={s.id} className="flex items-start gap-2 px-2.5 py-1.5 rounded-md bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                  <span className="text-[10px] font-mono text-gray-400 w-6 text-right pt-0.5 shrink-0">{i + 1}</span>
                  <StatusIcon state={s.status} size="sm" />
                  <div className="min-w-0 flex-1">
                    <span className="text-xs text-gray-500 dark:text-gray-400">{phaseOf(s)}{rowOf(s) !== null ? ` · row ${rowOf(s)! + 1}` : ''} · </span>
                    <span className="text-xs font-medium text-gray-800 dark:text-gray-100">{label(s.instrument)} {label(s.method)}</span>
                    {argsText(s) && <p className="text-[11px] font-mono text-gray-400 break-words">{argsText(s)}</p>}
                    {stepEditor?.(s)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
