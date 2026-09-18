"use client";

/**
 * Describe a protocol in prose; get a workflow you can review, edit and save.
 *
 * The panel never writes to the canvas on its own. Everything the agent produces arrives as a
 * *proposal*: a summary, the questions it could not answer, whatever the deck-aware validator
 * found wrong with it, and a diff against what is on the canvas now. The scientist decides
 * whether it lands. That is the whole design — a model that can suggest but not act is one a
 * lab can leave switched on.
 *
 * Proposals filed from elsewhere (Claude Desktop, over MCP) land in the same queue and are
 * polled for here, so a conversation held in another window still finishes in the Designer.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Bot, Check, ChevronDown, GitCompare, Loader2, RefreshCw, Send, Settings2, Sparkles, Trash2, X,
} from 'lucide-react';
import { API_BASE } from '@/config';
import {
  WorkflowDiff, diffSteps, toDiffStep, toSavedBlocks, toSequenceBlocks,
  type SequenceBlock,
} from '@ivoryos/shared-ui';

type Issue = { severity: 'error' | 'warning' | 'info'; where: string; message: string; hint?: string };

type Proposal = {
  id: number;
  kind: string;
  name: string;
  payload: any;
  summary: string;
  source: string;
  issues: Issue[];
  status: string;
  created_at: string | null;
};

type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; proposal?: Proposal; questions?: string[]; ok?: boolean; raw?: string | null }
  | { role: 'error'; content: string };

type Props = {
  /** The canvas as it is now — the left side of every diff, and the body sent for edits. */
  prepSequence: SequenceBlock[];
  sequence: SequenceBlock[];
  cleanupSequence: SequenceBlock[];
  workflowName: string;
  /** Replace the canvas with an accepted proposal. */
  onApply: (body: {
    prep: SequenceBlock[]; script: SequenceBlock[]; cleanup: SequenceBlock[];
    name?: string; description?: string;
  }) => void;
  instruments: any;
  onClose: () => void;
};

const severityStyles: Record<Issue['severity'], string> = {
  error: 'text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-900/20 dark:border-red-500/30',
  warning: 'text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-900/20 dark:border-amber-500/30',
  info: 'text-sky-700 bg-sky-50 border-sky-200 dark:text-sky-300 dark:bg-sky-900/20 dark:border-sky-500/30',
};

export default function AgentPanel({
  prepSequence, sequence, cleanupSequence, workflowName, onApply, instruments, onClose,
}: Props) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // What the loop is doing right now, newest last. A local model spends tens of seconds
  // per attempt and may take three, so the check-and-correct cycle is shown as it happens
  // rather than behind a spinner that says nothing about whether it is going well.
  const [progress, setProgress] = useState<{ text: string; detail?: string; bad?: boolean }[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<any>(null);
  const [providers, setProviders] = useState<any[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [inbox, setInbox] = useState<Proposal[]>([]);
  const [diffFor, setDiffFor] = useState<Proposal | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const stepCount = (body: any) =>
    ['prep', 'script', 'cleanup'].reduce((n, k) => n + ((body?.[k] || []).length), 0);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, busy]);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/agent/settings`);
      const data = await res.json();
      setSettings(data.settings);
      setProviders(data.providers || []);
    } catch {
      setSettings(null);
    }
  }, []);

  const loadModels = useCallback(async () => {
    setModelError(null);
    try {
      const res = await fetch(`${API_BASE}/api/agent/models`);
      const data = await res.json();
      if (!res.ok) { setModels([]); setModelError(data.error || 'Could not list models.'); return; }
      setModels(data.models || []);
    } catch (e: any) {
      setModels([]);
      setModelError(e.message);
    }
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);
  useEffect(() => { if (settingsOpen) loadModels(); }, [settingsOpen, loadModels]);

  // Proposals filed from another surface — a conversation in Claude Desktop — show up here
  // without the scientist having to know a second place to look.
  const refreshInbox = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/agent/proposals?status=pending`);
      const data = await res.json();
      const mine = new Set(
        turns.flatMap(t => (t.role === 'assistant' && t.proposal ? [t.proposal.id] : []))
      );
      setInbox((data.proposals || []).filter((p: Proposal) => !mine.has(p.id)));
    } catch { /* the panel is useful offline; an unreachable inbox is not worth an error */ }
  }, [turns]);

  useEffect(() => {
    refreshInbox();
    const timer = setInterval(refreshInbox, 5000);
    return () => clearInterval(timer);
  }, [refreshInbox]);

  const currentBody = () => ({
    name: workflowName || 'Untitled protocol',
    prep: toSavedBlocks(prepSequence),
    script: toSavedBlocks(sequence),
    cleanup: toSavedBlocks(cleanupSequence),
  });

  const describePhase = (e: any): { text: string; detail?: string; bad?: boolean } | null => {
    switch (e.phase) {
      case 'reading_deck':
        return { text: e.editing ? `Reading the deck and “${e.editing}”` : `Reading the deck (${e.instruments} instruments)` };
      case 'drafting':
        return { text: e.attempt === 1 ? 'Writing the steps' : `Rewriting (attempt ${e.attempt} of ${e.max_attempts})` };
      case 'validating':
        return { text: `Checking ${e.steps} steps against the deck` };
      case 'valid':
        return { text: 'Everything checks out' };
      case 'found_problems':
        return { text: `Found ${e.errors.length} problem${e.errors.length === 1 ? '' : 's'} — fixing`,
                 detail: e.errors.join('\n'), bad: true };
      case 'unreadable':
        return { text: 'The reply was not usable JSON — asking again', bad: true };
      case 'gave_up':
        return { text: `Still ${e.remaining} unresolved — handing it to you anyway`, bad: true };
      default:
        return null;
    }
  };

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft('');
    setBusy(true);
    setProgress([]);

    const history = turns
      .filter(t => t.role === 'user' || (t.role === 'assistant' && t.content))
      .slice(-6)
      .map(t => ({ role: t.role === 'error' ? 'assistant' : t.role, content: t.content }));

    setTurns(prev => [...prev, { role: 'user', content: message }]);

    const hasCanvas = prepSequence.length + sequence.length + cleanupSequence.length > 0;
    const finish = (data: any) => {
      setTurns(prev => [...prev, {
        role: 'assistant',
        content: data.proposal?.summary || '(no summary)',
        proposal: data.proposal,
        questions: data.questions || [],
        ok: data.ok,
        raw: data.raw,
      }]);
    };

    try {
      const res = await fetch(`${API_BASE}/api/agent/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          history,
          ...(hasCanvas ? { workflow_name: workflowName || undefined, workflow_body: currentBody() } : {}),
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setTurns(prev => [...prev, { role: 'error', content: data.error || `Request failed (${res.status}).` }]);
      } else {
        // Plain SSE framing: events are separated by a blank line, and a chunk can split one,
        // so the tail is carried over rather than parsed as a truncated event.
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
            let event: any;
            try { event = JSON.parse(line.slice(6)); } catch { continue; }
            if (event.phase === 'filed') finish(event);
            else if (event.phase === 'error') setTurns(prev => [...prev, { role: 'error', content: event.error }]);
            else {
              const described = describePhase(event);
              if (described) setProgress(prev => [...prev, described]);
            }
          }
        }
      }
    } catch (e: any) {
      setTurns(prev => [...prev, { role: 'error', content: e.message }]);
    } finally {
      setBusy(false);
      setProgress([]);
    }
  };

  const applyToCanvas = async (proposal: Proposal) => {
    const body = proposal.payload || {};
    onApply({
      prep: toSequenceBlocks(body.prep, instruments),
      script: toSequenceBlocks(body.script || body.sequence, instruments),
      cleanup: toSequenceBlocks(body.cleanup, instruments),
      name: body.name || proposal.name,
      description: body.description,
    });
    // Recorded as accepted but not saved: the scientist edits on the canvas and saves when
    // they are satisfied, the same way they would with anything else they built.
    await fetch(`${API_BASE}/api/agent/proposals/${proposal.id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ save: false }),
    }).catch(() => {});
    setInbox(prev => prev.filter(p => p.id !== proposal.id));
    setDiffFor(null);
  };

  const dismiss = async (proposal: Proposal, note?: string) => {
    await fetch(`${API_BASE}/api/agent/proposals/${proposal.id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: note || '' }),
    }).catch(() => {});
    setInbox(prev => prev.filter(p => p.id !== proposal.id));
    setTurns(prev => prev.map(t =>
      t.role === 'assistant' && t.proposal?.id === proposal.id
        ? { ...t, proposal: { ...t.proposal, status: 'rejected' } }
        : t));
    setDiffFor(null);
  };

  const saveSettings = async (patch: any) => {
    const res = await fetch(`${API_BASE}/api/agent/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (res.ok) setSettings(data.settings);
    loadModels();
  };

  const diffRows = diffFor
    ? diffSteps(
        [...toSavedBlocks(prepSequence), ...toSavedBlocks(sequence), ...toSavedBlocks(cleanupSequence)],
        [...(diffFor.payload?.prep || []), ...(diffFor.payload?.script || []), ...(diffFor.payload?.cleanup || [])],
      )
    : [];

  const renderProposal = (proposal: Proposal, questions: string[] = [], ok?: boolean, raw?: string | null) => {
    const errors = (proposal.issues || []).filter(i => i.severity === 'error');
    const others = (proposal.issues || []).filter(i => i.severity !== 'error');
    const decided = proposal.status !== 'pending';
    return (
      <div className="mt-2 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#141414] overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-100 dark:border-white/5 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-bold text-gray-800 dark:text-gray-100 truncate">{proposal.name}</div>
            <div className="text-[10px] text-gray-400">
              {stepCount(proposal.payload)} steps · {proposal.source || 'agent'}
            </div>
          </div>
          {ok === false || errors.length > 0 ? (
            <span className="shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300">
              {errors.length} problem{errors.length === 1 ? '' : 's'}
            </span>
          ) : (
            <span className="shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">
              validates
            </span>
          )}
        </div>

        {questions.length > 0 && (
          <div className="px-3 py-2 border-b border-gray-100 dark:border-white/5 bg-amber-50/50 dark:bg-amber-900/10">
            <div className="text-[10px] font-bold uppercase text-amber-700 dark:text-amber-400 mb-1">
              Needs your decision
            </div>
            <ul className="list-disc pl-4 space-y-0.5 text-[11px] text-amber-800 dark:text-amber-300">
              {questions.map((q, i) => <li key={i}>{q}</li>)}
            </ul>
          </div>
        )}

        {(errors.length > 0 || others.length > 0) && (
          <div className="px-3 py-2 border-b border-gray-100 dark:border-white/5 space-y-1">
            {[...errors, ...others].slice(0, 8).map((issue, i) => (
              <div key={i} className={`text-[11px] px-2 py-1 rounded border ${severityStyles[issue.severity]}`}>
                <span className="font-mono opacity-70">{issue.where}</span> {issue.message}
                {issue.hint && <span className="opacity-70"> — {issue.hint}</span>}
              </div>
            ))}
          </div>
        )}

        {raw && (
          <details className="px-3 py-2 border-b border-gray-100 dark:border-white/5">
            <summary className="text-[10px] text-gray-400 cursor-pointer">What the model actually replied</summary>
            <pre className="mt-1 text-[10px] whitespace-pre-wrap break-all text-gray-500 max-h-40 overflow-auto">{raw}</pre>
          </details>
        )}

        <div className="px-3 py-2 flex items-center gap-2">
          {decided ? (
            <span className="text-[11px] text-gray-400 italic">{proposal.status}</span>
          ) : (
            <>
              <button
                onClick={() => applyToCanvas(proposal)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-500/30"
              >
                <Check className="w-3 h-3" /> Put on canvas
              </button>
              <button
                onClick={() => setDiffFor(proposal)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium bg-white text-gray-600 border border-gray-200 hover:bg-gray-50 dark:bg-white/5 dark:text-gray-300 dark:border-white/10"
              >
                <GitCompare className="w-3 h-3" /> Compare
              </button>
              <button
                onClick={() => dismiss(proposal)}
                title="Discard this suggestion"
                className="ml-auto p-1 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  const providerInfo = providers.find(p => p.name === settings?.provider);

  return (
    // Docked on the left, between the app sidebar and the module toolbox. The right edge belongs
    // to the Prep & Cleanup drawer, and a second right-hand column fought it for the same space.
    <div className="w-[26rem] shrink-0 border-r border-gray-200 dark:border-white/10 bg-gray-50/60 dark:bg-black/20 flex flex-col h-full">
      <div className="h-16 shrink-0 px-4 flex items-center justify-between border-b border-gray-200 dark:border-white/10 bg-white/80 dark:bg-black/20">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-4 h-4 text-purple-500 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-gray-800 dark:text-gray-100">Protocol assistant</div>
            <div className="text-[10px] text-gray-400 truncate">
              {settings ? `${settings.provider}${settings.model ? ` · ${settings.model}` : ''}` : 'not configured'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => setSettingsOpen(v => !v)} title="Model settings"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-white/10">
            <Settings2 className="w-4 h-4" />
          </button>
          <button onClick={onClose} title="Close"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-white/10">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div className="px-4 py-3 border-b border-gray-200 dark:border-white/10 bg-white dark:bg-[#141414] space-y-2">
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-400">Provider</label>
            <select
              value={settings?.provider || 'ollama'}
              onChange={e => saveSettings({ provider: e.target.value })}
              className="w-full mt-1 bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs outline-none"
            >
              {providers.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-400">Endpoint</label>
            <input
              type="text"
              defaultValue={settings?.base_url || providerInfo?.default_base_url || ''}
              onBlur={e => saveSettings({ base_url: e.target.value })}
              className="w-full mt-1 bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs outline-none font-mono"
            />
          </div>
          {providerInfo?.needs_api_key && (
            <div>
              <label className="text-[10px] font-bold uppercase text-gray-400">
                API key {settings?.api_key_set && <span className="text-green-600 normal-case">· saved</span>}
              </label>
              <input
                type="password"
                value={apiKeyDraft}
                placeholder={settings?.api_key_set ? '•••••••• (leave blank to keep)' : ''}
                onChange={e => setApiKeyDraft(e.target.value)}
                onBlur={() => { if (apiKeyDraft) { saveSettings({ api_key: apiKeyDraft }); setApiKeyDraft(''); } }}
                className="w-full mt-1 bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs outline-none"
              />
            </div>
          )}
          <div>
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-bold uppercase text-gray-400">Model</label>
              <button onClick={loadModels} className="text-[10px] text-gray-400 hover:text-gray-600 flex items-center gap-1">
                <RefreshCw className="w-3 h-3" /> refresh
              </button>
            </div>
            {models.length > 0 ? (
              <select
                value={settings?.model || ''}
                onChange={e => saveSettings({ model: e.target.value })}
                className="w-full mt-1 bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs outline-none"
              >
                <option value="">(provider default)</option>
                {models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input
                type="text"
                defaultValue={settings?.model || ''}
                placeholder={providerInfo?.default_model || 'model name'}
                onBlur={e => saveSettings({ model: e.target.value })}
                className="w-full mt-1 bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs outline-none font-mono"
              />
            )}
            {modelError && (
              <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400 flex items-start gap-1">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /><span>{modelError}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {inbox.length > 0 && (
        <div className="px-4 py-2 border-b border-gray-200 dark:border-white/10 bg-purple-50/50 dark:bg-purple-900/10">
          <div className="text-[10px] font-bold uppercase text-purple-700 dark:text-purple-300 mb-1 flex items-center gap-1">
            <Bot className="w-3 h-3" /> waiting for you ({inbox.length})
          </div>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {inbox.map(p => (
              <div key={p.id}>
                {p.kind === 'run' ? (
                  <div className="rounded-xl border border-amber-300 dark:border-amber-500/40 bg-white dark:bg-[#141414] p-3">
                    <div className="text-xs font-bold text-gray-800 dark:text-gray-100">Run “{p.name}” on the hardware?</div>
                    <div className="text-[11px] text-gray-500 mt-1">{p.summary}</div>
                    <div className="text-[10px] text-gray-400 mt-1">asked by {p.source || 'agent'}</div>
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={async () => {
                          await fetch(`${API_BASE}/api/agent/proposals/${p.id}/accept`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                          });
                          setInbox(prev => prev.filter(x => x.id !== p.id));
                        }}
                        className="px-2 py-1 rounded-lg text-[11px] font-bold bg-amber-500 text-white hover:bg-amber-600"
                      >
                        Start the run
                      </button>
                      <button onClick={() => dismiss(p)}
                        className="px-2 py-1 rounded-lg text-[11px] font-medium bg-white text-gray-600 border border-gray-200 dark:bg-white/5 dark:text-gray-300 dark:border-white/10">
                        No
                      </button>
                    </div>
                  </div>
                ) : renderProposal(p)}
              </div>
            ))}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {turns.length === 0 && inbox.length === 0 && (
          <div className="text-xs text-gray-400 dark:text-gray-500 space-y-2">
            <p>Describe a protocol in your own words and it will be drafted against this deck.</p>
            <p className="italic">
              “Charge the vial with 1 mL of substrate and 1.2 equivalents of boronic acid, add
              2.5 mol% catalyst, hold at 65 °C for two hours, then assay the yield by HPLC.”
            </p>
            <p>With steps already on the canvas, it edits them instead — “add a 5 minute purge before the hold”.</p>
            <p className="text-[11px]">Nothing is saved or run until you accept it.</p>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i}>
            {turn.role === 'user' && (
              <div className="ml-6 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-500/20 px-3 py-2 text-xs text-gray-800 dark:text-gray-100 whitespace-pre-wrap">
                {turn.content}
              </div>
            )}
            {turn.role === 'assistant' && (
              <div className="mr-2">
                <div className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{turn.content}</div>
                {turn.proposal && renderProposal(turn.proposal, turn.questions, turn.ok, turn.raw)}
              </div>
            )}
            {turn.role === 'error' && (
              <div className="rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{turn.content}</span>
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#141414] p-3 space-y-1.5">
            {progress.map((step, i) => {
              const current = i === progress.length - 1;
              return (
                <div key={i} className="flex items-start gap-2 text-[11px]">
                  {current ? (
                    <Loader2 className="w-3 h-3 mt-0.5 shrink-0 animate-spin text-purple-500" />
                  ) : (
                    <Check className="w-3 h-3 mt-0.5 shrink-0 text-green-500" />
                  )}
                  <div className="min-w-0">
                    <div className={step.bad ? 'text-amber-700 dark:text-amber-400' : 'text-gray-600 dark:text-gray-300'}>
                      {step.text}
                    </div>
                    {step.detail && (
                      <pre className="mt-0.5 whitespace-pre-wrap text-[10px] text-gray-400 font-mono">{step.detail}</pre>
                    )}
                  </div>
                </div>
              );
            })}
            {progress.length === 0 && (
              <div className="flex items-center gap-2 text-[11px] text-gray-400">
                <Loader2 className="w-3 h-3 animate-spin" /> starting…
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 p-3 border-t border-gray-200 dark:border-white/10 bg-white dark:bg-[#141414]">
        <div className="relative">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              // Enter sends, Shift+Enter is a newline — the same as the legacy panel.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            rows={3}
            placeholder="Describe the protocol, or the change you want…"
            disabled={busy}
            className="w-full resize-none bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-xl px-3 py-2 pr-10 text-xs outline-none focus:border-purple-400 disabled:opacity-60"
          />
          <button
            onClick={send}
            disabled={busy || !draft.trim()}
            className="absolute right-2 bottom-2 p-1.5 rounded-lg bg-purple-600 text-white disabled:opacity-40 hover:bg-purple-700"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <WorkflowDiff
        isOpen={!!diffFor}
        title={`Suggested changes to ${diffFor?.name || ''}`}
        fromLabel="On the canvas now"
        toLabel="Suggested"
        rows={diffRows}
        applyLabel="Put on canvas"
        onApply={() => diffFor && applyToCanvas(diffFor)}
        onClose={() => setDiffFor(null)}
      />
    </div>
  );
}
