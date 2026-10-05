"use client";
import { API_BASE } from '@/config';

import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { confirmDialog, notify } from '@ivoryos/shared-ui';
import {
  CLASS_PREFIX, cardClass, ghostButton, inputClass, leafParams, methodLabel, readings, slug,
  type SafetyConfig, type Schema, type StateEffect, type StateNow, type StateSpec,
} from './model';

/**
 * States: the deck's condition in the lab's own words ("Balance door": open / closed).
 *
 * No two drivers say it the same way (`arm.open_gripper()`, `arm.gripper(state="open")`), and none
 * of them is changed: each is mapped onto a state here. A state is either read from an instrument
 * every time it is needed, or changed by the calls listed under it; the second kind is remembered
 * across restarts. Rules then speak of the state, not of any one driver's methods.
 *
 * Kept short on purpose: a name, its values, where the value comes from. The pairs the deck's own
 * method names imply (open_door / close_door) are offered ready-made, so the first state is a click.
 */
export default function StatesEditor({ config, onChange, schema, classes, suggested, savedNames }: {
  config: SafetyConfig;
  onChange: (next: SafetyConfig) => void;
  schema: Schema;
  classes: Record<string, string[]>;
  suggested: { name: string; state: StateSpec }[];
  /** States the edge already has: only those have a value to show or set. */
  savedNames: string[];
}) {
  const instruments = Object.keys(schema);
  const { readings: readable, called } = readings(schema);
  const [now, setNow] = useState<Record<string, StateNow>>({});
  const [loading, setLoading] = useState(false);

  // Asked for when a person looks, not polled: a state bound to a reading is read from its
  // instrument each time.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetch(`${API_BASE}/api/safety/state`).then((r) => r.json());
      setNow(data.states || {});
    } catch { /* shown as "not known yet" */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh, savedNames.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const setByHand = async (name: string, value: string | null) => {
    const res = await fetch(`${API_BASE}/api/safety/state`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, value }),
    });
    const data = await res.json();
    if (!res.ok) { await notify(data.error || 'Could not set it.', { title: 'Not set', tone: 'error' }); return; }
    setNow(data.states || {});
  };

  const patch = (name: string, change: Partial<StateSpec>) =>
    onChange({ ...config, states: { ...config.states, [name]: { ...config.states[name], ...change } } });

  const add = (name: string, state: StateSpec) => {
    let id = slug(name);
    for (let n = 2; config.states[id]; n++) id = `${slug(name)}_${n}`;
    onChange({ ...config, states: { ...config.states, [id]: state } });
  };

  const usedBy = (name: string) => config.rules.filter((r) => JSON.stringify([r.if, r.require]).includes(`"state":"${name}"`));

  const remove = async (name: string) => {
    const users = usedBy(name);
    if (users.length) {
      const ok = await confirmDialog(
        `${users.length === 1 ? `The rule "${users[0].name || 'unnamed'}" reads` : `${users.length} rules read`} this state. Removing it removes ${users.length === 1 ? 'that rule' : 'those rules'} too.`,
        { title: `Remove ${config.states[name].label || name}?`, confirmLabel: 'Remove', tone: 'danger' },
      );
      if (!ok) return;
    }
    const states = { ...config.states };
    delete states[name];
    onChange({ ...config, states, rules: config.rules.filter((r) => !users.includes(r)) });
  };

  // Every method a state can be set by: per instrument, and per driver class when several share one.
  const sharedClasses = Array.from(new Set(instruments.map((i) => (classes[i] || [])[0]).filter(Boolean)))
    .filter((cls) => instruments.filter((i) => (classes[i] || [])[0] === cls).length > 1);
  const methodsOf = (target: string) => {
    const matching = target.startsWith(CLASS_PREFIX)
      ? instruments.filter((i) => (classes[i] || []).includes(target.slice(CLASS_PREFIX.length)))
      : [target];
    return Array.from(new Set(matching.flatMap((i) => Object.keys(schema[i] || {}))));
  };
  const argsOf = (target: string, method: string) => {
    const first = target.startsWith(CLASS_PREFIX)
      ? instruments.find((i) => (classes[i] || []).includes(target.slice(CLASS_PREFIX.length))) || ''
      : target;
    return leafParams(schema[first]?.[method]).map((p) => p.path);
  };

  const when = (ts?: number) => (ts ? new Date(ts * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const label = 'w-24 shrink-0 pt-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-400';
  const names = Object.keys(config.states);

  return (
    <div className="space-y-4 overflow-y-auto pb-6 pr-1">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => add('State', { label: 'New state', values: [], set_by: [] })} className={`${ghostButton} inline-flex shrink-0 items-center gap-1 whitespace-nowrap`}>
          <Plus className="h-3 w-3" /> Add a state
        </button>
        {suggested.filter((s) => !config.states[s.name]).length > 0 && (
          <>
            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400" title="From method names that come in pairs, such as open_door and close_door">This deck suggests</span>
            {suggested.filter((s) => !config.states[s.name]).map((s) => (
              <button key={s.name} type="button" onClick={() => add(s.name, s.state)} title={s.state.set_by.map((e) => `${e.target}.${e.method} → ${String(e.value)}`).join(', ')}
                className="inline-flex items-center gap-1 rounded-full border border-accent-tint bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent hover:text-on-accent">
                <Plus className="h-3 w-3" /> {s.state.label} <span className="font-normal opacity-70">({s.state.values.join(' / ')})</span>
              </button>
            ))}
          </>
        )}
        <button type="button" onClick={refresh} title="Read every state again" aria-label="Read every state again" className="ml-auto rounded-lg p-2 text-gray-400 hover:bg-gray-200/60 hover:text-gray-700 dark:hover:bg-white/10">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {names.length === 0 && (
        <p className="max-w-xl text-sm text-gray-500 dark:text-gray-400">
          No states yet. A state is something about the deck that a rule depends on and that no single call says:
          a door that is open or closed, a gripper that is holding or empty, a balance pan that is occupied. Name it,
          say which calls change it (or which reading reports it), and rules can require it.
        </p>
      )}

      {names.map((name) => {
        const state = config.states[name];
        const reads = !!state.read;
        const current = now[name];
        const saved = savedNames.includes(name);
        const setEffect = (index: number, change: Partial<StateEffect>) =>
          patch(name, { set_by: state.set_by.map((e, i) => (i === index ? { ...e, ...change } : e)) });
        const valueKey = (value: StateEffect['value']) =>
          value && typeof value === 'object' ? ('arg' in value ? `arg:${(value as { arg: string }).arg}` : `result:${(value as { result: string }).result}`) : `value:${String(value ?? '')}`;
        return (
          <section key={name} className={`${cardClass} space-y-3 p-4`}>
            <div className="flex items-center gap-3">
              <input value={state.label} onChange={(e) => patch(name, { label: e.target.value })} placeholder="What it is, e.g. Balance door" className={`${inputClass} w-56 text-sm font-semibold`} aria-label="State name" />
              <span className="font-mono text-[11px] text-gray-400">{name}</span>
              {/* Now: what a rule would see this moment, and for a remembered state, a way to say. */}
              {saved ? (
                <span className="ml-auto flex items-center gap-2 text-xs">
                  <span className="text-gray-500 dark:text-gray-400">Now</span>
                  {current?.unknown !== undefined || !current ? (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" title={current?.unknown}>not known</span>
                  ) : (
                    <span className="rounded-full bg-green-50 px-2 py-0.5 font-mono font-semibold text-green-700 dark:bg-green-500/10 dark:text-green-300"
                      title={current.source === 'reading' ? 'Read from the instrument just now' : `Set by ${current.by || 'a call'} · ${when(current.ts)}`}>
                      {String(current.value)}
                    </span>
                  )}
                  {!reads && (
                    <select value="" aria-label="Say what it is" onChange={(e) => { if (e.target.value) setByHand(name, e.target.value === '?' ? null : e.target.value); }} className={`${inputClass} w-28`}>
                      <option value="">it is…</option>
                      {state.values.map((v) => <option key={v} value={v}>{v}</option>)}
                      <option value="?">not known</option>
                    </select>
                  )}
                </span>
              ) : <span className="ml-auto text-[11px] text-gray-400">save to start tracking it</span>}
              <button type="button" onClick={() => remove(name)} aria-label="Remove this state" title="Remove this state" className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-white/10">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            <div className="flex gap-3">
              <span className={label}>Can be</span>
              <input
                defaultValue={state.values.join(', ')} key={state.values.join(',')} placeholder="open, closed" aria-label="Values"
                onBlur={(e) => patch(name, { values: Array.from(new Set(e.target.value.split(',').map((v) => v.trim()).filter(Boolean))) })}
                className={`${inputClass} w-72`}
              />
            </div>

            <div className="flex gap-3">
              <span className={label}>Known from</span>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-1 text-xs">
                  {([['calls', 'the calls that change it'], ['reading', 'a reading of the instrument']] as const).map(([key, text]) => (
                    <button key={key} type="button"
                      onClick={() => patch(name, key === 'reading' ? { read: state.read || { read: readable[0] || '' } } : { read: undefined })}
                      className={`rounded-md border px-2 py-1 font-medium ${(key === 'reading') === reads ? 'border-accent-tint bg-accent-soft text-accent-fg' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10'}`}>
                      {text}
                    </button>
                  ))}
                  <span className="ml-2 text-gray-400">{reads ? 'asked each time; nothing to remember' : 'remembered, also across restarts'}</span>
                </div>

                {reads ? (
                  <div className="space-y-1.5">
                    <select value={state.read!.read} aria-label="Reading" onChange={(e) => patch(name, { read: { ...state.read!, read: e.target.value, path: undefined } })} className={`${inputClass} w-64 font-mono`}>
                      {![...readable, ...called].includes(state.read!.read) && <option value={state.read!.read}>{state.read!.read || 'choose a reading'}</option>}
                      {readable.map((r) => <option key={r} value={r}>{r}</option>)}
                      {called.length > 0 && <optgroup label="Called each time it is needed">{called.map((r) => <option key={r} value={r}>{r}</option>)}</optgroup>}
                    </select>
                    {/* The instrument's own word for each value, where it differs (True -> open). */}
                    {state.values.map((value) => {
                      const raw = Object.entries(state.read!.map || {}).find(([, mapped]) => String(mapped) === value)?.[0] ?? '';
                      return (
                        <div key={value} className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                          <span className="w-24 truncate font-mono text-gray-700 dark:text-gray-200">{value}</span>
                          <span>when it reads</span>
                          <input defaultValue={raw} key={`${value}:${raw}`} placeholder={value} aria-label={`Reading that means ${value}`}
                            onBlur={(e) => {
                              const map = Object.fromEntries(Object.entries(state.read!.map || {}).filter(([, mapped]) => String(mapped) !== value));
                              if (e.target.value.trim()) map[e.target.value.trim()] = value;
                              patch(name, { read: { ...state.read!, map: Object.keys(map).length ? map : undefined } });
                            }}
                            className={`${inputClass} w-32 font-mono`} />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {state.set_by.map((effect, index) => {
                      const args = argsOf(effect.target, effect.method);
                      const condition = effect.if?.[0];
                      const simple = !effect.if?.length || (effect.if.length === 1 && condition?.left.arg !== undefined && 'value' in (condition?.right || {}));
                      return (
                        <div key={index} className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                          <select value={effect.target} aria-label="Instrument"
                            onChange={(e) => setEffect(index, { target: e.target.value, method: methodsOf(e.target.value).includes(effect.method) ? effect.method : methodsOf(e.target.value)[0] || '', if: undefined })}
                            className={`${inputClass} w-32`}>
                            {![...instruments, ...sharedClasses.map((c) => `${CLASS_PREFIX}${c}`)].includes(effect.target) && <option value={effect.target}>{effect.target}</option>}
                            {instruments.map((i) => <option key={i} value={i}>{i.replace(/_/g, ' ')}</option>)}
                            {sharedClasses.map((c) => <option key={c} value={`${CLASS_PREFIX}${c}`}>every {c}</option>)}
                          </select>
                          <select value={effect.method} aria-label="Method" onChange={(e) => setEffect(index, { method: e.target.value, if: undefined })} className={`${inputClass} w-36`}>
                            {!methodsOf(effect.target).includes(effect.method) && <option value={effect.method}>{effect.method || 'choose a method'}</option>}
                            {methodsOf(effect.target).map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}
                          </select>
                          <span>makes it</span>
                          <select value={valueKey(effect.value)} aria-label="Value it leaves"
                            onChange={(e) => {
                              const [kind, ...rest] = e.target.value.split(':');
                              const text = rest.join(':');
                              setEffect(index, { value: kind === 'arg' ? { arg: text } : kind === 'result' ? { result: text } : text });
                            }}
                            className={`${inputClass} w-32`}>
                            {!state.values.includes(String(effect.value)) && typeof effect.value !== 'object' && <option value={valueKey(effect.value)}>{String(effect.value || 'choose')}</option>}
                            {state.values.map((v) => <option key={v} value={`value:${v}`}>{v}</option>)}
                            {args.map((a) => <option key={a} value={`arg:${a}`}>whatever its {a} is</option>)}
                            <option value="result:">whatever it returns</option>
                          </select>
                          {simple ? (
                            <>
                              <span>{condition ? 'when its' : ''}</span>
                              <select value={condition?.left.arg || ''} aria-label="Only when this argument"
                                onChange={(e) => setEffect(index, { if: e.target.value ? [{ left: { arg: e.target.value }, op: '==', right: { value: condition?.right.value ?? '' } }] : undefined })}
                                className={`${inputClass} w-28`}>
                                <option value="">always</option>
                                {args.map((a) => <option key={a} value={a}>only when {a}</option>)}
                              </select>
                              {condition && (
                                <>
                                  <span>is</span>
                                  <input defaultValue={String(condition.right.value ?? '')} key={String(condition.right.value ?? '')} aria-label="Argument value" placeholder="value"
                                    onBlur={(e) => setEffect(index, { if: [{ ...condition, right: { value: e.target.value.trim() } }] })}
                                    className={`${inputClass} w-24 font-mono`} />
                                </>
                              )}
                            </>
                          ) : <span title={JSON.stringify(effect.if)}>under {effect.if!.length} condition{effect.if!.length === 1 ? '' : 's'}</span>}
                          <button type="button" aria-label="Remove" title="Remove" onClick={() => patch(name, { set_by: state.set_by.filter((_, i) => i !== index) })}
                            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-white/10">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    })}
                    <button type="button"
                      onClick={() => patch(name, { set_by: [...state.set_by, { target: instruments[0] || '', method: methodsOf(instruments[0] || '')[0] || '', value: state.values[0] ?? '' }] })}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-fg hover:underline">
                      <Plus className="h-3 w-3" /> a call that changes it
                    </button>
                  </div>
                )}
              </div>
            </div>

            {usedBy(name).length > 0 && (
              <p className="text-[11px] text-gray-500 dark:text-gray-400">Required by {usedBy(name).map((r) => r.name || 'a rule').join(', ')}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
