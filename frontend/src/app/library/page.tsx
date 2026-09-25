"use client";
import { API_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Book, Download, Sun, Moon, Search, Calendar, Clock, Filter, ArrowUpDown, AlertTriangle, Trash2, Link2, History, X, Tag, Plus } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { workflowSignature, toSequenceBlocks, confirmDialog, notify, runtimeSummary, formatDuration, type WorkflowRuntime } from '@ivoryos/shared-ui';

type WorkflowItem = {
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
  // Present since workflows became append-only. `linked_by` is the blast radius of editing this
  // workflow: those are the ones that resolve to it at run time and will change with it.
  version?: number;
  note?: string;
  links?: string[];
  linked_by?: string[];
  // Free-form labels, stored beside the workflow rather than inside it. Tags rather than folders
  // because a protocol genuinely belongs to several groupings at once ("screening" *and*
  // "calibration"), and because a folder would be a second identity for something whose name is
  // already its identity — moving one would break every pinned reference to it.
  tags?: string[];
  // Whether this still runs against the drivers currently connected. Computed server-side by the
  // same validator the agent uses, cached per body_hash + deck fingerprint — so it is already in
  // the listing response rather than something this page has to ask for. See compatibility.py.
  compatibility?: { status: 'ok' | 'broken'; error_count: number; deck_version?: number; errors: { where?: string; message: string; hint?: string }[] };
  // Typical duration from this deck's own completed runs of it (runtime.py); absent until it has run.
  runtime?: WorkflowRuntime | null;
};

// Mirrors MAX_TAGS / MAX_TAG_LENGTH in edge_server/ivoryos_edge/workflows.py. Enforced here too
// so the editor shows the real limit instead of silently dropping what the server trims.
const MAX_TAGS = 24;
const MAX_TAG_LENGTH = 40;

/**
 * A card's link relationships, on exactly one line, with the full list on hover.
 *
 * These lists grow — a workflow used by four others wrapped to three lines, pushing that card's
 * dates and buttons down so it no longer lined up with the cards beside it. What you scan a card
 * for is *whether* it has dependents and how many; the names are worth a hover, not three lines
 * of every card forever. One name is still shown outright, since at that point the name is
 * shorter than the count would be.
 */
function LinkLine({ names, tone, lead, tooltipTitle }: {
  names: string[];
  tone: 'warn' | 'muted';
  lead: string;
  tooltipTitle: string;
}) {
  const isWarn = tone === 'warn';
  return (
    <div
      className={`group/links relative mt-2 flex items-center gap-1.5 text-[11px] ${
        isWarn
          ? 'mt-3 rounded-lg px-2 py-1.5 text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40'
          : 'text-gray-500 dark:text-gray-400'
      }`}
    >
      {isWarn && <Link2 className="w-3.5 h-3.5 shrink-0" />}
      {/* The consequence ("editing changes them too") lives in the tooltip, not here: spelled out
          inline it was the part that overflowed, so the warning was the first thing to be cut. The
          emerald box already says "this has consequences"; the tooltip says which. */}
      <span className="min-w-0 flex-1 truncate">
        {lead} <strong>{names.length === 1 ? names[0] : `${names.length} workflows`}</strong>
      </span>
      {/* Above rather than below: these sit low on the card, and a tooltip opening downward fell
          outside it and got clipped by the grid. */}
      <div className="hidden group-hover/links:block absolute left-0 bottom-full mb-1.5 z-50 w-max max-w-[240px] p-2.5 rounded-lg bg-gray-900 text-white dark:bg-white dark:text-gray-900 text-[11px] shadow-xl pointer-events-none">
        <p className="font-semibold mb-1 opacity-70">{tooltipTitle}</p>
        <ul className="space-y-0.5">
          {names.map(n => <li key={n} className="break-words">{n}</li>)}
        </ul>
      </div>
    </div>
  );
}

/**
 * A workflow that no longer fits the deck.
 *
 * Stored steps name an instrument, a method and arguments, and none of it is resolved until the
 * workflow runs — so a driver edit (a renamed parameter, a dropped method, an instrument swapped
 * for a newer model) leaves every affected workflow looking perfectly fine until someone queues
 * one and a reaction fails four steps in. This is that failure, moved to where the decision to
 * run is actually made.
 *
 * Red rather than amber, and the count rather than the first message: the count is what says how
 * much work this is, and the messages are long enough that one of them inline would push the rest
 * of the card out. The tooltip carries them, with the step each one is about.
 */
function IncompatibleLine({ compatibility }: { compatibility: NonNullable<WorkflowItem['compatibility']> }) {
  const { error_count: count, errors } = compatibility;
  return (
    <div className="group/compat relative mt-3 flex items-center gap-1.5 text-[11px] rounded-lg px-2 py-1.5 text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        Won&apos;t run on this deck — <strong>{count === 1 ? '1 problem' : `${count} problems`}</strong>
        {compatibility.deck_version ? <span className="opacity-70"> · written for deck v{compatibility.deck_version}</span> : null}
      </span>
      <div className="hidden group-hover/compat:block absolute left-0 bottom-full mb-1.5 z-50 w-max max-w-[300px] p-2.5 rounded-lg bg-gray-900 text-white dark:bg-white dark:text-gray-900 text-[11px] shadow-xl pointer-events-none">
        <p className="font-semibold mb-1 opacity-70">Checked against the connected instruments:</p>
        <ul className="space-y-1">
          {errors.map((e: { where?: string; message: string }, i: number) => (
            <li key={i} className="break-words">
              {e.where ? <span className="font-mono opacity-60">{e.where} </span> : null}
              {e.message}
            </li>
          ))}
          {count > errors.length && (
            <li className="opacity-60">…and {count - errors.length} more. Open it in the Designer to see every step.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

/**
 * The one tag nobody types: a workflow other workflows link to. Derived from `linked_by` on every
 * load rather than stored, so it can never go stale — unlinking the last dependent removes it, and
 * there is nothing to edit or forget to clean up. It carries the list of dependents on hover,
 * which is the reason to care: editing this workflow changes them too.
 */
const USED_BY_TAG = 'used by others';

function UsedByTag({ names }: { names: string[] }) {
  return (
    <span className="group/usedby relative inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-900/20 dark:border-emerald-800/40 dark:text-emerald-400">
      <Link2 className="w-3 h-3" />
      used by {names.length === 1 ? names[0] : `${names.length}`}
      <span className="hidden group-hover/usedby:block absolute left-0 bottom-full mb-1.5 z-50 w-max max-w-[240px] p-2.5 rounded-lg bg-gray-900 text-white dark:bg-white dark:text-gray-900 text-[11px] font-normal shadow-xl pointer-events-none">
        <span className="block font-semibold mb-1 opacity-70">Editing this changes {names.length > 1 ? 'them' : 'it'} too:</span>
        {names.map(n => <span key={n} className="block break-words">{n}</span>)}
      </span>
    </span>
  );
}

type VersionEntry = {
  version: number;
  updated_at: number;
  note?: string;
  author?: string;
  steps: number;
};

export default function LibraryPage() {
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [edgeStatus, setEdgeStatus] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'created_at' | 'updated_at'>('updated_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  // Workflows that won't run on this deck go after the ones that will, whatever the sort — the
  // library is mostly opened to pick something to run.
  const [workingFirst, setWorkingFirst] = useState(true);
  const [usedByOnly, setUsedByOnly] = useState(false);
  // Loading a workflow overwrites whatever is on the designer canvas. If that canvas holds
  // unsaved edits, legacy IvoryOS stopped and asked first instead of silently discarding them.
  const [pendingLoad, setPendingLoad] = useState<{ name: string; draftName: string; version?: number } | null>(null);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  // The tag editor holds its own working copy, so Cancel really cancels and nothing is written
  // until Save.
  const [tagEditor, setTagEditor] = useState<{ name: string; tags: string[] } | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [savingTags, setSavingTags] = useState(false);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionEntry[] | null>(null);

  useEffect(() => {
    // Theme init
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');

    fetchWorkflows();
    
    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => setEdgeStatus(data))
      .catch(err => console.error(err));
  }, []);

  const fetchWorkflows = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/workflows`);
      const data = await res.json();
      if (data.workflows) {
        const mapped = data.workflows.map((w: any) => {
          if (typeof w === 'string') return { name: w, description: '', created_at: 0, updated_at: 0 };
          return w;
        });
        setWorkflows(mapped);
        setAllTags(data.tags || []);
        // Drop filters whose tag no longer exists anywhere, so the list can't silently come back
        // empty with no visible reason.
        setActiveTags(prev => prev.filter(t =>
          (data.tags || []).some((known: string) => known.toLowerCase() === t.toLowerCase())));
      }
    } catch (e) {
      console.error(e);
    }
  };

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  // Tags are compared case-insensitively everywhere, matching how the server dedupes them. The
  // filter bar shows one chip for "screening"/"Screening", so an exact-match filter would silently
  // fail to find the workflows spelled the other way.
  const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const hasTag = (workflow: WorkflowItem, tag: string) =>
    (workflow.tags || []).some(t => sameTag(t, tag));
  const isTagActive = (tag: string) => activeTags.some(t => sameTag(t, tag));

  const toggleTag = (tag: string) =>
    setActiveTags(prev => prev.some(t => sameTag(t, tag)) ? prev.filter(t => !sameTag(t, tag)) : [...prev, tag]);

  // Tags are edited as chips, not as a comma-separated string. One text field holding
  // "screening, calibration" makes you retype the whole set to drop one of them, gives no hint
  // that "Screening" already exists elsewhere in the library, and turns a typo into a new tag
  // that quietly files the workflow on its own. Add one at a time, remove with an x, and pick
  // from what's already in use.
  const editTags = (workflow: WorkflowItem) => {
    setTagEditor({ name: workflow.name, tags: [...(workflow.tags || [])] });
    setTagDraft('');
  };

  const addTag = (raw: string) => {
    // Mirrors the server's normalise_tags so what you see in the dialog is what gets stored:
    // collapse whitespace, cap the length, dedupe case-insensitively, cap the count.
    const cleaned = raw.split(/\s+/).filter(Boolean).join(' ').slice(0, MAX_TAG_LENGTH).trim();
    if (!cleaned || !tagEditor) return;
    if (tagEditor.tags.some(t => sameTag(t, cleaned))) { setTagDraft(''); return; }
    if (tagEditor.tags.length >= MAX_TAGS) return;
    setTagEditor({ ...tagEditor, tags: [...tagEditor.tags, cleaned] });
    setTagDraft('');
  };

  const removeTag = (tag: string) => {
    if (!tagEditor) return;
    setTagEditor({ ...tagEditor, tags: tagEditor.tags.filter(t => !sameTag(t, tag)) });
  };

  const saveTags = async () => {
    if (!tagEditor) return;
    setSavingTags(true);
    try {
      const saved = await fetch(`${API_BASE}/api/workflows/${encodeURIComponent(tagEditor.name)}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: tagEditor.tags }),
      });
      const data = await saved.json();
      if (!saved.ok) throw new Error(data.error || 'Could not save tags');
      setTagEditor(null);
      fetchWorkflows();
    } catch (e: any) {
      await notify(e.message, { title: 'Could not save tags', tone: 'error' });
    } finally {
      setSavingTags(false);
    }
  };

  const filteredWorkflows = workflows.filter(w =>
    (w.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
     w.description.toLowerCase().includes(searchQuery.toLowerCase()))
    // AND across selected tags: each one you add narrows the list, which is what people expect
    // from filter chips and what makes combining two of them useful.
    && activeTags.every(t => hasTag(w, t))
    && (!usedByOnly || (w.linked_by?.length ?? 0) > 0)
  ).sort((a, b) => {
     if (workingFirst) {
       const broken = (w: WorkflowItem) => (w.compatibility?.status === 'broken' ? 1 : 0);
       if (broken(a) !== broken(b)) return broken(a) - broken(b);
     }
     let valA = a[sortBy];
     let valB = b[sortBy];
     if (typeof valA === 'string') valA = valA.toLowerCase();
     if (typeof valB === 'string') valB = valB.toLowerCase();
     if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
     if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
     return 0;
  });

  const requestLoad = (name: string, version?: number) => {
    const unsaved = localStorage.getItem('ivoryos_is_unsaved') === 'true';
    const hasBlocks = ['ivoryos_sequence', 'ivoryos_prep_sequence', 'ivoryos_cleanup_sequence'].some(key => {
      try {
        const raw = localStorage.getItem(key);
        return !!raw && JSON.parse(raw).length > 0;
      } catch {
        return false;
      }
    });
    const draftName = localStorage.getItem('ivoryos_editing_workflow') || '';
    if (unsaved && hasBlocks && draftName !== name) {
      setPendingLoad({ name, draftName, version });
      return;
    }
    loadWorkflow(name, version);
  };

  // Deleting is guarded server-side: the API returns 409 while another workflow still links to
  // this one, naming them. Forcing past that is offered explicitly rather than silently, because
  // it leaves those workflows unable to run until their steps are detached.
  const deleteWorkflow = async (workflow: WorkflowItem) => {
    const ok = await confirmDialog(
      'Past runs keep their own copy of what they executed, so their history is unaffected.',
      { title: `Delete "${workflow.name}"?`, confirmLabel: 'Delete', tone: 'danger' },
    );
    if (!ok) return;
    try {
      let res = await fetch(`${API_BASE}/api/workflows/${encodeURIComponent(workflow.name)}`, { method: 'DELETE' });
      if (res.status === 409) {
        const blocked = await res.json();
        const force = await confirmDialog(blocked.error, {
          title: 'Other workflows still use this',
          confirmLabel: 'Delete anyway',
          tone: 'danger',
        });
        if (!force) return;
        res = await fetch(`${API_BASE}/api/workflows/${encodeURIComponent(workflow.name)}?force=true`, { method: 'DELETE' });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      fetchWorkflows();
    } catch (e: any) {
      await notify(e.message, { title: 'Could not delete', tone: 'error' });
    }
  };

  const fetchVersions = async (name: string) => {
    setHistoryFor(name);
    setVersions(null);
    try {
      const res = await fetch(`${API_BASE}/api/workflows/${name}/versions`);
      const data = await res.json();
      setVersions(data.versions || []);
    } catch (e) {
      setVersions([]);
    }
  };

  // `version` loads an older snapshot instead of the head. Opening an old version in the Designer
  // does not roll anything back on its own — saving from there is what creates the next version,
  // which keeps the history append-only and makes a "restore" just another ordinary edit.
  const loadWorkflow = async (name: string, version?: number) => {
    setPendingLoad(null);
    try {
      const url = version
        ? `${API_BASE}/api/workflows/${name}?version=${version}`
        : `${API_BASE}/api/workflows/${name}`;
      const res = await fetch(url);
      const legacyData = await res.json();
      if (!res.ok) throw new Error(legacyData.error || 'Workflow could not be read');

      const statRes = await fetch(`${API_BASE}/api/status`);
      const statusData = await statRes.json();
      const instruments = statusData.instruments || {};

      // Shared with the Designer's import path and the Cloud editor, so a saved block means the
      // same thing everywhere (AGENTS.md section 3).
      const newSequence = toSequenceBlocks(legacyData.script, instruments);
      const prepSequence = toSequenceBlocks(legacyData.prep, instruments);
      const cleanupSequence = toSequenceBlocks(legacyData.cleanup, instruments);
      localStorage.setItem('ivoryos_sequence', JSON.stringify(newSequence));
      localStorage.setItem('ivoryos_prep_sequence', JSON.stringify(prepSequence));
      localStorage.setItem('ivoryos_cleanup_sequence', JSON.stringify(cleanupSequence));
      localStorage.setItem('ivoryos_editing_workflow', name);
      localStorage.setItem('ivoryos_editing_workflow_desc', legacyData.description || '');
      // A freshly loaded head version matches what's on disk, so it starts clean — otherwise the
      // designer would show "Unsaved" (and this page would warn) before a single edit. Loading an
      // older version is deliberately marked unsaved instead: saving from there creates the next
      // version rather than silently rolling back, so it should read the same as any other edit.
      localStorage.setItem(
        'ivoryos_saved_signature',
        workflowSignature(prepSequence, newSequence, cleanupSequence, name, legacyData.description || '')
      );
      localStorage.setItem('ivoryos_is_unsaved', version ? 'true' : 'false');
      window.location.href = '/designer';
    } catch (e: any) {
      await notify(e.message, { title: 'Could not load workflow', tone: 'error' });
    }
  };

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {pendingLoad && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#1a1a1a] border border-amber-200 dark:border-amber-500/30 rounded-2xl shadow-2xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              </div>
              <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">You have unsaved changes</h2>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              The designer canvas {pendingLoad.draftName ? <>still holds unsaved edits to <span className="font-semibold text-gray-800 dark:text-gray-200">{pendingLoad.draftName}</span></> : 'still holds an unsaved draft'}.
              Loading <span className="font-semibold text-gray-800 dark:text-gray-200">{pendingLoad.name}</span> will replace it.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingLoad(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 transition-colors"
              >
                Keep editing
              </button>
              <a
                href="/designer"
                className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:hover:bg-indigo-800/40 text-indigo-600 dark:text-indigo-300 transition-colors"
              >
                Go save it first
              </a>
              <button
                onClick={() => loadWorkflow(pendingLoad.name, pendingLoad.version)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-colors"
              >
                Discard &amp; load
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Sidebar */}
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      {/* Main Area */}
      <div className="flex-1 flex flex-col relative z-0">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 className="text-base font-medium text-gray-800 dark:text-gray-200">Workflow Library</h2>
        </header>

        <div className="px-8 pt-8 pb-4">
            <div className="flex flex-col sm:flex-row justify-between items-center space-y-4 sm:space-y-0">
                <div className="relative w-full sm:w-96">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                    <input 
                        type="text" 
                        placeholder="Search workflows..." 
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                </div>
                <div className="flex items-center space-x-3 w-full sm:w-auto">
                    <div className="flex items-center space-x-2 text-sm text-gray-500">
                        <Filter className="w-4 h-4" />
                        <span>Sort by:</span>
                    </div>
                    <select 
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as any)}
                        className="bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-lg text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                        <option value="updated_at">Last Modified</option>
                        <option value="created_at">Date Created</option>
                        <option value="name">Name</option>
                    </select>
                    <button 
                        onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                        className="p-2 border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                    >
                        <ArrowUpDown className="w-4 h-4 text-gray-500" />
                    </button>
                    <label
                        title="List workflows that won't run on this deck after the ones that will"
                        className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 cursor-pointer select-none whitespace-nowrap"
                    >
                        <input
                            type="checkbox"
                            checked={workingFirst}
                            onChange={(e) => setWorkingFirst(e.target.checked)}
                            className="accent-indigo-600"
                        />
                        working first
                    </label>
                </div>
            </div>
        </div>

        {(allTags.length > 0 || workflows.some(w => (w.linked_by?.length ?? 0) > 0)) && (
          <div className="px-8 pb-2 flex items-center flex-wrap gap-2">
            <Tag className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            {workflows.some(w => (w.linked_by?.length ?? 0) > 0) && (
              <button
                onClick={() => setUsedByOnly(v => !v)}
                title="Added automatically to every workflow another workflow links to"
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  usedByOnly
                    ? 'bg-emerald-600 border-emerald-600 text-white'
                    : 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:border-emerald-800/40 dark:text-emerald-400 dark:hover:bg-emerald-900/40'
                }`}
              >
                <Link2 className="w-3 h-3" />
                {USED_BY_TAG}
              </button>
            )}
            {allTags.map(tag => {
              const on = isTagActive(tag);
              return (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    on
                      ? 'bg-indigo-600 border-indigo-600 text-white'
                      : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10'
                  }`}
                >
                  {tag}
                </button>
              );
            })}
            {(activeTags.length > 0 || usedByOnly) && (
              <button
                onClick={() => { setActiveTags([]); setUsedByOnly(false); }}
                className="px-2 py-1 text-xs font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        <div className="px-8 pb-8 flex-1 overflow-y-auto">
          {filteredWorkflows.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-500 dark:text-gray-400 border-2 border-dashed border-gray-300 dark:border-white/10 rounded-2xl">
              <p className="text-sm font-medium">No saved workflows found.</p>
              <p className="text-xs mt-2">
                {activeTags.length > 0 || usedByOnly
                  ? `Nothing is tagged ${[...(usedByOnly ? [USED_BY_TAG] : []), ...activeTags].join(' + ')}.`
                  : 'Check your search filter or go to the Designer to create a new one.'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredWorkflows.map(workflow => (
                <div key={workflow.name} className="bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl p-5 hover:shadow-lg transition-all flex flex-col justify-between">
                    <div>
                        {/* Delete lives up here rather than in the action row below. Three
                            buttons never fit a card at this width, and `justify-end` pushed the
                            overflow out past the card's left border instead of wrapping. */}
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100 min-w-0 break-words">{workflow.name}</h3>
                          <div className="flex items-center gap-1 shrink-0">
                            {workflow.version ? (
                              <span className="mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300">
                                v{workflow.version}
                              </span>
                            ) : null}
                            <button
                              onClick={() => deleteWorkflow(workflow)}
                              title="Delete workflow"
                              className="p-1.5 -mr-1 rounded-md text-gray-300 hover:text-red-600 hover:bg-red-50 dark:text-gray-600 dark:hover:text-red-400 dark:hover:bg-red-900/30 transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                        {workflow.description ? (
                            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2 line-clamp-2">{workflow.description}</p>
                        ) : (
                            <p className="text-xs text-gray-400 mt-2 italic">No description provided.</p>
                        )}
                        {workflow.compatibility?.status === 'broken' && (
                          <IncompatibleLine compatibility={workflow.compatibility} />
                        )}
                        {workflow.runtime?.runs ? (
                          <div
                            className="mt-2 flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400"
                            title={`Median of its recent completed runs: prep ${formatDuration(workflow.runtime.prep_s)}, body ${formatDuration(workflow.runtime.iteration_s)} per pass, cleanup ${formatDuration(workflow.runtime.cleanup_s)}`}
                          >
                            <Clock className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{runtimeSummary(workflow.runtime)}</span>
                          </div>
                        ) : null}
                        {(workflow.links?.length ?? 0) > 0 && (
                          <LinkLine
                            tone="muted"
                            names={workflow.links!}
                            lead="Links to"
                            tooltipTitle="Resolves at run time to:"
                          />
                        )}
                        {/* Labels, not controls. Filtering lives in one place — the chip bar above
                            the list — and a second set of clickable chips on every card only made
                            it ambiguous which one you were touching. */}
                        <div className="mt-3 flex flex-wrap items-center gap-1.5">
                          {/* The blast radius of editing this workflow: these resolve to it at run
                              time and change with it. Copies never appear here, because an inlined
                              copy holds no reference for anything to propagate through. */}
                          {(workflow.linked_by?.length ?? 0) > 0 && <UsedByTag names={workflow.linked_by!} />}
                          {(workflow.tags || []).map(tag => (
                            <span
                              key={tag}
                              className="px-2 py-0.5 rounded-full text-[10px] font-medium border bg-gray-50 border-gray-200 text-gray-600 dark:bg-white/5 dark:border-white/10 dark:text-gray-300"
                            >
                              {tag}
                            </span>
                          ))}
                          <button
                            onClick={() => editTags(workflow)}
                            title="Edit tags"
                            className="px-2 py-0.5 rounded-full text-[10px] font-medium border border-dashed border-gray-300 text-gray-500 hover:text-gray-700 hover:border-gray-400 dark:border-white/15 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
                          >
                            {(workflow.tags || []).length ? 'Edit tags' : '+ Tag'}
                          </button>
                        </div>
                    </div>
                    <div className="mt-4 space-y-2">
                        <div className="flex items-center space-x-2 text-[10px] text-gray-500 uppercase font-bold tracking-wider">
                            <Calendar className="w-3.5 h-3.5" />
                            <span>Created: {workflow.created_at ? new Date(workflow.created_at).toLocaleDateString() : 'N/A'}</span>
                        </div>
                        <div className="flex items-center space-x-2 text-[10px] text-gray-500 uppercase font-bold tracking-wider">
                            <Clock className="w-3.5 h-3.5" />
                            <span>Modified: {workflow.updated_at ? new Date(workflow.updated_at).toLocaleString() : 'N/A'}</span>
                        </div>
                    </div>
                    <div className="mt-6 flex items-center gap-2">
                        <button
                            onClick={() => fetchVersions(workflow.name)}
                            title="Version history"
                            className="flex items-center justify-center gap-2 shrink-0 px-3 py-2 bg-gray-50 hover:bg-gray-100 dark:bg-white/5 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300 rounded-lg transition-colors text-sm font-medium"
                        >
                            {/* Icon-only: at three-column widths the label was costing enough
                                room to truncate the primary action next to it. */}
                            <History className="w-4 h-4" />
                        </button>
                        {/* flex-1 + min-w-0 so the primary action absorbs the remaining width and
                            truncates instead of overflowing the card at three-column widths. */}
                        <button
                            onClick={() => requestLoad(workflow.name)}
                            className="flex-1 min-w-0 flex items-center justify-center gap-2 px-3 py-2 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:hover:bg-indigo-800/40 text-indigo-600 dark:text-indigo-300 rounded-lg transition-colors text-sm font-medium"
                        >
                            <Download className="w-4 h-4 shrink-0" />
                            <span className="truncate">Load to Designer</span>
                        </button>
                    </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {tagEditor && (() => {
        // Only tags that aren't already on this workflow are worth offering — a suggestion that
        // does nothing when clicked is worse than no suggestion.
        const suggestions = allTags.filter(t => !tagEditor.tags.some(applied => sameTag(applied, t)));
        const draftIsNew = tagDraft.trim().length > 0
          && !allTags.some(t => sameTag(t, tagDraft.trim()))
          && !tagEditor.tags.some(t => sameTag(t, tagDraft.trim()));
        const full = tagEditor.tags.length >= MAX_TAGS;
        return (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 p-4" onClick={() => setTagEditor(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md flex flex-col bg-white dark:bg-[#111] rounded-2xl shadow-2xl border border-gray-200 dark:border-white/10">
            <header className="shrink-0 px-5 py-4 border-b border-gray-200 dark:border-white/10 flex items-start justify-between">
              <div className="min-w-0">
                <h2 className="text-base font-bold text-gray-900 dark:text-white break-words">Tags for &ldquo;{tagEditor.name}&rdquo;</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Labels for finding things. Changing them creates no new version.
                </p>
              </div>
              <button onClick={() => setTagEditor(null)} className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 shrink-0 ml-4">
                <X className="w-4 h-4" />
              </button>
            </header>

            <div className="px-5 py-4 space-y-4">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2">On this workflow</p>
                {tagEditor.tags.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">No tags yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {tagEditor.tags.map(tag => (
                      <span key={tag} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/30">
                        {tag}
                        <button
                          onClick={() => removeTag(tag)}
                          title={`Remove ${tag}`}
                          className="p-0.5 rounded-full text-indigo-400 hover:text-indigo-700 hover:bg-indigo-100 dark:hover:text-indigo-200 dark:hover:bg-indigo-500/25 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2">
                  {suggestions.length > 0 ? 'Already in use' : 'Add a tag'}
                </p>
                {suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2.5">
                    {suggestions.map(tag => (
                      <button
                        key={tag}
                        onClick={() => addTag(tag)}
                        disabled={full}
                        title={full ? `Limit of ${MAX_TAGS} tags reached` : `Add ${tag}`}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border border-dashed border-gray-300 text-gray-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-white/15 dark:text-gray-300 dark:hover:border-indigo-400 dark:hover:text-indigo-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <Plus className="w-3 h-3" />
                        {tag}
                      </button>
                    ))}
                  </div>
                )}
                {/* Still a field, because the first workflow to need a tag has nothing to pick
                    from — but it takes one tag, on Enter, not a comma-separated list. */}
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={tagDraft}
                    maxLength={MAX_TAG_LENGTH}
                    disabled={full}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); addTag(tagDraft); }
                      // Backspace on an empty field removes the last chip, the way tag fields
                      // everywhere else behave.
                      else if (e.key === 'Backspace' && !tagDraft && tagEditor.tags.length) {
                        removeTag(tagEditor.tags[tagEditor.tags.length - 1]);
                      }
                    }}
                    placeholder={full ? `Limit of ${MAX_TAGS} tags reached` : 'New tag, then Enter'}
                    className="flex-1 min-w-0 px-3 py-2 rounded-lg text-sm bg-white dark:bg-black/40 border border-gray-300 dark:border-white/10 text-gray-800 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:border-indigo-400 disabled:opacity-50"
                  />
                  <button
                    onClick={() => addTag(tagDraft)}
                    disabled={!tagDraft.trim() || full}
                    className="shrink-0 px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Add
                  </button>
                </div>
                {draftIsNew && (
                  <p className="text-[11px] text-gray-400 mt-1.5">
                    &ldquo;{tagDraft.trim()}&rdquo; is new — it will be created.
                  </p>
                )}
              </div>
            </div>

            <footer className="shrink-0 px-5 py-3 border-t border-gray-200 dark:border-white/10 flex items-center justify-between gap-2">
              <span className="text-[11px] text-gray-400">{tagEditor.tags.length}/{MAX_TAGS}</span>
              <div className="flex gap-2">
                <button
                  onClick={() => setTagEditor(null)}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={saveTags}
                  disabled={savingTags}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-60 transition-colors"
                >
                  {savingTags ? 'Saving...' : 'Save'}
                </button>
              </div>
            </footer>
          </div>
        </div>
        );
      })()}

      {historyFor && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={() => setHistoryFor(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg max-h-[80vh] flex flex-col bg-white dark:bg-[#111] rounded-2xl shadow-2xl border border-gray-200 dark:border-white/10">
            <header className="shrink-0 px-5 py-4 border-b border-gray-200 dark:border-white/10 flex items-start justify-between">
              <div className="min-w-0">
                <h2 className="text-base font-bold text-gray-900 dark:text-white break-words">{historyFor}</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Every save is kept. Opening an older version does not roll anything back on its own —
                  saving from the Designer is what creates the next version.
                </p>
              </div>
              <button onClick={() => setHistoryFor(null)} className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 shrink-0 ml-4">
                <X className="w-4 h-4" />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
              {versions === null && <p className="text-sm text-gray-400 py-6 text-center">Loading...</p>}
              {versions?.length === 0 && <p className="text-sm text-gray-400 py-6 text-center">No history recorded yet.</p>}
              {versions?.map((v, i) => (
                <div key={v.version} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/[0.03] border border-gray-200/70 dark:border-white/5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-gray-800 dark:text-gray-100">v{v.version}</span>
                      {i === 0 && <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300">Current</span>}
                      <span className="text-[11px] text-gray-400">{v.steps} steps</span>
                    </div>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                      {v.updated_at ? new Date(v.updated_at).toLocaleString() : 'unknown time'}
                      {v.author ? ` \u00b7 ${v.author}` : ''}
                      {v.note ? ` \u00b7 ${v.note}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => requestLoad(historyFor, v.version)}
                    className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10"
                  >
                    Open
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
