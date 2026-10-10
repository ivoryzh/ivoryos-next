"use client";
import { API_BASE } from '@/config';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ShieldCheck, ShieldOff, Sparkles } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { confirmDialog, notify, useDocumentTheme, type SafetyView } from '@ivoryos/shared-ui';
import LimitsEditor from '@/components/safety/LimitsEditor';
import TraysEditor from '@/components/safety/TraysEditor';
import RulesEditor from '@/components/safety/RulesEditor';
import StatesEditor from '@/components/safety/StatesEditor';
import { emptyConfig, type Problem, type SafetyConfig, type SafetyInfo, type Schema } from '@/components/safety/model';
import { clearRequestParam, useAssistantPage, usePageRequest } from '@/assistant';

type Tab = 'limits' | 'trays' | 'states' | 'rules' | 'blocked';

/**
 * A safety proposal from the assistant (components/AssistantPanel.tsx, or an agent over MCP),
 * opened here to be read before anything is enforced: it is laid over the configuration in force
 * now (GET /api/agent/proposals/{id}/safety-draft) and put in the draft, unsaved. Saving the page
 * accepts it, as edited; discarding rejects it.
 */
type Suggestion = {
  id: number;
  summary: string;
  source: string;
  questions: string[];
  added: string[];
};

const addedLines = (add: any): string[] => [
  ...Object.keys(add?.states || {}).map((n) => `state ${n}`),
  ...(add?.limits || []).map((l: any) => `limit ${l.target}.${l.method}.${l.param}`),
  ...(add?.rules || []).map((r: any) => `rule "${r.name || 'unnamed'}"`),
];

/**
 * The safety guard: what this bench allows its instruments to do, kept outside the drivers
 * (edge: ivoryos_edge/safety.py).
 *
 * One draft, edited across three tabs and saved whole. The edge checks the draft as it changes and
 * the page shows what it says, rather than validating a second time here; a draft with an error
 * cannot be saved. Saving takes effect on the next call sent to an instrument.
 */
export default function SafetyPage() {
  const theme = useDocumentTheme();
  const [tab, setTab] = useState<Tab>('limits');
  const [info, setInfo] = useState<SafetyInfo | null>(null);
  const [schema, setSchema] = useState<Schema>({});
  const [draft, setDraft] = useState<SafetyConfig | null>(null);
  const [saved, setSaved] = useState('');
  const [problems, setProblems] = useState<Problem[]>([]);
  const [resolved, setResolved] = useState<SafetyView | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const checkSeq = useRef(0);
  // An assistant proposal being reviewed, and one asked for before the page had loaded.
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [pendingReview, setPendingReview] = useState<number | null>(null);
  usePageRequest('review-safety', setPendingReview);

  const adopt = useCallback((data: SafetyInfo) => {
    setInfo(data);
    setDraft(data.config);
    setSaved(JSON.stringify(data.config));
    setProblems(data.problems || []);
    setResolved(data.resolved);
  }, []);

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/api/safety`).then((r) => r.json()),
      fetch(`${API_BASE}/api/status`).then((r) => r.json()),
    ]).then(([safety, status]) => {
      // An edge from before the guard (or the tour's simulated one) answers with an error instead.
      if (!safety?.config) { setFailed(safety?.error || 'This edge has no safety guard.'); return; }
      adopt(safety);
      setSchema(status.instruments || {});
    }).catch(() => setFailed('Could not reach the edge.'));
  }, [adopt]);

  const dirty = !!draft && JSON.stringify(draft) !== saved;

  // The edge checks the draft a moment after it stops changing. Answers can arrive out of order;
  // only the newest is shown.
  useEffect(() => {
    if (!draft) return;
    const seq = ++checkSeq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/safety/check`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: draft }),
        });
        const data = await res.json();
        if (seq !== checkSeq.current) return;
        setProblems(data.problems || []);
        setResolved(data.resolved || null);
      } catch { /* the Save will say so */ }
    }, 250);
    return () => clearTimeout(timer);
  }, [draft]);

  const errors = problems.filter((p) => p.level === 'error');
  const warnings = problems.filter((p) => p.level === 'warning');

  const save = async (config: SafetyConfig) => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/safety`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }),
      });
      const data = await res.json();
      if (!res.ok) {
        setProblems(data.problems || []);
        await notify(data.error || 'The edge refused this configuration.', { title: 'Not saved', tone: 'error' });
        return;
      }
      adopt(data);
      if (suggestion) {
        // Saved as a person left it after reading: the proposal is recorded as accepted, nothing
        // more is written (the configuration just saved is the decision).
        await fetch(`${API_BASE}/api/agent/proposals/${suggestion.id}/accept`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ save: false }),
        }).catch(() => {});
        setSuggestion(null);
      }
    } catch {
      await notify('Could not reach the edge.', { title: 'Not saved', tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const discard = async () => {
    if (suggestion) {
      await fetch(`${API_BASE}/api/agent/proposals/${suggestion.id}/reject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'Discarded on the Safety page' }),
      }).catch(() => {});
      setSuggestion(null);
    }
    if (info) adopt(info);
  };

  // Open an assistant proposal in the draft, once the page has the configuration to lay it over.
  useEffect(() => {
    if (pendingReview === null || !info || !draft) return;
    const id = pendingReview;
    setPendingReview(null);
    clearRequestParam('review-safety');
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/agent/proposals/${id}/safety-draft`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'That suggestion could not be read.');
        const proposal = data.proposal;
        if (proposal.status !== 'pending') {
          await notify(`This suggestion was already ${proposal.status}.`, { title: 'Nothing to review' });
          return;
        }
        if (dirty && !(await confirmDialog('The page has changes you have not saved. Reviewing this suggestion replaces them.', { title: 'Replace your changes?', confirmLabel: 'Replace', tone: 'danger' }))) return;
        const add = proposal.payload?.add || {};
        setDraft(data.config);
        setProblems(data.problems || []);
        setSuggestion({ id, summary: proposal.summary, source: proposal.source, questions: proposal.payload?.questions || [], added: addedLines(add) });
        setTab(add.rules?.length ? 'rules' : Object.keys(add.states || {}).length ? 'states' : 'limits');
      } catch (e: any) {
        await notify(e.message, { title: 'Could not open the suggestion', tone: 'error' });
      }
    })();
  }, [pendingReview, info, draft, dirty]);

  useAssistantPage({
    page: 'safety',
    defaultMode: 'safety',
    describe: draft
      ? `The Safety page: ${draft.limits.length} limits, ${Object.keys(draft.states || {}).length} states and ${draft.rules.length} rules${dirty ? ', with unsaved changes' : ''}. The guard is ${draft.enabled ? 'on' : 'off'}.`
      : 'The Safety page.',
  }, [draft?.limits.length, draft?.rules.length, Object.keys(draft?.states || {}).length, draft?.enabled, dirty]);

  const toggleGuard = async () => {
    if (!draft) return;
    if (draft.enabled) {
      const ok = await confirmDialog(
        'With the guard off, nothing is checked: limits, tray positions and rules are all ignored until it is turned on again.',
        { title: 'Turn the safety guard off?', confirmLabel: 'Turn off', tone: 'danger' },
      );
      if (!ok) return;
    }
    setDraft({ ...draft, enabled: !draft.enabled });
  };

  const startOver = async () => {
    const ok = await confirmDialog(
      'This replaces the unreadable file with an empty configuration: no limits, no trays, no rules.',
      { title: 'Start over?', confirmLabel: 'Start over', tone: 'danger' },
    );
    if (ok) await save(emptyConfig());
  };

  const tabs: { key: Tab; label: string; count?: number }[] = draft ? [
    { key: 'limits', label: 'Limits', count: draft.limits.length },
    { key: 'trays', label: 'Trays', count: Object.keys(draft.trays).length },
    { key: 'states', label: 'States', count: Object.keys(draft.states || {}).length },
    { key: 'rules', label: 'Rules', count: draft.rules.length },
    { key: 'blocked', label: 'Blocked', count: info?.blocked.length },
  ] : [];

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-gray-100 dark:bg-transparent">
        <header data-ivoryos-page-header="mixed" className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-3 px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 data-ivoryos-page-title className="text-base font-medium text-gray-800 dark:text-gray-200">Safety</h2>
          {draft && (
            <>
              <button
                type="button"
                onClick={toggleGuard}
                title={draft.enabled ? 'Checked before every call to an instrument. Click to turn off.' : 'Nothing is being checked. Click to turn on.'}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider ${
                  draft.enabled
                    ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-500/30 dark:bg-green-900/30 dark:text-green-300'
                    : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-900/30 dark:text-red-300'
                }`}
              >
                {draft.enabled ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldOff className="h-3.5 w-3.5" />}
                {draft.enabled ? 'Guard on' : 'Guard off'}
              </button>
              <div className="ml-auto flex items-center gap-2">
                {dirty && <span className="text-xs text-gray-500 dark:text-gray-400">{errors.length ? `${errors.length} to fix before saving` : 'Not saved yet'}</span>}
                {dirty && (
                  <button type="button" onClick={discard} className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">Discard</button>
                )}
                <button
                  type="button"
                  disabled={!dirty || saving || errors.length > 0}
                  onClick={() => save(draft)}
                  className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-40"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </>
          )}
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
          {failed && <p className="text-sm text-red-600 dark:text-red-400">{failed}</p>}
          {!draft && !failed && <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>}

          {info?.load_error && (
            <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-500/30 dark:bg-red-900/20">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-semibold text-red-800 dark:text-red-200">Nothing can be sent to an instrument: the safety configuration cannot be read.</p>
                <p className="break-words font-mono text-xs text-red-700 dark:text-red-300">{info.load_error}</p>
                <p className="text-xs text-red-700 dark:text-red-300">Fix the file and restart the edge, or start over here.</p>
                <button type="button" onClick={startOver} className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700">Start over with an empty configuration</button>
              </div>
            </div>
          )}

          {draft && (
            <>
              <div className="flex items-center gap-1">
                {tabs.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${
                      tab === t.key ? 'bg-accent-soft text-accent-fg' : 'text-gray-600 hover:bg-gray-200/60 dark:text-gray-400 dark:hover:bg-white/5'
                    }`}
                  >
                    {t.label}
                    {!!t.count && <span className="rounded-full bg-gray-200 px-1.5 text-[10px] font-semibold text-gray-700 dark:bg-white/10 dark:text-gray-200">{t.count}</span>}
                  </button>
                ))}
                <p className="ml-auto hidden text-xs text-gray-400 dark:text-gray-500 lg:block">
                  Checked on the edge before a run starts and again as each step is sent.
                </p>
              </div>

              {/* An assistant proposal under review: in the tabs, unsaved, until Save or Discard. */}
              {suggestion && (
                <div className="flex shrink-0 items-start gap-3 rounded-xl border border-accent-tint bg-accent-soft/50 px-4 py-2.5 text-xs">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-gray-800 dark:text-gray-100">
                      <span className="font-semibold">Suggested by the assistant</span>{suggestion.source ? ` (${suggestion.source})` : ''}: {suggestion.summary || 'safety additions.'}
                    </p>
                    {suggestion.added.length > 0 && (
                      <p className="text-gray-600 dark:text-gray-300">Added, not saved yet: {suggestion.added.join(', ')}. Read it in the tabs, change anything you like, then Save to accept it.</p>
                    )}
                    {suggestion.questions.map((q, i) => <p key={i} className="text-amber-700 dark:text-amber-300">To decide: {q}</p>)}
                  </div>
                  <button type="button" onClick={discard} className="shrink-0 rounded-lg px-2 py-1 font-medium text-gray-600 hover:bg-white/60 dark:text-gray-300 dark:hover:bg-white/10">Discard suggestion</button>
                </div>
              )}

              {(errors.length > 0 || warnings.length > 0) && (
                <ul className="max-h-32 shrink-0 space-y-1 overflow-y-auto rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-xs dark:border-white/10 dark:bg-white/5">
                  {[...errors, ...warnings].map((p, i) => (
                    <li key={i} className={`flex items-start gap-2 ${p.level === 'error' ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'}`}>
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{p.message}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex min-h-0 flex-1 flex-col">
                {tab === 'limits' && <LimitsEditor config={draft} onChange={setDraft} schema={schema} classes={info?.classes || {}} />}
                {tab === 'trays' && <TraysEditor config={draft} onChange={setDraft} resolved={resolved} />}
                {tab === 'states' && (
                  <StatesEditor config={draft} onChange={setDraft} schema={schema} classes={info?.classes || {}}
                    suggested={info?.suggested_states || []} savedNames={Object.keys(info?.config.states || {})} />
                )}
                {tab === 'rules' && <RulesEditor config={draft} onChange={setDraft} schema={schema} classes={info?.classes || {}} />}
                {tab === 'blocked' && (
                  <div className="space-y-2 overflow-y-auto pb-6 pr-1">
                    {(info?.blocked.length || 0) === 0 ? (
                      <p className="text-sm text-gray-500 dark:text-gray-400">Nothing has been blocked since the edge started.</p>
                    ) : [...(info?.blocked || [])].reverse().map((b, i) => (
                      <div key={i} className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 dark:border-white/10 dark:bg-white/5">
                        <div className="flex flex-wrap items-baseline gap-x-3 text-xs">
                          <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">{b.instrument ? `${b.instrument}.${b.method}` : 'A run'}</span>
                          <span className="font-mono text-gray-500 dark:text-gray-400">{Object.entries(b.args || {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')}</span>
                          <span className="ml-auto text-gray-400">{b.source === 'manual' ? 'by hand' : b.source === 'start' ? 'refused before it started' : 'in a run'} · {new Date(b.ts * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' })}</span>
                        </div>
                        {b.problems.map((p, j) => <p key={j} className="mt-1 text-xs text-red-700 dark:text-red-300">{p}</p>)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
