/**
 * The safety configuration as the Safety page edits it (edge: ivoryos_edge/safety.py, which is the
 * authority on what is valid). The page keeps a draft, has the edge check it as it changes
 * (`POST /api/safety/check`), and saves it whole.
 */
import type { SafetyView } from '@ivoryos/shared-ui';

export type Limit = {
  target: string;
  method: string;
  param: string;
  min?: number | string;
  max?: number | string;
  allowed?: unknown[];
  tray?: string;
  note?: string;
  /** What the field's numbers are in, chosen here. A label (no conversion); a unit alone is a limit. */
  unit?: string;
};

/**
 * The units offered on a limit row, grouped the way a lab thinks of them. Anything else is
 * typed in under "other" and kept as written: a unit is a label, so no list has to be complete.
 */
export const UNIT_GROUPS: { label: string; units: string[] }[] = [
  { label: 'Volume', units: ['µL', 'mL', 'L'] },
  { label: 'Mass', units: ['mg', 'g', 'kg'] },
  { label: 'Temperature', units: ['°C', 'K'] },
  { label: 'Speed', units: ['rpm'] },
  { label: 'Length', units: ['nm', 'µm', 'mm', 'cm'] },
  { label: 'Flow rate', units: ['µL/s', 'mL/min', 'L/min'] },
  { label: 'Time', units: ['s', 'min', 'h'] },
  { label: 'Percent', units: ['%'] },
];

export const KNOWN_UNITS = new Set(UNIT_GROUPS.flatMap((g) => g.units));

export type Tray = {
  label: string;
  rows: number | string;
  columns: number | string;
  naming: string;
  order: string;
  blocked: string[];
  /** What it holds, and who keeps the numbers (edge: contents.py). Absent: not tracked. */
  contents?: TrayContents;
};

export const VOLUME_UNITS = ['µL', 'mL', 'L'];

/**
 * A tray's contents: vessels with a capacity, or a stock (a source, never drawn dry or overfilled
 * here). Kept by this edge (a record the transfers change and a person can set), or by the deck's
 * own code, read in place from `read.from` (an instrument, then attributes or keys).
 */
export type TrayContents = {
  role: 'vessels' | 'stock';
  kept_by: 'ivoryos' | 'deck';
  unit: string;
  capacity?: number | string;
  /** What a position nobody has recorded holds: an empty vessel (a rack of vials), or nothing (a reactor slot). */
  empty?: 'vessel' | 'nothing';
  /** Refuse drawing more than a vessel holds. Off by default: it draws air, and a vial filled by hand is in no record. */
  check_draws?: boolean;
  /** A stock this edge keeps: which reagent each position holds. */
  liquids?: Record<string, string>;
  /** Other names calls use for this tray ('easymax' for the reactor). */
  aliases?: string[];
  read?: { from: string; volume?: string; capacity?: string; liquids?: string; liquid?: string };
};

export type SideSpec = { tray: Operand; position?: Operand };

/**
 * What one call moves: an amount (an argument and its unit) from a tray and position to another,
 * or a whole vessel, which takes its contents and capacity along. Declared once per method, like a
 * state's set_by: nothing in a signature says a method moves liquid.
 */
export type Transfer = {
  id: string;
  name: string;
  enabled: boolean;
  when: { target: string; method: string };
  moves: 'liquid' | 'vessel';
  amount?: Operand;
  unit?: string;
  from?: SideSpec;
  to?: SideSpec;
  if: Clause[];
};

/** One position as it stands now (GET /api/safety/contents). */
export type PositionNow = {
  vacant?: boolean;
  volume?: number;
  capacity?: number;
  liquids?: Record<string, number>;
  unknown?: string;
  /** A stock's reagent. */
  liquid?: string;
  /** Where the vessel here came from, when it is not its own place ("Extraction vials A1"). */
  from?: string;
  ts?: number;
  by?: string;
};

export type TrayNow = {
  role: 'vessels' | 'stock';
  kept_by: 'ivoryos' | 'deck';
  unit: string;
  capacity?: number;
  read?: TrayContents['read'];
  label: string;
  grid: string[][];
  positions: Record<string, PositionNow>;
};

export type Operand = { arg?: string; read?: string; path?: string; last?: string; state?: string; value?: unknown };
export type Clause = { left: Operand; op: string; right: Operand };
export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  when: { target: string; method: string };
  if: Clause[];
  require: Clause[];
  message: string;
};

/** One call that changes a state: to a fixed value, one of its arguments, or a field of its result. */
export type StateEffect = {
  target: string;
  method: string;
  value: unknown | { arg: string } | { result: string };
  if?: Clause[];
};

/**
 * A condition of the deck in the lab's own words ("Balance door": open / closed). It is either
 * asked of an instrument each time (`read`) or changed by the calls listed in `set_by`.
 */
export type StateSpec = {
  label: string;
  values: string[];
  read?: { read: string; path?: string; map?: Record<string, unknown> };
  set_by: StateEffect[];
};

/** A state as it stands now (GET /api/safety/state). */
export type StateNow = { source: 'reading' | 'tracked'; value?: unknown; unknown?: string; ts?: number; by?: string };

export type SafetyConfig = {
  format: string;
  enabled: boolean;
  trays: Record<string, Tray>;
  states: Record<string, StateSpec>;
  limits: Limit[];
  rules: Rule[];
  transfers: Transfer[];
};

export type Problem = { level: 'error' | 'warning'; where: string; message: string };

export type Blocked = {
  ts: number;
  instrument: string;
  method: string;
  source: string;
  args: Record<string, unknown>;
  problems: string[];
};

export type SafetyInfo = {
  config: SafetyConfig;
  problems: Problem[];
  resolved: SafetyView;
  load_error: string | null;
  path: string;
  /** Each instrument's class and its bases, most derived first. */
  classes: Record<string, string[]>;
  blocked: Blocked[];
  /** States this deck's method names imply (open_door beside close_door), ready to add. */
  suggested_states?: { name: string; state: StateSpec }[];
  /** Transfers this deck's signatures imply (a volume, a source and a destination), ready to add. */
  suggested_transfers?: Transfer[];
};

export type Schema = Record<string, Record<string, any>>;

export const CLASS_PREFIX = 'class:';

export const emptyConfig = (): SafetyConfig => ({
  format: 'ivoryos-safety/1', enabled: true, trays: {}, states: {}, limits: [], rules: [], transfers: [],
});

/** A method's fields, nested objects opened out to dotted paths: what a limit can be set on. */
export function leafParams(methodSchema: any): { path: string; info: any }[] {
  const out: { path: string; info: any }[] = [];
  const walk = (fields: Record<string, any> | undefined, prefix: string) => {
    for (const [name, info] of Object.entries(fields || {})) {
      if (info?.is_object && info?.fields) walk(info.fields, `${prefix}${name}.`);
      else out.push({ path: `${prefix}${name}`, info });
    }
  };
  walk(methodSchema?.parameters, '');
  return out;
}

export const isNumeric = (info: any) => {
  const type = String(info?.type || '').toLowerCase();
  return !!info?.numeric || type.includes('int') || type.includes('float');
};

/** `flow_rate_(setter)` reads better as "flow rate (set)". */
export const methodLabel = (method: string) =>
  method.endsWith('_(setter)') ? `${method.slice(0, -'_(setter)'.length).replace(/_/g, ' ')} (set)` : method.replace(/_/g, ' ');

export const targetLabel = (target: string) =>
  target === '*' ? 'any instrument'
    : target.startsWith(CLASS_PREFIX) ? `every ${target.slice(CLASS_PREFIX.length)}`
      : target.replace(/_/g, ' ');

/** The limit in force for one field of one instrument: its own, else its class's. */
export function limitFor(config: SafetyConfig, classes: string[], instrument: string, method: string, param: string): Limit | undefined {
  const same = (l: Limit) => l.method === method && l.param === param;
  const own = config.limits.find((l) => l.target === instrument && same(l));
  if (own) return own;
  for (const cls of classes) {
    const shared = config.limits.find((l) => l.target === `${CLASS_PREFIX}${cls}` && same(l));
    if (shared) return shared;
  }
  return undefined;
}

// What makes a limit worth keeping. A unit on its own counts: "this field is in µL" is a fact
// about the bench even with no bounds on it.
const CONSTRAINTS = ['min', 'max', 'allowed', 'tray', 'unit'] as const;

const isBlank = (value: unknown) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

/** Change one field's limit. A limit left with nothing to enforce is removed. */
export function patchLimit(
  config: SafetyConfig, classes: string[], instrument: string, method: string, param: string, patch: Partial<Limit>,
): SafetyConfig {
  const current = limitFor(config, classes, instrument, method, param);
  const next: Limit = { ...(current || { target: instrument, method, param }), ...patch };
  for (const key of [...CONSTRAINTS, 'note'] as const) if (isBlank(next[key])) delete next[key];
  const kept = CONSTRAINTS.some((key) => key in next);
  const limits = config.limits.filter((l) => l !== current);
  if (kept) {
    // Moving a limit onto a target that already has one for this field replaces that one.
    const clash = limits.findIndex((l) => l.target === next.target && l.method === method && l.param === param);
    if (clash >= 0) limits.splice(clash, 1);
    limits.push(next);
  }
  return { ...config, limits };
}

/** Whether a limit names something on this deck. One that does not is listed apart, to be removed. */
export function limitIsLive(limit: Limit, schema: Schema, classes: Record<string, string[]>): boolean {
  return Object.keys(schema).some((instrument) => {
    const matches = limit.target === instrument
      || (limit.target.startsWith(CLASS_PREFIX) && (classes[instrument] || []).includes(limit.target.slice(CLASS_PREFIX.length)));
    const method = schema[instrument]?.[limit.method];
    return matches && !!method && (method.accepts_kwargs || leafParams(method).some((p) => p.path === limit.param));
  });
}

const READING_PREFIXES = ['read', 'get', 'is_', 'has_', 'check', 'query'];

/**
 * What a rule can read: `readings` are property getters and methods named like a reading;
 * `called` are the other methods that need no arguments and return something. A rule *calls* what
 * it reads every time it is checked, so a method such as `pump.prime` is kept apart and labelled:
 * picking it would prime the pump before every dispense. The edge warns about the same ones
 * (safety.py looks_like_reading), with the same prefixes.
 */
export function readings(schema: Schema): { readings: string[]; called: string[] } {
  const out = { readings: [] as string[], called: [] as string[] };
  for (const [instrument, methods] of Object.entries(schema)) {
    for (const [name, entry] of Object.entries(methods || {})) {
      if (entry?.property_access === 'set') continue;
      const needsArgs = Object.values(entry?.parameters || {}).some((p: any) => p?.required && !('default' in p));
      const returnsNothing = ['None', 'NoneType'].includes(String(entry?.return_type ?? ''));
      if (needsArgs || returnsNothing) continue;
      const reading = entry?.property_access === 'get' || READING_PREFIXES.some((p) => name.toLowerCase().startsWith(p));
      (reading ? out.readings : out.called).push(`${instrument}.${name}`);
    }
  }
  return out;
}

export const slug = (text: string) =>
  text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'tray';

export const inputClass =
  'bg-gray-50 dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-accent';
export const cardClass =
  'rounded-2xl bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 shadow-sm dark:shadow-none';
export const ghostButton =
  'rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10';
