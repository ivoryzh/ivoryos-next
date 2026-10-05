"use client";

import { Plus, Trash2 } from 'lucide-react';
import { confirmDialog, type SafetyView } from '@ivoryos/shared-ui';
import { cardClass, ghostButton, inputClass, slug, targetLabel, type SafetyConfig, type Tray } from './model';

const PRESETS: { label: string; tray: Tray }[] = [
  { label: '96-well plate', tray: { label: '96-well plate', rows: 8, columns: 12, naming: 'A1', order: 'row', blocked: [] } },
  { label: '24-vial rack', tray: { label: 'Vial rack', rows: 4, columns: 6, naming: 'A1', order: 'row', blocked: [] } },
  { label: '384-well plate', tray: { label: '384-well plate', rows: 16, columns: 24, naming: 'A1', order: 'row', blocked: [] } },
  { label: 'Custom', tray: { label: 'Tray', rows: 2, columns: 5, naming: '1', order: 'row', blocked: [] } },
];

const NAMINGS = [
  { value: 'A1', label: 'A1, A2 ... (letter row, number column)' },
  { value: 'A01', label: 'A01, A02 ... (padded)' },
  { value: '1', label: '1, 2, 3 ... (counted from 1)' },
  { value: '0', label: '0, 1, 2 ... (counted from 0)' },
];

/**
 * Trays: a rack or a plate as rows by columns, with how its positions are named. A field set to
 * "position on <tray>" (Limits) then takes only those positions, and is picked on a drawing of the
 * tray instead of typed. The drawing here comes from the edge's check of the draft, so the names
 * shown are the names the edge will accept.
 */
export default function TraysEditor({ config, onChange, resolved }: {
  config: SafetyConfig;
  onChange: (next: SafetyConfig) => void;
  /** The draft as the edge laid it out; lags a keystroke behind while it is being checked. */
  resolved: SafetyView | null;
}) {
  const names = Object.keys(config.trays);

  const add = (tray: Tray) => {
    let id = slug(tray.label);
    for (let n = 2; config.trays[id]; n++) id = `${slug(tray.label)}_${n}`;
    onChange({ ...config, trays: { ...config.trays, [id]: { ...tray, blocked: [] } } });
  };

  const patch = (id: string, change: Partial<Tray>) => {
    const next = { ...config.trays[id], ...change };
    // Renaming the positions or resizing the tray leaves old blocked names meaning nothing.
    if ('rows' in change || 'columns' in change || 'naming' in change || 'order' in change) next.blocked = [];
    onChange({ ...config, trays: { ...config.trays, [id]: next } });
  };

  const usedBy = (id: string) => config.limits.filter((l) => l.tray === id);

  const remove = async (id: string) => {
    const users = usedBy(id);
    if (users.length) {
      const ok = await confirmDialog(
        `${users.length === 1 ? 'One field uses' : `${users.length} fields use`} this tray. Removing it also stops checking ${users.length === 1 ? 'that field' : 'those fields'} against it.`,
        { title: `Remove ${config.trays[id].label || id}?`, confirmLabel: 'Remove', tone: 'danger' },
      );
      if (!ok) return;
    }
    const trays = { ...config.trays };
    delete trays[id];
    const limits = config.limits
      .map((l) => (l.tray === id ? (({ tray: _dropped, ...rest }) => rest)(l) : l))
      .filter((l) => 'min' in l || 'max' in l || 'allowed' in l || 'tray' in l);
    onChange({ ...config, trays, limits });
  };

  return (
    <div className="space-y-4 overflow-y-auto pb-6 pr-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500 dark:text-gray-400">Add</span>
        {PRESETS.map((preset) => (
          <button key={preset.label} type="button" onClick={() => add(preset.tray)} className={`${ghostButton} inline-flex items-center gap-1`}>
            <Plus className="h-3 w-3" /> {preset.label}
          </button>
        ))}
      </div>

      {names.length === 0 && (
        <p className="max-w-xl text-sm text-gray-500 dark:text-gray-400">
          No trays yet. Add the racks and plates on this deck, then on Limits set a field (a vial id, a well) to
          &ldquo;position on&rdquo; one. That field then takes only real positions, and Run fills a spreadsheet from the tray.
        </p>
      )}

      {names.map((id) => {
        const tray = config.trays[id];
        const grid = resolved?.trays?.[id]?.grid;
        const numbered = tray.naming === '1' || tray.naming === '0';
        const users = usedBy(id);
        const toggle = (position: string) =>
          onChange({ ...config, trays: { ...config.trays, [id]: {
            ...tray, blocked: tray.blocked.includes(position) ? tray.blocked.filter((p) => p !== position) : [...tray.blocked, position],
          } } });
        const cell = Number(tray.columns) > 24 ? 'h-4 w-4 text-[0px]' : Number(tray.columns) > 12 ? 'h-6 w-6 text-[8px]' : 'h-8 w-8 text-[10px]';
        return (
          <section key={id} className={`${cardClass} p-4`}>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                Name
                <input value={tray.label} onChange={(e) => patch(id, { label: e.target.value })} className={`${inputClass} mt-1 block w-44`} />
              </label>
              <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                Rows
                <input type="number" min={1} max={100} value={tray.rows} onChange={(e) => patch(id, { rows: e.target.value })} className={`${inputClass} mt-1 block w-16`} />
              </label>
              <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                Columns
                <input type="number" min={1} max={100} value={tray.columns} onChange={(e) => patch(id, { columns: e.target.value })} className={`${inputClass} mt-1 block w-16`} />
              </label>
              <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                Positions are named
                <select value={tray.naming} onChange={(e) => patch(id, { naming: e.target.value })} className={`${inputClass} mt-1 block w-64`}>
                  {NAMINGS.map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}
                </select>
              </label>
              {numbered && (
                <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                  Counted
                  <select value={tray.order} onChange={(e) => patch(id, { order: e.target.value })} className={`${inputClass} mt-1 block w-40`}>
                    <option value="row">along each row</option>
                    <option value="column">down each column</option>
                  </select>
                </label>
              )}
              <button type="button" onClick={() => remove(id)} title="Remove this tray" aria-label="Remove this tray" className="ml-auto rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-white/10">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            {grid ? (
              <div className="mt-4 overflow-x-auto">
                <div className="inline-grid gap-1" style={{ gridTemplateColumns: `repeat(${grid[0]?.length || 1}, max-content)` }}>
                  {grid.flat().map((position) => {
                    const off = tray.blocked.includes(position);
                    return (
                      <button
                        key={position}
                        type="button"
                        aria-pressed={off}
                        title={off ? `${position}: blocked. Click to allow.` : `${position}. Click to block.`}
                        onClick={() => toggle(position)}
                        className={`${cell} flex items-center justify-center rounded-full border font-mono leading-none ${
                          off
                            ? 'border-dashed border-red-300 bg-red-50 text-red-400 line-through dark:border-red-500/40 dark:bg-red-500/10'
                            : 'border-gray-300 text-gray-600 hover:border-red-300 dark:border-white/20 dark:text-gray-300'
                        }`}
                      >
                        {position}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="mt-4 text-xs text-gray-400">Give it rows and columns to see it.</p>
            )}

            <p className="mt-3 text-[11px] text-gray-500 dark:text-gray-400">
              <span className="font-mono">{id}</span>
              {' · '}
              {tray.blocked.length ? `${tray.blocked.length} blocked (${tray.blocked.join(', ')})` : 'click a position to block it'}
              {' · '}
              {users.length
                ? `used by ${users.map((l) => `${targetLabel(l.target)} ${l.method}.${l.param}`).join(', ')}`
                : 'not used by any field yet (set one on Limits)'}
            </p>
          </section>
        );
      })}
    </div>
  );
}
