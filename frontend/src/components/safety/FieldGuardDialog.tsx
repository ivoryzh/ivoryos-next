"use client";
import { API_BASE } from '@/config';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, ShieldCheck, X } from 'lucide-react';
import type { SafetyView } from '@ivoryos/shared-ui';
import { LimitControls } from './LimitsEditor';
import { CLASS_PREFIX, ghostButton, limitFor, methodLabel, patchLimit, type Limit, type Problem, type SafetyConfig, type SafetyInfo } from './model';

export type GuardedField = { instrument: string; method: string; param: string; info: any };

/**
 * One field's limit, set from beside the field (the Instruments page): its range and unit, or
 * whichever of the Safety page's controls fit the field (LimitControls, the same ones). The rest of
 * the configuration is not touched here, but it is saved whole, as the Safety page saves it: read
 * fresh when the dialog opens, this one limit changed, written back. The edge checks it on the
 * way in; a refusal is shown here and nothing changes.
 */
export default function FieldGuardDialog({ field, onSaved, onClose }: {
  field: GuardedField;
  /** The guard as it now stands on the deck (what /api/status carries as `safety`). */
  onSaved: (resolved: SafetyView) => void;
  onClose: () => void;
}) {
  const { instrument, method, param, info } = field;
  const [loaded, setLoaded] = useState<SafetyInfo | null>(null);
  const [draft, setDraft] = useState<SafetyConfig | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/safety`).then((r) => r.json()).then((data) => {
      if (!data?.config) { setFailed(data?.error || 'This edge has no safety guard.'); return; }
      if (data.load_error) { setFailed(`The safety configuration could not be read (${data.load_error}). Fix or replace it on the Safety page.`); return; }
      setLoaded(data);
      setDraft(data.config);
    }).catch(() => setFailed('Could not reach the edge.'));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const classes = loaded?.classes[instrument] || [];
  const limit = draft ? limitFor(draft, classes, instrument, method, param) : undefined;
  const shared = !!limit && limit.target.startsWith(CLASS_PREFIX);
  const set = (patch: Partial<Limit>) =>
    setDraft((d) => (d ? patchLimit(d, classes, instrument, method, param, patch) : d));
  const changed = !!draft && !!loaded && JSON.stringify(draft) !== JSON.stringify(loaded.config);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setProblems([]);
    try {
      const res = await fetch(`${API_BASE}/api/safety`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: draft }),
      });
      const data = await res.json();
      if (!res.ok) {
        setProblems(data.problems?.length ? data.problems : [{ level: 'error', where: '', message: data.error || 'The edge refused this limit.' }]);
        return;
      }
      onSaved(data.resolved);
      onClose();
    } catch {
      setProblems([{ level: 'error', where: '', message: 'Could not reach the edge.' }]);
    } finally {
      setSaving(false);
    }
  };

  const errors = problems.filter((p) => p.level === 'error');
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label={`Limit on ${param}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#141414]"
      >
        <div className="flex items-start gap-3 border-b border-gray-100 px-5 py-4 dark:border-white/10">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent-fg" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Limit on <span className="font-mono">{param}</span>
            </div>
            <div className="truncate text-xs capitalize text-gray-500 dark:text-gray-400">
              {instrument.replace(/_/g, ' ')} · {methodLabel(method)}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          {failed ? (
            <p className="text-sm text-red-600 dark:text-red-400">{failed}</p>
          ) : !draft ? (
            <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Reading the safety configuration…</div>
          ) : (
            <>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                The edge refuses a call with a value outside this, from this page, a workflow or the Optimizer. The unit is a label: nothing is converted.
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <LimitControls rowKey={`${instrument}.${method}.${param}`} path={param} info={info} limit={limit} set={set} trays={draft.trays} />
              </div>
              {limit && classes[0] && (
                <label
                  className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"
                  title={`One limit for every instrument built from ${classes[0]}, instead of this one only`}
                >
                  <input
                    type="checkbox" className="accent-accent" checked={shared}
                    onChange={(e) => set({ target: e.target.checked ? `${CLASS_PREFIX}${classes[0]}` : instrument })}
                  />
                  The same for every <span className="font-mono">{classes[0]}</span>
                </label>
              )}
              {errors.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-xs text-red-600 dark:text-red-400">
                  {errors.map((p, i) => <li key={i}>{p.message}</li>)}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-gray-100 px-5 py-3 dark:border-white/10">
          <Link href="/safety" className="text-xs text-gray-500 hover:text-gray-800 hover:underline dark:text-gray-400 dark:hover:text-gray-200">
            All limits, trays and rules on the Safety page
          </Link>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={ghostButton}>Cancel</button>
          <button
            type="button" onClick={save} disabled={!changed || saving}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
