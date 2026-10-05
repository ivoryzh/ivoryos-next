/**
 * Labware, as the forms see it: wells picked on a plate, and arguments a batch step is given once
 * per row.
 *
 * The edge owns all of it (edge_server/ivoryos_edge/labware.py). A driver marks an argument as
 * "wells on the labware named by that other argument", the schema carries the mark (`wells`,
 * `per_well`), and every labware on an instrument's worktable is published among the safety
 * guard's trays as `<instrument>:<labware>`, so the tray picker draws a plate with nothing new to
 * learn. `expandWells` / `compactWells` mirror `expand_wells` / `compact_wells` there: the edge's
 * are the ones a run is checked and executed with, these only fill a picker and mark a typo as
 * it is typed. Change them together.
 */

import type { SafetyView, TrayView } from './safety';

/**
 * A parameter a batch step is handed one value per row for, in one call, instead of the first
 * row's value: a well selection, or a number per well (`Wells` / `PerWell`).
 */
export const takesRowList = (declared: any): boolean => !!(declared && (declared.wells || declared.per_well));

export const labwareTrayName = (instrument: string, labware: unknown) => `${instrument}:${labware}`;

const isReference = (value: unknown) => typeof value === 'string' && value.trim().startsWith('#');

/**
 * The plate a wells argument picks on: the labware its sibling argument names, when that is
 * already a name rather than a '#variable'. `params` are the step's own arguments.
 */
export function wellsTray(
  safety: SafetyView | null | undefined,
  instrument: string,
  declared: any,
  params: Record<string, any> | undefined,
  schemaParams?: Record<string, any>,
): { name: string; tray: TrayView } | undefined {
  const on = declared?.wells?.on;
  if (!on) return undefined;
  const labware = params?.[on] ?? schemaParams?.[on]?.default;
  if (labware === undefined || labware === null || labware === '' || isReference(labware)) return undefined;
  const name = labwareTrayName(instrument, labware);
  const tray = safety?.trays?.[name];
  return tray ? { name, tray } : undefined;
}

const indexOf = (grid: string[][]) => {
  const index = new Map<string, [number, number]>();
  grid.forEach((row, r) => row.forEach((name, c) => index.set(name, [r, c])));
  return index;
};

const span = (a: number, b: number) =>
  Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => (a <= b ? a + i : a - i));

/**
 * A selection as the positions it names, in visiting order: "A1:H1" down a column, "A1:A12" along
 * a row, a range whose corners differ in both as the rectangle between them column by column,
 * "all" the whole labware. Throws naming what is not a position.
 */
export function expandWells(selection: unknown, grid: string[][]): string[] {
  const index = indexOf(grid);
  const tokens = Array.isArray(selection)
    ? selection.map((t) => String(t).trim())
    : String(selection ?? '').trim().split(/[,;\s]+/).filter(Boolean);
  const out: string[] = [];
  for (const token of tokens) {
    if (!token) continue;
    if (token.toLowerCase() === 'all' || token === '*') {
      const columns = grid[0]?.length ?? 0;
      for (let c = 0; c < columns; c++) for (let r = 0; r < grid.length; r++) out.push(grid[r][c]);
      continue;
    }
    if (token.includes(':')) {
      const [first, last] = [token.slice(0, token.indexOf(':')).trim(), token.slice(token.indexOf(':') + 1).trim()];
      for (const corner of [first, last]) {
        if (!index.has(corner)) throw new Error(`'${corner}' is not a position`);
      }
      const [r1, c1] = index.get(first)!;
      const [r2, c2] = index.get(last)!;
      for (const c of span(c1, c2)) for (const r of span(r1, r2)) out.push(grid[r][c]);
      continue;
    }
    if (!index.has(token)) throw new Error(`'${token}' is not a position`);
    out.push(token);
  }
  return out;
}

/** The shortest selection that expands back to exactly `positions`, in order. */
export function compactWells(positions: string[], grid: string[][]): string {
  const index = indexOf(grid);
  if (positions.some((p) => !index.has(p))) return positions.join(', ');
  const runs: string[][] = [];
  for (const name of positions) {
    const run = runs[runs.length - 1];
    if (run) {
      const [r0, c0] = index.get(run[0])!;
      const [r1, c1] = index.get(run[run.length - 1])!;
      const [r, c] = index.get(name)!;
      const single = run.length === 1;
      const down = c === c1 && r === r1 + 1 && (single || (c1 === c0 && r1 - r0 === run.length - 1));
      const across = r === r1 && c === c1 + 1 && (single || (r1 === r0 && c1 - c0 === run.length - 1));
      if (down || across) { run.push(name); continue; }
    }
    runs.push([name]);
  }
  // Neighbouring columns covering the same rows are one rectangle ("A1:H12").
  const merged: string[][] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous && previous.length > 1 && run.length > 1) {
      const [pr0] = index.get(previous[0])!;
      const [pr1, pc1] = index.get(previous[1])!;
      const [r0, c0] = index.get(run[0])!;
      const [r1, c1] = index.get(run[run.length - 1])!;
      if (c0 === c1 && r0 === pr0 && r1 === pr1 && c0 === pc1 + 1 && pr1 > pr0) {
        previous[1] = run[run.length - 1];
        continue;
      }
    }
    merged.push(run.length > 1 ? [run[0], run[run.length - 1]] : run);
  }
  return merged.map((run) => (run.length > 1 ? `${run[0]}:${run[1]}` : run[0])).join(', ');
}

/** Why a wells value would be refused on this plate, or null. '#references' are not judged. */
export function wellsProblem(value: unknown, tray: TrayView | undefined): string | null {
  if (!tray || value === undefined || value === null || value === '') return null;
  const listed = Array.isArray(value) ? value : [value];
  if (listed.some(isReference)) return null;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'next') return null;
  try {
    expandWells(value, tray.grid);
    return null;
  } catch (e: any) {
    return `${e.message} on ${tray.label} (${tray.rows} x ${tray.columns})`;
  }
}

/** How many wells a value names on this plate, for a step's one-line summary; null if unknown. */
export function wellCount(value: unknown, tray: TrayView | undefined): number | null {
  if (!tray || value === undefined || value === null || value === '') return null;
  try {
    return expandWells(value, tray.grid).length;
  } catch {
    return null;
  }
}
