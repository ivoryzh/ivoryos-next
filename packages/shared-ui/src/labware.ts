/**
 * Labware, as the forms see it: wells picked on a plate, and arguments a batch step is given once
 * per row.
 *
 * The edge owns all of it (edge_server/ivoryos_edge/labware.py). Wells are written as PyLabRobot
 * writes them, as text: `assay_plate[A1:H1]` is PyLabRobot's `assay_plate["A1:H1"]`, one argument
 * naming the labware and its wells together. A driver marks such an argument (`wells` in the
 * schema, with the kinds of labware it takes) and every labware on an instrument's worktable is
 * published among the safety guard's trays as `<instrument>:<labware>`, so the tray picker draws a
 * plate with nothing new to learn. `expandWells` / `compactWells` / `parseReferences` mirror
 * `expand_wells` / `compact_wells` / `parse_references` there: the edge's are the ones a run is
 * checked and executed with, these only fill a picker and mark a typo as it is typed. Change them
 * together.
 */

import type { SafetyView, TrayView } from './safety';

/**
 * A parameter a batch step is handed one value per row for, in one call, instead of the first
 * row's value: wells, or a number per well (`Wells` / `PerWell`).
 */
export const takesRowList = (declared: any): boolean => !!(declared && (declared.wells || declared.per_well));

/** One labware a wells argument can be picked on: its tray key, its name, and its grid. */
export interface TrayChoice {
  name: string;
  label: string;
  tray: TrayView;
}

const isReference = (value: unknown) => typeof value === 'string' && value.trim().startsWith('#');

/** The labware on `instrument`'s worktable a wells argument may name (of these kinds, if any). */
export function wellChoices(
  safety: SafetyView | null | undefined,
  instrument: string,
  categories: string[] = [],
): TrayChoice[] {
  const prefix = `${instrument}:`;
  return Object.entries(safety?.trays || {})
    .filter(([name, tray]) => name.startsWith(prefix) && (!categories.length || !tray.category || categories.includes(tray.category)))
    .map(([name, tray]) => ({ name, label: name.slice(prefix.length), tray }));
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

const REFERENCE = /\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[([^\]]*)\])?\s*[,;]?\s*/y;
const WELL_NAME = /^[A-Za-z]{1,2}[0-9]{1,3}$/;

/** `assay_plate[A1:H1], reservoir[A1]` (or a list) as [{labware, selection}]; null selection = all. */
export function parseReferences(value: unknown): { labware: string; selection: string | null }[] {
  const items = Array.isArray(value) ? value : [value];
  const out: { labware: string; selection: string | null }[] = [];
  for (const item of items) {
    const text = String(item ?? '').trim();
    let at = 0;
    while (at < text.length) {
      REFERENCE.lastIndex = at;
      const m = REFERENCE.exec(text);
      if (!m || REFERENCE.lastIndex === at) throw new Error(`'${text}' is not written as labware[wells], e.g. assay_plate[A1:H1]`);
      out.push({ labware: m[1], selection: m[2] ?? null });
      at = REFERENCE.lastIndex;
    }
  }
  if (!out.length) throw new Error('no wells were given');
  return out;
}

/** Every {labware, well} a value names on these choices, in order. Throws saying what is wrong. */
export function expandReferences(value: unknown, choices: TrayChoice[]): { labware: string; well: string }[] {
  const out: { labware: string; well: string }[] = [];
  for (const { labware, selection } of parseReferences(value)) {
    const choice = choices.find((c) => c.label === labware);
    if (!choice) {
      const hint = WELL_NAME.test(labware) ? ' (write wells with their labware, e.g. assay_plate[A1])' : '';
      throw new Error(`'${labware}' is not on this worktable${hint}`);
    }
    try {
      expandWells(selection ?? 'all', choice.tray.grid).forEach((well) => out.push({ labware, well }));
    } catch (e: any) {
      throw new Error(`${e.message} on ${labware}`);
    }
  }
  return out;
}

/** Positions picked on one labware, as the shortest text that names them: `assay_plate[A1:H3]`. */
export const formatReference = (choice: TrayChoice, positions: string[]) =>
  `${choice.label}[${compactWells(positions, choice.tray.grid)}]`;

/** Why a wells value would be refused, or null. Empty values and '#references' are not judged. */
export function referencesProblem(value: unknown, choices: TrayChoice[]): string | null {
  if (value === undefined || value === null || value === '') return null;
  const listed = Array.isArray(value) ? value : [value];
  if (listed.some(isReference) || !choices.length) return null;
  try {
    expandReferences(value, choices);
    return null;
  } catch (e: any) {
    return e.message;
  }
}

/** How many wells a value names, for a step's one-line summary; null if it cannot be read. */
export function referenceCount(value: unknown, choices: TrayChoice[]): number | null {
  if (value === undefined || value === null || value === '' || !choices.length) return null;
  try {
    return expandReferences(value, choices).length;
  } catch {
    return null;
  }
}

/** Where a picker opens for a value: the labware it names first (else the first choice), and the
 *  positions already picked on it. */
export function referenceStart(values: unknown, choices: TrayChoice[]): { choice: TrayChoice | undefined; positions: string[] } {
  let found: { labware: string; well: string }[] = [];
  const items = (Array.isArray(values) ? values : [values]).filter((v) => v !== undefined && v !== null && String(v).trim() !== '');
  for (const item of items) {
    try { found = found.concat(expandReferences(item, choices)); } catch { /* a typo: skip it */ }
  }
  const choice = choices.find((c) => c.label === found[0]?.labware) ?? choices[0];
  return { choice, positions: choice ? found.filter((f) => f.labware === choice.label).map((f) => f.well) : [] };
}
