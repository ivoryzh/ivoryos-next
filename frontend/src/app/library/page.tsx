"use client";
import { API_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Book, Download, Sun, Moon, Search, Calendar, Clock, Filter, ArrowUpDown } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

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

  const loadWorkflow = async (name: string) => {
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
          returnVar: action.return || ""
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
      window.location.href = '/designer';
    } catch (e: any) {
      alert("Failed to load workflow: " + e.message);
    }
  };

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {/* Sidebar */}
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      {/* Main Area */}
      <div className="flex-1 flex flex-col relative z-0">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300  flex items-center space-x-2">
            <Book className="w-5 h-5" />
            <span>Workflow Library</span>
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
                        className="w-full pl-10 pr-4 py-2 bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                        className="bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-lg text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                    <div className="mt-6 flex justify-end">
                        <button 
                            onClick={() => loadWorkflow(workflow.name)}
                            className="flex items-center space-x-2 px-4 py-2 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/30 dark:hover:bg-blue-800/40 text-blue-600 dark:text-blue-300 rounded-lg transition-colors text-sm font-medium"
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
