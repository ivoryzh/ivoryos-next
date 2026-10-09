"use client";
import { API_BASE } from '@/config';

import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Download, Lightbulb, Loader2, Pencil, Trash2, Undo2 } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { confirmDialog, notify, promptDialog, useDocumentTheme } from '@ivoryos/shared-ui';

type Row = {
  id: number;
  batch: number;
  suggested_at: string;
  values: Record<string, unknown>;
  results: Record<string, number> | null;
  note?: string;
  discarded?: boolean;
};

type CampaignData = {
  id: number;
  name: string;
  optimizer: string;
  created_at: string | null;
  done: number;
  waiting: number;
  parameters: {
    parameter_space?: { name: string }[];
    objective_config?: { name: string; minimize?: boolean }[];
    parameter_constraints?: string[];
    batch_size?: number;
  };
  rows: Row[];
};

const LABELS: Record<string, string> = { baybe: 'BayBE', ax: 'Ax (BoTorch)', nimo: 'NIMO' };

const show = (value: unknown) => {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(+value.toPrecision(5));
  return value === null || value === undefined ? '' : String(value);
};

const csvCell = (value: unknown) => {
  const text = show(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * A suggest-only campaign (edge campaigns.py): what the optimizer suggested, for people to run
 * their own way, with a cell per objective to type each result into whenever it is ready. Asking
 * for more builds the optimizer again from every result here, so there is nothing to keep open.
 */
function CampaignContent() {
  const id = useSearchParams().get('id');
  const router = useRouter();
  const theme = useDocumentTheme();
  const [campaign, setCampaign] = useState<CampaignData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  // What is being typed, by `${rowId}:${field}`, until it is saved on leaving the cell.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    if (!id) return;
    fetch(`${API_BASE}/api/campaigns/${id}`)
      .then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Not found'); return data; })
      .then(setCampaign)
      .catch(e => setFailed(e.message));
  }, [id]);
  useEffect(load, [load]);

  const params = useMemo(() => campaign?.parameters || {}, [campaign]);
  const names = (params.parameter_space || []).map(p => p.name);
  const objectives = useMemo(() => params.objective_config || [], [params]);
  const rows = useMemo(() => campaign?.rows || [], [campaign]);
  const howMany = count ?? Math.max(1, params.batch_size || 1);

  // The best result so far for each objective, among suggestions not set aside.
  const best = useMemo(() => {
    const out: Record<string, number> = {};
    for (const o of objectives) {
      for (const r of rows) {
        const v = r.results?.[o.name];
        if (r.discarded || typeof v !== 'number') continue;
        if (out[o.name] === undefined || (o.minimize ? v < out[o.name] : v > out[o.name])) out[o.name] = v;
      }
    }
    return out;
  }, [objectives, rows]);

  const save = async (row: Row, body: Record<string, unknown>, draftKey?: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/campaigns/${id}/rows/${row.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Not saved.');
      setCampaign(data);
      if (draftKey) setDrafts(d => { const next = { ...d }; delete next[draftKey]; return next; });
    } catch (e: any) {
      await notify(e.message, { title: 'Not saved', tone: 'error' });
    }
  };

  const suggestMore = async () => {
    setSuggesting(true);
    try {
      const res = await fetch(`${API_BASE}/api/campaigns/${id}/suggest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: howMany }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No suggestions.');
      setCampaign(data);
    } catch (e: any) {
      await notify(e.message, { title: 'Could not get suggestions', tone: 'error' });
    } finally {
      setSuggesting(false);
    }
  };

  const rename = async () => {
    const name = await promptDialog('What should this campaign be called?', { title: 'Rename campaign', defaultValue: campaign?.name, confirmLabel: 'Rename' });
    if (!name) return;
    const res = await fetch(`${API_BASE}/api/campaigns/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    if (res.ok) setCampaign(await res.json());
  };

  const remove = async () => {
    if (!await confirmDialog(`Delete "${campaign?.name}" and every result typed into it?`, { title: 'Delete campaign?', confirmLabel: 'Delete', tone: 'danger' })) return;
    await fetch(`${API_BASE}/api/campaigns/${id}`, { method: 'DELETE' });
    router.push('/optimize');
  };

  const exportCsv = () => {
    const header = ['suggestion', 'batch', ...names, ...objectives.map(o => o.name), 'note', 'set_aside'];
    const lines = rows.map(r => [r.id, r.batch, ...names.map(n => r.values[n]), ...objectives.map(o => r.results?.[o.name]), r.note || '', r.discarded ? 'yes' : '']
      .map(csvCell).join(','));
    const url = URL.createObjectURL(new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${(campaign?.name || 'campaign').replace(/[^\w.-]+/g, '_')}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const cell = 'px-3 py-1.5 border-b border-gray-100 dark:border-white/5';
  const input = 'w-full min-w-[5rem] bg-transparent border border-transparent hover:border-gray-200 focus:border-accent dark:hover:border-white/15 rounded-md px-2 py-1 text-xs font-mono outline-none';

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header data-ivoryos-page-header="mixed" className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-3 px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md">
          <Link href="/optimize" title="Back to Optimize" className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10"><ArrowLeft className="w-4 h-4" /></Link>
          <Lightbulb className="w-4 h-4 text-purple-500 shrink-0" />
          <h2 data-ivoryos-page-title className="text-sm font-bold truncate">{campaign?.name || 'Campaign'}</h2>
          {campaign && (
            <button type="button" onClick={rename} title="Rename" className="p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><Pencil className="w-3.5 h-3.5" /></button>
          )}
          {campaign && <span className="text-xs text-gray-400 truncate">{LABELS[campaign.optimizer] || campaign.optimizer} · suggest only</span>}
          <span className="flex-1" />
          {campaign && (
            <>
              <button type="button" onClick={exportCsv} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5"><Download className="w-3.5 h-3.5" /> Export CSV</button>
              <button type="button" onClick={remove} title="Delete this campaign" className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"><Trash2 className="w-4 h-4" /></button>
            </>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {failed ? (
            <p className="text-sm text-red-600 dark:text-red-400">{failed}</p>
          ) : !campaign ? (
            <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading the campaign…</div>
          ) : (
            <div className="max-w-6xl space-y-4">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Run these your own way and type each result in when it is ready, today or next week. Asking for more uses every result here;
                suggestions still waiting are left out of the next ones, so nothing is suggested twice.
              </p>
              {(params.parameter_constraints || []).length > 0 && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Kept to: {(params.parameter_constraints || []).map(c => <code key={c} className="mr-2 font-mono bg-gray-100 dark:bg-white/5 px-1 py-0.5 rounded">{c}</code>)}
                </p>
              )}

              <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111]">
                <table className="w-full text-left text-sm border-collapse">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-white/5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                      <th className={`${cell} w-12`}>#</th>
                      {names.map(n => <th key={n} className={`${cell} font-mono normal-case`}>{n}</th>)}
                      {objectives.map(o => (
                        <th key={o.name} className={`${cell} font-mono normal-case text-purple-700 dark:text-purple-300`} title={o.minimize ? 'Minimized' : 'Maximized'}>
                          {o.name} {o.minimize ? '↓' : '↑'}
                        </th>
                      ))}
                      <th className={cell}>Note</th>
                      <th className={`${cell} w-10`} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      const waiting = !r.discarded && objectives.some(o => typeof r.results?.[o.name] !== 'number');
                      return (
                        <tr key={r.id} className={`${r.discarded ? 'opacity-40' : ''} ${r.batch % 2 ? '' : 'bg-gray-50/60 dark:bg-white/[0.02]'}`}>
                          <td className={`${cell} text-xs text-gray-400 ${waiting ? 'border-l-2 border-l-amber-400' : ''}`} title={`Batch ${r.batch}, suggested ${new Date(r.suggested_at + 'Z').toLocaleString()}`}>
                            {r.id}
                          </td>
                          {names.map(n => <td key={n} className={`${cell} font-mono text-xs ${r.discarded ? 'line-through' : ''}`}>{show(r.values[n])}</td>)}
                          {objectives.map(o => {
                            const key = `${r.id}:${o.name}`;
                            const saved = r.results?.[o.name];
                            const isBest = typeof saved === 'number' && saved === best[o.name];
                            return (
                              <td key={o.name} className={cell}>
                                <input
                                  type="text" inputMode="decimal"
                                  disabled={r.discarded}
                                  placeholder={r.discarded ? '' : 'result'}
                                  value={drafts[key] ?? show(saved)}
                                  onChange={e => setDrafts(d => ({ ...d, [key]: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                  onBlur={() => { if (key in drafts && drafts[key] !== show(saved)) save(r, { results: { [o.name]: drafts[key] } }, key); }}
                                  title={isBest ? 'Best so far' : undefined}
                                  className={`${input} ${isBest ? 'font-semibold text-green-700 dark:text-green-400' : ''}`}
                                />
                              </td>
                            );
                          })}
                          <td className={cell}>
                            <input
                              type="text"
                              disabled={r.discarded}
                              placeholder=""
                              value={drafts[`${r.id}:note`] ?? (r.note || '')}
                              onChange={e => setDrafts(d => ({ ...d, [`${r.id}:note`]: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                              onBlur={() => { const k = `${r.id}:note`; if (k in drafts && drafts[k] !== (r.note || '')) save(r, { note: drafts[k] }, k); }}
                              className={`${input} font-sans`}
                            />
                          </td>
                          <td className={cell}>
                            <button
                              type="button"
                              onClick={() => save(r, { discarded: !r.discarded })}
                              title={r.discarded ? 'Bring it back' : 'Set aside: not run, so neither a result nor waiting'}
                              className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-white/10 dark:hover:text-gray-200"
                            >
                              {r.discarded ? <Undo2 className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button" onClick={suggestMore} disabled={suggesting}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-60"
                >
                  {suggesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lightbulb className="w-4 h-4" />}
                  {suggesting ? 'Fitting the model…' : `Suggest ${howMany} more`}
                </button>
                <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                  How many
                  <input type="number" min={1} max={100} value={howMany} onChange={e => setCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
                    className="w-16 h-7 bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-md px-2 text-xs outline-none focus:border-accent" />
                </label>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {campaign.done} with results{campaign.waiting ? ` · ${campaign.waiting} still waiting` : ''}
                  {Object.keys(best).length > 0 && ` · best ${objectives.filter(o => best[o.name] !== undefined).map(o => `${o.name} ${show(best[o.name])}`).join(', ')}`}
                </span>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default function CampaignPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-[#0a0a0a]"><Loader2 className="w-8 h-8 animate-spin text-gray-700 dark:text-gray-200" /></div>}>
      <CampaignContent />
    </Suspense>
  );
}
