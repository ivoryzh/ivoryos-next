"use client";

/**
 * "Full sequence preview" — the flattened list of steps a run will actually execute, with every
 * linked workflow expanded.
 *
 * The step list is NOT computed here. It comes from `POST /api/workflows/expand`, which runs the
 * same `expand_workflow_blocks` the dispatch path uses. That is deliberate: this panel exists to
 * tell someone what physical hardware is about to do, so a second, parallel implementation that
 * could drift from the real expansion would be worse than showing nothing at all.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Layers, Link2, RefreshCw, X } from 'lucide-react';

export type ExpandedStep = {
  instrument: string;
  method: string;
  params: Record<string, any>;
  batch_action?: boolean;
  isBatchAction?: boolean;
  [key: string]: any;
};

export type ExpansionResult = {
  prep: ExpandedStep[];
  sequence: ExpandedStep[];
  cleanup: ExpandedStep[];
  resolved_links: { name: string; version?: number; body_hash?: string; mode?: string; depth?: number }[];
  counts: { prep: number; sequence: number; cleanup: number; total: number };
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  /** Calls the dry-run endpoint. Provided by the host app because API base URLs differ. */
  fetchExpansion: () => Promise<ExpansionResult>;
  /**
   * Set when a spreadsheet is loaded (Configure page). Per-sample steps repeat once per row within
   * a batch group and batch steps run once per group, so the flat step count alone understates the
   * real work by a large factor — this is the number that is otherwise impossible to work out ahead
   * of time.
   *
   * `onBatchSizeChange` makes the batch-size control in this panel write back to the page's real
   * setting rather than being a private what-if, so what the preview shows is what will run.
   */
  spreadsheet?: { rows: number; batchSize: number; onBatchSizeChange?: (size: number) => void };
};

/** Used when no spreadsheet is loaded (the Designer), so batch behaviour is still explorable. */
const EXAMPLE_ROWS = 6;
const EXAMPLE_BATCH_SIZE = 3;

const PHASES: { key: 'prep' | 'sequence' | 'cleanup'; label: string }[] = [
  { key: 'prep', label: 'Prep' },
  { key: 'sequence', label: 'Main' },
  { key: 'cleanup', label: 'Cleanup' },
];

const isInternalParam = (key: string) => key.startsWith('_');

const isBatchStep = (step: ExpandedStep) => !!(step.batch_action ?? step.isBatchAction);

/** Consecutive steps sharing a `_parent_workflow` form one collapsible group. */
type Group = { parent: string | null; steps: ExpandedStep[]; startIndex: number };

function groupSteps(steps: ExpandedStep[]): Group[] {
  const groups: Group[] = [];
  steps.forEach((step, index) => {
    const parent = step.params?._parent_workflow || null;
    const last = groups[groups.length - 1];
    if (last && last.parent === parent && parent !== null) {
      last.steps.push(step);
    } else if (last && last.parent === null && parent === null) {
      last.steps.push(step);
    } else {
      groups.push({ parent, steps: [step], startIndex: index });
    }
  });
  return groups;
}

/**
 * What a phase actually costs once a spreadsheet is applied. Mirrors `executeSpreadsheet`'s walk in
 * the Configure page: rows are chunked into groups of `batchSize`, and within each group a
 * per-sample step expands to one call per row while a batch step expands to exactly one call.
 * Prep and Cleanup run once regardless, by definition.
 */
function spreadsheetCost(steps: ExpandedStep[], rows: number, batchSize: number) {
  const groupSize = Math.max(1, batchSize || rows);
  const groups = Math.max(1, Math.ceil(rows / groupSize));
  let calls = 0;
  for (const step of steps) {
    calls += isBatchStep(step) ? groups : rows;
  }
  return { groups, calls };
}

/**
 * The actual per-group execution: which rows fall in each batch group, and for each step whether it
 * repeats once per row or fires once for the whole group. Mirrors `executeSpreadsheet`'s block-major
 * walk in the Configure page — within a group the sequence is walked once, a per-sample step
 * expanding to one call per row and a batch step to exactly one.
 */
function batchGroups(steps: ExpandedStep[], rows: number, batchSize: number) {
  const groupSize = Math.max(1, batchSize || rows || 1);
  const total = Math.max(1, rows);
  const groups = [];
  for (let start = 0; start < total; start += groupSize) {
    const size = Math.min(groupSize, total - start);
    groups.push({
      index: groups.length + 1,
      firstRow: start + 1,
      lastRow: start + size,
      rowCount: size,
      calls: steps.reduce((n, step) => n + (isBatchStep(step) ? 1 : size), 0),
    });
  }
  return groups;
}

export function WorkflowMap({ isOpen, onClose, fetchExpansion, spreadsheet }: Props) {
  const [result, setResult] = useState<ExpansionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // What-if values, used only when no spreadsheet is loaded (the Designer). With one loaded the
  // real rows/batch size win, so the panel can never show a different run than the one configured.
  const [exampleRows, setExampleRows] = useState(EXAMPLE_ROWS);
  const [exampleBatchSize, setExampleBatchSize] = useState(EXAMPLE_BATCH_SIZE);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setResult(await fetchExpansion());
    } catch (e: any) {
      setResult(null);
      setError(e?.message || 'Could not expand this sequence.');
    } finally {
      setIsLoading(false);
    }
  }, [fetchExpansion]);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const toggle = (key: string) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));

  const rows = spreadsheet ? spreadsheet.rows : exampleRows;
  const batchSize = spreadsheet ? (spreadsheet.batchSize || spreadsheet.rows) : exampleBatchSize;
  const setBatchSize = (n: number) => {
    if (spreadsheet?.onBatchSizeChange) spreadsheet.onBatchSizeChange(n);
    else if (!spreadsheet) setExampleBatchSize(n);
  };

  const mainSteps = result?.sequence || [];
  const batchStepCount = mainSteps.filter(isBatchStep).length;
  const perSampleCount = mainSteps.length - batchStepCount;
  // Worth showing whenever the main phase repeats per row at all — the batch/per-sample split is
  // exactly as confusing when every step is per-sample and the count silently multiplies.
  const showBatchSection = !!result && mainSteps.length > 0 && (!!spreadsheet || batchStepCount > 0);

  const cost = result ? spreadsheetCost(mainSteps, rows, batchSize) : null;
  const totalCalls = result && cost
    ? cost.calls + result.prep.length + result.cleanup.length
    : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-white dark:bg-[#111] rounded-2xl shadow-2xl border border-gray-200 dark:border-white/10"
      >
        <header className="shrink-0 px-5 py-4 border-b border-gray-200 dark:border-white/10 flex items-start justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-gray-900 dark:text-white">Full sequence preview</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Every linked workflow expanded — exactly what will be queued.
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-4">
            <button
              onClick={load}
              title="Recalculate"
              className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {result && (
          <div className="shrink-0 px-5 py-3 border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02] flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
            <span className="text-gray-600 dark:text-gray-300">
              <strong className="text-gray-900 dark:text-white">{result.counts.total}</strong> steps
              <span className="text-gray-400 dark:text-gray-500">
                {' '}({result.counts.prep} prep · {result.counts.sequence} main · {result.counts.cleanup} cleanup)
              </span>
            </span>
            {spreadsheet && totalCalls !== null && cost && (
              <span className="text-gray-600 dark:text-gray-300">
                {rows} rows × batch {batchSize} ={' '}
                <strong className="text-gray-900 dark:text-white">{cost.groups}</strong>{' '}
                groups, <strong className="text-gray-900 dark:text-white">{totalCalls}</strong> calls
              </span>
            )}
            {result.resolved_links.length > 0 && (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                <Link2 className="w-3.5 h-3.5" />
                {result.resolved_links.map(l => `${l.name}${l.version ? ` v${l.version}` : ''}`).join(', ')}
              </span>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading && !result && (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">Expanding…</p>
          )}

          {error && (
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-500/30">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-red-700 dark:text-red-400">This sequence cannot run yet</p>
                {/* Verbatim from the server, which is the same message a real run submission would
                    be refused with — so the preview never disagrees with dispatch. */}
                <p className="text-xs text-red-600 dark:text-red-300 mt-1 break-words">{error}</p>
              </div>
            </div>
          )}

          {result && !error && result.counts.total === 0 && (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">
              Nothing to run yet — add some steps first.
            </p>
          )}

          {showBatchSection && result && !error && (() => {
            const groups = batchGroups(mainSteps, rows, batchSize);
            return (
              <section className="mb-5 rounded-xl border border-teal-200 dark:border-teal-800/40 bg-teal-50/40 dark:bg-teal-900/10 overflow-hidden">
                <div className="px-3 py-2.5 border-b border-teal-200/70 dark:border-teal-800/40 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Layers className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
                  <span className="text-xs font-bold text-teal-800 dark:text-teal-300">Batch execution</span>

                  <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300">
                    Rows
                    <input
                      type="number"
                      min={1}
                      value={rows}
                      disabled={!!spreadsheet}
                      onChange={(e) => setExampleRows(Math.max(1, parseInt(e.target.value) || 1))}
                      title={spreadsheet ? 'Taken from the spreadsheet' : 'Example row count — no spreadsheet is loaded'}
                      className="w-14 px-1.5 py-0.5 rounded border border-gray-300 dark:border-white/10 bg-white dark:bg-black/40 text-gray-800 dark:text-gray-100 disabled:opacity-60"
                    />
                  </label>

                  <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300">
                    Batch size
                    <input
                      type="number"
                      min={1}
                      value={batchSize}
                      onChange={(e) => setBatchSize(Math.max(1, parseInt(e.target.value) || 1))}
                      title={spreadsheet?.onBatchSizeChange
                        ? 'Changes the real batch size for this run'
                        : 'How many consecutive rows make up one batch group'}
                      className="w-14 px-1.5 py-0.5 rounded border border-gray-300 dark:border-white/10 bg-white dark:bg-black/40 text-gray-800 dark:text-gray-100"
                    />
                  </label>

                  <span className="text-[11px] text-gray-500 dark:text-gray-400">
                    {perSampleCount} per-sample · {batchStepCount} batch step{batchStepCount === 1 ? '' : 's'}
                    {' → '}
                    <strong className="text-gray-800 dark:text-gray-100">{groups.length}</strong> group{groups.length === 1 ? '' : 's'},{' '}
                    <strong className="text-gray-800 dark:text-gray-100">{cost?.calls}</strong> calls
                  </span>
                </div>

                {!spreadsheet && (
                  <p className="px-3 pt-2 text-[10px] text-gray-500 dark:text-gray-400">
                    No spreadsheet is loaded, so these are example numbers — change them to see how the
                    batch steps would be grouped on the Configure page.
                  </p>
                )}

                <div className="p-3 space-y-2">
                  {groups.map(group => (
                    <div key={group.index} className="rounded-lg border border-teal-200/70 dark:border-teal-800/30 bg-white dark:bg-black/20 overflow-hidden">
                      <div className="px-2.5 py-1.5 bg-teal-50 dark:bg-teal-900/20 flex items-center justify-between gap-2">
                        <span className="text-[11px] font-bold text-teal-800 dark:text-teal-300">
                          Batch {group.index}
                          <span className="font-medium text-teal-600/80 dark:text-teal-400/80">
                            {' '}· rows {group.firstRow}–{group.lastRow}
                          </span>
                        </span>
                        <span className="text-[10px] text-gray-500 dark:text-gray-400">{group.calls} calls</span>
                      </div>
                      <div className="divide-y divide-gray-100 dark:divide-white/5">
                        {mainSteps.map((step, i) => {
                          const batch = isBatchStep(step);
                          return (
                            <div key={i} className="px-2.5 py-1.5 flex items-center justify-between gap-2">
                              <span className="text-[11px] text-gray-700 dark:text-gray-200 min-w-0 truncate">
                                <span className="text-gray-400 dark:text-gray-500 capitalize">
                                  {String(step.instrument || '').replace(/_/g, ' ')}.
                                </span>
                                <span className="font-medium">{step.method}</span>
                              </span>
                              {batch ? (
                                <span className="shrink-0 inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 border border-teal-300 dark:bg-teal-500/20 dark:text-teal-300 dark:border-teal-700/40">
                                  <Layers className="w-2.5 h-2.5" /> once for this batch
                                </span>
                              ) : (
                                <span className="shrink-0 text-[10px] font-semibold text-gray-500 dark:text-gray-400">
                                  × {group.rowCount} (one per row)
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })()}

          {result && !error && PHASES.map(({ key, label }) => {
            const steps = result[key];
            if (!steps.length) return null;
            return (
              <section key={key} className="mb-5 last:mb-0">
                <div className="flex items-center gap-2 mb-2">
                  <div className="h-px bg-gray-200 dark:bg-white/10 flex-1" />
                  <span className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest">
                    {label} · {steps.length}
                  </span>
                  <div className="h-px bg-gray-200 dark:bg-white/10 flex-1" />
                </div>

                <div className="space-y-1">
                  {groupSteps(steps).map((group, gi) => {
                    const groupKey = `${key}-${gi}`;
                    const isCollapsed = collapsed[groupKey];

                    const rows = group.steps.map((step, si) => {
                      const params = Object.entries(step.params || {}).filter(([k]) => !isInternalParam(k));
                      return (
                        <div
                          key={si}
                          className={`flex items-start gap-2 px-2.5 py-1.5 rounded-md bg-gray-50 dark:bg-white/[0.03] ${group.parent ? 'ml-5 border-l-2 border-emerald-200 dark:border-emerald-800/50' : ''}`}
                        >
                          <span className="text-[10px] font-mono text-gray-400 dark:text-gray-600 w-6 shrink-0 text-right pt-0.5">
                            {group.startIndex + si + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 dark:bg-white/10 dark:text-gray-300 capitalize">
                                {String(step.instrument || '').replace(/_/g, ' ')}
                              </span>
                              <span className="text-xs font-medium text-gray-800 dark:text-gray-100 capitalize">
                                {String(step.method || '').replace(/_/g, ' ')}
                              </span>
                              {key === 'sequence' && isBatchStep(step) && (
                                <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-200 dark:bg-teal-500/20 dark:text-teal-300 dark:border-teal-700/40">
                                  <Layers className="w-2.5 h-2.5" /> Batch
                                </span>
                              )}
                            </div>
                            {params.length > 0 && (
                              <p className="text-[11px] text-gray-500 dark:text-gray-400 font-mono mt-0.5 break-words">
                                {params.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    });

                    if (!group.parent) return <div key={groupKey} className="space-y-1">{rows}</div>;

                    return (
                      <div key={groupKey} className="space-y-1">
                        <button
                          onClick={() => toggle(groupKey)}
                          className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 transition-colors text-left"
                        >
                          {isCollapsed
                            ? <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                            : <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
                          <Link2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                          <span className="text-xs font-bold text-gray-700 dark:text-gray-200 truncate">
                            {group.parent}
                          </span>
                          <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0">
                            {group.steps.length} steps
                          </span>
                        </button>
                        {!isCollapsed && rows}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default WorkflowMap;
