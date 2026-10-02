"use client";
import React from 'react';
import type { ArgDef } from '@/desktop';
import type { FormValues } from '@/launcherArgs';
import { inputClass, labelClass } from './ui';

/**
 * A form for an instrument's constructor arguments, from the Hub's definitions: a text box per
 * argument, a checkbox for a bool, and a nested group for an object argument (a backend or
 * settings object the Hub knows how to build).
 */
export default function ArgsForm({ defs, values, onChange, depth = 0 }: {
  defs: ArgDef[];
  values: FormValues;
  onChange: (next: FormValues) => void;
  depth?: number;
}) {
  if (!defs.length) return null;
  return (
    <div className={depth ? 'space-y-3 pl-3 border-l-2 border-gray-100 dark:border-white/10' : 'space-y-3'}>
      {defs.map(def => {
        const set = (v: unknown) => onChange({ ...values, [def.name]: v });
        if (def.type === 'object') {
          return (
            <div key={def.name}>
              <div className={labelClass}>
                {def.name}
                {def.class_name && <span className="ml-1.5 normal-case font-mono font-normal text-gray-400">{def.class_name}</span>}
              </div>
              {(def.args || []).length === 0
                ? <p className="text-xs text-gray-500 dark:text-gray-400">Built for you, nothing to fill in.</p>
                : <ArgsForm defs={def.args || []} values={(values[def.name] as FormValues) || {}} onChange={set} depth={depth + 1} />}
            </div>
          );
        }
        if (def.type === 'bool') {
          return (
            <label key={def.name} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
              <input type="checkbox" checked={values[def.name] === true} onChange={e => set(e.target.checked)} className="accent-accent" />
              <span className="font-mono">{def.name}</span>
            </label>
          );
        }
        return (
          <label key={def.name} className="block">
            <span className={labelClass}>
              {def.name} <span className="normal-case font-normal text-gray-400">{def.type || 'str'}</span>
            </span>
            <input
              value={String(values[def.name] ?? '')}
              placeholder={def.default !== undefined && def.default !== null ? `default: ${String(def.default)}` : ''}
              inputMode={def.type === 'int' || def.type === 'float' ? 'decimal' : undefined}
              onChange={e => set(e.target.value)}
              className={`${inputClass} font-mono`}
            />
          </label>
        );
      })}
    </div>
  );
}
