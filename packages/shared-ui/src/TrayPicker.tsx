"use client";

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { orderPositions, type TrayView } from './safety';
import type { TrayChoice } from './labware';

/**
 * A tray seen from above: rows by columns, pick the positions to use.
 *
 * Typing "A1, A2, ... H12" into a column is where a plate run goes wrong: a skipped well, the same
 * well twice, a position the rack does not have. Picking them on the tray itself cannot produce a
 * position that is not there, and the order they will be visited in is shown on the wells.
 *
 * `multiple` is a column of a spreadsheet (click, drag a rectangle, or click a row or column
 * heading); without it one click picks a position and closes. Blocked positions are drawn and
 * cannot be picked. The grid comes from the edge (safety.ts): nothing here names a position.
 *
 * With `choices` (a wells argument that names its own labware, `plate[A1:H1]`), the plate is
 * chosen here too, and `onPick` says which one. Changing plate starts the picking over.
 */
export interface TrayPickerProps {
  tray: TrayView;
  title?: string;
  multiple?: boolean;
  /** Positions already chosen, e.g. what the column holds now (on `tray`). */
  initial?: string[];
  /** Labware to choose between; `tray` is the one shown first. */
  choices?: TrayChoice[];
  onPick: (positions: string[], choice?: TrayChoice) => void;
  onClose: () => void;
}

export function TrayPicker({ tray: first, title, multiple = false, initial = [], choices, onPick, onClose }: TrayPickerProps) {
  const [choiceName, setChoiceName] = useState(() => choices?.find((c) => c.tray === first)?.name ?? choices?.[0]?.name);
  const choice = choices?.find((c) => c.name === choiceName);
  const tray = choice?.tray ?? first;
  const blocked = useMemo(() => new Set(tray.blocked), [tray]);
  const usable = useMemo(() => tray.grid.flat().filter((p) => !blocked.has(p)), [tray, blocked]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial.filter((p) => usable.includes(p))));
  // A plate on a liquid handler is worked column by column; a tray says which way it runs.
  const [order, setOrder] = useState<'row' | 'column'>(tray.order === 'column' ? 'column' : 'row');
  const choose = (name: string) => {
    setChoiceName(name);
    setPicked(new Set());
    const next = choices?.find((c) => c.name === name)?.tray;
    if (next) setOrder(next.order === 'column' ? 'column' : 'row');
  };
  // A drag paints a rectangle: adding when it started on an empty well, removing otherwise.
  const drag = useRef<{ r: number; c: number; add: boolean; base: Set<string> } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onUp = () => { drag.current = null; };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('mouseup', onUp); };
  }, [onClose]);

  const ordered = useMemo(() => orderPositions(tray, picked, order), [tray, picked, order]);
  const sequence = useMemo(() => new Map(ordered.map((p, i) => [p, i + 1])), [ordered]);

  const paint = (r: number, c: number) => {
    const d = drag.current;
    if (!d) return;
    const next = new Set(d.base);
    for (let i = Math.min(d.r, r); i <= Math.max(d.r, r); i++) {
      for (let j = Math.min(d.c, c); j <= Math.max(d.c, c); j++) {
        const name = tray.grid[i][j];
        if (blocked.has(name)) continue;
        if (d.add) next.add(name); else next.delete(name);
      }
    }
    setPicked(next);
  };

  const toggleMany = (names: string[]) => {
    const free = names.filter((n) => !blocked.has(n));
    const all = free.length > 0 && free.every((n) => picked.has(n));
    const next = new Set(picked);
    free.forEach((n) => (all ? next.delete(n) : next.add(n)));
    setPicked(next);
  };

  // Small wells for big plates: a 384-well plate still fits, names move to the tooltip.
  const size = tray.columns > 24 ? 'h-4 w-4 text-[0px]' : tray.columns > 12 ? 'h-6 w-6 text-[8px]' : 'h-9 w-9 text-[10px]';
  const head = 'select-none text-center font-mono text-[10px] text-gray-400 dark:text-gray-500';
  const numbered = tray.naming === '1' || tray.naming === '0';

  // On <body>, not where it is mounted: a page's content area is its own stacking context
  // (`relative z-0`), so a dialog drawn inside it sat *under* the sidebar, half hidden.
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      data-ivoryos-popover
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-label={title || tray.label} className="flex max-h-[90vh] min-w-[min(30rem,95vw)] max-w-[95vw] flex-col rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#1a1a1a]">
        <header className="flex items-center gap-3 border-b border-gray-200 px-5 py-3 dark:border-white/10">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-bold text-gray-900 dark:text-gray-100">{title || tray.label}</h2>
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              {choices ? '' : `${tray.label} · `}{tray.rows} x {tray.columns}
              {multiple ? ' · click, drag, or click a row or column heading' : ' · click a position'}
            </p>
          </div>
          {choices && choices.length > 0 && (
            <select
              aria-label="Labware"
              value={choiceName}
              onChange={(e) => choose(e.target.value)}
              className="h-8 max-w-[14rem] shrink-0 rounded-lg border border-gray-200 bg-white px-2 font-mono text-xs text-gray-800 focus:border-accent focus:outline-none dark:border-white/10 dark:bg-white/5 dark:text-gray-100"
            >
              {choices.map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
            </select>
          )}
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="overflow-auto px-5 py-4">
          <table className="border-separate border-spacing-1">
            <thead>
              <tr>
                <th />
                {tray.grid[0].map((_, c) => (
                  <th key={c} className={head}>
                    {multiple ? (
                      <button type="button" title="Whole column" onClick={() => toggleMany(tray.grid.map((row) => row[c]))} className="w-full rounded hover:bg-gray-100 dark:hover:bg-white/10">{c + 1}</button>
                    ) : c + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tray.grid.map((row, r) => (
                <tr key={r}>
                  <th className={`${head} pr-1`}>
                    {multiple ? (
                      <button type="button" title="Whole row" onClick={() => toggleMany(row)} className="rounded px-1 hover:bg-gray-100 dark:hover:bg-white/10">{numbered ? r + 1 : row[0].replace(/\d+$/, '')}</button>
                    ) : numbered ? r + 1 : row[0].replace(/\d+$/, '')}
                  </th>
                  {row.map((name, c) => {
                    const isBlocked = blocked.has(name);
                    const on = picked.has(name);
                    return (
                      <td key={name} className="p-0">
                        <button
                          type="button"
                          disabled={isBlocked}
                          aria-pressed={on}
                          title={isBlocked ? `${name} (blocked)` : on && multiple ? `${name}, visited ${sequence.get(name)}` : name}
                          onMouseDown={(e) => {
                            if (!multiple || isBlocked) return;
                            e.preventDefault();
                            drag.current = { r, c, add: !on, base: new Set(picked) };
                            paint(r, c);
                          }}
                          onMouseEnter={() => { if (multiple) paint(r, c); }}
                          onClick={() => { if (!multiple && !isBlocked) { onPick([name], choice); onClose(); } }}
                          className={`${size} flex items-center justify-center rounded-full border font-mono leading-none transition-colors ${
                            isBlocked
                              ? 'cursor-not-allowed border-dashed border-gray-300 text-gray-300 line-through dark:border-white/10 dark:text-gray-600'
                              : on
                                ? 'border-accent bg-accent text-on-accent'
                                : 'border-gray-300 text-gray-500 hover:border-accent hover:bg-accent-soft dark:border-white/20 dark:text-gray-400'
                          }`}
                        >
                          {on && multiple ? sequence.get(name) : name}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {multiple && (
          // `w-0 min-w-full`: the footer fills the dialog but never widens it, so the count and the
          // first/last text changing as wells are picked cannot change the dialog's width. Those
          // two also have room for their longest text, so nothing in the row shifts either.
          <footer className="flex w-0 min-w-full flex-wrap items-center gap-2 border-t border-gray-200 px-5 py-3 text-xs dark:border-white/10">
            <span className="text-gray-500 dark:text-gray-400">Visit</span>
            {(['row', 'column'] as const).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setOrder(o)}
                className={`rounded-md border px-2 py-1 font-medium ${order === o ? 'border-accent-tint bg-accent-soft text-accent-fg' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10'}`}
              >
                {o === 'row' ? 'row by row' : 'column by column'}
              </button>
            ))}
            <button type="button" onClick={() => setPicked(new Set(usable))} className="ml-2 rounded-md px-2 py-1 font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">All</button>
            <button type="button" onClick={() => setPicked(new Set())} className="rounded-md px-2 py-1 font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">Clear</button>
            {/* Kept together, so on a narrow tray they wrap as one, to the right. */}
            <div className="ml-auto flex items-center gap-2">
              <span className="min-w-[8.5rem] text-right tabular-nums text-gray-500 dark:text-gray-400">
                {ordered.length === 0 ? 'Nothing picked' : `${ordered[0]} first, ${ordered[ordered.length - 1]} last`}
              </span>
              <button
                type="button"
                disabled={ordered.length === 0}
                onClick={() => { onPick(ordered, choice); onClose(); }}
                className="min-w-[8.5rem] rounded-lg bg-accent px-3 py-1.5 text-center font-semibold tabular-nums text-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                Use {ordered.length} {ordered.length === 1 ? 'position' : 'positions'}
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
