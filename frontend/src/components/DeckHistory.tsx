"use client";

import { useEffect, useRef, useState } from 'react';
import { History } from 'lucide-react';
import { API_BASE } from '@/config';

type DeckVersionEntry = { version: number; first_seen: number; last_seen: number; instruments: string[] };
type DeckChange = {
  change: string;
  instrument: string;
  method?: string;
  param?: string;
  before?: any;
  after?: any;
};

const when = (epochSeconds: number) =>
  epochSeconds ? new Date(epochSeconds * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';

const paramSummary = (p: any) => (p ? `${p.type || 'any'}${p.required ? ', required' : ''}` : '');

/** One change as a line a person fixing a workflow can act on. */
function describe(c: DeckChange): { sign: '+' | '−' | '~'; text: string } {
  const call = c.method ? `${c.instrument}.${c.method}` : c.instrument;
  switch (c.change) {
    case 'instrument_added': return { sign: '+', text: `instrument ${c.instrument}` };
    case 'instrument_removed': return { sign: '−', text: `instrument ${c.instrument}` };
    case 'method_added': return { sign: '+', text: `${call}()` };
    case 'method_removed': return { sign: '−', text: `${call}()` };
    case 'param_added': return { sign: '+', text: `${call}(${c.param}: ${paramSummary(c.after)})` };
    case 'param_removed': return { sign: '−', text: `${call}(${c.param})` };
    case 'param_changed': {
      const parts: string[] = [];
      if (c.before?.type !== c.after?.type) parts.push(`${c.before?.type || 'any'} → ${c.after?.type || 'any'}`);
      if (!!c.before?.required !== !!c.after?.required) parts.push(c.after?.required ? 'now required' : 'now optional');
      if (JSON.stringify(c.before?.options) !== JSON.stringify(c.after?.options)) parts.push('choices changed');
      return { sign: '~', text: `${call}(${c.param}): ${parts.join(', ')}` };
    }
    case 'returns_changed': return { sign: '~', text: `${call} returns ${c.before ?? 'nothing'} → ${c.after ?? 'nothing'}` };
    default: return { sign: '~', text: `${call} ${c.change}` };
  }
}

const SIGN_CLASS = {
  '+': 'text-green-600 dark:text-green-400',
  '−': 'text-red-600 dark:text-red-400',
  '~': 'text-amber-600 dark:text-amber-400',
};

/**
 * The deck's recorded versions and what changed between any two of them.
 *
 * A new version is recorded at startup only when the drivers' introspected schema actually
 * changed (edge_server/ivoryos_edge/deck.py). Runs and saved workflows are stamped with the
 * version they used, so this is where "written for deck v3" in the Library gets explained.
 */
export default function DeckHistory() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [versions, setVersions] = useState<DeckVersionEntry[]>([]);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [changes, setChanges] = useState<DeckChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/deck`)
      .then(r => r.json())
      .then(d => {
        setCurrent(d.version ?? null);
        setVersions(d.versions || []);
        if (d.version) {
          setTo(d.version);
          setFrom(d.version > 1 ? d.version - 1 : null);
        }
      })
      .catch(() => setError('Could not load deck versions.'));
  }, []);

  useEffect(() => {
    if (!open || to === null || from === null) { setChanges(null); return; }
    fetch(`${API_BASE}/api/deck/diff?to=${to}&frm=${from}`)
      .then(r => r.json())
      .then(d => setChanges(d.changes || []))
      .catch(() => setError('Could not compare those versions.'));
  }, [open, from, to]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (current === null) return null;

  const option = (v: DeckVersionEntry) => (
    <option key={v.version} value={v.version}>v{v.version} · {when(v.first_seen)}</option>
  );

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title="Recorded versions of this deck's instruments, and what changed between them"
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium bg-white border-gray-200 text-gray-600 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10"
      >
        <History className="w-3.5 h-3.5" />
        deck v{current}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-[30rem] max-w-[90vw] rounded-xl border border-gray-200 bg-white shadow-xl dark:border-white/10 dark:bg-[#1a1a1a]">
          <div className="px-4 py-3 border-b border-gray-100 dark:border-white/5">
            <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">Deck history</div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              A new version is recorded whenever the drivers change. Runs and saved workflows remember theirs.
            </div>
          </div>
          {error ? (
            <p className="px-4 py-3 text-xs text-red-600">{error}</p>
          ) : versions.length < 2 ? (
            <p className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
              Only one version recorded so far ({when(versions[0]?.first_seen || 0)}). Changes appear here after a driver update.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2 px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
                <span>compare</span>
                <select
                  value={from ?? ''}
                  onChange={e => setFrom(Number(e.target.value))}
                  className="rounded-md border border-gray-200 bg-white px-1.5 py-1 text-xs dark:border-white/10 dark:bg-black/40"
                >
                  {versions.filter(v => v.version !== to).map(option)}
                </select>
                <span>→</span>
                <select
                  value={to ?? ''}
                  onChange={e => setTo(Number(e.target.value))}
                  className="rounded-md border border-gray-200 bg-white px-1.5 py-1 text-xs dark:border-white/10 dark:bg-black/40"
                >
                  {versions.filter(v => v.version !== from).map(option)}
                </select>
              </div>
              <div className="max-h-[50vh] overflow-y-auto px-4 pb-3">
                {changes === null ? (
                  <p className="text-xs text-gray-400">Comparing…</p>
                ) : changes.length === 0 ? (
                  <p className="text-xs text-gray-500">No changes a workflow depends on (descriptions may differ).</p>
                ) : (
                  <ul className="space-y-0.5 font-mono text-[11px]">
                    {changes.map((c, i) => {
                      const { sign, text } = describe(c);
                      return (
                        <li key={i} className="flex gap-2 min-w-0">
                          <span className={`shrink-0 font-bold ${SIGN_CLASS[sign]}`}>{sign}</span>
                          <span className="text-gray-700 dark:text-gray-300 break-all">{text}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
