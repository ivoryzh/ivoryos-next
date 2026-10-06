/**
 * The safety guard, as the forms see it.
 *
 * The edge keeps the limits (edge_server/ivoryos_edge/safety.py) and is the only thing that
 * enforces them: a run is refused before it starts, and every step is checked again as it is sent.
 * What is here only lets a form say so *while a value is being typed*, from the view the edge
 * publishes in `/api/status` (`safety`). Two things are deliberately not re-implemented: a tray's
 * position names come from the edge as a ready-made grid, and rules are not evaluated at all (they
 * read live instruments). A check added to the edge's `check_value` belongs here too, or a form
 * will accept what the run then refuses, but never the other way round.
 */

import { referencesProblem, wellChoices, type TrayChoice } from './labware';

export interface TrayView {
  label: string;
  /** A labware a driver declared (plate, tip_rack, reservoir, ...); absent for a lab's own tray. */
  category?: string;
  rows: number;
  columns: number;
  /** 'A1' | 'A01' | '1' | '0' */
  naming: string;
  order: string;
  blocked: string[];
  /** Position names, as rows of columns, the way the tray looks from above. */
  grid: string[][];
}

export interface FieldGuard {
  min?: number;
  max?: number;
  allowed?: unknown[];
  tray?: string;
  note?: string;
  /** The instrument, or `class:<Name>`, the limit was written for. */
  source?: string;
  /**
   * What the field's numbers are in: chosen with the limit on the Safety page, or declared by
   * the driver itself (`Annotated[float, Unit("°C")]`, which then takes precedence). A label,
   * never a conversion: "0 to 120 °C".
   */
  unit?: string;
  /** Wells written with their labware (`plate[A1:H1]`) on this instrument's worktable (labware.ts). */
  wells?: { instrument: string; labware: string[] };
}

export interface SafetyView {
  enabled: boolean;
  error?: string | null;
  fields: Record<string, Record<string, Record<string, FieldGuard>>>;
  trays: Record<string, TrayView>;
  rules: number;
}

/** Where a `#variable` is used, so its limits can be looked up. */
export interface FieldRef {
  instrument: string;
  method: string;
  param: string;
  /** Set for a wells argument: the kinds of labware it takes (labware.ts). */
  wells?: { labware: string[] };
}

export const fieldGuard = (
  safety: SafetyView | null | undefined,
  instrument: string,
  method: string,
  param: string,
): FieldGuard | undefined => safety?.fields?.[instrument]?.[method]?.[param];

export const trayOf = (safety: SafetyView | null | undefined, guard: FieldGuard | undefined): TrayView | undefined =>
  guard?.tray ? safety?.trays?.[guard.tray] : undefined;

/** Every limit on the fields a variable feeds. A value has to satisfy all of them. */
export const guardsFor = (safety: SafetyView | null | undefined, refs: FieldRef[] | undefined): FieldGuard[] =>
  (refs || []).flatMap((r) => [
    fieldGuard(safety, r.instrument, r.method, r.param),
    r.wells ? { wells: { instrument: r.instrument, labware: r.wells.labware }, source: r.instrument } : undefined,
  ]).filter((g): g is FieldGuard => !!g);

const show = (n: number) => String(Number(n.toPrecision(12)));

/**
 * The unit a field's values are in, for a field or for a `#variable` feeding several: the
 * driver's own declaration (`declared`, from the schema) first, else the one chosen on the Safety
 * page with the field's limit. Several guards naming different units are a disagreement between
 * fields, and the first is shown rather than none.
 */
export function unitOf(guards: FieldGuard | FieldGuard[] | undefined, declared?: string | null): string | undefined {
  if (declared) return String(declared);
  const list = Array.isArray(guards) ? guards : guards ? [guards] : [];
  return list.find((g) => g.unit)?.unit;
}

const positionText = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) ? String(value) : String(value).trim();

const isReference = (value: unknown) => typeof value === 'string' && value.trim().startsWith('#');

/** One line saying what the field takes: "0 to 120", "at most 5", "Vial rack, 4 x 6". */
export function guardHint(guard: FieldGuard | undefined, safety: SafetyView | null | undefined): string {
  if (!guard) return '';
  const parts: string[] = [];
  const unit = guard.unit ? ` ${guard.unit}` : '';
  if (guard.min !== undefined && guard.max !== undefined) parts.push(`${show(guard.min)} to ${show(guard.max)}${unit}`);
  else if (guard.min !== undefined) parts.push(`at least ${show(guard.min)}${unit}`);
  else if (guard.max !== undefined) parts.push(`at most ${show(guard.max)}${unit}`);
  if (guard.allowed) parts.push(`one of ${guard.allowed.map(String).join(', ')}`);
  if (guard.wells) parts.push('wells, written plate[A1:H1]');
  const tray = trayOf(safety, guard);
  if (tray) parts.push(`${tray.label}, ${tray.rows} x ${tray.columns}`);
  return parts.join(' · ');
}

/**
 * Why a value would be refused, or null. Empty values and '#references' are not judged: the first
 * is "not filled in yet", the second is checked by the edge once the run puts a value there.
 */
export function guardProblem(
  guard: FieldGuard | FieldGuard[] | undefined,
  value: unknown,
  safety: SafetyView | null | undefined,
): string | null {
  if (!guard || !safety?.enabled) return null;
  if (Array.isArray(guard)) {
    for (const g of guard) {
      const problem = guardProblem(g, value, safety);
      if (problem) return problem;
    }
    return null;
  }
  if (value === undefined || value === null || value === '' || isReference(value)) return null;
  if (guard.wells) return referencesProblem(value, wellChoices(safety, guard.wells.instrument, guard.wells.labware));
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = guardProblem(guard, item, safety);
      if (problem) return problem;
    }
    return null;
  }
  if (guard.min !== undefined || guard.max !== undefined) {
    const n = typeof value === 'boolean' || String(value).trim() === '' ? NaN : Number(value);
    if (Number.isNaN(n)) return 'is not a number, and this field has a limit';
    const unit = guard.unit ? ` ${guard.unit}` : '';
    if (guard.min !== undefined && n < guard.min) return `is below the minimum of ${show(guard.min)}${unit}`;
    if (guard.max !== undefined && n > guard.max) return `is above the maximum of ${show(guard.max)}${unit}`;
  }
  if (guard.allowed && !guard.allowed.map(String).includes(positionText(value))) {
    return `is not allowed here (allowed: ${guard.allowed.map(String).join(', ')})`;
  }
  const tray = trayOf(safety, guard);
  if (tray) {
    const position = positionText(value);
    if (!tray.grid.some((row) => row.includes(position))) return `is not a position on ${tray.label}`;
    if (tray.blocked.includes(position)) return `is a blocked position on ${tray.label}`;
  }
  return null;
}

/** The values worth offering as the field is typed: a tray's usable positions, or the allowed list. */
export function guardSuggestions(guard: FieldGuard | undefined, safety: SafetyView | null | undefined): string[] {
  if (!guard) return [];
  if (guard.wells) return wellChoices(safety, guard.wells.instrument, guard.wells.labware).map((c) => `${c.label}[`);
  const tray = trayOf(safety, guard);
  if (tray) return tray.grid.flat().filter((p) => !tray.blocked.includes(p));
  return (guard.allowed || []).map(String);
}

/**
 * The first tray among a variable's limits, with its name: what a column's picker opens. For a
 * wells argument, `choices` are the plates it may name, and what is picked is written
 * `plate[A1]` (labware.ts formatReference).
 */
export function trayForGuards(
  guards: FieldGuard[] | undefined,
  safety: SafetyView | null | undefined,
): { name: string; tray: TrayView; choices?: TrayChoice[] } | undefined {
  // A column feeding several wells arguments offers only labware every one of them takes (the
  // plate reader's plates, not the reservoir a transfer could also draw from).
  const wellGuards = (guards || []).filter((g) => g.wells);
  if (wellGuards.length) {
    const choices = wellGuards
      .map((g) => wellChoices(safety, g.wells!.instrument, g.wells!.labware))
      // By labware name: an instrument sharing the worktable publishes the same plates under its own.
      .reduce((kept, next) => kept.filter((c) => next.some((n) => n.label === c.label)));
    if (choices.length) return { name: choices[0].name, tray: choices[0].tray, choices };
  }
  for (const g of guards || []) {
    if (g.wells) continue;
    const tray = trayOf(safety, g);
    if (tray && g.tray) return { name: g.tray, tray };
  }
  return undefined;
}

/** A tray's positions in the order a run would visit them: along rows, or down columns. */
export function orderPositions(tray: TrayView, picked: Iterable<string>, order: 'row' | 'column'): string[] {
  const wanted = new Set(picked);
  const out: string[] = [];
  if (order === 'row') {
    for (const row of tray.grid) for (const name of row) if (wanted.has(name)) out.push(name);
  } else {
    for (let c = 0; c < tray.columns; c++) {
      for (let r = 0; r < tray.rows; r++) {
        const name = tray.grid[r]?.[c];
        if (name !== undefined && wanted.has(name)) out.push(name);
      }
    }
  }
  return out;
}
