"use client";

import React, { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';

/**
 * Name/value rows for the arguments a `**kwargs` method takes but the schema cannot list.
 *
 * A driver that forwards to a vendor SDK (`def measure(self, wavelength_nm, **vendor_options)`)
 * publishes one parameter and accepts a dozen. Everything below the UI already handles that —
 * a step's args are a dict, unlisted keys flow through `cast_arguments` into `**kwargs`, and
 * the validator treats them as real rather than as typos — but with no way to type one in, such
 * a method could only ever be called with nothing, which is not what the vendor's manual says.
 *
 * `**kwargs` is a dict of *names*, so name/value rows map onto it exactly. (`*args` is an
 * ordered list with no names and no way to travel in a step's args dict, which is why there is
 * no equivalent for it here.)
 *
 * The better answer, where the driver author can be persuaded to take it, is to declare the
 * options as a TypedDict behind `Unpack` (PEP 692): introspection then lists them as ordinary
 * typed parameters and none of this is reached. These rows are the fallback for everything
 * undeclared.
 */

export type ExtraArgumentsProps = {
  /** The arguments currently set that the schema does not list. */
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Names to offer — keys already used for this same method elsewhere. */
  suggestions?: string[];
  /** Values to offer, e.g. '#variables' produced by earlier steps. */
  valueSuggestions?: { value: string; label?: string }[];
  /** Distinguishes this editor's datalists, and reseeds the rows when it changes. */
  idPrefix: string;
  layout?: 'inline' | 'stacked';
  /** True when the method's signature could not be read at all, rather than it declaring a
   *  `**kwargs`. The rows are the same; what can be promised about them is not. */
  unknownSignature?: boolean;
};

type Row = { id: string; name: string; value: string };

let rowSeq = 0;
const nextRowId = () => `xa-${++rowSeq}`;

/**
 * What a typed row means. A form has only text, but `**kwargs` is untyped by definition — there
 * is no annotation to cast against on the way in — so `20` would otherwise reach the driver as
 * "20" and a vendor SDK expecting a number would be the one to complain, well after the point
 * anyone could see why. Quote it to keep it text; a '#reference' is left alone for the run to
 * substitute. A driver that *does* annotate its `**kwargs` gets cast server-side as well, which
 * is the authoritative pass — this one only makes the obvious cases obvious.
 */
export function coerceArgumentLiteral(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('#')) return text;
  if (trimmed.length >= 2
      && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed);
  return text;
}

const seedRows = (value: Record<string, unknown>): Row[] =>
  Object.entries(value || {}).map(([name, v]) => ({
    id: nextRowId(),
    name,
    value: v === null || v === undefined ? '' : String(v),
  }));

export function ExtraArguments({
  value,
  onChange,
  suggestions = [],
  valueSuggestions = [],
  idPrefix,
  layout = 'inline',
  unknownSignature = false,
}: ExtraArgumentsProps) {
  // Rows are held here rather than derived from `value` on every render, because a row exists
  // before it has a name: deriving them would make the key disappear from under the cursor as
  // soon as the name box was cleared, taking the value with it.
  const [rows, setRows] = useState<Row[]>(() => seedRows(value));
  const seededFor = useRef(idPrefix);
  useEffect(() => {
    if (seededFor.current !== idPrefix) {
      seededFor.current = idPrefix;
      setRows(seedRows(value));
    }
  }, [idPrefix, value]);

  const commit = (next: Row[]) => {
    setRows(next);
    const out: Record<string, unknown> = {};
    for (const row of next) {
      const name = row.name.trim();
      // A half-typed row is not an argument yet, and an empty value is how you remove one
      // without losing the row you are in the middle of filling in.
      if (!name || row.value.trim() === '') continue;
      out[name] = coerceArgumentLiteral(row.value);
    }
    onChange(out);
  };

  const update = (id: string, patch: Partial<Row>) =>
    commit(rows.map(r => (r.id === id ? { ...r, ...patch } : r)));

  const stacked = layout === 'stacked';
  const nameListId = `${idPrefix}-names`;
  const valueListId = `${idPrefix}-values`;
  const inputClass = stacked
    ? 'bg-gray-50 dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-indigo-500'
    : 'bg-transparent text-[11px] text-gray-800 dark:text-gray-100 focus:outline-none placeholder:text-gray-300 dark:placeholder:text-gray-700';

  return (
    <div className={stacked ? 'space-y-2' : 'flex flex-col space-y-1.5'}>
      {/* Not a flex row: in a narrow instrument card the label and the note would each be
          squeezed into their own column and wrap mid-phrase. Plain inline text just flows. */}
      <div className="leading-snug">
        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Extra arguments
        </span>
        {/* Two different facts, and conflating them wastes someone's afternoon: a **kwargs is a
            promise the signature makes, while an unreadable signature is a guess. A compiled
            function that takes only positional arguments cannot be called from here at all —
            it reports having received nothing, however much was typed in — and the only honest
            thing to do is say where the names are going. */}
        {unknownSignature ? (
          <span className="text-[10px] text-gray-400 dark:text-gray-500">
            {' '}— this method&apos;s signature can&apos;t be read, so arguments are sent by name.
            A compiled function that takes positional arguments only will refuse them.
          </span>
        ) : (
          <span className="text-[10px] text-gray-400 dark:text-gray-500">
            {' '}— forwarded to <span className="font-mono">**kwargs</span>
          </span>
        )}
      </div>

      {rows.map(row => (
        <div
          key={row.id}
          className={stacked
            ? 'flex items-center gap-2'
            : 'flex items-center gap-2 shrink-0 bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 rounded-md px-2 py-1'}
        >
          <input
            type="text"
            list={suggestions.length > 0 ? nameListId : undefined}
            value={row.name}
            placeholder="name"
            onChange={e => update(row.id, { name: e.target.value })}
            className={`${inputClass} ${stacked ? 'w-1/2' : 'w-24'}`}
          />
          <span className="text-gray-400 dark:text-gray-600 text-[11px]">=</span>
          <input
            type="text"
            list={valueSuggestions.length > 0 ? valueListId : undefined}
            value={row.value}
            placeholder="value"
            onChange={e => update(row.id, { value: e.target.value })}
            className={`${inputClass} ${stacked ? 'flex-1' : 'w-24'}`}
          />
          <button
            type="button"
            title="Remove this argument"
            onClick={() => commit(rows.filter(r => r.id !== row.id))}
            className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors shrink-0"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => setRows([...rows, { id: nextRowId(), name: '', value: '' }])}
        className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 w-fit"
      >
        <Plus className="w-3 h-3" /> Add argument
      </button>

      {suggestions.length > 0 && (
        <datalist id={nameListId}>
          {suggestions.map(name => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      {valueSuggestions.length > 0 && (
        <datalist id={valueListId}>
          {valueSuggestions.map(v => (
            <option key={v.value} value={v.value} label={v.label} />
          ))}
        </datalist>
      )}
    </div>
  );
}
