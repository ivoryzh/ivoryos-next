"use client";

/**
 * "What changes if I update?" — a side-by-side comparison shown before a copy is replaced or a
 * pinned link is re-pointed.
 *
 * Updating used to be a yes/no confirm naming a version number and nothing else, which asked the
 * user to approve a change to hardware instructions sight unseen. Since updating a copy also
 * discards whatever they edited into it, that is exactly the moment to show the steps.
 *
 * Two columns rather than a unified list: the question people actually have is "where in my
 * protocol does this change, and what does it become", and a summary makes them rebuild that
 * alignment in their head. Aligned steps sit on the same row, a missing counterpart is drawn as an
 * explicit gap, and the individual parameters that differ are highlighted inside each cell.
 */

import React, { useEffect, useState } from 'react';
import { ArrowRight, Layers, X } from 'lucide-react';

import { summariseDiff, type DiffRow, type DiffStep, type StepChange } from './workflowBody';

type Props = {
  isOpen: boolean;
  title: string;
  fromLabel: string;
  toLabel: string;
  rows: DiffRow[];
  /** Shown above the list when applying is destructive (a copy's local edits are lost). */
  warning?: string;
  /**
   * What happens to the values this step supplies. Separate from the step diff because these are
   * the caller's own inputs: the new version may stop reading one (its value is dropped) or start
   * needing one (it has to be filled in).
   */
  paramChanges?: { added: string[]; removed: { key: string; value: any }[] };
  applyLabel: string;
  onApply: () => void;
  onClose: () => void;
};

type Side = 'before' | 'after';

const label = (step: DiffStep) =>
  `${String(step.instrument).replace(/_/g, ' ')}.${String(step.method).replace(/_/g, ' ')}`;

const show = (value: any) =>
  value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** Param keys that differ, so a cell can highlight just those rather than the whole step. */
function changedParamKeys(changes: StepChange[]): Set<string> {
  return new Set(changes.filter(c => c.key !== 'saves as' && c.key !== 'runs').map(c => c.key));
}

const rowStatus = (row: DiffRow) => row.kind;

function StepCell({
  step, side, status, changes, index,
}: {
  step?: DiffStep;
  side: Side;
  status: DiffRow['kind'];
  changes: StepChange[];
  index?: number;
}) {
  // No counterpart on this side — drawn as a visible gap so the reader can see *where* the other
  // column gained or lost a step, instead of the two columns silently sliding out of step.
  if (!step) {
    return (
      <div className="rounded-lg border border-dashed border-gray-200 dark:border-white/10 px-2.5 py-2 flex items-center">
        <span className="text-[10px] italic text-gray-300 dark:text-gray-600">
          {side === 'before' ? 'not in this version' : 'removed'}
        </span>
      </div>
    );
  }

  const tint =
    status === 'added' ? (side === 'after'
      ? 'bg-emerald-50/70 border-emerald-300 dark:bg-emerald-900/20 dark:border-emerald-700/50' : '')
    : status === 'removed' ? (side === 'before'
      ? 'bg-red-50/70 border-red-300 dark:bg-red-900/20 dark:border-red-700/50' : '')
    : status === 'changed'
      ? 'bg-amber-50/60 border-amber-300 dark:bg-amber-900/15 dark:border-amber-700/50'
      : 'bg-gray-50/60 border-gray-200 dark:bg-white/[0.02] dark:border-white/5';

  const keys = changedParamKeys(changes);
  const batchChange = changes.find(c => c.key === 'runs');
  const savesChange = changes.find(c => c.key === 'saves as');
  const muted = status === 'same';

  const valueClass = side === 'before'
    ? 'text-red-700 dark:text-red-300 bg-red-100/70 dark:bg-red-900/30'
    : 'text-emerald-800 dark:text-emerald-300 bg-emerald-100/70 dark:bg-emerald-900/30';

  return (
    <div className={`rounded-lg border px-2.5 py-2 ${tint}`}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[10px] font-mono text-gray-400 dark:text-gray-600 shrink-0">
          {index !== undefined ? index + 1 : ''}
        </span>
        <span className={`text-xs capitalize break-words ${
          muted ? 'text-gray-500 dark:text-gray-400' : 'font-medium text-gray-800 dark:text-gray-100'
        } ${status === 'removed' && side === 'before' ? 'line-through' : ''}`}>
          {label(step)}
        </span>
        {step.batch && (
          <span className={`inline-flex items-center gap-0.5 text-[9px] font-bold uppercase px-1 py-0.5 rounded shrink-0 ${
            batchChange ? valueClass : 'bg-teal-100 text-teal-700 dark:bg-teal-500/20 dark:text-teal-300'
          }`}>
            <Layers className="w-2.5 h-2.5" /> batch
          </span>
        )}
        {!step.batch && batchChange && (
          <span className={`text-[9px] font-bold uppercase px-1 py-0.5 rounded shrink-0 ${valueClass}`}>
            per row
          </span>
        )}
      </div>

      {Object.keys(step.params || {}).length > 0 && (
        <div className="mt-1 pl-4 flex flex-col gap-0.5">
          {Object.entries(step.params).map(([key, value]) => {
            const isChanged = keys.has(key);
            return (
              <span key={key} className="text-[11px] font-mono break-all">
                <span className="text-gray-400 dark:text-gray-500">{key}=</span>
                <span className={isChanged ? `px-1 rounded ${valueClass}` : 'text-gray-600 dark:text-gray-300'}>
                  {show(value)}
                </span>
              </span>
            );
          })}
        </div>
      )}

      {step.returnVar && (
        <div className="mt-1 pl-4 text-[11px] font-mono break-all">
          <span className="text-gray-400 dark:text-gray-500">saves as </span>
          <span className={savesChange ? `px-1 rounded ${valueClass}` : 'text-gray-600 dark:text-gray-300'}>
            {step.returnVar}
          </span>
        </div>
      )}
    </div>
  );
}

export function WorkflowDiff({
  isOpen, title, fromLabel, toLabel, rows, warning, paramChanges, applyLabel, onApply, onClose,
}: Props) {
  const [onlyChanges, setOnlyChanges] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => { if (isOpen) setOnlyChanges(false); }, [isOpen]);

  if (!isOpen) return null;

  const counts = summariseDiff(rows);
  const identical = counts.added + counts.removed + counts.changed === 0;

  // Step numbers count independently per side, so a reader can see that "step 3 here is step 4
  // there" rather than assuming the rows line up positionally.
  let beforeIndex = -1;
  let afterIndex = -1;
  const numbered = rows.map(row => {
    const before = 'before' in row ? row.before : undefined;
    const after = 'after' in row ? row.after : undefined;
    if (before) beforeIndex += 1;
    if (after) afterIndex += 1;
    return {
      row,
      before,
      after,
      beforeIndex: before ? beforeIndex : undefined,
      afterIndex: after ? afterIndex : undefined,
      changes: row.kind === 'changed' || row.kind === 'same' ? row.changes : [],
    };
  });

  const visible = onlyChanges ? numbered.filter(n => n.row.kind !== 'same') : numbered;

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl max-h-[88vh] flex flex-col bg-white dark:bg-[#111] rounded-2xl shadow-2xl border border-gray-200 dark:border-white/10"
      >
        <header className="shrink-0 px-5 py-4 border-b border-gray-200 dark:border-white/10 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-gray-900 dark:text-white break-words">{title}</h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-xs">
              {identical ? (
                <span className="text-gray-500 dark:text-gray-400">
                  No step-level differences — only the version number changes.
                </span>
              ) : (
                <>
                  {counts.added > 0 && <span className="text-emerald-700 dark:text-emerald-400">+{counts.added} added</span>}
                  {counts.removed > 0 && <span className="text-red-600 dark:text-red-400">−{counts.removed} removed</span>}
                  {counts.changed > 0 && <span className="text-amber-700 dark:text-amber-400">{counts.changed} changed</span>}
                  {counts.same > 0 && <span className="text-gray-400 dark:text-gray-500">{counts.same} unchanged</span>}
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {counts.same > 0 && !identical && (
              <label className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={onlyChanges}
                  onChange={(e) => setOnlyChanges(e.target.checked)}
                  className="accent-indigo-600"
                />
                Only changes
              </label>
            )}
            <button
              onClick={onClose}
              className="p-1.5 -mr-1 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Column headings stay put while the steps scroll, so it is always clear which side is
            which — the whole point of the two-column layout. */}
        <div className="shrink-0 grid grid-cols-1 sm:grid-cols-2 gap-3 px-5 py-2 border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02]">
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 truncate">
            {fromLabel}
          </span>
          <span className="hidden sm:flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 truncate">
            <ArrowRight className="w-3 h-3 shrink-0" />
            {toLabel}
          </span>
        </div>

        {warning && (
          <p className="shrink-0 mx-5 mt-3 text-[11px] text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-lg px-2.5 py-2">
            {warning}
          </p>
        )}

        {(paramChanges?.added.length || paramChanges?.removed.length) ? (
          <div className="shrink-0 mx-5 mt-3 rounded-lg border border-indigo-200 dark:border-indigo-800/40 bg-indigo-50/60 dark:bg-indigo-900/15 px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
              This step&apos;s inputs
            </p>
            <div className="mt-1 space-y-0.5">
              {paramChanges.removed.map(({ key, value }) => (
                <p key={key} className="text-[11px] text-gray-600 dark:text-gray-300">
                  <span className="font-mono font-semibold">{key}</span>
                  {' is no longer used — its value ('}
                  <span className="font-mono">{show(value)}</span>
                  {') will be removed.'}
                </p>
              ))}
              {paramChanges.added.map(key => (
                <p key={key} className="text-[11px] text-gray-600 dark:text-gray-300">
                  <span className="font-mono font-semibold">{key}</span>
                  {' is new — it will need a value.'}
                </p>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {visible.length === 0 && (
            <p className="text-sm text-gray-400 py-8 text-center">Nothing changed between these versions.</p>
          )}
          {visible.map((entry, i) => (
            <div key={i} className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-stretch">
              {/* On a narrow screen the pair stacks, so the left cell is labelled to keep the
                  before/after reading order unambiguous. */}
              <div className="min-w-0">
                <span className="sm:hidden block text-[9px] font-bold uppercase tracking-wider text-gray-400 mb-0.5">
                  {fromLabel}
                </span>
                <StepCell
                  step={entry.before}
                  side="before"
                  status={rowStatus(entry.row)}
                  changes={entry.changes}
                  index={entry.beforeIndex}
                />
              </div>
              <div className="min-w-0">
                <span className="sm:hidden block text-[9px] font-bold uppercase tracking-wider text-indigo-500 mb-0.5">
                  {toLabel}
                </span>
                <StepCell
                  step={entry.after}
                  side="after"
                  status={rowStatus(entry.row)}
                  changes={entry.changes}
                  index={entry.afterIndex}
                />
              </div>
            </div>
          ))}
        </div>

        <footer className="shrink-0 px-5 py-3 border-t border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-700 hover:bg-gray-100 dark:bg-white/5 dark:border-white/10 dark:text-gray-200 dark:hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={onApply}
            className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700"
          >
            {applyLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default WorkflowDiff;
