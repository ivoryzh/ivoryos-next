"use client";

import { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import {
  CLASS_PREFIX, KNOWN_UNITS, UNIT_GROUPS, cardClass, inputClass, isNumeric, leafParams, limitFor, limitIsLive, methodLabel,
  patchLimit, targetLabel, type Limit, type SafetyConfig, type Schema,
} from './model';

const OTHER_UNIT = '__other';

/**
 * Limits, set on the deck itself: pick an instrument, and every field of every method is there to
 * be given a range, a list of allowed values, or a tray, and told what unit its numbers are in.
 * Nothing to look up or spell: the fields are the ones the drivers publish.
 */
export default function LimitsEditor({ config, onChange, schema, classes }: {
  config: SafetyConfig;
  onChange: (next: SafetyConfig) => void;
  schema: Schema;
  classes: Record<string, string[]>;
}) {
  const instruments = Object.keys(schema);
  const [active, setActive] = useState('');
  const [query, setQuery] = useState('');
  // Rows whose unit is being typed rather than picked ("other…" chosen, nothing written yet).
  const [typingUnit, setTypingUnit] = useState<Record<string, boolean>>({});
  useEffect(() => { if (!schema[active] && instruments.length) setActive(instruments[0]); }, [instruments, active, schema]);

  const trayNames = Object.keys(config.trays);
  const mine = classes[active] || [];
  const sameClass = mine[0] ? instruments.filter((i) => (classes[i] || [])[0] === mine[0]).length : 0;

  const countFor = (instrument: string) =>
    Object.entries(schema[instrument] || {}).reduce((n, [method, entry]) =>
      n + leafParams(entry).filter((p) => limitFor(config, classes[instrument] || [], instrument, method, p.path)).length, 0);

  const orphans = useMemo(() => config.limits.filter((l) => !limitIsLive(l, schema, classes)), [config.limits, schema, classes]);

  const methods = Object.entries(schema[active] || {})
    .map(([method, entry]) => ({ method, entry, params: leafParams(entry) }))
    .filter(({ method, params }) => params.length > 0 && (!query.trim() || methodLabel(method).toLowerCase().includes(query.trim().toLowerCase())
      || params.some((p) => p.path.toLowerCase().includes(query.trim().toLowerCase()))));

  const describe = (l: Limit) => [
    l.min !== undefined && l.min !== '' ? `min ${l.min}` : '',
    l.max !== undefined && l.max !== '' ? `max ${l.max}` : '',
    l.allowed ? `only ${l.allowed.join(', ')}` : '',
    l.tray ? `tray ${l.tray}` : '',
    l.unit ? `in ${l.unit}` : '',
  ].filter(Boolean).join(', ');

  if (instruments.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No instruments on this deck yet, so there is nothing to limit.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 gap-6">
      <nav className="w-52 shrink-0 space-y-0.5 overflow-y-auto">
        {instruments.map((name) => {
          const count = countFor(name);
          return (
            <button
              key={name}
              type="button"
              onClick={() => setActive(name)}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm capitalize ${
                active === name ? 'bg-accent-soft font-semibold text-accent-fg' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5'
              }`}
            >
              <span className="truncate">{name.replace(/_/g, ' ')}</span>
              {count > 0 && <span className="shrink-0 rounded-full bg-gray-200 px-1.5 text-[10px] font-semibold text-gray-700 dark:bg-white/10 dark:text-gray-200">{count}</span>}
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 flex-1 space-y-4 overflow-y-auto pb-6 pr-1">
        <div className="flex items-center gap-3">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a method or field" className={`${inputClass} w-full pl-8`} />
          </div>
          {mine[0] && <span className="text-xs text-gray-500 dark:text-gray-400">{active.replace(/_/g, ' ')} is a <span className="font-mono">{mine[0]}</span></span>}
        </div>

        {methods.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {query.trim() ? 'Nothing here matches.' : 'None of this instrument’s methods take a value, so there is nothing to limit.'}
          </p>
        )}

        {methods.map(({ method, params }) => (
          <section key={method} className={`${cardClass} px-4 py-3`}>
            <h3 className="mb-2 text-sm font-semibold capitalize text-gray-900 dark:text-gray-100">{methodLabel(method)}</h3>
            <div className="divide-y divide-gray-100 dark:divide-white/5">
              {params.map(({ path, info }) => {
                const limit = limitFor(config, mine, active, method, path);
                const shared = !!limit && limit.target.startsWith(CLASS_PREFIX);
                const set = (patch: Partial<Limit>) => onChange(patchLimit(config, mine, active, method, path, patch));
                const options: unknown[] | undefined = info?.options;
                const allowed = limit?.allowed?.map(String);
                // The unit the field's numbers are in. One the driver itself declared is shown
                // as it is: it says what the code does, so it is not up for choosing here. Any
                // other field takes one from the dropdown, or typed under "other…" and kept as
                // written. A label only -- the edge converts nothing.
                const rowKey = `${active}.${method}.${path}`;
                const declaredUnit: string | undefined = info?.unit ? String(info.unit) : undefined;
                const chosenUnit = limit?.unit || '';
                const unitSelect = typingUnit[rowKey] || (chosenUnit && !KNOWN_UNITS.has(chosenUnit)) ? OTHER_UNIT : chosenUnit;
                const typeText = String(info?.type || 'any').toLowerCase();
                const takesUnit = !options && (isNumeric(info) || typeText === 'any' || typeText === '');
                return (
                  <div key={path} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2">
                    <div className="w-44 shrink-0">
                      <div className="truncate font-mono text-xs text-gray-800 dark:text-gray-200" title={path}>{path}</div>
                      <div className="text-[10px] text-gray-400 dark:text-gray-500">
                        {String(info?.type || 'any')}{info?.default !== undefined ? `, default ${String(info.default)}` : ''}
                      </div>
                    </div>

                    {options ? (
                      // Choices the driver itself declares (an Enum, a Literal). The edge holds every
                      // call to them with nothing set here; this is only for forbidding some of them.
                      <div className="flex flex-wrap items-center gap-1.5" title="Only these are ever accepted, with nothing set here. Click one to forbid it on this bench.">
                        {options.map((option) => {
                          const text = String(option);
                          const on = !allowed || allowed.includes(text);
                          return (
                            <button
                              key={text}
                              type="button"
                              aria-pressed={on}
                              title={on ? 'Allowed. Click to forbid.' : 'Forbidden. Click to allow.'}
                              onClick={() => {
                                const now = (allowed || options.map(String)).filter((o) => o !== text);
                                if (on && now.length === 0) return; // forbidding every choice forbids the call
                                const next = on ? now : [...(allowed || []), text];
                                // Everything allowed again is no limit at all.
                                set({ allowed: next.length === options.length ? undefined : options.filter((o) => next.includes(String(o))) });
                              }}
                              className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${
                                on ? 'border-gray-300 text-gray-700 dark:border-white/20 dark:text-gray-200'
                                  : 'border-red-200 bg-red-50 text-red-500 line-through dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400'
                              }`}
                            >
                              {text}
                            </button>
                          );
                        })}
                        {!allowed && <span className="text-[10px] text-gray-400 dark:text-gray-500">always held to these; click one to forbid it</span>}
                      </div>
                    ) : (
                      <>
                        {isNumeric(info) && (
                          <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                            <input
                              type="number" step="any" placeholder="min" aria-label={`${path} minimum`}
                              value={limit?.min ?? ''} onChange={(e) => set({ min: e.target.value === '' ? undefined : Number(e.target.value) })}
                              className={`${inputClass} w-20`}
                            />
                            <span>to</span>
                            <input
                              type="number" step="any" placeholder="max" aria-label={`${path} maximum`}
                              value={limit?.max ?? ''} onChange={(e) => set({ max: e.target.value === '' ? undefined : Number(e.target.value) })}
                              className={`${inputClass} w-20`}
                            />
                          </div>
                        )}
                        {declaredUnit ? (
                          <span
                            className="text-xs text-gray-600 dark:text-gray-300"
                            title="Declared by the driver itself, so the bounds are in it and it cannot be changed here"
                          >
                            {declaredUnit} <span className="text-[10px] text-gray-400 dark:text-gray-500">(driver)</span>
                          </span>
                        ) : takesUnit && (
                          <span className="flex items-center gap-1.5">
                            <select
                              aria-label={`${path} unit`}
                              title="What this field's numbers are in. Shown with the bounds and on every form; nothing is converted."
                              value={unitSelect}
                              onChange={(e) => {
                                const picked = e.target.value;
                                if (picked === OTHER_UNIT) {
                                  setTypingUnit((t) => ({ ...t, [rowKey]: true }));
                                  if (chosenUnit && KNOWN_UNITS.has(chosenUnit)) set({ unit: undefined });
                                  return;
                                }
                                setTypingUnit((t) => ({ ...t, [rowKey]: false }));
                                set({ unit: picked || undefined });
                              }}
                              className={`${inputClass} w-28`}
                            >
                              <option value="">no unit</option>
                              {UNIT_GROUPS.map((group) => (
                                <optgroup key={group.label} label={group.label}>
                                  {group.units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                                </optgroup>
                              ))}
                              <option value={OTHER_UNIT}>other…</option>
                            </select>
                            {unitSelect === OTHER_UNIT && (
                              <input
                                aria-label={`${path} unit, typed`}
                                placeholder="unit"
                                defaultValue={KNOWN_UNITS.has(chosenUnit) ? '' : chosenUnit}
                                key={`${rowKey}.unit.${chosenUnit}`}
                                autoFocus={!!typingUnit[rowKey]}
                                onBlur={(e) => {
                                  const text = e.target.value.trim();
                                  setTypingUnit((t) => ({ ...t, [rowKey]: false }));
                                  set({ unit: text || undefined });
                                }}
                                className={`${inputClass} w-20`}
                              />
                            )}
                          </span>
                        )}
                        {!isNumeric(info) && (
                          <input
                            placeholder="only these values (a, b, c)" aria-label={`${path} allowed values`}
                            defaultValue={(limit?.allowed || []).join(', ')}
                            key={`${active}.${method}.${path}.${(limit?.allowed || []).join(',')}`}
                            onBlur={(e) => {
                              const values = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
                              set({ allowed: values.length ? values : undefined });
                            }}
                            className={`${inputClass} w-48`}
                          />
                        )}
                        {trayNames.length > 0 && String(info?.type || '').toLowerCase() !== 'float' && (
                          <select
                            aria-label={`${path} tray`}
                            value={limit?.tray || ''} onChange={(e) => set({ tray: e.target.value || undefined })}
                            className={`${inputClass} w-40`}
                          >
                            <option value="">not a tray position</option>
                            {trayNames.map((name) => <option key={name} value={name}>position on {config.trays[name].label || name}</option>)}
                          </select>
                        )}
                      </>
                    )}

                    {limit && mine[0] && (
                      <label
                        className="ml-auto flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400"
                        title={`One limit for every instrument built from ${mine[0]}${sameClass > 1 ? ` (${sameClass} on this deck)` : ''}, instead of this one only`}
                      >
                        <input
                          type="checkbox" className="accent-accent" checked={shared}
                          onChange={(e) => set({ target: e.target.checked ? `${CLASS_PREFIX}${mine[0]}` : active })}
                        />
                        every {mine[0]}
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        {orphans.length > 0 && (
          <section className={`${cardClass} border-amber-200 px-4 py-3 dark:border-amber-500/30`}>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Limits for things not on this deck</h3>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">Kept, and inactive until an instrument, method or field of that name is here again.</p>
            <ul className="space-y-1">
              {orphans.map((l) => (
                <li key={`${l.target}.${l.method}.${l.param}`} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-gray-700 dark:text-gray-200">{targetLabel(l.target)} · {l.method} · {l.param}</span>
                  <span className="text-gray-500 dark:text-gray-400">{describe(l)}</span>
                  <button
                    type="button" aria-label="Remove this limit" title="Remove this limit"
                    onClick={() => onChange({ ...config, limits: config.limits.filter((x) => x !== l) })}
                    className="ml-auto rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-white/10"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
