"use client";
import { API_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Book, Download, Sun, Moon, Search, Calendar, Clock, Filter, ArrowUpDown, AlertTriangle, Trash2 } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { workflowSignature } from '@ivoryos/shared-ui';

type WorkflowItem = {
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
};

export default function LibraryPage() {
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [edgeStatus, setEdgeStatus] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'created_at' | 'updated_at'>('updated_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  // Loading a workflow overwrites whatever is on the designer canvas. If that canvas holds
  // unsaved edits, legacy IvoryOS stopped and asked first instead of silently discarding them.
  const [pendingLoad, setPendingLoad] = useState<{ name: string; draftName: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

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

  const filteredWorkflows = workflows.filter(w => 
    w.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    w.description.toLowerCase().includes(searchQuery.toLowerCase())
  ).sort((a, b) => {
     let valA = a[sortBy];
     let valB = b[sortBy];
     if (typeof valA === 'string') valA = valA.toLowerCase();
     if (typeof valB === 'string') valB = valB.toLowerCase();
     if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
     if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
     return 0;
  });

  const requestLoad = (name: string) => {
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
      setPendingLoad({ name, draftName });
      return;
    }
    loadWorkflow(name);
  };

  const loadWorkflow = async (name: string) => {
    setPendingLoad(null);
    try {
      // 1. Fetch legacy json
      const res = await fetch(`${API_BASE}/api/workflows/${name}`);
      const legacyData = await res.json();
      
      // 2. Fetch schema data
      const statRes = await fetch(`${API_BASE}/api/status`);
      const statusData = await statRes.json();
      const instruments = statusData.instruments || {};

      // 3. Rebuild sequence
      const mapScriptToBlocks = (arr: any[]) => arr.map((action: any) => {
        const schema = instruments[action.instrument]?.[action.action] || { parameters: {} };
        return {
          id: `block-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          instrument: action.instrument,
          method: action.action,
          schema: schema,
          params: action.args || {},
          returnVar: action.return || "",
          // Per-field pointers into a structured return value; absent on workflows saved before
          // pointers existed, which fall back to mapping `return` onto the result positionally.
          returnBindings: action.return_bindings || undefined
        };
      });

      const prepSequence = mapScriptToBlocks(legacyData.prep || []);
      const newSequence = mapScriptToBlocks(legacyData.script || []);
      const cleanupSequence = mapScriptToBlocks(legacyData.cleanup || []);
      // 4. Save and redirect
      localStorage.setItem('ivoryos_sequence', JSON.stringify(newSequence));
      localStorage.setItem('ivoryos_prep_sequence', JSON.stringify(prepSequence));
      localStorage.setItem('ivoryos_cleanup_sequence', JSON.stringify(cleanupSequence));
      localStorage.setItem('ivoryos_editing_workflow', name);
      localStorage.setItem('ivoryos_editing_workflow_desc', legacyData.description || '');
      // A freshly loaded workflow matches what's on disk, so it starts clean — otherwise the
      // designer would show "Unsaved" (and this page would warn) before a single edit.
      localStorage.setItem(
        'ivoryos_saved_signature',
        workflowSignature(prepSequence, newSequence, cleanupSequence, name, legacyData.description || '')
      );
      localStorage.setItem('ivoryos_is_unsaved', 'false');
      window.location.href = '/designer';
    } catch (e: any) {
      alert("Failed to load workflow: " + e.message);
    }
  };

  const deleteWorkflow = async (name: string) => {
    setIsDeleting(true);
    try {
      const res = await fetch(`${API_BASE}/api/workflows/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete workflow');
      setWorkflows(prev => prev.filter(w => w.name !== name));
      setPendingDelete(null);
    } catch (e: any) {
      alert("Failed to delete workflow: " + e.message);
    } finally {
      setIsDeleting(false);
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
                onClick={() => loadWorkflow(pendingLoad.name)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-colors"
              >
                Discard &amp; load
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingDelete && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#1a1a1a] border border-red-200 dark:border-red-500/30 rounded-2xl shadow-2xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg bg-red-50 dark:bg-red-500/10 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-red-600 dark:text-red-400" />
              </div>
              <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">Delete this workflow?</h2>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              <span className="font-semibold text-gray-800 dark:text-gray-200">{pendingDelete}</span> will be permanently removed. This can&rsquo;t be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingDelete(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteWorkflow(pendingDelete)}
                disabled={isDeleting}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white transition-colors"
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
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
                </div>
            </div>
        </div>

        <div className="px-8 pb-8 flex-1 overflow-y-auto">
          {filteredWorkflows.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-500 dark:text-gray-400 border-2 border-dashed border-gray-300 dark:border-white/10 rounded-2xl">
              <p className="text-sm font-medium">No saved workflows found.</p>
              <p className="text-xs mt-2">Check your search filter or go to the Designer to create a new one.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredWorkflows.map(workflow => (
                <div key={workflow.name} className="bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl p-5 hover:shadow-lg transition-all flex flex-col justify-between">
                    <div>
                        <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100">{workflow.name}</h3>
                        {workflow.description ? (
                            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2 line-clamp-2">{workflow.description}</p>
                        ) : (
                            <p className="text-xs text-gray-400 mt-2 italic">No description provided.</p>
                        )}
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
                    <div className="mt-6 flex justify-end items-center gap-2">
                        <button
                            onClick={() => setPendingDelete(workflow.name)}
                            title="Delete workflow"
                            className="flex items-center justify-center w-9 h-9 bg-gray-50 hover:bg-red-50 dark:bg-white/5 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg transition-colors shrink-0"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => requestLoad(workflow.name)}
                            className="flex items-center space-x-2 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:hover:bg-indigo-800/40 text-indigo-600 dark:text-indigo-300 rounded-lg transition-colors text-sm font-medium"
                        >
                            <Download className="w-4 h-4" />
                            <span>Load to Designer</span>
                        </button>
                    </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
