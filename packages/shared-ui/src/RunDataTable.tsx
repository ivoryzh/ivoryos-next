"use client";

import React from 'react';
import { cellText } from './runRecord';

/**
 * The flattened datasheet: one line per row/trial, inputs then named outputs. Exactly what
 * "Export Data" writes (`datasheetCsv`) -- both read `run.variables` and `row.values`, so they
 * cannot disagree. Used by the edge's Data History and by Cloud's view of synced results.
 */
export function RunDataTable({ run, title = 'data', maxHeight = '420px' }: {
  run: { variables?: string[]; rows?: { row: number; status: string; values?: unknown[] }[] };
  title?: string;
  maxHeight?: string;
}) {
  if (!run.rows?.length || !run.variables?.length) return null;
  const variables = run.variables;
  // The title sits above the card, like every section heading on these pages (`SectionTitle`).
  return (
    <div className="min-w-0">
      {title && <SectionTitle>{title}</SectionTitle>}
    <div className="bg-white dark:bg-black/40 rounded-xl border border-gray-200 dark:border-white/10 shadow-sm min-w-0 overflow-hidden">
      <div className="overflow-auto" style={{ maxHeight }}>
        <table className="w-full text-xs font-mono border-collapse">
          <thead className="sticky top-0 bg-gray-50 dark:bg-[#141414] z-10">
            <tr>
              <th className="px-3 py-1.5 text-right text-[10px] font-bold text-gray-400 border-b border-gray-200 dark:border-white/10 w-10">#</th>
              {variables.map((v) => (
                <th key={v} className="px-3 py-1.5 text-left text-[11px] font-semibold text-gray-500 border-b border-gray-200 dark:border-white/10 whitespace-nowrap">{v}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.rows.map((row) => (
              <tr
                key={row.row}
                title={row.status}
                className={`border-b border-gray-100 dark:border-white/5 ${row.status === 'error' ? 'bg-red-50/60 dark:bg-red-900/10' : 'hover:bg-gray-50 dark:hover:bg-white/[0.02]'}`}
              >
                <td className="px-3 py-1 text-right text-gray-400">{row.row}</td>
                {variables.map((v, i) => (
                  <td key={v} className="px-3 py-1 text-gray-800 dark:text-gray-200 whitespace-nowrap max-w-[16rem] truncate" title={cellText(row.values?.[i])}>
                    {cellText(row.values?.[i])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    </div>
  );
}

/** A section heading: lowercase, above its card. Shared so Data History and Cloud's Results match. */
export function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-1.5">
      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 shrink-0">{children}</h3>
      {aside}
    </div>
  );
}

export default RunDataTable;
