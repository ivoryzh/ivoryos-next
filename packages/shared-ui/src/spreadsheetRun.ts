/**
 * Spreadsheet (per-sample / batch) expansion — the rules that turn a table of rows plus one
 * authored sequence into the flat step list a run actually executes.
 *
 * This was previously inline in the edge Configure page and nowhere else. It moves here because
 * the Cloud orchestrator now dispatches spreadsheet runs too, and a second implementation of the
 * chunking would be the worst possible place for a drifted copy: the two would disagree about how
 * many times real hardware moves. The edge Configure page and Cloud's per-node config both call
 * the functions below, and `SpreadsheetTable` renders its group boundaries from the very same
 * `chunkRowGroups`, so what the table promises and what runs cannot come apart.
 *
 * Two hard rules, both of which have already been broken once each and cost a real bug:
 *
 * 1. **A batch step reads its value from the group's FIRST row, and only the first row.** Not
 *    "whichever row in the group has one". The table mutes every other row in a batch column and
 *    labels it "not used for this row"; a best-effort scan makes that label a lie.
 * 2. **Groups are chunked by plain row POSITION, never by which rows currently hold data.** With
 *    5 rows and batch size 4, row 5 begins batch 2 on a freshly loaded, completely empty table —
 *    grouping that waits for content never appears at all until someone starts typing.
 */

import { RunConfigError, resolveBlockParams } from './runConfig';
import { isFlowControlInstrument } from './flowControl';

export type SpreadsheetRow = Record<string, any>;

/** A row with nothing in it at all is skipped when expanding, but never shifts a group boundary. */
export const isRowActive = (row: SpreadsheetRow) =>
  Object.values(row || {}).some((v) => v !== undefined && v !== null && v !== '');

/**
 * Rows per batch group. A blank/invalid batch size means "one group holding everything", which is
 * the legacy-equivalent behaviour — a batch step then fires exactly once for the whole run.
 */
export const groupSizeFor = (batchSize: string | number | undefined, rowCount: number) =>
  Math.max(1, (typeof batchSize === 'number' ? batchSize : parseInt(String(batchSize ?? ''), 10)) || rowCount || 1);

export interface RowGroup {
  rows: SpreadsheetRow[];
  /** Index of this group's first row in the full table — what "row N" means in every message. */
  start: number;
  /** 1-based group number by raw position, matching the table's "Batch N" label exactly. */
  number: number;
}

/**
 * Chunk rows into batch groups by position. Groups that are blank end to end are dropped (they
 * are trailing unused rows), but the boundaries themselves are never content-dependent — see
 * rule 2 above.
 */
export function chunkRowGroups(rows: SpreadsheetRow[], groupSize: number): RowGroup[] {
  const groups: RowGroup[] = [];
  const size = Math.max(1, groupSize);
  for (let start = 0; start < rows.length; start += size) {
    const slice = rows.slice(start, start + size);
    if (slice.some(isRowActive)) {
      groups.push({ rows: slice, start, number: Math.floor(start / size) + 1 });
    }
  }
  return groups;
}

export interface ExpandedSpreadsheetStep {
  instrument: string;
  method: string;
  params: Record<string, any>;
  /** The table row this call came from (a batch step reports its group's first row). */
  originalRow: number;
  /** Position in the authored sequence, so results can be matched back to the step that made them. */
  originalBlockIndex: number;
  /**
   * What the step's result is bound to. Dropping these was a shipped bug: every call ran, but no
   * output was ever named, so the first later step reading one (`If absorbance > 1.5`) failed with
   * "name 'absorbance' is not defined".
   */
  returnVar?: string;
  returnBindings?: any[];
}

export interface ExpandOptions {
  /** The authored Main sequence, each block optionally flagged `isBatchAction`. */
  sequence: any[];
  rows: SpreadsheetRow[];
  /** The `#name`s that appear as spreadsheet columns. Empty means "run the sequence once as-is". */
  variables: string[];
  batchSize?: string | number;
  /** Names the edge resolves live at run time (`User_Input`) — left as `#name`. */
  liveInputVars?: Set<string>;
}

const CLOSERS: Record<string, string> = { If: 'End_If', While: 'End_While' };

/**
 * The sequence cut into the units the walk repeats: a plain step on its own, or a whole If/While
 * construct (through its matching End_If/End_While, nesting included).
 *
 * A construct has to stay whole. Walked block by block like everything else, a per-sample
 * `If … Comment … End_If` over two rows became `If(r1) If(r2) Comment(r1) Comment(r2) End_If(r1)
 * End_If(r2)`: row 2's If nested inside row 1's, each branch deciding the other row's steps.
 * An unmatched opener is left as a single step; the Designer's validation reports it.
 */
export function sequenceSegments(sequence: any[]): { start: number; end: number }[] {
  const segments: { start: number; end: number }[] = [];
  let i = 0;
  while (i < sequence.length) {
    const block = sequence[i];
    const closer = isFlowControlInstrument(block?.instrument) ? CLOSERS[block?.method] : undefined;
    let end = i;
    if (closer) {
      let depth = 0;
      for (let j = i + 1; j < sequence.length; j++) {
        const s = sequence[j];
        if (!isFlowControlInstrument(s?.instrument)) continue;
        if (s.method === block.method) depth++;
        else if (s.method === closer) {
          if (depth === 0) { end = j; break; }
          depth--;
        }
      }
    }
    segments.push({ start: i, end });
    i = end + 1;
  }
  return segments;
}

const outputsOf = (block: any) => ({
  ...(block?.returnVar ? { returnVar: block.returnVar } : {}),
  ...(block?.returnBindings?.length ? { returnBindings: block.returnBindings } : {}),
});

/**
 * Walk the sequence once per batch group, block-major: a per-sample block expands to one call per
 * active row in that group, a batch block to exactly one call for the group. 24 rows at batch
 * size 4 walks the sequence 6 times over 4 rows each — not once over all 24, and not once per row.
 *
 * An If/While construct is one unit of that walk (see `sequenceSegments`): a per-sample one runs
 * whole for each row in turn, a batch one (flagged on its opening step) runs whole once for the
 * group with the first row's values. The edge scopes variables to the row that produced them
 * (`scoped_context` in queue.py), so row 2's If reads row 2's measurement even though row 3 has
 * been measured since.
 *
 * Throws `RunConfigError` with a message naming the row or group that is missing a value.
 */
export function expandSpreadsheet(opts: ExpandOptions): ExpandedSpreadsheetStep[] {
  const { sequence, rows, variables, batchSize, liveInputVars } = opts;
  const out: ExpandedSpreadsheetStep[] = [];
  const skip = liveInputVars ? (v: string) => liveInputVars.has(v) : undefined;

  if (variables.length === 0) {
    // No spreadsheet columns at all — the sequence runs once, exactly as authored.
    sequence.forEach((block, i) => {
      out.push({
        instrument: block.instrument,
        method: block.method,
        params: JSON.parse(JSON.stringify(block.params || {})),
        originalRow: 0,
        originalBlockIndex: i,
        ...outputsOf(block),
      });
    });
    return out;
  }

  if (!rows.some(isRowActive)) {
    throw new RunConfigError('Fill in at least one row before running.');
  }

  const groups = chunkRowGroups(rows, groupSizeFor(batchSize, rows.length));
  const segments = sequenceSegments(sequence);

  for (const group of groups) {
    const groupDesc = groups.length > 1
      ? `batch ${group.number} (rows ${group.start + 1}-${group.start + group.rows.length})`
      : 'the batch';

    for (const segment of segments) {
      const blocks = sequence.slice(segment.start, segment.end + 1);

      if (sequence[segment.start].isBatchAction) {
        blocks.forEach((block, k) => {
          out.push({
            instrument: block.instrument,
            method: block.method,
            params: resolveBlockParams(block, {
              // Rule 1: strictly the group's first row.
              lookup: (v) => group.rows[0]?.[v],
              describe: (v) =>
                `'${v}' for ${groupDesc} — fill it in on the first row of that group (row ${group.start + 1})`,
              onMissing: 'throw',
              numeric: 'strict',
              skip,
            }),
            originalRow: group.start,
            originalBlockIndex: segment.start + k,
            ...outputsOf(block),
          });
        });
        continue;
      }

      for (let r = 0; r < group.rows.length; r++) {
        const rowData = group.rows[r];
        if (!isRowActive(rowData)) continue; // an unused row inside a group has nothing to run
        const rowIndex = group.start + r;
        blocks.forEach((block, k) => {
          out.push({
            instrument: block.instrument,
            method: block.method,
            params: resolveBlockParams(block, {
              lookup: (v) => rowData[v],
              describe: (v) => `'${v}' in row ${rowIndex + 1}`,
              onMissing: 'throw',
              numeric: 'strict',
              skip,
            }),
            originalRow: rowIndex,
            originalBlockIndex: segment.start + k,
            ...outputsOf(block),
          });
        });
      }
    }
  }

  return out;
}

/**
 * One expanded step, in the shape a run payload carries — with the row it belongs to recorded on
 * it as `_row` (and its position in the authored sequence as `_block`).
 *
 * This is metadata, not an argument: `cast_arguments` in `introspection.py` never forwards a
 * `_`-prefixed key to a driver, the same channel `_phase` and `_return_var` already use.
 *
 * **Why the row has to be recorded rather than re-derived.** Data History used to recover "which
 * steps belong to row i" by slicing the flat step list into equal chunks of `sequence_template.
 * length`. That silently assumes the flattening is row-major, and it is not: within a batch group
 * the walk is block-major (`A(r1) A(r2) A(r3) B(r1) B(r2) B(r3)`, see `expandSpreadsheet` above),
 * so row 1 was shown `A(r1), A(r2), A(r3)` — three steps, two of which carry another row's
 * values. In a lab record, attributing one sample's measurement to a different sample is the
 * worst kind of wrong, because every step still reads "completed".
 *
 * Position cannot be made to work in general either: a batch step contributes one call for a
 * whole group rather than one per row, and a `Library Workflows` step expands on the device into
 * however many steps its body holds. Recording the row is the only thing that survives all three.
 */
export function toSubmittedStep(step: ExpandedSpreadsheetStep) {
  return {
    instrument: step.instrument,
    method: step.method,
    params: { ...step.params, _row: step.originalRow, _block: step.originalBlockIndex },
    ...(step.returnVar ? { returnVar: step.returnVar } : {}),
    ...(step.returnBindings?.length ? { returnBindings: step.returnBindings } : {}),
  };
}

/**
 * The `parameters` blob persisted with a Spreadsheet run.
 *
 * `sequence_template` is what lets Data History name the output columns later: the run otherwise
 * records only the inputs someone typed, with no record of which step produced "the" result — a
 * real shipped bug where a completed run exported a CSV with no result column at all.
 */
export function buildSpreadsheetParameters(opts: {
  variables: string[];
  rows: SpreadsheetRow[];
  sequence: any[];
  /** Recorded so the Queue can draw the run's batches as they were, not infer them. */
  batchSize?: string | number;
}) {
  const { variables, rows, sequence, batchSize } = opts;
  return {
    type: variables.length > 0 ? 'Spreadsheet' : 'Simple',
    variables,
    rows: variables.length > 0 ? rows.filter(isRowActive) : [],
    ...(variables.length > 0 ? { batch_size: groupSizeFor(batchSize, rows.length) } : {}),
    sequence_template: sequence.map((b) => ({
      instrument: b.instrument,
      method: b.method,
      returnVar: b.returnVar || null,
      returnBindings: b.returnBindings || null,
    })),
  };
}
