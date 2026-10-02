"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Edge, Node } from '@xyflow/react';
import { AlertTriangle, Check, ChevronDown, Loader2, RefreshCw, Send, Settings2, Sparkles, Trash2, X } from 'lucide-react';

/**
 * The assistant for the Orchestrator: prose in, a reviewable graph across devices out. The same
 * shape as the edge Designer's AgentPanel, with one addition that matters here: the *target*.
 * Designing for one device, for a platform (a device group), or for everything is a different
 * question, and the model is told only about the chosen devices, which also keeps the prompt
 * small once a lab has several decks. Nothing the model produces reaches the canvas until "Put
 * on canvas", and nothing runs until Run; the model never dispatches.
 */

type Issue = { severity: 'error' | 'warning' | 'info'; where: string; message: string; hint?: string };
type Step = { id: string; device: string; instrument?: string; method: string; args?: Record<string, unknown>; outputs?: string[]; after?: unknown[] };
type Proposal = {
  id?: string; proposal_id?: string; source?: string; status?: string;
  summary: string; spec: { name: string; description?: string; steps: Step[] };
  graph: { nodes: Node[]; edges: Edge[] } | null; questions: string[]; issues: Issue[];
  validation_summary?: string; ok?: boolean; attempts?: number; model?: string; raw?: string | null;
};
type Turn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; proposal?: Proposal; applied?: boolean }
  | { role: 'error'; content: string };
type Target = { kind: 'all' | 'platform' | 'device'; id?: string };
type Platform = { id: string; name: string; device_ids: string[] };
type Settings = { provider?: string; base_url?: string; model?: string; api_key_set?: boolean };
type ProviderSpec = { name: string; default_base_url: string; default_model: string; needs_api_key: boolean };

const STORE_KEY = 'cloud_agent_chat';
const TARGET_KEY = 'cloud_agent_target';
const MAX_STORED = 40;

function describePhase(ev: any): { text: string; detail?: string; bad?: boolean } {
  switch (ev.phase) {
    case 'reading_deck': return { text: `Reading ${ev.devices} device${ev.devices === 1 ? '' : 's'}${ev.target?.name ? ` (${ev.target.name})` : ''}` };
    case 'drafting': return { text: ev.attempt === 1 ? 'Writing the steps' : `Rewriting (attempt ${ev.attempt} of ${ev.max_attempts})` };
    case 'validating': return { text: `Checking ${ev.steps} step${ev.steps === 1 ? '' : 's'} against the devices` };
    case 'valid': return { text: 'Everything checks out' };
    case 'found_problems': return { text: `Found ${ev.errors?.length || 0} problem${ev.errors?.length === 1 ? '' : 's'}, fixing`, detail: (ev.errors || []).join('\n'), bad: true };
    case 'unreadable': return { text: 'The reply was not usable JSON, asking again', detail: ev.detail, bad: true };
    case 'gave_up': return { text: `Still ${ev.remaining} unresolved, handing it to you anyway`, bad: true };
    default: return { text: String(ev.phase || 'working') };
  }
}

export default function CloudAgentPanel({ nodes, edges, workflowName, devices, onApply, onClose }: {
  nodes: Node[]; edges: Edge[]; workflowName: string;
  devices: { id: string; name?: string; status?: string }[];
  onApply: (graph: { nodes: Node[]; edges: Edge[]; name?: string; description?: string }) => void;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ text: string; detail?: string; bad?: boolean }[]>([]);
  const [target, setTarget] = useState<Target>({ kind: 'all' });
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>({});
  const [providers, setProviders] = useState<ProviderSpec[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  // Proposals filed from outside this panel (an MCP client, a script), waiting for a person.
  const [inbox, setInbox] = useState<Proposal[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Per browser: the last turns (slimmed: proposals carry whole graphs) and the chosen target.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      if (Array.isArray(saved)) setTurns(saved);
      const t = JSON.parse(localStorage.getItem(TARGET_KEY) || 'null');
      if (t && t.kind) setTarget(t);
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const slim = turns.slice(-MAX_STORED).map(t => (t.role === 'assistant' ? { role: t.role, content: t.content, applied: t.applied } : t));
    try { localStorage.setItem(STORE_KEY, JSON.stringify(slim)); } catch { /* ignore */ }
  }, [turns, loaded]);
  useEffect(() => { try { localStorage.setItem(TARGET_KEY, JSON.stringify(target)); } catch { /* ignore */ } }, [target]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [turns, busy, progress]);

  useEffect(() => {
    fetch('/api/platforms').then(r => (r.ok ? r.json() : [])).then(p => setPlatforms(Array.isArray(p) ? p : [])).catch(() => {});
    fetch('/api/agent/settings').then(r => r.json()).then(d => { setSettings(d.settings || {}); setProviders(d.providers || []); }).catch(() => {});
  }, []);
  const refreshModels = useCallback(() => {
    setModelError(null);
    fetch('/api/agent/models').then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); setModels(d.models || []); })
      .catch(e => { setModels([]); setModelError(e.message); });
  }, []);
  useEffect(() => { if (settingsOpen) refreshModels(); }, [settingsOpen, refreshModels]);
  const saveSettings = async (patch: Record<string, unknown>) => {
    const r = await fetch('/api/agent/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const d = await r.json().catch(() => ({}));
    if (d.settings) setSettings(d.settings);
    refreshModels();
  };
  const providerSpec = providers.find(p => p.name === (settings.provider || 'ollama'));

  const shownIds = useMemo(() => new Set(turns.map(t => (t.role === 'assistant' ? t.proposal?.proposal_id || t.proposal?.id : null)).filter(Boolean) as string[]), [turns]);
  const refreshInbox = useCallback(() => {
    fetch('/api/agent/proposals?status=pending').then(r => (r.ok ? r.json() : { proposals: [] }))
      .then(d => setInbox((d.proposals || []).filter((p: Proposal) => !shownIds.has(p.id!))))
      .catch(() => {});
  }, [shownIds]);
  useEffect(() => { refreshInbox(); const t = setInterval(refreshInbox, 5000); return () => clearInterval(t); }, [refreshInbox]);
  const decide = async (p: Proposal, action: 'accept' | 'reject', body: Record<string, unknown> = {}) => {
    const id = p.proposal_id || p.id;
    if (!id) return;
    await fetch(`/api/agent/proposals/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    setInbox(list => list.filter(x => x.id !== id));
  };

  const targetLabel = useMemo(() => {
    if (target.kind === 'device') return devices.find(d => String(d.id) === target.id)?.name || target.id || 'a device';
    if (target.kind === 'platform') return platforms.find(p => p.id === target.id)?.name || 'a platform';
    return `all devices (${devices.length})`;
  }, [target, devices, platforms]);

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    const history = turns.filter(t => t.role !== 'error' && t.content).slice(-6).map(t => ({ role: t.role as 'user' | 'assistant', content: t.content }));
    setTurns(ts => [...ts, { role: 'user', content: message }]);
    setDraft('');
    setBusy(true);
    setProgress([]);
    try {
      const hasGraph = nodes.some(n => (n.data as any)?.block?.method !== 'Start');
      const res = await fetch('/api/agent/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, target, history, existing: hasGraph ? { name: workflowName, nodes, edges } : undefined }),
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        setTurns(ts => [...ts, { role: 'error', content: d.error || `Request failed (${res.status})` }]);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.phase === 'filed') {
            const proposal: Proposal = ev;
            setTurns(ts => [...ts, { role: 'assistant', content: proposal.summary || '(no summary)', proposal }]);
          } else if (ev.phase === 'error') {
            setTurns(ts => [...ts, { role: 'error', content: ev.error }]);
          } else {
            setProgress(ps => [...ps, describePhase(ev)]);
          }
        }
      }
    } catch (e: any) {
      setTurns(ts => [...ts, { role: 'error', content: e.message }]);
    } finally {
      setBusy(false);
      setProgress([]);
    }
  };

  const apply = (index: number, p: Proposal) => {
    if (!p.graph) return;
    onApply({ nodes: p.graph.nodes, edges: p.graph.edges, name: p.spec.name, description: p.spec.description });
    if (index >= 0) setTurns(ts => ts.map((t, i) => (i === index && t.role === 'assistant' ? { ...t, applied: true } : t)));
    // Taken onto the canvas: recorded as accepted without a library save (Save is the person's).
    decide(p, 'accept', { save: false });
  };
  const deviceName = (id: string) => (id === 'cloud' ? 'Cloud' : devices.find(d => String(d.id) === id)?.name || id);

  const renderProposal = (index: number, p: Proposal, applied?: boolean) => {
    const errors = p.issues.filter(i => i.severity === 'error');
    const byDevice = new Map<string, Step[]>();
    for (const s of p.spec.steps || []) { const k = s.device; byDevice.set(k, [...(byDevice.get(k) || []), s]); }
    return (
      <div className="mt-2 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.03] overflow-hidden text-xs">
        <div className="px-3 py-2 flex items-center gap-2 border-b border-gray-100 dark:border-white/5">
          <span className="font-semibold text-gray-900 dark:text-gray-100 truncate">{p.spec.name}</span>
          <span className="text-gray-400">{p.spec.steps?.length || 0} steps · {byDevice.size} device{byDevice.size === 1 ? '' : 's'}</span>
          <span className={`ml-auto shrink-0 px-2 py-0.5 rounded-full font-bold ${errors.length ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'}`}>
            {errors.length ? `${errors.length} problem${errors.length === 1 ? '' : 's'}` : 'validates'}
          </span>
        </div>
        <div className="px-3 py-2 space-y-2">
          {[...byDevice.entries()].map(([dev, steps]) => (
            <div key={dev}>
              <div className="text-[11px] font-semibold text-gray-500 dark:text-gray-400">{deviceName(dev)}</div>
              <ol className="mt-0.5 space-y-0.5">
                {steps.map(s => (
                  <li key={s.id} className="font-mono text-[11px] text-gray-700 dark:text-gray-300 truncate" title={JSON.stringify(s.args || {})}>
                    {s.instrument === 'Library Workflows' ? <span className="text-gray-900 dark:text-white">⟲ {s.method}</span> : <>{s.instrument ? `${s.instrument}.` : ''}{s.method}</>}
                    {Object.keys(s.args || {}).length > 0 && <span className="text-gray-400"> ({Object.entries(s.args || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')})</span>}
                    {s.outputs?.length ? <span className="text-emerald-600 dark:text-emerald-400"> → {s.outputs.join(', ')}</span> : null}
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {p.questions.length > 0 && (
            <div className="rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 px-2.5 py-2 text-amber-800 dark:text-amber-200">
              <div className="font-semibold mb-0.5">Needs your decision</div>
              <ul className="list-disc pl-4 space-y-0.5">{p.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </div>
          )}
          {p.issues.length > 0 && (
            <ul className="space-y-0.5">
              {p.issues.slice(0, 8).map((i, k) => (
                <li key={k} className={i.severity === 'error' ? 'text-red-600 dark:text-red-400' : i.severity === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500'}>
                  <span className="font-mono">{i.where}</span> {i.message}{i.hint ? <span className="text-gray-400"> — {i.hint}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {p.raw && <details className="text-gray-400"><summary className="cursor-pointer">What the model actually replied</summary><pre className="mt-1 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{p.raw}</pre></details>}
        </div>
        <div className="px-3 py-2 border-t border-gray-100 dark:border-white/5 flex items-center gap-2">
          {applied ? <span className="text-green-700 dark:text-green-300 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> on the canvas</span> : (
            <>
              <button type="button" disabled={!p.graph} onClick={() => apply(index, p)} title={p.graph ? 'Replace the canvas with this graph. Nothing runs until you press Run.' : 'Fix the problems first: this proposal could not be turned into a graph'}
                className="px-2.5 py-1 rounded-lg bg-accent text-on-accent font-semibold hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed">Put on canvas</button>
              {index < 0 && <button type="button" onClick={() => decide(p, 'reject')} title="Dismiss this proposal" className="p-1 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"><Trash2 className="w-3.5 h-3.5" /></button>}
            </>
          )}
          <span className="ml-auto text-gray-400">{p.model || p.source}{(p.attempts || 0) > 1 ? ` · ${p.attempts} attempts` : ''}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="w-[26rem] shrink-0 border-r border-gray-200 dark:border-white/10 bg-gray-50/60 dark:bg-black/20 flex flex-col h-full">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-white/10 flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-violet-500" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Assistant</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{settings.provider ? `${settings.provider} · ${settings.model || providerSpec?.default_model || 'default model'}` : 'not configured'}</div>
        </div>
        <button type="button" onClick={() => { setTurns([]); setProgress([]); try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } }} title="New chat" className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-white/10"><Trash2 className="w-4 h-4" /></button>
        <button type="button" onClick={() => setSettingsOpen(o => !o)} title="Model settings" className={`p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/10 ${settingsOpen ? 'text-violet-600' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}><Settings2 className="w-4 h-4" /></button>
        <button type="button" onClick={onClose} title="Hide the assistant" className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-white/10"><X className="w-4 h-4" /></button>
      </div>

      {settingsOpen && (
        <div className="px-4 py-3 border-b border-gray-200 dark:border-white/10 space-y-2 text-xs bg-white/60 dark:bg-white/[0.02]">
          <label className="block"><span className="text-gray-500">Provider</span>
            <select value={settings.provider || 'ollama'} onChange={e => saveSettings({ provider: e.target.value })} className="mt-0.5 w-full rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-black/40 px-2 py-1">
              {providers.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select></label>
          <label className="block"><span className="text-gray-500">Endpoint</span>
            <input defaultValue={settings.base_url || providerSpec?.default_base_url || ''} onBlur={e => saveSettings({ base_url: e.target.value })} className="mt-0.5 w-full rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-black/40 px-2 py-1 font-mono" /></label>
          {providerSpec?.needs_api_key && (
            <label className="block"><span className="text-gray-500">API key{settings.api_key_set ? ' · saved' : ''}</span>
              <input type="password" value={apiKeyDraft} onChange={e => setApiKeyDraft(e.target.value)} onBlur={() => { if (apiKeyDraft) { saveSettings({ api_key: apiKeyDraft }); setApiKeyDraft(''); } }} placeholder={settings.api_key_set ? '••••••••' : 'paste a key'} className="mt-0.5 w-full rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-black/40 px-2 py-1" /></label>
          )}
          <label className="block"><span className="text-gray-500 flex items-center gap-1">Model <button type="button" onClick={refreshModels} title="Refresh the list" className="p-0.5 text-gray-400 hover:text-gray-700"><RefreshCw className="w-3 h-3" /></button></span>
            {models.length ? (
              <select value={settings.model || ''} onChange={e => saveSettings({ model: e.target.value })} className="mt-0.5 w-full rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-black/40 px-2 py-1">
                <option value="">(provider default)</option>
                {models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : <input defaultValue={settings.model || ''} onBlur={e => saveSettings({ model: e.target.value })} placeholder={providerSpec?.default_model} className="mt-0.5 w-full rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-black/40 px-2 py-1 font-mono" />}
          </label>
          {modelError && <div className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {modelError}</div>}
        </div>
      )}

      {/* The target: what the model is told about, and so what it may design with. */}
      <div className="px-4 py-2 border-b border-gray-200 dark:border-white/10 flex items-center gap-2 text-xs">
        <span className="text-gray-500 dark:text-gray-400 shrink-0">Design for</span>
        <div className="relative flex-1 min-w-0">
          <select
            value={target.kind === 'all' ? 'all' : `${target.kind}:${target.id}`}
            onChange={e => { const v = e.target.value; if (v === 'all') setTarget({ kind: 'all' }); else { const [kind, id] = v.split(':'); setTarget({ kind: kind as Target['kind'], id }); } }}
            className="w-full appearance-none rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-black/40 pl-2 pr-6 py-1 font-medium truncate"
          >
            <option value="all">All devices ({devices.length})</option>
            {platforms.length > 0 && <optgroup label="Platforms">{platforms.map(p => <option key={p.id} value={`platform:${p.id}`}>{p.name} ({p.device_ids.length})</option>)}</optgroup>}
            <optgroup label="Devices">{devices.map(d => <option key={d.id} value={`device:${d.id}`}>{d.name || d.id}{d.status?.includes('online') ? '' : ' (offline)'}</option>)}</optgroup>
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1.5 w-3.5 h-3.5 text-gray-400" />
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
        {inbox.length > 0 && (
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-violet-600 dark:text-violet-300 mb-1">Waiting for you ({inbox.length})</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Filed by an agent outside this panel (an MCP client, a script). Review, then put on the canvas or dismiss.</div>
            {inbox.map(p => <div key={p.id}>{renderProposal(-1, p)}</div>)}
          </div>
        )}
        {turns.length === 0 && !busy && inbox.length === 0 && (
          <div className="text-gray-500 dark:text-gray-400 text-xs space-y-2">
            <p>Describe what should happen across {targetLabel}, in plain words. For example: “Run the colour screen on Bench A with volume 1.5, then if its absorbance is above 0.8, have Bench B park the arm.”</p>
            <p>You get a graph to review: which device does what, in what order, with every step checked against the real instruments and saved workflows. Saved workflows are preferred for anything long on one device.</p>
            <p className="font-medium text-gray-600 dark:text-gray-300">Nothing reaches the canvas or runs until you say so.</p>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={t.role === 'user' ? 'flex justify-end' : ''}>
            {t.role === 'user' ? (
              <div className="max-w-[90%] rounded-2xl rounded-br-md bg-accent text-on-accent px-3 py-2 text-sm whitespace-pre-wrap">{t.content}</div>
            ) : t.role === 'error' ? (
              <div className="rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-900/10 px-3 py-2 text-red-700 dark:text-red-300 text-xs">{t.content}</div>
            ) : (
              <div>
                <div className="text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{t.content}</div>
                {t.proposal ? renderProposal(i, t.proposal, t.applied) : t.applied ? <div className="mt-1 text-xs text-green-700 dark:text-green-300 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> put on the canvas</div> : null}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.03] px-3 py-2 text-xs space-y-1">
            {progress.length === 0 && <div className="flex items-center gap-2 text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> starting…</div>}
            {progress.map((p, i) => (
              <div key={i} className={`flex items-start gap-2 ${p.bad ? 'text-amber-700 dark:text-amber-300' : 'text-gray-600 dark:text-gray-300'}`}>
                {i === progress.length - 1 ? <Loader2 className="w-3.5 h-3.5 mt-0.5 animate-spin shrink-0" /> : <Check className="w-3.5 h-3.5 mt-0.5 shrink-0 text-green-500" />}
                <div className="min-w-0"><div>{p.text}</div>{p.detail && <pre className="mt-0.5 whitespace-pre-wrap text-[11px] text-gray-500">{p.detail}</pre>}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-gray-200 dark:border-white/10">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            rows={2}
            placeholder={`What should happen across ${targetLabel}?`}
            className="flex-1 resize-none rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-black/40 px-3 py-2 text-sm focus:outline-none focus:border-violet-400"
          />
          <button type="button" onClick={send} disabled={busy || !draft.trim()} title="Send (Enter)" className="p-2.5 rounded-xl bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"><Send className="w-4 h-4" /></button>
        </div>
      </div>
    </div>
  );
}
