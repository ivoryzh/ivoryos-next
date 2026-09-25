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
 * So: one Field | Value row per leaf, keyed by the driver's own field names. Field names are shown
 * as written — units are deliberately not guessed from suffixes (`_c` as °C, `_m` as metres or
 * molar?), since a wrong unit beside a number is worse than none. The raw JSON stays one click
 * away, because "what exactly did the driver send" is a real question too.
 */

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

/**
 * One table row per leaf, keyed by its dotted path. Nested models used to render as indented
 * blocks with dotted leaders, which read as prose rather than data; a flat Field | Value table is
 * what people scan down, and the path still says where a nested value came from.
 */
function flatten(value: unknown, path: string[], out: { path: string[]; value: unknown }[]) {
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) out.push({ path, value: '' });
    for (const [k, v] of entries) flatten(v, [...path, k], out);
  } else if (Array.isArray(value) && value.some(item => isPlainObject(item) || Array.isArray(item))) {
    value.forEach((item, i) => flatten(item, [...path, String(i + 1)], out));
  } else {
    out.push({ path, value });
  }
  return out;
}

function ResultTable({ value }: { value: unknown }) {
  const leaves = flatten(value, [], []);
  return (
    <table className="w-full text-xs border-collapse">
      <tbody>
        {leaves.map(({ path, value: v }) => {
          const label = path[path.length - 1] ?? '';
          const parents = path.slice(0, -1);
          return (
            <tr key={path.join('.')} className="border-b last:border-b-0 border-gray-100 dark:border-white/5 align-top">
              <td className="py-1 pr-4 font-mono text-gray-500 dark:text-gray-400 whitespace-nowrap w-0">
                {parents.length > 0 && <span className="text-gray-400 dark:text-gray-500">{parents.join('.')}.</span>}
                {label}
              </td>
              <td className="py-1 text-gray-800 dark:text-gray-200 break-words" style={{ overflowWrap: 'anywhere' }}>
                {Array.isArray(v)
                  ? (v.length === 0
                    ? <span className="text-gray-400 dark:text-gray-600">empty</span>
                    : <span className="font-mono">{v.map(item => (typeof item === 'number' ? formatNumber(item) : String(item))).join(', ')}</span>)
                  : <Scalar value={v} />}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
      ) : (
        <ResultTable value={value} />
      )}
    </div>
  );
}
