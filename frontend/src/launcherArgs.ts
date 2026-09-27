import type { ArgDef } from '@/desktop';

/**
 * An instrument's constructor arguments, between the deck file's shape and a form's.
 *
 * A deck stores `{"backend": {"$object": {import, class, args: {...}}}, "port": "COM3"}`; a form
 * edits `{"backend": {...}, "port": "COM3"}`. Hub-sourced instruments carry the Hub's argument
 * definitions (`hub.init_args`), which is what makes a typed form possible offline -- changing a
 * COM port must not need the network.
 *
 * `fromForm` must agree with `argValue` in the Hub's utils/deck-manifest.ts, which builds the same
 * entry when an instrument is first added: object arguments become `$object` when the definition
 * names a class, numbers and booleans are typed, and an empty field is left out rather than sent
 * as "". If you change one, change the other.
 */

export type FormValues = Record<string, unknown>;

export function toForm(defs: ArgDef[], args: Record<string, unknown> = {}): FormValues {
  const out: FormValues = {};
  for (const def of defs) {
    const v = args[def.name];
    if (def.type === 'object') {
      const inner = v && typeof v === 'object'
        ? ((v as { $object?: { args?: Record<string, unknown> } }).$object?.args ?? (v as Record<string, unknown>))
        : {};
      out[def.name] = toForm(def.args || [], inner as Record<string, unknown>);
    } else if (def.type === 'bool') {
      out[def.name] = v === true;
    } else {
      out[def.name] = v === undefined || v === null ? '' : String(v);
    }
  }
  return out;
}

function valueFor(def: ArgDef, value: unknown): unknown {
  if (def.type === 'object') {
    const inner = value && typeof value === 'object' ? (value as FormValues) : {};
    const args: Record<string, unknown> = {};
    for (const nested of def.args || []) {
      const v = valueFor(nested, inner[nested.name]);
      if (v !== undefined) args[nested.name] = v;
    }
    if (!def.import_path || !def.class_name) return args;
    return { $object: { import: def.import_path, class: def.class_name, args } };
  }
  if (value === undefined || value === null || value === '') return undefined;
  if (def.type === 'int') { const n = Number.parseInt(String(value), 10); return Number.isFinite(n) ? n : String(value); }
  if (def.type === 'float') { const n = Number.parseFloat(String(value)); return Number.isFinite(n) ? n : String(value); }
  if (def.type === 'bool') return value === true || value === 'true' || value === 'True';
  return String(value);
}

export function fromForm(defs: ArgDef[], values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const v = valueFor(def, values[def.name]);
    if (v !== undefined) out[def.name] = v;
  }
  return out;
}

/**
 * A free-form argument typed into a name/value row: a bare number is a number, true/false a bool,
 * `null` null, JSON in braces or brackets that structure, and anything else text -- quote it to
 * force text. The same reading the Designer's extra-arguments rows use.
 */
export function parseLiteral(text: string): unknown {
  const t = text.trim();
  if (t === '') return '';
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (t === 'true' || t === 'True') return true;
  if (t === 'false' || t === 'False') return false;
  if (t === 'null' || t === 'None') return null;
  if (/^["'].*["']$/.test(t)) return t.slice(1, -1);
  if (/^[[{]/.test(t)) { try { return JSON.parse(t); } catch { /* text */ } }
  return text;
}

export function showLiteral(value: unknown): string {
  if (typeof value === 'string') return /^-?\d+(\.\d+)?$|^(true|false|null|True|False|None)$/.test(value.trim()) ? `"${value}"` : value;
  if (value === undefined) return '';
  return JSON.stringify(value);
}
