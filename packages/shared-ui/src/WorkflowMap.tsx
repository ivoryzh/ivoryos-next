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
import { AlertTriangle, ChevronDown, ChevronRight, Layers, Link2, RefreshCw, Repeat, X } from 'lucide-react';

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
  /**
   * Turns the preview into the step before a run. The Designer has no separate Preview
   * button any more — this panel *is* what you see before committing, so the confirming
   * action belongs on it rather than behind a second trip to the header.
   */
  confirmLabel?: string;
  onConfirm?: () => void;
};

/** Used when no spreadsheet is loaded (the Designer), so batch behaviour is still explorable. */
const EXAMPLE_ROWS = 6;
const EXAMPLE_BATCH_SIZE = 3;

const isInternalParam = (key: string) => key.startsWith('_');

const isBatchStep = (step: ExpandedStep) => !!(step.batch_action ?? step.isBatchAction);

/**
 * Consecutive steps from the same *expansion* form one collapsible group.
 *
 * Keyed on `_expansion_id`, not on the workflow name: using the same saved workflow twice in a
 * row produces two adjacent runs of steps with an identical `_parent_workflow`, and grouping by
 * name silently fused them into one — a sequence that used "Suzuki coupling screen" twice read
 * as a single 32-step block instead of two 16-step ones. Runs recorded before the expander
 * emitted the id fall back to the name and keep their old (merged) rendering rather than
 * breaking.
 */
type Group = { parent: string | null; steps: ExpandedStep[]; startIndex: number };

const expansionKey = (step: ExpandedStep) => {
  const parent = step.params?._parent_workflow || null;
  if (!parent) return null;
  const id = step.params?._expansion_id;
  return id === undefined || id === null ? `name:${parent}` : `exp:${id}`;
};

function groupSteps(steps: ExpandedStep[]): Group[] {
  const groups: Group[] = [];
  let lastKey: string | null | undefined;
  steps.forEach((step, index) => {
    const parent = step.params?._parent_workflow || null;
    const key = expansionKey(step);
    const last = groups[groups.length - 1];
    if (last && key === lastKey) {
      last.steps.push(step);
    } else {
      groups.push({ parent, steps: [step], startIndex: index });
    }
    lastKey = key;
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

/**
 * How often one main-phase step fires, as a pill in a fixed column so the whole list scans at a
 * glance. It replaces a faint "× 5 each" that read as part of the method name and said nothing
 * about *what* the 5 counted.
 */
function RepeatPill({ batch, perGroup, lastGroup, groups, rows }: {
  batch: boolean;
  perGroup: number;
  lastGroup: number;
  groups: number;
  rows: number;
}) {
  if (batch) {
    return (
      <span
        title={`Runs once for each batch${groups > 1 ? ` — ${groups} times in all` : ''}, with the values from that batch's first row.`}
        className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-bold bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-500/15 dark:text-teal-300 dark:border-teal-500/30"
      >
        <Layers className="w-3 h-3" />
        ×1
        <span className="font-medium opacity-75">per batch</span>
      </span>
    );
  }
  const uneven = groups > 1 && lastGroup !== perGroup;
  return (
    <span
      title={`Runs once for each row ${groups > 1 ? 'in a batch' : ''} before the next step starts — ${rows} times in all${uneven ? `; the last batch has ${lastGroup} row${lastGroup === 1 ? '' : 's'}` : ''}.`}
      className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-bold bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/30"
    >
      <Repeat className="w-3 h-3" />
      ×{perGroup}{uneven ? '*' : ''}
      <span className="font-medium opacity-75">per sample</span>
    </span>
  );
}

const numberInputClass =
  'w-12 px-1.5 py-0.5 rounded border border-gray-300 dark:border-white/10 bg-white dark:bg-black/40 text-gray-800 dark:text-gray-100 text-[11px] disabled:opacity-60';

export function WorkflowMap({ isOpen, onClose, fetchExpansion, spreadsheet, confirmLabel, onConfirm }: Props) {
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

  // Whether the main phase repeats at all. With a spreadsheet it always does (once per row). In
  // the Designer a plain Run goes through once, so the loop is only drawn — with example numbers —
  // when batch steps exist and there is a grouping worth exploring.
  const loops = !!spreadsheet || batchStepCount > 0;
  const isExample = !spreadsheet && loops;
  const groups = loops ? batchGroups(mainSteps, rows, batchSize) : [];
  const perGroup = groups[0]?.rowCount ?? 1;
  const lastGroup = groups[groups.length - 1]?.rowCount ?? 1;
  // The batch-size control matters whenever there is something for it to change: a batch step to
  // group, or (on Configure) a batch size already set that splits the walk into several passes.
  const showBatchControl = loops && (batchStepCount > 0 || groups.length > 1);

  const cost = result ? spreadsheetCost(mainSteps, rows, batchSize) : null;
  const totalCalls = result && cost && loops
    ? cost.calls + result.prep.length + result.cleanup.length
    : result?.counts.total ?? null;

  const renderSteps = (phase: 'prep' | 'sequence' | 'cleanup', steps: ExpandedStep[]) =>
    groupSteps(steps).map((group, gi) => {
      const groupKey = `${phase}-${gi}`;
      const isCollapsed = collapsed[groupKey];

      const stepRows = group.steps.map((step, si) => {
        const params = Object.entries(step.params || {}).filter(([k]) => !isInternalParam(k));
        return (
          <div
            key={si}
            className={`flex items-start gap-2 px-2.5 py-1.5 rounded-md bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5 ${group.parent ? 'ml-5 border-l-2 border-l-emerald-200 dark:border-l-emerald-800/50' : ''}`}
          >
            <span className="text-[10px] font-mono text-gray-400 dark:text-gray-600 w-5 shrink-0 text-right pt-0.5">
              {group.startIndex + si + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300">
                  {String(step.instrument || '').replace(/_/g, ' ')}
                </span>
                <span className="text-xs font-medium text-gray-800 dark:text-gray-100">
                  {String(step.method || '').replace(/_/g, ' ')}
                </span>
              </div>
              {params.length > 0 && (
                <p className="text-[11px] text-gray-500 dark:text-gray-400 font-mono mt-0.5 break-words">
                  {params.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')}
                </p>
              )}
            </div>
            {/* Only the main phase repeats — prep and cleanup say "once" in their header. */}
            {phase === 'sequence' && loops && (
              <RepeatPill
                batch={isBatchStep(step)}
                perGroup={perGroup}
                lastGroup={lastGroup}
                groups={groups.length}
                rows={rows}
              />
            )}
          </div>
        );
      });

      if (!group.parent) return <div key={groupKey} className="space-y-1">{stepRows}</div>;

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
          {!isCollapsed && stepRows}
        </div>
      );
    });

  // One header shape for all three phases, so "once" and "×3 batches" sit in the same place and
  // read as answers to the same question.
  const phaseHeader = (label: string, count: number, badge: React.ReactNode, extra?: React.ReactNode) => (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 mb-2">
      <span className="text-xs font-bold text-gray-800 dark:text-gray-100">{label}</span>
      <span className="text-[11px] text-gray-400 dark:text-gray-500">{count} step{count === 1 ? '' : 's'}</span>
      {badge}
      <div className="h-px bg-gray-200 dark:bg-white/10 flex-1 min-w-[1rem]" />
      {extra}
    </div>
  );

  const oncePill = (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300">
      once
    </span>
  );

  const bookend = (key: 'prep' | 'cleanup', label: string) => {
    if (!result || !result[key].length) return null;
    return (
      <section className="mb-4">
        {phaseHeader(label, result[key].length, oncePill)}
        <div className="space-y-1">{renderSteps(key, result[key])}</div>
      </section>
    );
  };

  const mainSection = () => {
    if (!result || !mainSteps.length) return null;
    const passes = groups.length;
    const iterationPill = !loops ? oncePill : (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-indigo-600 text-white">
        <Repeat className="w-3 h-3" />
        {passes > 1 ? `${passes} batches` : `${rows} row${rows === 1 ? '' : 's'}`}
      </span>
    );
    const controls = loops ? (
      <div className="flex items-center gap-3 text-[11px] text-gray-500 dark:text-gray-400">
        <label className="flex items-center gap-1.5">
          rows
          <input
            type="number"
            min={1}
            value={rows}
            disabled={!!spreadsheet}
            onChange={(e) => setExampleRows(Math.max(1, parseInt(e.target.value) || 1))}
            title={spreadsheet ? 'Taken from the spreadsheet' : 'Example row count — no spreadsheet is loaded'}
            className={numberInputClass}
          />
        </label>
        {showBatchControl && (
          <label className="flex items-center gap-1.5">
            batch size
            <input
              type="number"
              min={1}
              value={batchSize}
              onChange={(e) => setBatchSize(Math.max(1, parseInt(e.target.value) || 1))}
              title={spreadsheet?.onBatchSizeChange
                ? 'Changes the real batch size for this run'
                : 'How many consecutive rows make up one batch'}
              className={numberInputClass}
            />
          </label>
        )}
      </div>
    ) : null;

    return (
      <section className="mb-4">
        {phaseHeader('Main', mainSteps.length, iterationPill, controls)}
        {!loops ? (
          <div className="space-y-1">{renderSteps('sequence', mainSteps)}</div>
        ) : (
          // The loop is drawn, not described: a frame around exactly the steps that repeat, with
          // what it repeats over written on the frame itself. Prep and cleanup sit outside it.
          <div className="rounded-xl border-2 border-dashed border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/30 dark:bg-indigo-500/[0.04] p-2">
            <div className="space-y-1">{renderSteps('sequence', mainSteps)}</div>
            <div className="mt-2 pt-2 border-t border-dashed border-indigo-200 dark:border-indigo-500/30 flex flex-wrap items-center gap-1.5 text-[11px] text-indigo-700 dark:text-indigo-300">
              <Repeat className="w-3.5 h-3.5 shrink-0" />
              {passes > 1 ? (
                <>
                  <span className="font-semibold">repeat for each batch</span>
                  {groups.map(group => (
                    <span
                      key={group.index}
                      className="px-2 py-0.5 rounded-full bg-white dark:bg-black/30 border border-indigo-200 dark:border-indigo-500/30"
                    >
                      {/* "rows 5–5" reads like a typo; a remainder batch of one is common. */}
                      {group.firstRow === group.lastRow ? `row ${group.firstRow}` : `rows ${group.firstRow}–${group.lastRow}`}
                    </span>
                  ))}
                </>
              ) : (
                <span>each step runs for every row before the next step starts; an If/While block runs whole, row by row</span>
              )}
              {isExample && <span className="text-gray-400 dark:text-gray-500">· example numbers, no spreadsheet loaded</span>}
            </div>
          </div>
        )}
      </section>
    );
  };

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

        {confirmLabel && onConfirm && (
          <div className="shrink-0 px-5 py-3 border-b border-gray-200 dark:border-white/10 bg-gray-50/70 dark:bg-white/[0.02] flex items-center justify-between gap-3">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              This is what will be dispatched. Nothing has started yet.
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                disabled={isLoading}
                className="px-4 py-1.5 rounded-lg text-xs font-bold bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        )}

        {result && (
          // Totals only. How they break down is the phase sections' job, directly below.
          <div className="shrink-0 px-5 py-2.5 border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02] flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-gray-600 dark:text-gray-300">
            <span>
              <strong className="text-gray-900 dark:text-white">{result.counts.total}</strong> steps
              {loops && totalCalls !== null && (
                <> → <strong className="text-gray-900 dark:text-white">{totalCalls}</strong> calls{isExample ? ' (example)' : ''}</>
              )}
            </span>
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

          {result && !error && (
            <>
              {bookend('prep', 'Prep')}
              {mainSection()}
              {bookend('cleanup', 'Cleanup')}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default WorkflowMap;
