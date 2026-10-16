"use client";

import { Plus, Trash2 } from 'lucide-react';
import {
  CLASS_PREFIX, VOLUME_UNITS, cardClass, ghostButton, inputClass, leafParams, methodLabel, targetLabel,
  type Operand, type SafetyConfig, type Schema, type SideSpec, type Transfer,
} from './model';

const keyOf = (operand: Operand | undefined) =>
  !operand ? 'none' : operand.arg !== undefined ? `arg:${operand.arg}` : 'value';

/**
 * Transfers: which calls move liquid, or a whole vessel, between trays (edge: contents.py).
 *
 * Nothing in `charge_liquid(volume_ml, source_tray, source_index, ...)` says it moves liquid, so it
 * is said here, once per method, the way a state lists the calls that set it: how much (an argument
 * and its unit), from which tray and position, to which. A method that moves several things lists
 * one transfer each, in order. Only the step a workflow calls is seen, never the calls inside it.
 *
 * The deck's own signatures suggest the common ones (a volume, a source and a destination).
 */
export default function TransfersEditor({ config, onChange, schema, classes, suggested }: {
  config: SafetyConfig;
  onChange: (next: SafetyConfig) => void;
  schema: Schema;
  classes: Record<string, string[]>;
  suggested: Transfer[];
}) {
  const transfers = config.transfers || [];
  const instruments = Object.keys(schema);
  const sharedClasses = Array.from(new Set(instruments.map((i) => (classes[i] || [])[0]).filter(Boolean)))
    .filter((cls) => instruments.filter((i) => (classes[i] || [])[0] === cls).length > 1);
  const matching = (target: string) => (target.startsWith(CLASS_PREFIX)
    ? instruments.filter((i) => (classes[i] || []).includes(target.slice(CLASS_PREFIX.length)))
    : [target]);
  const methodsOf = (target: string) => Array.from(new Set(matching(target).flatMap((i) => Object.keys(schema[i] || {}))));
  const argsOf = (target: string, method: string) =>
    Array.from(new Set(matching(target).flatMap((i) => leafParams(schema[i]?.[method]).map((p) => p.path))));
  const held = Object.entries(config.trays).filter(([, t]) => t.contents);

  const setAll = (next: Transfer[]) => onChange({ ...config, transfers: next });
  const patch = (index: number, change: Partial<Transfer>) =>
    setAll(transfers.map((t, i) => (i === index ? { ...t, ...change } : t)));
  const add = (transfer: Transfer) => setAll([...transfers, { ...transfer, id: Math.random().toString(36).slice(2, 10) }]);
  const blank = (): Transfer => {
    const target = instruments[0] || '';
    return { id: '', name: '', enabled: true, when: { target, method: methodsOf(target)[0] || '' }, moves: 'liquid',
      amount: { arg: '' }, unit: 'mL', from: { tray: { arg: '' } }, to: { tray: { arg: '' } }, if: [] };
  };
  const offered = suggested.filter((s) => !transfers.some((t) => t.when.target === s.when.target && t.when.method === s.when.method));
  const label = 'w-16 shrink-0 text-[11px] font-bold uppercase tracking-wider text-gray-400';

  // Plain functions rather than components, so a field being typed in is not remounted.
  const operandPicker = (operand: Operand | undefined, args: string[], onSet: (o: Operand | undefined) => void,
    fixed: 'number' | 'text' | 'tray', allowNone: string | null, aria: string) => {
    const key = keyOf(operand);
    return (
      <span className="inline-flex items-center gap-1">
        <select value={key} aria-label={aria}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'none') onSet(undefined);
            else if (v === 'value') onSet({ value: fixed === 'tray' ? (held[0]?.[0] ?? '') : '' });
            else onSet({ arg: v.slice(4) });
          }}
          className={`${inputClass} w-52 font-mono`}>
          {allowNone !== null && <option value="none">{allowNone}</option>}
          {key.startsWith('arg:') && !args.includes(operand!.arg!) && <option value={key}>{operand!.arg || 'choose an argument'}</option>}
          {args.map((a) => <option key={a} value={`arg:${a}`}>its {a}</option>)}
          <option value="value">{fixed === 'tray' ? 'always the tray…' : 'a fixed value…'}</option>
        </select>
        {key === 'value' && fixed === 'tray' && (
          <select value={String(operand!.value ?? '')} aria-label={`${aria}: which tray`} onChange={(e) => onSet({ value: e.target.value })} className={`${inputClass} w-52`}>
            {!held.some(([id]) => id === operand!.value) && <option value={String(operand!.value ?? '')}>{String(operand!.value || 'choose')}</option>}
            {held.map(([id, t]) => <option key={id} value={id}>{t.label || id}</option>)}
          </select>
        )}
        {key === 'value' && fixed !== 'tray' && (
          <input value={String(operand!.value ?? '')} aria-label={`${aria}: value`} inputMode={fixed === 'number' ? 'decimal' : undefined}
            onChange={(e) => onSet({ value: fixed === 'number' && e.target.value !== '' && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value })}
            className={`${inputClass} w-20 font-mono`} />
        )}
      </span>
    );
  };

  const sidePicker = (side: SideSpec | undefined, args: string[], onSet: (s: SideSpec | undefined) => void, part: string, optional: boolean) => (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {operandPicker(side?.tray, args, (tray) => onSet(tray ? { ...(side || {}), tray } : undefined), 'tray', optional ? 'nowhere tracked' : null, `Tray it moves ${part}`)}
      {side && (
        <>
          <span>at</span>
          {operandPicker(side.position, args, (position) => onSet({ ...side, ...(position ? { position } : { position: undefined }) }),
            'text', 'its only position, or the deck picks', `Position it moves ${part}`)}
        </>
      )}
    </span>
  );

  return (
    <div className="space-y-4 overflow-y-auto pb-6 pr-1">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => add(blank())} className={`${ghostButton} inline-flex shrink-0 items-center gap-1 whitespace-nowrap`}>
          <Plus className="h-3 w-3" /> Add a transfer
        </button>
        {offered.length > 0 && (
          <>
            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400" title="Methods taking a volume, a source and a destination">This deck suggests</span>
            {offered.map((s) => (
              <button key={`${s.when.target}.${s.when.method}`} type="button" onClick={() => add(s)}
                title={`${s.when.target}.${s.when.method}: ${s.moves === 'vessel' ? 'carries a vessel' : `moves its ${s.amount?.arg}`}`}
                className="inline-flex items-center gap-1 rounded-full border border-accent-tint bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent hover:text-on-accent">
                <Plus className="h-3 w-3" /> {targetLabel(s.when.target)} {methodLabel(s.when.method)}
              </button>
            ))}
          </>
        )}
      </div>

      {transfers.length === 0 && (
        <p className="max-w-xl text-sm text-gray-500 dark:text-gray-400">
          No transfers yet. A transfer says that a method moves liquid (how much, from where, to where) or carries a vessel.
          With trays that hold vessels (Trays), a call that would overflow one, draw more than one holds, or pour where there is
          no vessel is then refused, and a run is walked through before it starts.
          {held.length === 0 && ' Start on Trays: say which hold vessels and which are a stock.'}
        </p>
      )}

      {transfers.map((transfer, index) => {
        const args = argsOf(transfer.when.target, transfer.when.method);
        return (
          <section key={transfer.id || index} className={`${cardClass} space-y-2.5 p-4 ${transfer.enabled ? '' : 'opacity-60'}`}>
            <div className="flex items-center gap-3">
              <input value={transfer.name} onChange={(e) => patch(index, { name: e.target.value })}
                placeholder={`${transfer.when.target}.${transfer.when.method}`} aria-label="Transfer name"
                className={`${inputClass} w-56 text-sm font-semibold`} />
              <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                <input type="checkbox" checked={transfer.enabled} onChange={(e) => patch(index, { enabled: e.target.checked })} className="accent-accent" />
                checked
              </label>
              <button type="button" onClick={() => setAll(transfers.filter((_, i) => i !== index))} aria-label="Remove this transfer" title="Remove this transfer"
                className="ml-auto rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-white/10">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <span className={label}>When</span>
              <select value={transfer.when.target} aria-label="Instrument"
                onChange={(e) => patch(index, { when: { target: e.target.value, method: methodsOf(e.target.value).includes(transfer.when.method) ? transfer.when.method : methodsOf(e.target.value)[0] || '' } })}
                className={`${inputClass} w-36`}>
                {![...instruments, ...sharedClasses.map((c) => `${CLASS_PREFIX}${c}`)].includes(transfer.when.target) && <option value={transfer.when.target}>{transfer.when.target || 'choose'}</option>}
                {instruments.map((i) => <option key={i} value={i}>{i.replace(/_/g, ' ')}</option>)}
                {sharedClasses.map((c) => <option key={c} value={`${CLASS_PREFIX}${c}`}>every {c}</option>)}
              </select>
              <select value={transfer.when.method} aria-label="Method" onChange={(e) => patch(index, { when: { ...transfer.when, method: e.target.value } })} className={`${inputClass} w-44`}>
                {!methodsOf(transfer.when.target).includes(transfer.when.method) && <option value={transfer.when.method}>{transfer.when.method || 'choose a method'}</option>}
                {methodsOf(transfer.when.target).map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}
              </select>
              <span>runs, it moves</span>
              <select value={transfer.moves} aria-label="What it moves"
                onChange={(e) => patch(index, e.target.value === 'vessel'
                  ? { moves: 'vessel', amount: undefined, unit: undefined }
                  : { moves: 'liquid', amount: transfer.amount || { arg: '' }, unit: transfer.unit || 'mL' })}
                className={`${inputClass} w-32`}>
                <option value="liquid">liquid</option>
                <option value="vessel">a whole vessel</option>
              </select>
              {transfer.moves === 'liquid' && (
                <>
                  {operandPicker(transfer.amount, args, (amount) => patch(index, { amount }), 'number', null, 'How much')}
                  <select value={transfer.unit || 'mL'} aria-label="Unit of the amount" onChange={(e) => patch(index, { unit: e.target.value })} className={`${inputClass} w-16`}>
                    {VOLUME_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <span className={label}>From</span>
              {sidePicker(transfer.from, args, (from) => patch(index, { from }), 'from', transfer.moves === 'liquid')}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <span className={label}>To</span>
              {sidePicker(transfer.to, args, (to) => patch(index, { to }), 'to', transfer.moves === 'liquid')}
            </div>
            {transfer.if.length > 0 && (
              <p className="pl-[4.375rem] text-[11px] text-gray-500 dark:text-gray-400" title={JSON.stringify(transfer.if)}>
                Only when {transfer.if.length} condition{transfer.if.length === 1 ? ' holds' : 's hold'} (set in the file).
              </p>
            )}
          </section>
        );
      })}

      {transfers.length > 0 && (
        <p className="max-w-2xl text-[11px] text-gray-400 dark:text-gray-500">
          A tray argument left empty moves nothing, so an optional phase skips itself. A tray with no contents on Trays
          (a backing line, a drain) is not followed. A position left to the deck cannot be followed on a tray IvoryOS keeps.
        </p>
      )}
    </div>
  );
}
