"use client";

import { Plus, Trash2, X } from 'lucide-react';
import {
  CLASS_PREFIX, cardClass, ghostButton, inputClass, leafParams, methodLabel, readings, targetLabel,
  type Clause, type Operand, type Rule, type SafetyConfig, type Schema,
} from './model';

const OPS = [
  { value: '<=', label: 'is at most' },
  { value: '<', label: 'is below' },
  { value: '>=', label: 'is at least' },
  { value: '>', label: 'is above' },
  { value: '==', label: 'is' },
  { value: '!=', label: 'is not' },
  { value: 'in', label: 'is one of' },
  { value: 'not in', label: 'is not one of' },
];

type Kind = 'state' | 'arg' | 'read' | 'last' | 'action' | 'value';

const kindOf = (operand: Operand): Kind =>
  'state' in operand ? 'state'
    : 'arg' in operand ? 'arg'
    : 'read' in operand ? 'read'
      : 'last' in operand ? (String(operand.last).includes('.') || operand.last === '' ? 'last' : 'action')
        : 'value';

const KIND_LABELS: Record<Kind, string> = {
  state: 'state',
  arg: "this call's",
  read: 'reading',
  last: 'last value sent to',
  action: 'last action on',
  value: 'value',
};

/** What a person types for a fixed value: a number stays a number, true/false a boolean. */
const parseValue = (text: string): unknown => {
  const trimmed = text.trim();
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed);
  return text;
};

const showValue = (value: unknown) => (Array.isArray(value) ? value.join(', ') : value === undefined || value === null ? '' : String(value));

/**
 * Rules: interlocks across the deck. "When a pump dispenses, the reactor must read at most 60."
 * Each is a sentence built from pickers, so the instruments, methods, arguments and readings are
 * the ones the deck has, and nothing is spelled from memory.
 */
export default function RulesEditor({ config, onChange, schema, classes }: {
  config: SafetyConfig;
  onChange: (next: SafetyConfig) => void;
  schema: Schema;
  classes: Record<string, string[]>;
}) {
  const instruments = Object.keys(schema);
  const classNames = Array.from(new Set(instruments.map((i) => (classes[i] || [])[0]).filter(Boolean)));
  const { readings: readable, called } = readings(schema);
  const stateNames = Object.keys(config.states || {});

  const matching = (target: string) => instruments.filter((i) =>
    target === '*' || target === i || (target.startsWith(CLASS_PREFIX) && (classes[i] || []).includes(target.slice(CLASS_PREFIX.length))));
  const methodsOf = (target: string) => Array.from(new Set(matching(target).flatMap((i) => Object.keys(schema[i] || {}))));
  const argsOf = (target: string, method: string) =>
    Array.from(new Set(matching(target).flatMap((i) => leafParams(schema[i]?.[method]).map((p) => p.path))));

  const setRule = (index: number, patch: Partial<Rule>) =>
    onChange({ ...config, rules: config.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)) });

  const add = () => {
    const target = instruments[0] || '*';
    onChange({ ...config, rules: [...config.rules, {
      id: Math.random().toString(36).slice(2, 10), name: '', enabled: true,
      when: { target, method: methodsOf(target)[0] || '*' }, if: [],
      require: [stateNames.length
        ? { left: { state: stateNames[0] }, op: '==', right: { value: config.states[stateNames[0]].values[0] ?? '' } }
        : { left: { read: readable[0] || '' }, op: '<=', right: { value: 0 } }], message: '',
    }] });
  };

  // Plain functions, not components: a component declared in here would be a new type on every
  // render, and React would remount its fields (dropping what is being typed) each time.
  // `choices`: the values to pick from when the other side is a state that lists its values.
  const operandEditor = (operand: Operand, rule: Rule, onSet: (o: Operand) => void, allowValue: boolean, choices?: string[]) => {
    const kind = kindOf(operand);
    const kinds = (['state', 'arg', 'read', 'last', 'action', 'value'] as Kind[])
      .filter((k) => (k !== 'value' || allowValue) && (k !== 'arg' || rule.when.method !== '*') && (k !== 'state' || stateNames.length > 0 || kind === 'state'));
    const change = (next: Kind) => {
      if (next === 'state') onSet({ state: stateNames[0] || '' });
      else if (next === 'arg') onSet({ arg: argsOf(rule.when.target, rule.when.method)[0] || '' });
      else if (next === 'read') onSet({ read: readable[0] || '' });
      else if (next === 'last') onSet({ last: '' });
      else if (next === 'action') onSet({ last: instruments[0] || '' });
      else onSet({ value: '' });
    };
    // "the last value sent to" is instrument.method.field, picked in three steps.
    const [lastInstrument = '', lastMethod = '', ...lastRest] = String(operand.last ?? '').split('.');
    const lastParam = lastRest.join('.');
    const returnPaths: { path: string }[] = operand.read
      ? (schema[operand.read.split('.')[0]]?.[operand.read.split('.').slice(1).join('.')]?.return_paths || []).filter((p: { path: string }) => p.path)
      : [];
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <select value={kind} onChange={(e) => change(e.target.value as Kind)} className={`${inputClass} w-36`} aria-label="What to compare">
          {kinds.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
        </select>
        {kind === 'state' && (
          <select value={operand.state} onChange={(e) => onSet({ state: e.target.value })} className={`${inputClass} w-44`} aria-label="State">
            {!stateNames.includes(operand.state || '') && <option value={operand.state}>{operand.state || 'choose a state'}</option>}
            {stateNames.map((n) => <option key={n} value={n}>{config.states[n].label || n}</option>)}
          </select>
        )}
        {kind === 'arg' && (
          <select value={operand.arg} onChange={(e) => onSet({ arg: e.target.value })} className={`${inputClass} w-40 font-mono`} aria-label="Argument">
            {!argsOf(rule.when.target, rule.when.method).includes(operand.arg || '') && <option value={operand.arg}>{operand.arg || 'choose an argument'}</option>}
            {argsOf(rule.when.target, rule.when.method).map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        {kind === 'read' && (
          <>
            <select value={operand.read} onChange={(e) => onSet({ read: e.target.value })} className={`${inputClass} w-56 font-mono`} aria-label="Reading">
              {![...readable, ...called].includes(operand.read || '') && <option value={operand.read}>{operand.read || 'choose a reading'}</option>}
              {readable.map((r) => <option key={r} value={r}>{r}</option>)}
              {called.length > 0 && (
                // Not named like a reading: the rule would call it every time it is checked.
                <optgroup label="Called each time the rule is checked">
                  {called.map((r) => <option key={r} value={r}>{r}</option>)}
                </optgroup>
              )}
            </select>
            {returnPaths.length > 0 && (
              <select value={operand.path || ''} onChange={(e) => onSet({ read: operand.read, ...(e.target.value ? { path: e.target.value } : {}) })} className={`${inputClass} w-40 font-mono`} aria-label="Field of the reading">
                <option value="">the whole result</option>
                {returnPaths.map((p) => <option key={p.path} value={p.path}>{p.path}</option>)}
              </select>
            )}
          </>
        )}
        {kind === 'action' && (
          <select value={String(operand.last ?? '')} onChange={(e) => onSet({ last: e.target.value })} className={`${inputClass} w-40`} aria-label="Instrument">
            {instruments.map((i) => <option key={i} value={i}>{i.replace(/_/g, ' ')}</option>)}
          </select>
        )}
        {kind === 'last' && (
          <>
            <select value={lastInstrument} onChange={(e) => onSet({ last: `${e.target.value}..` })} className={`${inputClass} w-36`} aria-label="Instrument">
              <option value="">instrument</option>
              {instruments.map((i) => <option key={i} value={i}>{i.replace(/_/g, ' ')}</option>)}
            </select>
            <select value={lastMethod} onChange={(e) => onSet({ last: `${lastInstrument}.${e.target.value}.${leafParams(schema[lastInstrument]?.[e.target.value])[0]?.path || ''}` })} className={`${inputClass} w-40`} aria-label="Method">
              <option value="">method</option>
              {Object.keys(schema[lastInstrument] || {}).filter((m) => leafParams(schema[lastInstrument][m]).length > 0).map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}
            </select>
            <select value={lastParam} onChange={(e) => onSet({ last: `${lastInstrument}.${lastMethod}.${e.target.value}` })} className={`${inputClass} w-36 font-mono`} aria-label="Field">
              <option value="">field</option>
              {leafParams(schema[lastInstrument]?.[lastMethod]).map((p) => <option key={p.path} value={p.path}>{p.path}</option>)}
            </select>
          </>
        )}
        {kind === 'value' && choices && choices.length > 0 && (
          <select value={showValue(operand.value)} onChange={(e) => onSet({ value: e.target.value })} className={`${inputClass} w-32 font-mono`} aria-label="Value">
            {!choices.includes(showValue(operand.value)) && <option value={showValue(operand.value)}>{showValue(operand.value) || 'choose'}</option>}
            {choices.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {kind === 'value' && !(choices && choices.length > 0) && (
          <input
            defaultValue={showValue(operand.value)} key={showValue(operand.value)}
            onBlur={(e) => onSet({ value: parseValue(e.target.value) })}
            placeholder="value" aria-label="Value" className={`${inputClass} w-32 font-mono`}
          />
        )}
      </span>
    );
  };

  const clausesEditor = (rule: Rule, index: number, part: 'if' | 'require') => {
    const clauses = rule[part];
    const set = (j: number, patch: Partial<Clause>) =>
      setRule(index, { [part]: clauses.map((c, k) => (k === j ? { ...c, ...patch } : c)) } as Partial<Rule>);
    return (
      <div className="space-y-1.5">
        {clauses.map((clause, j) => (
          <div key={j} className="flex flex-wrap items-center gap-1.5">
            {j > 0 && <span className="text-[11px] font-semibold uppercase text-gray-400">and</span>}
            {operandEditor(clause.left, rule, (left) => set(j, { left }), false)}
            <select value={clause.op} onChange={(e) => set(j, { op: e.target.value })} className={`${inputClass} w-32`} aria-label="Comparison">
              {OPS.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
            </select>
            {operandEditor(clause.right, rule, (right) => set(j, { right }), true,
              clause.left.state && (clause.op === '==' || clause.op === '!=') ? config.states?.[clause.left.state]?.values : undefined)}
            <button type="button" aria-label="Remove this condition" title="Remove this condition"
              onClick={() => setRule(index, { [part]: clauses.filter((_, k) => k !== j) } as Partial<Rule>)}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-white/10">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button type="button"
          onClick={() => setRule(index, { [part]: [...clauses, { left: { read: readable[0] || '' }, op: '<=', right: { value: 0 } }] } as Partial<Rule>)}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-fg hover:underline">
          <Plus className="h-3 w-3" /> condition
        </button>
      </div>
    );
  };

  const label = 'w-24 shrink-0 pt-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-400';

  return (
    <div className="space-y-4 overflow-y-auto pb-6 pr-1">
      <div className="flex items-center gap-3">
        <button type="button" onClick={add} className={`${ghostButton} inline-flex shrink-0 items-center gap-1 whitespace-nowrap`}><Plus className="h-3 w-3" /> Add a rule</button>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Checked the moment a call is about to be sent. Something that cannot be read, or was never sent, blocks.
        </p>
      </div>

      {config.rules.length === 0 && (
        <p className="max-w-xl text-sm text-gray-500 dark:text-gray-400">
          No rules yet. A rule ties one instrument to another: no dispensing while the reactor is hot, no more
          volume than the syringe still holds, no pick until the door was opened.
        </p>
      )}

      {config.rules.map((rule, index) => (
        <section key={rule.id} className={`${cardClass} space-y-3 p-4 ${rule.enabled ? '' : 'opacity-60'}`}>
          <div className="flex items-center gap-3">
            <input type="checkbox" className="accent-accent" checked={rule.enabled} onChange={(e) => setRule(index, { enabled: e.target.checked })} title={rule.enabled ? 'On' : 'Off'} aria-label="Rule is on" />
            <input value={rule.name} onChange={(e) => setRule(index, { name: e.target.value })} placeholder={`Rule ${index + 1}: what it protects`} className={`${inputClass} flex-1 text-sm font-semibold`} />
            <button type="button" aria-label="Delete this rule" title="Delete this rule"
              onClick={() => onChange({ ...config, rules: config.rules.filter((_, i) => i !== index) })}
              className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-white/10">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>

          <div className="flex gap-3">
            <span className={label}>When</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <select value={rule.when.target} aria-label="Instrument"
                onChange={(e) => setRule(index, { when: { target: e.target.value, method: methodsOf(e.target.value).includes(rule.when.method) ? rule.when.method : '*' } })}
                className={`${inputClass} w-44`}>
                {![...instruments, '*', ...classNames.map((c) => `${CLASS_PREFIX}${c}`)].includes(rule.when.target) && <option value={rule.when.target}>{targetLabel(rule.when.target)}</option>}
                {instruments.map((i) => <option key={i} value={i}>{i.replace(/_/g, ' ')}</option>)}
                {classNames.map((c) => <option key={c} value={`${CLASS_PREFIX}${c}`}>every {c}</option>)}
                <option value="*">any instrument</option>
              </select>
              <span className="text-xs text-gray-500 dark:text-gray-400">is about to</span>
              <select value={rule.when.method} aria-label="Method"
                onChange={(e) => setRule(index, { when: { ...rule.when, method: e.target.value } })}
                className={`${inputClass} w-48`}>
                <option value="*">do anything</option>
                {!methodsOf(rule.when.target).includes(rule.when.method) && rule.when.method !== '*' && <option value={rule.when.method}>{methodLabel(rule.when.method)}</option>}
                {methodsOf(rule.when.target).map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}
              </select>
            </div>
          </div>

          <div className="flex gap-3">
            <span className={label} title="Optional. The rule only applies when all of these hold.">Only if</span>
            {clausesEditor(rule, index, 'if')}
          </div>

          <div className="flex gap-3">
            <span className={label}>Require</span>
            {clausesEditor(rule, index, 'require')}
          </div>

          <div className="flex gap-3">
            <span className={label}>Otherwise</span>
            <input value={rule.message} onChange={(e) => setRule(index, { message: e.target.value })}
              placeholder="block it, and say: (what the person should do)" className={`${inputClass} flex-1`} />
          </div>
        </section>
      ))}
    </div>
  );
}
