"use client";

import { useState, useEffect } from 'react';
import { Book, Download, Search, Calendar, Clock, Filter, ArrowUpDown, Cloud, Cpu, AlertTriangle } from 'lucide-react';
import { graphProblems } from '@/lib/libraryCheck';
import { runtimeSummary, type WorkflowRuntime } from '@ivoryos/shared-ui';

type Problem = { where?: string; message: string };

// Two distinct kinds of saved workflow live here side by side: a 'distributed' one is a
// multi-device Orchestrator graph (nodes/edges), browser-local only (cloud_saved_workflows) since
// it isn't tied to any one device. An 'edge' one is a single-device prep/sequence/cleanup
// sequence — shared, database-backed (edge_sequences), written either by the edge device itself
// (synced up automatically) or authored directly in the Cloud edge-sequence editor.
type DistributedWorkflowItem = {
  type: 'distributed';
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
  nodes: any[];
  edges: any[];
  /** Checked here, against each device's published schema -- see src/lib/libraryCheck.js. */
  problems: Problem[];
};
type EdgeSequenceItem = {
  type: 'edge';
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
  device_id: string;
  /** The device's own verdict, published with the body -- see `published_sequence` on the edge. */
  problems: Problem[];
  problemCount: number;
  /** Typical duration from the device's own runs of it (edge runtime.py). */
  runtime: WorkflowRuntime | null;
};
type WorkflowItem = DistributedWorkflowItem | EdgeSequenceItem;

/**
 * One line when a workflow will not run as saved, with the reasons on hover. The same treatment as
 * the edge Library's IncompatibleLine, so a broken workflow reads the same in both places.
 */
function ProblemLine({ lead, count, problems }: { lead: string; count: number; problems: Problem[] }) {
  return (
    <div className="group/compat relative mt-3 flex items-center gap-1.5 text-[11px] rounded-lg px-2 py-1.5 text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {lead} — <strong>{count === 1 ? '1 problem' : `${count} problems`}</strong>
      </span>
      <div className="hidden group-hover/compat:block absolute left-0 bottom-full mb-1.5 z-50 w-max max-w-[300px] p-2.5 rounded-lg bg-gray-900 text-white dark:bg-white dark:text-gray-900 text-[11px] shadow-xl pointer-events-none">
        <ul className="space-y-1">
          {problems.map((p, i) => (
            <li key={i} className="break-words">
              {p.where ? <span className="font-mono opacity-60">{p.where} </span> : null}
              {p.message}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function CloudLibraryPage() {
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'created_at' | 'updated_at'>('updated_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  // Workflows with problems go after the ones that will run, whatever the sort.
  const [workingFirst, setWorkingFirst] = useState(true);

  useEffect(() => {
    fetchWorkflows();
  }, []);

  const fetchWorkflows = async () => {
    const items: WorkflowItem[] = [];

    const [sequences, devices] = await Promise.all([
      fetch('/api/edge-sequences').then(r => r.json()).catch(e => { console.error('Failed to fetch edge sequences', e); return []; }),
      fetch('/api/devices').then(r => r.json()).catch(e => { console.error('Failed to fetch devices', e); return []; }),
    ]);
    const sequenceRows: any[] = Array.isArray(sequences) ? sequences : [];
    const deviceRows: any[] = Array.isArray(devices) ? devices : [];

    const saved = localStorage.getItem('cloud_saved_workflows');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        for (const w of parsed) {
          items.push({ ...w, type: 'distributed', problems: graphProblems(w.nodes || [], deviceRows, sequenceRows) });
        }
      } catch (e) {
        console.error("Failed to parse saved workflows", e);
      }
    }

    for (const s of sequenceRows) {
      const verdict = s.body?.compatibility;
      items.push({
        type: 'edge',
        name: s.name,
        description: s.description || '',
        created_at: s.created_at ? new Date(s.created_at).getTime() : 0,
        updated_at: s.updated_at ? new Date(s.updated_at).getTime() : 0,
        device_id: s.device_id,
        problems: verdict?.status === 'broken' ? (verdict.errors || []) : [],
        problemCount: verdict?.status === 'broken' ? (verdict.error_count || 0) : 0,
        runtime: s.body?.runtime || null,
      });
    }

    setWorkflows(items);
  };

  const filteredWorkflows = workflows.filter(w =>
    w.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    w.description.toLowerCase().includes(searchQuery.toLowerCase())
  ).sort((a, b) => {
     if (workingFirst) {
       const broken = (w: WorkflowItem) => ((w.problems?.length ?? 0) > 0 ? 1 : 0);
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

  const loadWorkflow = (workflow: WorkflowItem) => {
    if (workflow.type === 'edge') {
      window.location.href = `/edge-sequence?deviceId=${encodeURIComponent(workflow.device_id)}&sequence=${encodeURIComponent(workflow.name)}`;
      return;
    }
    try {
      localStorage.setItem('cloud_workflow', JSON.stringify({
        nodes: workflow.nodes,
        edges: workflow.edges,
        name: workflow.name
      }));
      window.location.href = '/';
    } catch (e: any) {
      alert("Failed to load workflow: " + e.message);
    }
  };

  return (
    <div className="flex-1 flex flex-col relative z-0 h-full w-full">
      <header className="h-16 shrink-0 border-b flex items-center justify-between px-6 glass-header z-10" style={{ borderColor: 'var(--panel-border)' }}>
        <h2 className="text-sm font-bold tracking-wider flex items-center space-x-2" style={{ color: 'var(--text-secondary)' }}>
          <Book className="w-5 h-5" />
          <span>Cloud Workflow Library</span>
        </h2>
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
                      className="w-full pl-10 pr-4 py-2 border rounded-lg text-sm"
                      style={{ background: 'var(--input-bg)', borderColor: 'var(--panel-border)', color: 'var(--text-primary)' }}
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
                      className="border rounded-lg text-sm px-3 py-2"
                      style={{ background: 'var(--input-bg)', borderColor: 'var(--panel-border)', color: 'var(--text-primary)' }}
                  >
                      <option value="updated_at">Last Modified</option>
                      <option value="created_at">Date Created</option>
                      <option value="name">Name</option>
                  </select>
                  <button 
                      onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                      className="p-2 border rounded-lg hover-bg transition-colors"
                      style={{ borderColor: 'var(--panel-border)', color: 'var(--text-primary)' }}
                  >
                      <ArrowUpDown className="w-4 h-4 text-gray-500" />
                  </button>
                  <label
                      title="List workflows with problems after the ones that will run"
                      className="flex items-center gap-1.5 text-sm cursor-pointer select-none whitespace-nowrap"
                      style={{ color: 'var(--text-secondary)' }}
                  >
                      <input type="checkbox" checked={workingFirst} onChange={(e) => setWorkingFirst(e.target.checked)} />
                      working first
                  </label>
              </div>
          </div>
      </div>

      <div className="px-8 pb-8 flex-1 overflow-y-auto">
        {filteredWorkflows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed rounded-2xl" style={{ borderColor: 'var(--panel-border)', color: 'var(--text-secondary)' }}>
            <p className="text-sm font-medium">No saved workflows found.</p>
            <p className="text-xs mt-2">Check your search filter or go to the Orchestrator to save a new one.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredWorkflows.map(workflow => (
              <div key={`${workflow.type}:${workflow.type === 'edge' ? workflow.device_id : ''}:${workflow.name}`} className="glass-panel border rounded-xl p-5 transition-all flex flex-col justify-between" style={{ borderColor: 'var(--panel-border)' }}>
                  <div>
                      <h3 className="text-lg font-bold truncate" style={{ color: 'var(--text-primary)' }} title={workflow.name}>{workflow.name}</h3>
                      {workflow.type === 'edge' ? (
                          <span className="inline-flex items-center gap-1 max-w-full text-[10px] uppercase font-bold tracking-wider px-2 py-1 mt-2 rounded-full" style={{ background: 'rgba(34, 197, 94, 0.15)', color: '#4ade80' }}>
                              <Cpu className="w-3 h-3 shrink-0" /> <span className="truncate" title={workflow.device_id}>{workflow.device_id}</span>
                          </span>
                      ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-2 py-1 mt-2 rounded-full" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa' }}>
                              <Cloud className="w-3 h-3 shrink-0" /> Distributed
                          </span>
                      )}
                      {workflow.description ? (
                          <p className="text-sm mt-2 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{workflow.description}</p>
                      ) : (
                          <p className="text-xs mt-2 italic text-gray-400">No description provided.</p>
                      )}
                      {workflow.type === 'edge' && workflow.problemCount > 0 && (
                          <ProblemLine lead={`Won't run on ${workflow.device_id}`} count={workflow.problemCount} problems={workflow.problems} />
                      )}
                      {workflow.type === 'edge' && workflow.runtime?.runs ? (
                          <div className="mt-2 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                              <Clock className="w-3.5 h-3.5 shrink-0" />
                              <span className="truncate">{runtimeSummary(workflow.runtime)}</span>
                          </div>
                      ) : null}
                      {workflow.type === 'distributed' && workflow.problems.length > 0 && (
                          <ProblemLine lead="Needs fixing before it can run" count={workflow.problems.length} problems={workflow.problems} />
                      )}
                  </div>
                  <div className="mt-4 space-y-2">
                      <div className="flex items-center space-x-2 text-[10px] uppercase font-bold tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                          <Calendar className="w-3.5 h-3.5" />
                          <span>Created: {workflow.created_at ? new Date(workflow.created_at).toLocaleDateString() : 'N/A'}</span>
                      </div>
                      <div className="flex items-center space-x-2 text-[10px] uppercase font-bold tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                          <Clock className="w-3.5 h-3.5" />
                          <span>Modified: {workflow.updated_at ? new Date(workflow.updated_at).toLocaleString() : 'N/A'}</span>
                      </div>
                  </div>
                  <div className="mt-6 flex justify-end">
                      <button 
                          onClick={() => loadWorkflow(workflow)}
                          className="flex items-center space-x-2 px-4 py-2 rounded-lg transition-colors text-sm font-medium hover-bg"
                          style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa' }}
                      >
                          <Download className="w-4 h-4" />
                          <span>{workflow.type === 'edge' ? 'Open in Edge Sequence Editor' : 'Load to Orchestrator'}</span>
                      </button>
                  </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
