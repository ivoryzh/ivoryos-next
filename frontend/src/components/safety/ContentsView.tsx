"use client";
import { API_BASE } from '@/config';

import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { notify } from '@ivoryos/shared-ui';
import { cardClass, ghostButton, inputClass, type PositionNow, type TrayNow } from './model';

const fmt = (n: number | undefined) => (n === undefined ? '' : `${Math.round(n * 1000) / 1000}`);

const describe = (p: PositionNow, unit: string) => {
  if (p.unknown) return `not known: ${p.unknown}`;
  if (p.vacant) return 'no vessel';
  const what = Object.entries(p.liquids || {}).map(([k, v]) => `${k} ${fmt(v)}`).join(', ');
  const of = p.capacity !== undefined ? ` of ${fmt(p.capacity)}` : '';
  return `${fmt(p.volume)}${of} ${unit}${what ? ` (${what})` : ''}${p.from ? `, the vessel from ${p.from}` : ''}`;
};

/**
 * Contents: what each position holds now (edge: contents.py), as the checks see it.
 *
 * A tray IvoryOS keeps is a record the transfers change as calls finish; a person sets it here the
 * first time, after loading vials by hand, or when a call that failed left a position unknown. A
 * tray the deck keeps is read from the deck as this page opens: what its vessels hold is the deck's
 * to change, and only where a vessel is (in its place, or taken away) is said here. Shows the saved
 * configuration, so a tray just added appears once the page is saved.
 */
export default function ContentsView({ unsaved }: { unsaved: boolean }) {
  const [trays, setTrays] = useState<Record<string, TrayNow>>({});
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{ tray: string; position: string; rows: { name: string; amount: string }[] } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetch(`${API_BASE}/api/safety/contents`).then((r) => r.json());
      setTrays(data.trays || {});
    } catch { /* shown as empty */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const send = async (body: Record<string, unknown>) => {
    const res = await fetch(`${API_BASE}/api/safety/contents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { await notify(data.error || 'Could not set it.', { title: 'Not set', tone: 'error' }); return false; }
    setTrays(data.trays || {});
    return true;
  };

  const open = (tray: string, position: string, now: PositionNow) => setEditing({
    tray, position,
    rows: Object.entries(now.liquids || {}).map(([name, amount]) => ({ name, amount: fmt(amount) })).concat(
      Object.keys(now.liquids || {}).length ? [] : [{ name: '', amount: '' }]),
  });

  const saveEdit = async () => {
    if (!editing) return;
    const liquids = Object.fromEntries(editing.rows.filter((r) => r.name.trim() && r.amount !== '').map((r) => [r.name.trim(), Number(r.amount)]));
    if (await send({ tray: editing.tray, position: editing.position, liquids })) setEditing(null);
  };

  const names = Object.keys(trays);

  return (
    <div className="space-y-4 overflow-y-auto pb-6 pr-1">
      <div className="flex items-center gap-2">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          What each position holds now, as the checks see it. {unsaved && 'Save the page to see changes to Trays here.'}
        </p>
        <button type="button" onClick={refresh} title="Read again" aria-label="Read again" className="ml-auto rounded-lg p-2 text-gray-400 hover:bg-gray-200/60 hover:text-gray-700 dark:hover:bg-white/10">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {names.length === 0 && !loading && (
        <p className="max-w-xl text-sm text-gray-500 dark:text-gray-400">
          No tray holds anything tracked yet. On Trays, say which hold vessels (and their capacity) and which are a stock;
          on Transfers, which calls move liquid between them.
        </p>
      )}

      {names.map((id) => {
        const tray = trays[id];
        const settable = tray.role === 'vessels';
        const deckKept = tray.kept_by === 'deck';
        const columns = tray.grid[0]?.length || 1;
        const size = columns > 12 ? 'h-7 w-7 text-[8px]' : 'h-10 w-10 text-[10px]';
        return (
          <section key={id} className={`${cardClass} p-4`}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{tray.label}</h3>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {tray.role === 'stock' ? 'a stock' : `vessels${tray.capacity !== undefined ? ` of ${fmt(tray.capacity)} ${tray.unit}` : ''}`}
                {' · '}
                {tray.kept_by === 'deck'
                  ? <>read from the deck: <span className="font-mono">{tray.read?.from}</span></>
                  : 'kept by IvoryOS'}
              </span>
              {settable && (
                <span className="ml-auto flex items-center gap-1.5">
                  <button type="button" className={ghostButton}
                    title={deckKept ? 'Every vessel back in its own place' : 'As nobody had recorded it: an empty vessel, or nothing, as the tray says'}
                    onClick={() => send({ tray: id, reset: 'empty' })}>{deckKept ? 'Mark all in place' : 'Mark all empty'}</button>
                  <button type="button" className={ghostButton} title="Every position blocks until someone says what it holds"
                    onClick={() => send({ tray: id, reset: 'unknown' })}>Mark all not known</button>
                </span>
              )}
            </div>

            <div className="mt-3 overflow-x-auto">
              <div className="inline-grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, max-content)` }}>
                {tray.grid.flat().map((position) => {
                  const now = tray.positions[position] || {};
                  const share = now.capacity ? Math.min(1, (now.volume || 0) / now.capacity) : (now.volume ? 0.5 : 0);
                  const tone = now.unknown
                    ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
                    : now.vacant
                      ? 'border-dashed border-gray-300 text-gray-300 dark:border-white/15 dark:text-gray-600'
                      : 'border-gray-300 text-gray-700 dark:border-white/20 dark:text-gray-200';
                  const title = tray.role === 'stock' ? `${position}: ${now.liquid}` : `${position}: ${describe(now, tray.unit)}${now.by ? ` · marked by ${now.by}` : ''}`;
                  return (
                    <button key={position} type="button" title={title} disabled={!settable}
                      onClick={() => settable && open(id, position, now)}
                      className={`${size} relative flex items-center justify-center overflow-hidden rounded-full border font-mono leading-none ${tone} ${settable ? 'hover:border-accent' : 'cursor-default'} ${
                        editing?.tray === id && editing.position === position ? 'ring-2 ring-accent/60' : ''}`}>
                      {tray.role !== 'stock' && !now.unknown && !now.vacant && (
                        <span aria-hidden className="absolute inset-x-0 bottom-0 bg-accent/30" style={{ height: `${share * 100}%` }} />
                      )}
                      <span className="relative">{position}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* A stock's reagents in full: a name cut to fit a circle reads as nothing. */}
            {tray.role === 'stock' && (
              <p className="mt-2 text-[11px] leading-5 text-gray-500 dark:text-gray-400">
                {tray.grid.flat().map((position) => (
                  <span key={position} className="mr-3 inline-block whitespace-nowrap">
                    <span className="font-mono text-gray-400">{position}</span> {tray.positions[position]?.liquid || '-'}
                  </span>
                ))}
              </p>
            )}

            {editing?.tray === id && deckKept && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-xl border border-gray-200 p-3 text-xs dark:border-white/10">
                <span className="mr-1 font-medium text-gray-700 dark:text-gray-200">{tray.label} {editing.position}:</span>
                <span className="text-gray-500">what it holds is the deck&rsquo;s record; say where its vessel is</span>
                <span className="ml-auto" />
                <button type="button" className={ghostButton} onClick={async () => { if (await send({ tray: id, position: editing.position, present: true })) setEditing(null); }}>In its place</button>
                {tray.grid.flat().length > 1 && (
                  <button type="button" className={ghostButton} onClick={async () => { if (await send({ tray: id, position: editing.position, vacant: true })) setEditing(null); }}>Taken away</button>
                )}
                <button type="button" className={ghostButton} onClick={async () => { if (await send({ tray: id, position: editing.position, unknown: true })) setEditing(null); }}>Not known</button>
                <button type="button" onClick={() => setEditing(null)} className="rounded-lg px-3 py-1.5 font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">Cancel</button>
              </div>
            )}

            {editing?.tray === id && !deckKept && (
              <div className="mt-3 space-y-1.5 rounded-xl border border-gray-200 p-3 text-xs dark:border-white/10">
                <p className="font-medium text-gray-700 dark:text-gray-200">{tray.label} {editing.position} holds</p>
                {editing.rows.map((row, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input value={row.name} placeholder="liquid, e.g. water" aria-label="Liquid"
                      onChange={(e) => setEditing({ ...editing, rows: editing.rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)) })}
                      className={`${inputClass} w-40`} />
                    <input value={row.amount} placeholder="0" inputMode="decimal" aria-label={`Amount in ${tray.unit}`}
                      onChange={(e) => setEditing({ ...editing, rows: editing.rows.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)) })}
                      className={`${inputClass} w-20 font-mono`} />
                    <span className="text-gray-500">{tray.unit}</span>
                    <button type="button" aria-label="Remove" onClick={() => setEditing({ ...editing, rows: editing.rows.filter((_, j) => j !== i) })}
                      className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-white/10"><X className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <button type="button" onClick={() => setEditing({ ...editing, rows: [...editing.rows, { name: '', amount: '' }] })}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-fg hover:underline"><Plus className="h-3 w-3" /> a liquid</button>
                  <span className="mx-1 text-gray-300">|</span>
                  <button type="button" className={ghostButton} onClick={async () => { if (await send({ tray: id, position: editing.position, liquids: {} })) setEditing(null); }}>Empty vessel</button>
                  <button type="button" className={ghostButton} onClick={async () => { if (await send({ tray: id, position: editing.position, vacant: true })) setEditing(null); }}>No vessel</button>
                  <button type="button" className={ghostButton} onClick={async () => { if (await send({ tray: id, position: editing.position, unknown: true })) setEditing(null); }}>Not known</button>
                  <span className="ml-auto" />
                  <button type="button" onClick={() => setEditing(null)} className="rounded-lg px-3 py-1.5 font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">Cancel</button>
                  <button type="button" onClick={saveEdit} className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-on-accent hover:bg-accent-hover">Set</button>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
