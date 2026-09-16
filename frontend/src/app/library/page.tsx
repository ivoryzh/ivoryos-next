"use client";
import { API_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Book, Download, Sun, Moon, Search, Calendar, Clock, Filter, ArrowUpDown, Link2, History, X, Trash2, Tag } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { toSequenceBlocks, confirmDialog, notify, openDialog } from '@ivoryos/shared-ui';

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
};

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
  const [allTags, setAllTags] = useState<string[]>([]);
  const [activeTags, setActiveTags] = useState<string[]>([]);
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

  const editTags = async (workflow: WorkflowItem) => {
    // openDialog rather than promptDialog: an emptied field has to mean "remove all tags", and
    // promptDialog collapses empty input to null so it can't be told apart from Cancel.
    const res = await openDialog({
      title: `Tags for "${workflow.name}"`,
      message: 'Separate tags with commas. Tags are only labels for finding things — changing them '
             + 'creates no new version and affects nothing that links to this workflow. '
             + 'Clear the field to remove all of them.',
      input: {
        defaultValue: (workflow.tags || []).join(', '),
        placeholder: 'screening, calibration',
      },
      actions: [
        { id: 'cancel', label: 'Cancel', kind: 'cancel' },
        { id: 'ok', label: 'Save tags', kind: 'primary' },
      ],
    });
    if (res.action !== 'ok') return;
    const entered = res.value || '';
    try {
      const saved = await fetch(`${API_BASE}/api/workflows/${encodeURIComponent(workflow.name)}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: entered.split(',') }),
      });
      const data = await saved.json();
      if (!saved.ok) throw new Error(data.error || 'Could not save tags');
      fetchWorkflows();
    } catch (e: any) {
      await notify(e.message, { title: 'Could not save tags', tone: 'error' });
    }
  };

  const filteredWorkflows = workflows.filter(w =>
    (w.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
     w.description.toLowerCase().includes(searchQuery.toLowerCase()))
    // AND across selected tags: each one you add narrows the list, which is what people expect
    // from filter chips and what makes combining two of them useful.
    && activeTags.every(t => hasTag(w, t))
  ).sort((a, b) => {
     let valA = a[sortBy];
     let valB = b[sortBy];
     if (typeof valA === 'string') valA = valA.toLowerCase();
     if (typeof valB === 'string') valB = valB.toLowerCase();
     if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
     if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
     return 0;
  });

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
      localStorage.setItem('ivoryos_sequence', JSON.stringify(toSequenceBlocks(legacyData.script, instruments)));
      localStorage.setItem('ivoryos_prep_sequence', JSON.stringify(toSequenceBlocks(legacyData.prep, instruments)));
      localStorage.setItem('ivoryos_cleanup_sequence', JSON.stringify(toSequenceBlocks(legacyData.cleanup, instruments)));
      localStorage.setItem('ivoryos_editing_workflow', name);
      localStorage.setItem('ivoryos_editing_workflow_desc', legacyData.description || '');
      localStorage.setItem('ivoryos_is_unsaved', version ? 'true' : 'false');
      window.location.href = '/designer';
    } catch (e: any) {
      await notify(e.message, { title: 'Could not load workflow', tone: 'error' });
    }
  };

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
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
                </div>
            </div>
        </div>

        {allTags.length > 0 && (
          <div className="px-8 pb-2 flex items-center flex-wrap gap-2">
            <Tag className="w-3.5 h-3.5 text-gray-400 shrink-0" />
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
            {activeTags.length > 0 && (
              <button
                onClick={() => setActiveTags([])}
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
                {activeTags.length > 0
                  ? `Nothing is tagged ${activeTags.join(' + ')}.`
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
                        {/* The blast radius of editing this workflow: these resolve to it at run
                            time and change with it. Copies never appear here, because an inlined
                            copy holds no reference for anything to propagate through. */}
                        {(workflow.linked_by?.length ?? 0) > 0 && (
                          <div className="mt-3 flex items-start gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40 rounded-lg px-2 py-1.5">
                            <Link2 className="w-3.5 h-3.5 shrink-0 mt-px" />
                            <span className="min-w-0">
                              Used by <strong>{workflow.linked_by!.join(', ')}</strong> — editing this changes {workflow.linked_by!.length > 1 ? 'them' : 'it'} too.
                            </span>
                          </div>
                        )}
                        {(workflow.links?.length ?? 0) > 0 && (
                          <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
                            Links to {workflow.links!.join(', ')}
                          </p>
                        )}
                        {/* Clicking a chip filters by it, so the card is also the way you navigate
                            between related protocols rather than a dead label. */}
                        <div className="mt-3 flex flex-wrap items-center gap-1.5">
                          {(workflow.tags || []).map(tag => (
                            <button
                              key={tag}
                              onClick={() => toggleTag(tag)}
                              title={isTagActive(tag) ? `Stop filtering by ${tag}` : `Filter by ${tag}`}
                              className={`px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors ${
                                isTagActive(tag)
                                  ? 'bg-indigo-600 border-indigo-600 text-white'
                                  : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10'
                              }`}
                            >
                              {tag}
                            </button>
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
                            onClick={() => loadWorkflow(workflow.name)}
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
                    onClick={() => loadWorkflow(historyFor, v.version)}
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
