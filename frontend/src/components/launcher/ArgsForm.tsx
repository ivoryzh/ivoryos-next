"use client";
import React, { useId } from 'react';
import type { ArgDef } from '@/desktop';
import type { FormValues } from '@/launcherArgs';
import { inputClass, labelClass } from './ui';

/** What an argument whose type the driver's code leaves open can be passed as. */
const TYPE_CHOICES = ['str', 'int', 'float', 'bool'];

/** The text a field shows while empty: what leaving it empty means. */
function placeholderFor(def: ArgDef) {
  if (def.required) return 'required';
  if (def.default !== undefined && def.default !== null) return `default: ${String(def.default)}`;
  // From the code (`required` is said): an explicit None, which the Hub's definitions cannot express.
  return def.required === false && def.default === null ? 'default: None' : '';
}

/**
 * A form for an instrument's constructor arguments, from the Hub's definitions or a driver's own
 * constructor: a text box per argument, a checkbox for a bool, and a nested group for an object
 * argument (a backend or settings object the Hub knows how to build). An argument marked
 * `type_unknown` gets a type choice beside its name when `onTypeChange` is given.
 */
export default function ArgsForm({ defs, values, onChange, onTypeChange, depth = 0 }: {
  defs: ArgDef[];
  values: FormValues;
  onChange: (next: FormValues) => void;
  onTypeChange?: (name: string, type: string) => void;
  depth?: number;
}) {
  const uid = useId();
  if (!defs.length) return null;
  const typeChoice = (def: ArgDef) => (def.type_unknown && onTypeChange ? (
    <select
      value={def.type || 'str'}
      onChange={e => onTypeChange(def.name, e.target.value)}
      title="The driver's code does not say: choose how the value is passed"
      aria-label={`Type of ${def.name}`}
      className="rounded border border-gray-200 dark:border-white/10 bg-transparent px-1 text-[11px] font-mono normal-case font-normal text-gray-500 dark:text-gray-400"
    >
      {TYPE_CHOICES.map(t => <option key={t} value={t}>{t}</option>)}
    </select>
  ) : null);
  return (
    <div className={depth ? 'space-y-3 pl-3 border-l-2 border-gray-100 dark:border-white/10' : 'space-y-3'}>
      {defs.map(def => {
        const set = (v: unknown) => onChange({ ...values, [def.name]: v });
        const id = `${uid}-${def.name}`;
        if (def.type === 'object') {
          return (
            <div key={def.name}>
              <div className={labelClass}>
                {def.name}
                {def.class_name && <span className="ml-1.5 normal-case font-mono font-normal text-gray-400">{def.class_name}</span>}
              </div>
              {(def.args || []).length === 0
                ? <p className="text-xs text-gray-500 dark:text-gray-400">Built for you, nothing to fill in.</p>
                : <ArgsForm defs={def.args || []} values={(values[def.name] as FormValues) || {}} onChange={set} onTypeChange={onTypeChange} depth={depth + 1} />}
            </div>
          );
        }
        if (def.type === 'bool') {
          return (
            <div key={def.name} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
              <input id={id} type="checkbox" checked={values[def.name] === true} onChange={e => set(e.target.checked)} className="accent-accent" />
              <label htmlFor={id} className="font-mono">{def.name}</label>
              {typeChoice(def)}
            </div>
          );
        }
        return (
          <div key={def.name}>
            <div className="flex items-center gap-1.5 mb-1">
              <label htmlFor={id} className={`${labelClass} !mb-0`}>{def.name}</label>
              {typeChoice(def) || <span className="text-[11px] tracking-wider text-gray-400">{def.type || 'str'}</span>}
            </div>
            <input
              id={id}
              value={String(values[def.name] ?? '')}
              placeholder={placeholderFor(def)}
              inputMode={def.type === 'int' || def.type === 'float' ? 'decimal' : undefined}
              onChange={e => set(e.target.value)}
              className={`${inputClass} font-mono`}
            />
          </div>
        );
      })}
    </div>
  );
}
