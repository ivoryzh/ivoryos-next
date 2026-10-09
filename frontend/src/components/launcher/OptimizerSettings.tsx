"use client";
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { confirmDialog } from '@ivoryos/shared-ui';
import type { DesktopApi, OptimizerChoice, Profile } from '@/desktop';
import { installFailed } from './ReportProblem';
import { Button, cardClass, inputClass } from './ui';

type Selection = Record<string, string | null>;
type State = { catalog: OptimizerChoice[]; selected: Selection; installed: Selection; error: string | null };

/**
 * A deck's Bayesian optimizer backends (desktop/src/optimizers.js): Ax, BayBE and NIMO, each at a
 * version IvoryOS has tested. The choice is written to the deck's packages and installed with
 * them in one go, so a conflict is refused before anything changes; PyTorch comes as its CPU
 * build. Anything else belongs in the deck's packages or a terminal.
 */
export default function OptimizerSettings({ api, profile }: { api: DesktopApi; profile: Profile }) {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Selection>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.optimizers(profile.id)
      .then(s => { setState(s); setDraft(s.selected); })
      .catch(e => setState({ catalog: [], selected: {}, installed: {}, error: e.message }));
  }, [api, profile.id]);
  useEffect(() => { load(); }, [load]);

  if (!state) return null;
  const changed = state.catalog.some(o => (draft[o.id] ?? null) !== (state.selected[o.id] ?? null));

  const apply = async () => {
    if (profile.status.state === 'running'
      && !await confirmDialog('Installing restarts the deck. Continue?', { title: 'Restart the deck?', confirmLabel: 'Install and restart' })) return;
    setBusy(true);
    try {
      await api.setOptimizers(profile.id, draft);
    } catch (e: any) {
      await installFailed(api, 'Could not install the optimizers', e, profile.id);
    } finally {
      setBusy(false);
      load();
    }
  };

  return (
    <section className={`${cardClass} p-4 space-y-3`}>
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Optimizers</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">For the Optimize page. Versions tested with IvoryOS; PyTorch installs without GPU support. BayBE with chemistry adds substances (solvents, reagents by structure) and a few hundred MB.</p>
      </div>
      <div className="space-y-2">
        {state.catalog.map(o => {
          const value = draft[o.id] ?? '';
          const installed = state.installed[o.id];
          return (
            <div key={o.id} className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-sm font-medium text-gray-800 dark:text-gray-200">{o.name}</span>
              {/* inputClass is full width; the box sets the width so the status stays on one line. */}
              <div className="w-56 shrink-0">
              <select value={value} disabled={busy} onChange={e => setDraft(d => ({ ...d, [o.id]: e.target.value || null }))}
                className={inputClass} aria-label={`${o.name} version`}>
                <option value="">Not used</option>
                {value === 'any' && <option value="any">Any version (from the Hub)</option>}
                {o.versions.map((v, i) => <option key={v} value={v}>{v}{i === 0 ? ' · recommended' : ''}</option>)}
                {/* The same versions with an extra install (BayBE's chemistry, for substances). */}
                {Object.entries(o.extras || {}).flatMap(([extra, label]) => o.versions.map(v => (
                  <option key={`${v}[${extra}]`} value={`${v}[${extra}]`}>{v} {label}</option>
                )))}
              </select>
              </div>
              <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{installed ? `installed ${installed}` : 'not installed'}</span>
            </div>
          );
        })}
      </div>
      {state.error && <p className="text-xs text-amber-700 dark:text-amber-300">{state.error}</p>}
      <div className="flex items-center gap-3">
        <Button small tone="primary" disabled={!changed || busy} onClick={apply}>
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {busy ? 'Installing…' : 'Apply'}
        </Button>
        {changed && !busy && <span className="text-xs text-gray-500 dark:text-gray-400">Taking one out leaves it installed for other decks.</span>}
      </div>
    </section>
  );
}
