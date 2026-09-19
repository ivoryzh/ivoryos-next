"use client";

import React, { useState } from 'react';

/**
 * A structured driver result, rendered to be read rather than parsed.
 *
 * Methods increasingly return dataclasses and Pydantic models, and dumping those as
 * `JSON.stringify(v, null, 1)` puts braces, quotes and trailing commas in front of the person
 * trying to answer "what was the yield?". The information is all there and none of it is
 * legible — worse in the Instruments log, where results are stacked one above another and the
 * punctuation is most of what you see.
 *
 * So: keys become labels, unit suffixes move out of the name and next to the number where they
 * read as units, and nesting becomes indentation instead of braces. The raw JSON stays one click
 * away, because "what exactly did the driver send" is a real question too — just not the common
 * one.
 */

// Only suffixes that are unambiguous in this domain. `_m` (metres? molar?) and `_mm`
// (millimetres? millimolar?) are deliberately absent: guessing wrong puts a false unit next to a
// number, which is worse than leaving the suffix in the label where it is at least honest.
// Longest first, so `_ml_per_min` is not eaten by `_min`, and `_celsius` not by `_c`.
const UNIT_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ['_ml_per_min', 'mL/min'],
  ['_ml_min', 'mL/min'],
  ['_deg_c', '°C'],
  ['_celsius', '°C'],
  ['_seconds', 's'],
  ['_minutes', 'min'],
  ['_percent', '%'],
  ['_hours', 'h'],
  ['_pct', '%'],
  ['_rpm', 'rpm'],
  ['_sec', 's'],
  ['_min', 'min'],
  ['_ml', 'mL'],
  ['_ul', 'µL'],
  ['_mg', 'mg'],
  ['_kg', 'kg'],
  ['_nm', 'nm'],
  ['_cm', 'cm'],
  ['_hr', 'h'],
  ['_g', 'g'],
  ['_c', '°C'],
];

/** Split a key into the label people read and the unit that belongs beside the value. */
export function labelAndUnit(key: string): { label: string; unit: string } {
  const lower = key.toLowerCase();
  for (const [suffix, unit] of UNIT_SUFFIXES) {
    // Never strip a key down to nothing: a field literally called "min" is a name, not a unit.
    if (lower.endsWith(suffix) && lower.length > suffix.length) {
      return { label: humanize(key.slice(0, key.length - suffix.length)), unit };
    }
  }
  return { label: humanize(key), unit: '' };
}

/** "substrate_remaining_percent" -> "Substrate remaining". Sentence case, not Title Case: a row
 *  of Capitalised Words reads like a headline and is harder to scan than a phrase. */
function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** Floats out of a simulation arrive as 0.30000000000000004; nobody needs those digits. */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  const rounded = Number(n.toPrecision(6));
  return String(rounded);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function Scalar({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-gray-400 dark:text-gray-600">—</span>;
  }
  if (typeof value === 'boolean') {
    return <span className={value ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}>{value ? 'yes' : 'no'}</span>;
  }
  if (typeof value === 'number') {
    return <span className="font-mono tabular-nums">{formatNumber(value)}</span>;
  }
  return <span>{String(value)}</span>;
}

function Rows({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  return (
    <div className={depth > 0 ? 'pl-3 border-l border-gray-200 dark:border-white/10 space-y-0.5' : 'space-y-0.5'}>
      {Object.entries(value).map(([key, v]) => {
        const { label, unit } = labelAndUnit(key);

        if (isPlainObject(v)) {
          return (
            <div key={key} className="pt-0.5">
              <div className="text-[10px] uppercase tracking-wider font-bold text-gray-400 dark:text-gray-500">{label}</div>
              <Rows value={v} depth={depth + 1} />
            </div>
          );
        }

        if (Array.isArray(v)) {
          // A list of scalars reads as a list; a list of objects needs its own indexed blocks or
          // the fields of item 1 and item 2 run together into one undifferentiated column.
          const allScalar = v.every(item => !isPlainObject(item) && !Array.isArray(item));
          return (
            <div key={key} className="pt-0.5">
              <div className="text-[10px] uppercase tracking-wider font-bold text-gray-400 dark:text-gray-500">
                {label}{v.length > 0 && <span className="normal-case font-normal"> ({v.length})</span>}
              </div>
              {v.length === 0 ? (
                <span className="text-gray-400 dark:text-gray-600">empty</span>
              ) : allScalar ? (
                <div className="font-mono">{v.map(item => (typeof item === 'number' ? formatNumber(item) : String(item))).join(', ')}{unit && ` ${unit}`}</div>
              ) : (
                <div className="pl-3 border-l border-gray-200 dark:border-white/10 space-y-1">
                  {v.map((item, i) => (
                    <div key={i}>
                      <div className="text-[10px] text-gray-400">#{i + 1}</div>
                      {isPlainObject(item)
                        ? <Rows value={item} depth={depth + 1} />
                        : <Scalar value={item} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }

        return (
          <div key={key} className="flex items-baseline gap-2">
            <span className="text-gray-500 dark:text-gray-400 shrink-0">{label}</span>
            {/* The dotted leader is what makes a stack of these scannable down the value column
                without drawing a full table around four fields. */}
            <span className="flex-1 min-w-0 border-b border-dotted border-gray-200 dark:border-white/10 translate-y-[-3px]" />
            <span className="shrink-0 text-gray-800 dark:text-gray-200">
              <Scalar value={v} />
              {unit && <span className="text-gray-400 dark:text-gray-500 ml-1">{unit}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ResultView({ value, className = '' }: { value: unknown; className?: string }) {
  const [raw, setRaw] = useState(false);

  // Nothing structured to lay out — don't wrap a single number in scaffolding.
  if (!isPlainObject(value) && !Array.isArray(value)) {
    return <span className={className}><Scalar value={value} /></span>;
  }

  return (
    <div className={`relative group/result ${className}`}>
      <button
        type="button"
        onClick={() => setRaw(r => !r)}
        title={raw ? 'Show the formatted view' : 'Show the raw JSON the driver returned'}
        className="absolute right-0 -top-4 text-[9px] uppercase tracking-wider font-bold text-gray-300 dark:text-gray-600 hover:text-indigo-500 dark:hover:text-indigo-400 opacity-0 group-hover/result:opacity-100 focus:opacity-100 transition-opacity"
      >
        {raw ? 'formatted' : 'raw'}
      </button>
      {raw ? (
        <code className="block whitespace-pre-wrap break-all font-mono text-[10px]">{JSON.stringify(value, null, 1)}</code>
      ) : Array.isArray(value) ? (
        <Rows value={{ items: value }} depth={0} />
      ) : (
        <Rows value={value} depth={0} />
      )}
    </div>
  );
}
