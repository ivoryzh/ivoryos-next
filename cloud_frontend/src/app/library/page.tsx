"use client";

import { useState, useEffect } from 'react';
import { Book, Download, Search, Calendar, Clock, Filter, ArrowUpDown } from 'lucide-react';

type WorkflowItem = {
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
  nodes: any[];
  edges: any[];
};

export default function CloudLibraryPage() {
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'created_at' | 'updated_at'>('updated_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    fetchWorkflows();
  }, []);

  const fetchWorkflows = () => {
    const saved = localStorage.getItem('cloud_saved_workflows');
    if (saved) {
      try {
        setWorkflows(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse saved workflows", e);
      }
    }
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

  const loadWorkflow = (workflow: WorkflowItem) => {
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
              <div key={workflow.name} className="glass-panel border rounded-xl p-5 transition-all flex flex-col justify-between" style={{ borderColor: 'var(--panel-border)' }}>
                  <div>
                      <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{workflow.name}</h3>
                      {workflow.description ? (
                          <p className="text-sm mt-2 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{workflow.description}</p>
                      ) : (
                          <p className="text-xs mt-2 italic text-gray-400">No description provided.</p>
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
                          <span>Load to Orchestrator</span>
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
