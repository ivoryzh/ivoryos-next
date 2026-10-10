"use client";

/**
 * The assistant, on every page: one panel along the right, opened from the top bar (or the
 * sidebar) and mounted once in the root layout, so a conversation follows the person around.
 *
 * Three modes, each one of the edge's chat modes (agent/routes.py `_run_mode`):
 *   Ask       questions answered from the records (runs, their tables, comparisons). Read-only.
 *   Workflow  a protocol in prose to a workflow; on the Designer it edits the canvas.
 *   Safety    a rule in words to safety additions, reviewed on the Safety page.
 * A page sets the default (Designer: Workflow, Safety: Safety, else Ask) and says where the
 * person is (src/assistant.ts `useAssistantPage`), which goes to the model with each request.
 *
 * Nothing the assistant writes takes effect by itself. A workflow, a run or a safety change
 * arrives as a *proposal* a person accepts: put on the canvas (or opened in the Designer, or
 * saved to the library), started, or saved from the Safety page after reading it there.
 * Proposals filed from elsewhere (Claude Desktop, over MCP) wait in the same queue, shown here.
 *
 * It overlays the page rather than making room for itself: a panel that pushed every page
 * aside was what the plugin panel stopped doing (AGENTS.md section 10).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  AlertTriangle, Bot, Check, GitCompare, Library, Loader2, MessageSquarePlus, PenLine, RefreshCw, Send, Settings2, ShieldCheck, Sparkles, Trash2, X,
} from 'lucide-react';
import { API_BASE } from '@/config';
import {
  WorkflowDiff, confirmDialog, diffSteps, notify, toSequenceBlocks,
} from '@ivoryos/shared-ui';
import {
  closeAssistant, defaultMode, restoreAssistantOpen, sendPageRequest, setAssistantMode, useAssistant,
  REQUEST_PAGE, REQUEST_PARAM, type AssistantMode, type PageRequestKind,
} from '@/assistant';
import { canvasHasUnsavedWork, canvasWorkflowName, handOffToDesigner } from '@/designerHandoff';
import { usePageArea } from '@/usePageArea';

type Issue = { severity: 'error' | 'warning' | 'info'; where: string; message: string; hint?: string };

type Proposal = {
  id: number;
  kind: 'workflow' | 'run' | 'safety' | string;
  name: string;
  payload: any;
  summary: string;
  source: string;
  issues: Issue[];
  status: string;
  created_at: string | null;
};

type ChatTurn =
  | { role: 'user'; content: string; mode?: AssistantMode }
  | { role: 'assistant'; content: string; mode?: AssistantMode; proposal?: Proposal | null; questions?: string[]; ok?: boolean; raw?: string | null; runs?: number[] }
  | { role: 'error'; content: string };

const CHAT_STORAGE_KEY = 'ivoryos_agent_chat';
// Enough to keep the thread readable without letting one long session fill the origin's quota.
const MAX_STORED_TURNS = 40;

const MODES: { key: AssistantMode; label: string; hint: string }[] = [
  { key: 'ask', label: 'Ask', hint: 'Questions about your runs and data' },
  { key: 'workflow', label: 'Workflow', hint: 'Draft or edit a protocol' },
  { key: 'safety', label: 'Safety', hint: 'Limits and rules in plain words' },
];

const severityStyles: Record<Issue['severity'], string> = {
  error: 'text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-900/20 dark:border-red-500/30',
  warning: 'text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-900/20 dark:border-amber-500/30',
  info: 'text-sky-700 bg-sky-50 border-sky-200 dark:text-sky-300 dark:bg-sky-900/20 dark:border-sky-500/30',
};

const LOOKUP_WORDS: Record<string, (args: any) => string> = {
  search_runs: (a) => (a?.q ? `Searching runs for “${a.q}”` : 'Listing runs'),
  run_table: (a) => `Reading run #${a?.run_id}`,
  compare_runs: (a) => `Comparing runs ${(a?.run_ids || []).map((id: number) => `#${id}`).join(', ')}`,
};

const stepCount = (body: any) => ['prep', 'script', 'cleanup'].reduce((n, k) => n + ((body?.[k] || []).length), 0);

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function AssistantPanel() {
  const { open, mode: chosenMode, page } = useAssistant();
  const pathname = usePathname() || '';
  const router = useRouter();
  const area = usePageArea();
  const onLauncher = pathname.startsWith('/launcher');
  const mode: AssistantMode = chosenMode || defaultMode(page, pathname);
  const designer = page?.designer;

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  // Whether the saved conversation has been read back yet. The persist effect below must not run
  // before it has, or the empty initial state overwrites the transcript on every page load.
  const [turnsLoaded, setTurnsLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // What the loop is doing right now, newest last. A local model spends tens of seconds per
  // attempt, so the check-and-correct cycle (or the lookups) is shown as it happens.
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

  useEffect(() => { restoreAssistantOpen(); }, []);

  // Controls fixed to the right edge (the queue chip and run card, GlobalQueueBar) move left of
  // the panel by this much while it is open, rather than sitting on top of its Send button.
  const panelRef = useRef<HTMLElement>(null);
  const shown = open && !onLauncher;
  useEffect(() => {
    const root = document.documentElement;
    if (!shown || !panelRef.current) { root.style.removeProperty('--ivoryos-dock-right'); return; }
    const panel = panelRef.current;
    const set = () => root.style.setProperty('--ivoryos-dock-right', `${panel.getBoundingClientRect().width}px`);
    set();
    const sized = new ResizeObserver(set);
    sized.observe(panel);
    return () => { sized.disconnect(); root.style.removeProperty('--ivoryos-dock-right'); };
  }, [shown]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, busy, open]);

  // The conversation survives a reload, moving between pages and closing the panel. "New chat" is
  // the only thing that clears it. Proposals are not stored: they are server state whose status
  // moves under us, and anything still pending comes back through the inbox.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CHAT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setTurns(parsed);
      }
    } catch { /* corrupt or unavailable storage just means starting fresh */ }
    setTurnsLoaded(true);
  }, []);

  useEffect(() => {
    if (!turnsLoaded) return;
    try {
      const slim = turns.slice(-MAX_STORED_TURNS).map(t =>
        t.role === 'assistant'
          ? { role: t.role, content: t.content, mode: t.mode, questions: t.questions, ok: t.ok, runs: t.runs }
          : t);
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(slim));
    } catch { /* over quota or blocked: the panel still works, it just forgets */ }
  }, [turns, turnsLoaded]);

  const startNewChat = () => {
    setTurns([]);
    setProgress([]);
    try { localStorage.removeItem(CHAT_STORAGE_KEY); } catch { /* nothing to clean up */ }
  };

  const loadSettings = useCallback(async () => {
    try {
      const data = await (await fetch(`${API_BASE}/api/agent/settings`)).json();
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

  useEffect(() => { if (open && !onLauncher) loadSettings(); }, [open, onLauncher, loadSettings]);
  useEffect(() => { if (settingsOpen) loadModels(); }, [settingsOpen, loadModels]);

  // Proposals filed from another surface (a conversation in Claude Desktop) show up here, so there
  // is one place to look. Asked for only while the panel is open.
  const refreshInbox = useCallback(async () => {
    try {
      const data = await (await fetch(`${API_BASE}/api/agent/proposals?status=pending`)).json();
      const mine = new Set(turns.flatMap(t => (t.role === 'assistant' && t.proposal ? [t.proposal.id] : [])));
      setInbox((data.proposals || []).filter((p: Proposal) => !mine.has(p.id)));
    } catch { /* an unreachable inbox is not worth an error */ }
  }, [turns]);

  useEffect(() => {
    if (!open || onLauncher) return;
    refreshInbox();
    const timer = setInterval(refreshInbox, 5000);
    return () => clearInterval(timer);
  }, [open, onLauncher, refreshInbox]);

  const describePhase = (e: any): { text: string; detail?: string; bad?: boolean } | null => {
    switch (e.phase) {
      case 'reading_deck':
        return { text: e.editing ? `Reading the deck and “${e.editing}”` : `Reading the deck (${e.instruments} instruments)` };
      case 'drafting':
        return { text: e.attempt === 1 ? 'Writing it' : `Rewriting (attempt ${e.attempt} of ${e.max_attempts})` };
      case 'validating':
        return { text: `Checking ${e.steps} steps against the deck` };
      case 'valid':
        return { text: 'Everything checks out' };
      case 'found_problems':
        return { text: `Found ${e.errors.length} problem${e.errors.length === 1 ? '' : 's'}, fixing`, detail: e.errors.join('\n'), bad: true };
      case 'unreadable':
        return { text: 'The reply was not usable JSON, asking again', bad: true };
      case 'gave_up':
        return { text: e.remaining ? `Still ${e.remaining} unresolved, handing it to you anyway` : 'Could not finish', bad: true };
      case 'thinking':
        return { text: 'Reading the recent runs' };
      case 'looking_up':
        return { text: (LOOKUP_WORDS[e.tool] || ((_: any) => `Looking up ${e.tool}`))(e.args) };
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
    setTurns(prev => [...prev, { role: 'user', content: message, mode }]);

    const canvas = mode === 'workflow' && designer?.hasSteps() ? designer.getBody() : null;
    const finish = (data: any) => {
      if (data.phase === 'answered') {
        setTurns(prev => [...prev, { role: 'assistant', mode, content: data.answer || '(no answer)', runs: data.runs || [], ok: data.ok }]);
        return;
      }
      setTurns(prev => [...prev, {
        role: 'assistant',
        mode,
        content: data.proposal?.summary || data.summary || (mode === 'safety' ? 'Nothing to add: the request could not be expressed with what this deck has.' : '(no summary)'),
        proposal: data.proposal || null,
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
          mode,
          page_context: page?.describe || '',
          ...(canvas ? { workflow_name: canvas.name || undefined, workflow_body: canvas } : {}),
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
            if (event.phase === 'filed' || event.phase === 'answered') finish(event);
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

  const markProposal = (id: number, status: string) => {
    setInbox(prev => prev.filter(p => p.id !== id));
    setTurns(prev => prev.map(t =>
      t.role === 'assistant' && t.proposal?.id === id ? { ...t, proposal: { ...t.proposal, status } } : t));
  };

  /** Ask the page that owns it, or go there with the request in the address. */
  const toPage = (kind: PageRequestKind, id: number) => {
    if (!sendPageRequest(kind, id)) router.push(`${REQUEST_PAGE[kind]}?${REQUEST_PARAM[kind]}=${id}`);
  };

  // On the Designer: replace the canvas, recorded as accepted but not saved (the scientist edits
  // and saves as with anything else they built).
  const putOnCanvas = async (proposal: Proposal) => {
    if (!designer) return;
    designer.apply({ ...proposal.payload, name: proposal.payload?.name || proposal.name });
    await postJson(`/api/agent/proposals/${proposal.id}/accept`, { save: false }).catch(() => {});
    markProposal(proposal.id, 'accepted');
    setDiffFor(null);
  };

  // Elsewhere: the same, by way of the Designer's own handoff (as the Library's Load to Designer).
  const openInDesigner = async (proposal: Proposal) => {
    const body = proposal.payload || {};
    const name = body.name || proposal.name;
    if (canvasHasUnsavedWork() && canvasWorkflowName() !== name) {
      const ok = await confirmDialog(
        `The Designer has unsaved changes${canvasWorkflowName() ? ` to “${canvasWorkflowName()}”` : ''}. Opening this suggestion replaces them.`,
        { title: 'Replace the canvas?', confirmLabel: 'Replace', tone: 'danger' },
      );
      if (!ok) return;
    }
    try {
      const status = await (await fetch(`${API_BASE}/api/status`)).json();
      const instruments = status.instruments || {};
      await postJson(`/api/agent/proposals/${proposal.id}/accept`, { save: false });
      handOffToDesigner({
        prep: toSequenceBlocks(body.prep, instruments),
        script: toSequenceBlocks(body.script || body.sequence, instruments),
        cleanup: toSequenceBlocks(body.cleanup, instruments),
        name, description: body.description || '', savedSignature: '', unsaved: true,
      });
    } catch (e: any) {
      await notify(e.message, { title: 'Could not open it in the Designer', tone: 'error' });
    }
  };

  const saveToLibrary = async (proposal: Proposal) => {
    try {
      const done = await postJson(`/api/agent/proposals/${proposal.id}/accept`, {});
      markProposal(proposal.id, 'accepted');
      await notify(`Saved “${done.name}” as version ${done.version}.`, { title: 'Saved to the library' });
    } catch (e: any) {
      await notify(e.message, { title: 'Not saved', tone: 'error' });
    }
  };

  const startRun = async (proposal: Proposal) => {
    try {
      await postJson(`/api/agent/proposals/${proposal.id}/accept`, {});
      markProposal(proposal.id, 'accepted');
    } catch (e: any) {
      await notify(e.message, { title: 'The run was not started', tone: 'error' });
    }
  };

  const dismiss = async (proposal: Proposal) => {
    await postJson(`/api/agent/proposals/${proposal.id}/reject`, { note: '' }).catch(() => {});
    markProposal(proposal.id, 'rejected');
    setDiffFor(null);
  };

  const saveSettings = async (patch: any) => {
    try {
      const data = await postJson('/api/agent/settings', patch);
      setSettings(data.settings);
    } catch { /* the field keeps what was typed */ }
    loadModels();
  };

  const diffRows = diffFor && designer
    ? (() => {
        const now = designer.getBody();
        return diffSteps(
          [...now.prep, ...now.script, ...now.cleanup],
          [...(diffFor.payload?.prep || []), ...(diffFor.payload?.script || []), ...(diffFor.payload?.cleanup || [])],
        );
      })()
    : [];

  const issueList = (issues: Issue[]) => issues.length > 0 && (
    <div className="px-3 py-2 border-b border-gray-100 dark:border-white/5 space-y-1">
      {issues.slice(0, 8).map((issue, i) => (
        <div key={i} className={`text-[11px] px-2 py-1 rounded border ${severityStyles[issue.severity] || severityStyles.info}`}>
          <span className="font-mono opacity-70">{issue.where}</span> {issue.message}
          {issue.hint && <span className="opacity-70"> ({issue.hint})</span>}
        </div>
      ))}
    </div>
  );

  const questionList = (questions: string[]) => questions.length > 0 && (
    <div className="px-3 py-2 border-b border-gray-100 dark:border-white/5 bg-amber-50/50 dark:bg-amber-900/10">
      <div className="text-[10px] font-bold uppercase text-amber-700 dark:text-amber-400 mb-1">Needs your decision</div>
      <ul className="list-disc pl-4 space-y-0.5 text-[11px] text-amber-800 dark:text-amber-300">
        {questions.map((q, i) => <li key={i}>{q}</li>)}
      </ul>
    </div>
  );

  const secondaryButton = 'flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium bg-white text-gray-600 border border-gray-200 hover:bg-gray-50 dark:bg-white/5 dark:text-gray-300 dark:border-white/10 dark:hover:bg-white/10';
  const primaryButton = 'flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold bg-accent-soft text-accent-fg border border-accent-tint/60 hover:bg-accent-tint/30';

  const renderProposal = (proposal: Proposal, questions: string[] = [], ok?: boolean, raw?: string | null) => {
    const decided = proposal.status !== 'pending';
    const errors = (proposal.issues || []).filter(i => i.severity === 'error');

    if (proposal.kind === 'run') {
      return (
        <div className="mt-2 rounded-xl border border-amber-300 dark:border-amber-500/40 bg-white dark:bg-[#141414] p-3">
          <div className="text-xs font-bold text-gray-800 dark:text-gray-100">Run “{proposal.name}” on the hardware?</div>
          <div className="text-[11px] text-gray-500 mt-1">{proposal.summary}</div>
          <div className="text-[10px] text-gray-400 mt-1">asked by {proposal.source || 'agent'}</div>
          {decided ? <div className="mt-2 text-[11px] text-gray-400 italic">{proposal.status}</div> : (
            <div className="flex items-center gap-2 mt-2">
              <button onClick={() => startRun(proposal)} className="px-2 py-1 rounded-lg text-[11px] font-bold bg-amber-500 text-white hover:bg-amber-600">Start the run</button>
              <button onClick={() => dismiss(proposal)} className={secondaryButton}>No</button>
            </div>
          )}
        </div>
      );
    }

    if (proposal.kind === 'safety') {
      const add = proposal.payload?.add || {};
      const lines = [
        ...Object.keys(add.states || {}).map((n: string) => `State ${n}`),
        ...(add.limits || []).map((l: any) => `Limit ${l.target}.${l.method}.${l.param}${l.min !== undefined || l.max !== undefined ? ` (${l.min ?? '…'} to ${l.max ?? '…'}${l.unit ? ` ${l.unit}` : ''})` : ''}${l.allowed ? ` one of ${l.allowed.join(', ')}` : ''}`),
        ...(add.rules || []).map((r: any) => `Rule “${r.name || 'unnamed'}” on ${r.when?.target}.${r.when?.method}`),
      ];
      return (
        <div className="mt-2 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#141414] overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-100 dark:border-white/5 flex items-center justify-between gap-2">
            <div className="min-w-0 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-gray-500" />
              <div className="text-xs font-bold text-gray-800 dark:text-gray-100 truncate">Safety additions</div>
            </div>
            <span className={`shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${errors.length ? 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300' : 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'}`}>
              {errors.length ? `${errors.length} problem${errors.length === 1 ? '' : 's'}` : 'validates'}
            </span>
          </div>
          {lines.length > 0 && (
            <ul className="px-3 py-2 border-b border-gray-100 dark:border-white/5 space-y-0.5 text-[11px] text-gray-700 dark:text-gray-300">
              {lines.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          )}
          {questionList(questions.length ? questions : proposal.payload?.questions || [])}
          {issueList(proposal.issues || [])}
          <div className="px-3 py-2 flex items-center gap-2">
            {decided ? <span className="text-[11px] text-gray-400 italic">{proposal.status}</span> : (
              <>
                {/* The page shows it in full, with its Save and Discard: out of the panel's way. */}
                <button onClick={() => { closeAssistant(); toPage('review-safety', proposal.id); }} className={primaryButton}>
                  <ShieldCheck className="w-3 h-3" /> Review on Safety page
                </button>
                <button onClick={() => dismiss(proposal)} title="Discard this suggestion" className="ml-auto p-1 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>
      );
    }

    // A workflow. "#x, which no earlier step produces" is how a reusable workflow is *supposed* to
    // look: those are its inputs. One line naming them, not one amber box per input.
    const inputRe = /reads #(\w+), which no earlier step produces/;
    const inputs = Array.from(new Set((proposal.issues || []).filter(i => i.severity === 'warning' && inputRe.test(i.message)).map(i => inputRe.exec(i.message)![1])));
    const others = (proposal.issues || []).filter(i => i.severity !== 'error' && !(i.severity === 'warning' && inputRe.test(i.message)));
    return (
      <div className="mt-2 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#141414] overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-100 dark:border-white/5 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-bold text-gray-800 dark:text-gray-100 truncate">{proposal.name}</div>
            <div className="text-[10px] text-gray-400">{stepCount(proposal.payload)} steps · {proposal.source || 'agent'}</div>
          </div>
          <span className={`shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${ok === false || errors.length ? 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300' : 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'}`}>
            {ok === false || errors.length ? `${errors.length} problem${errors.length === 1 ? '' : 's'}` : 'validates'}
          </span>
        </div>
        {questionList(questions)}
        {inputs.length > 0 && (
          <div className="px-3 py-2 border-b border-gray-100 dark:border-white/5 text-[11px] text-gray-600 dark:text-gray-300">
            <span className="font-semibold text-gray-700 dark:text-gray-200">Inputs</span>, filled per sample on the Iterate page or by the optimizer:{' '}
            {inputs.map(n => <code key={n} className="font-mono px-1 rounded bg-gray-100 dark:bg-white/10 mr-1">#{n}</code>)}
          </div>
        )}
        {issueList([...errors, ...others])}
        {raw && (
          <details className="px-3 py-2 border-b border-gray-100 dark:border-white/5">
            <summary className="text-[10px] text-gray-400 cursor-pointer">What the model actually replied</summary>
            <pre className="mt-1 text-[10px] whitespace-pre-wrap break-all text-gray-500 max-h-40 overflow-auto">{raw}</pre>
          </details>
        )}
        <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
          {decided ? <span className="text-[11px] text-gray-400 italic">{proposal.status}</span> : designer ? (
            <>
              <button onClick={() => putOnCanvas(proposal)} className={primaryButton}><Check className="w-3 h-3" /> Put on canvas</button>
              <button onClick={() => setDiffFor(proposal)} className={secondaryButton}><GitCompare className="w-3 h-3" /> Compare</button>
            </>
          ) : (
            <>
              <button onClick={() => openInDesigner(proposal)} className={primaryButton}><PenLine className="w-3 h-3" /> Open in Designer</button>
              <button onClick={() => saveToLibrary(proposal)} disabled={errors.length > 0} title={errors.length ? 'Fix it in the Designer first' : 'Save it as a workflow without editing'} className={`${secondaryButton} disabled:opacity-40`}><Library className="w-3 h-3" /> Save to library</button>
            </>
          )}
          {!decided && (
            <button onClick={() => dismiss(proposal)} title="Discard this suggestion" className="ml-auto p-1 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  };

  if (!open || onLauncher) return null;
  const providerInfo = providers.find(p => p.name === settings?.provider);
  const modeInfo = MODES.find(m => m.key === mode)!;

  return (
    <aside
      ref={panelRef}
      style={{ top: area.top }}
      className="fixed right-0 bottom-0 z-[9000] w-[26rem] max-w-[92vw] flex flex-col border-l border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-[#111] shadow-2xl"
      aria-label="Assistant"
    >
      <div className="shrink-0 px-4 pt-3 pb-2 border-b border-gray-200 dark:border-white/10 bg-white/90 dark:bg-black/30">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="w-4 h-4 text-accent shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-bold text-gray-800 dark:text-gray-100">Assistant</div>
              <div className="text-[10px] text-gray-400 truncate">
                {settings ? `${settings.provider}${settings.model ? ` · ${settings.model}` : ''}` : 'not configured'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => setSettingsOpen(v => !v)} title="Model settings" className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-white/10"><Settings2 className="w-4 h-4" /></button>
            <button onClick={startNewChat} disabled={busy || turns.length === 0} title="Start a new conversation" className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"><MessageSquarePlus className="w-4 h-4" /></button>
            <button onClick={closeAssistant} title="Close" className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-white/10"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-white/5 p-0.5" role="tablist" aria-label="What to do">
          {MODES.map(m => (
            <button key={m.key} role="tab" aria-selected={mode === m.key} title={m.hint} onClick={() => setAssistantMode(m.key)}
              className={`flex-1 rounded-md px-2 py-1 text-[11px] font-semibold ${mode === m.key ? 'bg-white text-gray-900 shadow-sm dark:bg-white/15 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'}`}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {settingsOpen && (
        <div className="px-4 py-3 border-b border-gray-200 dark:border-white/10 bg-white dark:bg-[#141414] space-y-2">
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-400">Provider</label>
            <select value={settings?.provider || 'ollama'} onChange={e => saveSettings({ provider: e.target.value })}
              className="w-full mt-1 bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs outline-none">
              {providers.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-400">Endpoint</label>
            <input type="text" key={`url-${settings?.provider}`} defaultValue={settings?.base_url || providerInfo?.default_base_url || ''} onBlur={e => saveSettings({ base_url: e.target.value })}
              className="w-full mt-1 bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs outline-none font-mono" />
          </div>
          {providerInfo?.needs_api_key && (
            <div>
              <label className="text-[10px] font-bold uppercase text-gray-400">API key {settings?.api_key_set && <span className="text-green-600 normal-case">· saved</span>}</label>
              <input type="password" value={apiKeyDraft} placeholder={settings?.api_key_set ? '•••••••• (leave blank to keep)' : ''}
                onChange={e => setApiKeyDraft(e.target.value)}
                onBlur={() => { if (apiKeyDraft) { saveSettings({ api_key: apiKeyDraft }); setApiKeyDraft(''); } }}
                className="w-full mt-1 bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs outline-none" />
            </div>
          )}
          <div>
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-bold uppercase text-gray-400">Model</label>
              <button onClick={loadModels} className="text-[10px] text-gray-400 hover:text-gray-600 flex items-center gap-1"><RefreshCw className="w-3 h-3" /> refresh</button>
            </div>
            {models.length > 0 ? (
              <select value={settings?.model || ''} onChange={e => saveSettings({ model: e.target.value })}
                className="w-full mt-1 bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs outline-none">
                <option value="">(provider default)</option>
                {models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input type="text" key={`model-${settings?.provider}`} defaultValue={settings?.model || ''} placeholder={providerInfo?.default_model || 'model name'} onBlur={e => saveSettings({ model: e.target.value })}
                className="w-full mt-1 bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs outline-none font-mono" />
            )}
            {modelError && (
              <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /><span>{modelError}</span></div>
            )}
          </div>
        </div>
      )}

      {inbox.length > 0 && (
        <div className="px-4 py-2 border-b border-gray-200 dark:border-white/10 bg-accent-soft/40">
          <div className="text-[10px] font-bold uppercase text-accent-fg mb-1 flex items-center gap-1"><Bot className="w-3 h-3" /> waiting for you ({inbox.length})</div>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {inbox.map(p => <div key={p.id}>{renderProposal(p)}</div>)}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {turns.length === 0 && inbox.length === 0 && (
          <div className="text-xs text-gray-400 dark:text-gray-500 space-y-2">
            {mode === 'ask' && <>
              <p>Ask about this deck&apos;s runs. Answers come from its own records, with the runs they used.</p>
              <p className="italic">“Which catalyst loading gave the best yield last week?” · “Compare my last two plates.” · “Why did run 12 stop?”</p>
            </>}
            {mode === 'workflow' && <>
              <p>Describe a protocol in your own words and it is drafted against this deck.{designer ? ' With steps on the canvas, it edits them instead.' : ''}</p>
              <p className="italic">“Charge the vial with 1 mL of substrate, add 2.5 mol% catalyst, hold at 65 °C for two hours, then assay the yield by HPLC.”</p>
            </>}
            {mode === 'safety' && <>
              <p>Say what should never happen, and it is written as limits, states and rules for you to review on the Safety page.</p>
              <p className="italic">“The arm may only put something on the balance when its door is open.” · “No pump faster than 5 mL/min.”</p>
            </>}
            <p className="text-[11px]">Nothing is saved, run or enforced until you accept it.</p>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i}>
            {turn.role === 'user' && (
              <div className="ml-6 rounded-xl bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/15 px-3 py-2 text-xs text-gray-800 dark:text-gray-100 whitespace-pre-wrap">{turn.content}</div>
            )}
            {turn.role === 'assistant' && (
              <div className="mr-2">
                <div className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{turn.content}</div>
                {!!turn.runs?.length && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {turn.runs.map(id => (
                      <button key={id} onClick={() => toPage('open-run', id)} title="Open in Data History"
                        className="rounded-md border border-gray-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300">#{id}</button>
                    ))}
                  </div>
                )}
                {turn.proposal && renderProposal(turn.proposal, turn.questions, turn.ok, turn.raw)}
                {!turn.proposal && turn.mode === 'safety' && turn.questions && turn.questions.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-[11px] text-amber-700 dark:text-amber-300">{turn.questions.map((q, j) => <li key={j}>{q}</li>)}</ul>
                )}
              </div>
            )}
            {turn.role === 'error' && (
              <div className="rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{turn.content}</span>
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#141414] p-3 space-y-1.5">
            {progress.map((step, i) => (
              <div key={i} className="flex items-start gap-2 text-[11px]">
                {i === progress.length - 1 ? <Loader2 className="w-3 h-3 mt-0.5 shrink-0 animate-spin text-accent" /> : <Check className="w-3 h-3 mt-0.5 shrink-0 text-green-500" />}
                <div className="min-w-0">
                  <div className={step.bad ? 'text-amber-700 dark:text-amber-400' : 'text-gray-600 dark:text-gray-300'}>{step.text}</div>
                  {step.detail && <pre className="mt-0.5 whitespace-pre-wrap text-[10px] text-gray-400 font-mono">{step.detail}</pre>}
                </div>
              </div>
            ))}
            {progress.length === 0 && <div className="flex items-center gap-2 text-[11px] text-gray-400"><Loader2 className="w-3 h-3 animate-spin" /> starting…</div>}
          </div>
        )}
      </div>

      <div className="shrink-0 p-3 border-t border-gray-200 dark:border-white/10 bg-white dark:bg-[#141414] space-y-2">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          rows={3}
          placeholder={mode === 'ask' ? 'Ask about your runs…' : mode === 'safety' ? 'Say what should be prevented…' : 'Describe the protocol, or the change you want…'}
          disabled={busy}
          className="w-full resize-none bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-xl px-3 py-2 text-xs outline-none focus:border-accent disabled:opacity-60"
        />
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[10px] text-gray-400 dark:text-gray-600 truncate">{modeInfo.hint} · Enter to send</span>
          <button onClick={send} disabled={busy || !draft.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[11px] font-bold disabled:opacity-40 transition-colors">
            <Send className="w-3.5 h-3.5" /><span>Send</span>
          </button>
        </div>
      </div>

      <WorkflowDiff
        isOpen={!!diffFor && !!designer}
        title={`Suggested changes to ${diffFor?.name || ''}`}
        fromLabel="On the canvas now"
        toLabel="Suggested"
        rows={diffRows}
        applyLabel="Put on canvas"
        onApply={() => diffFor && putOnCanvas(diffFor)}
        onClose={() => setDiffFor(null)}
      />
    </aside>
  );
}
