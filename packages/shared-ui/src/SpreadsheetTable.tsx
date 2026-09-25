"use client";

import React from 'react';
import { Plus, Trash2, GripVertical, Layers } from 'lucide-react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { groupSizeFor, SpreadsheetRow } from './spreadsheetRun';

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
 * function the expansion uses. That is the point of it living there: this table's teal divider,
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
  /** Rows per batch group. Blank/0 means one group holding every row. */
  batchSize?: string | number;
  /** False hides all batch affordances — there is no batch step in this sequence. */
  showBatchGrouping?: boolean;
  compact?: boolean;
  /** Drag-and-drop ids must be unique per page; Cloud renders several tables at once. */
  idPrefix?: string;
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
  batchSize,
  showBatchGrouping = false,
  compact = false,
  idPrefix = 'spreadsheet',
}: SpreadsheetTableProps) {
  const groupSize = groupSizeFor(batchSize);
  const showGroups = showBatchGrouping && groupSize > 1 && rows.length > groupSize;
  const cellPad = compact ? 'p-1.5' : 'p-2';
  const headPad = compact ? 'p-2' : 'p-3';

  const renderCell = (row: SpreadsheetRow, idx: number, v: string) => {
    const isBatchVar = batchVariables.includes(v);
    // Rule 1 made visible: for a batch column only the group's first row is ever read.
    const isDesignatedRow = !isBatchVar || idx % groupSize === 0;
    const invalid = isInvalidNumericCell(varTypes[v], row[v]);

    if (varOptions[v]) {
      return (
        <select
          value={row[v] || ''}
          onChange={(e) => onRowChange(idx, v, e.target.value)}
          className="w-full cursor-pointer border-b border-transparent bg-transparent px-2 py-1 text-sm outline-none transition-colors hover:border-gray-300 focus:border-indigo-500 dark:hover:border-white/20 dark:focus:border-indigo-500"
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
          invalid
            ? `Expects a number (${varTypes[v]})`
            : isDesignatedRow
              ? undefined
              : "Only needed once per batch group — this row's value (if any) is ignored."
        }
        className={`w-full border-b px-2 py-1 text-sm outline-none transition-colors ${
          invalid
            ? 'border-amber-400 bg-amber-50 dark:border-amber-500/50 dark:bg-amber-900/20'
            : isDesignatedRow
              ? 'border-transparent bg-transparent hover:border-gray-300 focus:border-indigo-500 dark:hover:border-white/20 dark:focus:border-indigo-500'
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
                {batchVariables.includes(v) && (
                  <span
                    title="Batch step value — only needs to be filled in on one row per batch group"
                    className="inline-flex items-center gap-0.5 rounded bg-teal-50 px-1 py-0.5 text-[9px] font-bold normal-case text-teal-600 dark:bg-teal-500/10 dark:text-teal-400"
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
                  <span className="mt-0.5 text-[8px] font-bold uppercase tracking-wider text-teal-600 dark:text-teal-400">
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
      isGroupStart ? 'border-t-2 border-t-teal-300 dark:border-t-teal-700/60' : ''
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

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-black/40 dark:shadow-none">
      <table className="w-full border-collapse text-left">
        {header}
        {onReorder ? draggableBody : staticBody}
      </table>
      {onAddRow && (
        <div className="border-t border-gray-200 bg-gray-50 p-3 dark:border-white/10 dark:bg-white/5">
          <button
            onClick={onAddRow}
            className="flex items-center space-x-2 px-2 py-1 text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            <Plus className="h-4 w-4" />
            <span>Add Row</span>
          </button>
        </div>
      )}
    </div>
  );
}
