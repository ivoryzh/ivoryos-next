"use client";

import React, { useState } from 'react';
import { Plus, Trash2, GripVertical, Layers, Grid3x3 } from 'lucide-react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { groupSizeFor, SpreadsheetRow } from './spreadsheetRun';
import { guardHint, guardProblem, trayForGuards, type FieldGuard, type SafetyView } from './safety';
import { TrayPicker } from './TrayPicker';
import { referenceStart } from './labware';

/**
 * The iteration table: one column per `#variable`, one row per sample.
 *
 * Extracted from the edge Configure page so the Cloud orchestrator can configure a spreadsheet run
 * for one node with the identical grid. Deliberately presentational — it owns no rows, no batch
 * size and no submit. The Cloud panel needs many of these on one screen (one per node) and the
 * edge page needs exactly one filling the viewport, which is a layout difference, not a behaviour
 * one; `compact` is the whole of that difference.
 *
 * The group boundaries drawn here come from `groupSizeFor` in spreadsheetRun.ts — the same
 * function the expansion uses. That is the point of it living there: this table's purple divider,
 * its "Batch N" label and its muted "not used for this row" cells are promises about what will
 * run, and they used to be computed separately from the thing that actually ran.
 */

export interface SpreadsheetTableProps {
  /** Columns, in the order the sequence's params declare them. */
  variables: string[];
  rows: SpreadsheetRow[];
  onRowChange: (rowIndex: number, varName: string, value: string) => void;
  onAddRow?: () => void;
  onRemoveRow?: (rowIndex: number) => void;
  /** Row drag-and-drop. Omit to render a static table (Cloud's per-node panel does). */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  /** Declared type per variable, shown under the header and used for numeric validation. */
  varTypes?: Record<string, string>;
  /** Enumerated choices per variable — renders a select instead of a free-text input. */
  varOptions?: Record<string, any[]>;
  /** Variables belonging to a batch step: only the group's first row is read. */
  batchVariables?: string[];
  /**
   * Columns a batch step takes from every row of its group, in one call (`rowListVariables` in
   * spreadsheetRun.ts: wells, a volume per well). Every row of these is read, so none is muted.
   */
  rowListVariables?: string[];
  /** Rows per batch group. Blank/0 means one group holding every row. */
  batchSize?: string | number;
  /** False hides all batch affordances — there is no batch step in this sequence. */
  showBatchGrouping?: boolean;
  compact?: boolean;
  /** Drag-and-drop ids must be unique per page; Cloud renders several tables at once. */
  idPrefix?: string;
  /**
   * What the edge's safety guard allows for each variable (safety.ts): a cell outside it is marked
   * as it is typed. The edge still refuses the run; this only says so earlier.
   */
  varGuards?: Record<string, FieldGuard[]>;
  safety?: SafetyView | null;
  /**
   * A variable that is a position on a tray gets a picker in its heading; the positions picked
   * there, in visiting order, replace the column. Omit to leave the column typed by hand.
   */
  onFillColumn?: (varName: string, values: string[]) => void;
}

const isInvalidNumericCell = (type: string | undefined, val: any) => {
  const hint = String(type || '').toLowerCase();
  if (!hint.includes('int') && !hint.includes('float')) return false;
  if (val === undefined || val === null || val === '') return false;
  return isNaN(Number(val));
};

export function SpreadsheetTable({
  variables,
  rows,
  onRowChange,
  onAddRow,
  onRemoveRow,
  onReorder,
  varTypes = {},
  varOptions = {},
  batchVariables = [],
  rowListVariables = [],
  batchSize,
  showBatchGrouping = false,
  compact = false,
  idPrefix = 'spreadsheet',
  varGuards = {},
  safety,
  onFillColumn,
}: SpreadsheetTableProps) {
  // Which tray column's picker is open.
  const [picking, setPicking] = useState<string | null>(null);
  const trays = Object.fromEntries(variables.map((v) => [v, trayForGuards(varGuards[v], safety)]));
  // The same position on two rows is usually a slip (the same vial filled twice), sometimes meant.
  // Said, not refused.
  const repeats = (v: string, idx: number): number[] => {
    const value = String(rows[idx]?.[v] ?? '').trim();
    if (!trays[v] || !value) return [];
    return rows.flatMap((r, i) => (i !== idx && String(r?.[v] ?? '').trim() === value ? [i + 1] : []));
  };
  const groupSize = groupSizeFor(batchSize);
  const showGroups = showBatchGrouping && groupSize > 1 && rows.length > groupSize;
  const cellPad = compact ? 'p-1.5' : 'p-2';
  const headPad = compact ? 'p-2' : 'p-3';

  const renderCell = (row: SpreadsheetRow, idx: number, v: string) => {
    const isBatchVar = batchVariables.includes(v) && !rowListVariables.includes(v);
    // Rule 1 made visible: for a batch column only the group's first row is ever read.
    const isDesignatedRow = !isBatchVar || idx % groupSize === 0;
    const invalid = isInvalidNumericCell(varTypes[v], row[v]);
    // Only a value that will be read is judged: a batch column's other rows are ignored anyway.
    const refused = isDesignatedRow ? guardProblem(varGuards[v], row[v], safety) : null;
    const repeated = isDesignatedRow && !refused ? repeats(v, idx) : [];

    if (varOptions[v]) {
      return (
        <select
          value={row[v] || ''}
          onChange={(e) => onRowChange(idx, v, e.target.value)}
          title={refused ? `${row[v]} ${refused}` : undefined}
          className={`w-full cursor-pointer border-b bg-transparent px-2 py-1 text-sm outline-none transition-colors ${
            refused
              ? 'border-red-400 bg-red-50 dark:border-red-500/60 dark:bg-red-900/20'
              : 'border-transparent hover:border-gray-300 focus:border-accent dark:hover:border-white/20'
          }`}
        >
          <option value="" disabled>Select {v}</option>
          {varOptions[v].map((opt) => (
            <option key={String(opt)} value={String(opt)}>{String(opt)}</option>
          ))}
        </select>
      );
    }

    return (
      <input
        type="text"
        value={row[v] || ''}
        onChange={(e) => onRowChange(idx, v, e.target.value)}
        placeholder={isDesignatedRow ? `Enter ${v}...` : 'not used for this row'}
        title={
          refused
            ? `${row[v]} ${refused}`
            : invalid
            ? `Expects a number (${varTypes[v]})`
            : repeated.length
              ? `Also on row ${repeated.join(', ')}`
            : isDesignatedRow
              ? undefined
              : "Only needed once per batch group — this row's value (if any) is ignored."
        }
        className={`w-full border-b px-2 py-1 text-sm outline-none transition-colors ${
          refused
            ? 'border-red-400 bg-red-50 dark:border-red-500/60 dark:bg-red-900/20'
            : invalid || repeated.length
            ? 'border-amber-400 bg-amber-50 dark:border-amber-500/50 dark:bg-amber-900/20'
            : isDesignatedRow
              ? 'border-transparent bg-transparent hover:border-gray-300 focus:border-accent dark:hover:border-white/20'
              : 'border-transparent bg-gray-50 italic text-gray-400 placeholder:text-gray-300 hover:border-gray-200 focus:border-gray-300 dark:bg-white/[0.03] dark:text-gray-600 dark:placeholder:text-gray-600'
        }`}
      />
    );
  };

  const header = (
    <thead>
      <tr className="border-b border-gray-200 bg-gray-50 text-xs font-semibold tracking-wider text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400">
        <th className={`${headPad} w-16 text-center`}>Row</th>
        {variables.map((v) => (
          <th key={v} className={`${headPad} border-l border-gray-200 dark:border-white/10`}>
            <div className="flex flex-col">
              <div className="flex items-center gap-1">
                <span>{v}</span>
                {rowListVariables.includes(v) && (
                  <span
                    title="A batch step takes this from every row of its group and acts on all of them in one call"
                    className="inline-flex items-center gap-0.5 rounded bg-purple-50 px-1 py-0.5 text-[9px] font-bold normal-case text-purple-600 dark:bg-purple-500/10 dark:text-purple-400"
                  >
                    <Layers className="h-2.5 w-2.5" /> each row · 1 call/batch
                  </span>
                )}
                {batchVariables.includes(v) && !rowListVariables.includes(v) && (
                  <span
                    title="Batch step value — only needs to be filled in on one row per batch group"
                    className="inline-flex items-center gap-0.5 rounded bg-purple-50 px-1 py-0.5 text-[9px] font-bold normal-case text-purple-600 dark:bg-purple-500/10 dark:text-purple-400"
                  >
                    <Layers className="h-2.5 w-2.5" /> 1/batch
                  </span>
                )}
              </div>
              {varTypes[v] && (
                <span className="text-[10px] font-normal normal-case text-gray-400 dark:text-gray-500">
                  {varTypes[v]}
                </span>
              )}
              {(varGuards[v] || []).length > 0 && (
                <span className="flex items-center gap-1.5 text-[10px] font-normal normal-case text-gray-500 dark:text-gray-400">
                  {/* One line per distinct limit: a column feeding three steps on one plate says so once. */}
                  <span title="What the safety guard allows here">{Array.from(new Set((varGuards[v] || []).map((g) => guardHint(g, safety)).filter(Boolean))).join(' · ')}</span>
                  {trays[v] && onFillColumn && (
                    <button
                      type="button"
                      onClick={() => setPicking(v)}
                      title={trays[v]!.choices ? 'Pick a plate and its wells: one row per well' : `Pick positions on ${trays[v]!.tray.label}: one row per position`}
                      className="inline-flex items-center gap-1 rounded border border-accent-tint bg-accent-soft px-1.5 py-0.5 font-semibold text-accent-fg hover:bg-accent hover:text-on-accent"
                    >
                      <Grid3x3 className="h-3 w-3" /> Pick
                    </button>
                  )}
                </span>
              )}
            </div>
          </th>
        ))}
        {onRemoveRow && (
          <th className={`${headPad} w-20 border-l border-gray-200 text-center dark:border-white/10`}>Action</th>
        )}
      </tr>
    </thead>
  );

  const rowCells = (row: SpreadsheetRow, idx: number, dragHandle?: React.ReactNode) => {
    const isGroupStart = showGroups && idx > 0 && idx % groupSize === 0;
    const groupNumber = isGroupStart ? Math.floor(idx / groupSize) + 1 : null;
    return {
      isGroupStart,
      cells: (
        <>
          <td className={`${cellPad} border-l border-gray-100 dark:border-white/5`}>
            <div className="flex items-center justify-center space-x-2 text-gray-400">
              {dragHandle}
              <div className="flex flex-col items-center leading-none">
                <span className="text-sm font-medium">{idx + 1}</span>
                {groupNumber && (
                  <span className="mt-0.5 text-[8px] font-bold uppercase tracking-wider text-purple-600 dark:text-purple-400">
                    Batch {groupNumber}
                  </span>
                )}
              </div>
            </div>
          </td>
          {variables.map((v) => (
            <td key={v} className={`${cellPad} border-l border-gray-100 dark:border-white/5`}>
              {renderCell(row, idx, v)}
            </td>
          ))}
          {onRemoveRow && (
            <td className={`${cellPad} border-l border-gray-100 text-center dark:border-white/5`}>
              <button
                onClick={() => onRemoveRow(idx)}
                disabled={rows.length === 1}
                aria-label={`Remove row ${idx + 1}`}
                className="text-gray-400 hover:text-red-500 disabled:opacity-50"
              >
                <Trash2 className="mx-auto h-4 w-4" />
              </button>
            </td>
          )}
        </>
      ),
    };
  };

  const rowClass = (isGroupStart: boolean) =>
    `border-b border-gray-100 bg-white hover:bg-gray-50 dark:border-white/5 dark:bg-transparent dark:hover:bg-white/[0.02] ${
      isGroupStart ? 'border-t-2 border-t-purple-300 dark:border-t-purple-700/60' : ''
    }`;

  const staticBody = (
    <tbody>
      {rows.map((row, idx) => {
        const { isGroupStart, cells } = rowCells(row, idx);
        return <tr key={`${idPrefix}-row-${idx}`} className={rowClass(isGroupStart)}>{cells}</tr>;
      })}
    </tbody>
  );

  const draggableBody = (
    <DragDropContext
      onDragEnd={(result: DropResult) => {
        if (!result.destination || !onReorder) return;
        onReorder(result.source.index, result.destination.index);
      }}
    >
      <Droppable droppableId={`${idPrefix}-rows`}>
        {(provided) => (
          <tbody {...provided.droppableProps} ref={provided.innerRef}>
            {rows.map((row, idx) => (
              <Draggable key={`${idPrefix}-row-${idx}`} draggableId={`${idPrefix}-row-${idx}`} index={idx}>
                {(dragProvided) => {
                  const { isGroupStart, cells } = rowCells(
                    row,
                    idx,
                    <span
                      {...dragProvided.dragHandleProps}
                      className="cursor-grab hover:text-gray-600 dark:hover:text-gray-200"
                    >
                      <GripVertical className="h-4 w-4" />
                    </span>,
                  );
                  return (
                    <tr ref={dragProvided.innerRef} {...dragProvided.draggableProps} className={rowClass(isGroupStart)}>
                      {cells}
                    </tr>
                  );
                }}
              </Draggable>
            ))}
            {provided.placeholder}
          </tbody>
        )}
      </Droppable>
    </DragDropContext>
  );

  // Compact sits flush in its host's card (Cloud's run panel), edge to edge, rather than as a
  // rounded box inside a box; the full-size page keeps its own framed table.
  return (
    <div className={compact
      ? 'overflow-hidden border-b border-gray-200 dark:border-white/10'
      : 'overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-black/40 dark:shadow-none'}>
      <table className="w-full border-collapse text-left">
        {header}
        {onReorder ? draggableBody : staticBody}
      </table>
      {picking && trays[picking] && onFillColumn && (() => {
        const found = trays[picking]!;
        const cells = rows.map((r) => String(r?.[picking] ?? '').trim()).filter(Boolean);
        // A wells column holds `plate[A1]` per row (labware.ts): the picker chooses the plate too.
        const start = found.choices ? referenceStart(cells, found.choices) : null;
        return (
          <TrayPicker
            tray={start?.choice?.tray ?? found.tray}
            choices={found.choices}
            title={`${picking}: one row per ${found.choices ? 'well' : 'position'}`}
            multiple
            initial={start ? start.positions : cells}
            onPick={(positions, choice) => onFillColumn(picking, choice && found.choices
              ? positions.map((position) => `${choice.label}[${position}]`)
              : positions)}
            onClose={() => setPicking(null)}
          />
        );
      })()}
      {onAddRow && (
        <div className={compact
          ? 'border-t border-gray-100 px-2 py-1.5 dark:border-white/5'
          : 'border-t border-gray-200 bg-gray-50 p-3 dark:border-white/10 dark:bg-white/5'}>
          <button
            onClick={onAddRow}
            className="flex items-center space-x-2 px-2 py-1 text-sm font-medium text-accent-fg hover:text-accent"
          >
            <Plus className="h-4 w-4" />
            <span>Add Row</span>
          </button>
        </div>
      )}
    </div>
  );
}
