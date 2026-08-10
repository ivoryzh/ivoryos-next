"use client";
import { API_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Book, Download, Sun, Moon } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

export default function LibraryPage() {
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [edgeStatus, setEdgeStatus] = useState<any>(null);

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
        setWorkflows(data.workflows);
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

        <div className="p-8 flex-1 overflow-y-auto">
          {workflows.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-500 dark:text-gray-400 border-2 border-dashed border-gray-300 dark:border-white/10 rounded-2xl">
              <p className="text-sm font-medium">No saved workflows found.</p>
              <p className="text-xs mt-2">Go to the Designer and click Save to store a workflow.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {workflows.map(name => (
                <div key={name} className="bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl p-5 hover:shadow-lg transition-all flex flex-col justify-between">
                    <div>
                        <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100">{name}</h3>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Legacy JSON Format</p>
                    </div>
                    <div className="mt-6 flex justify-end">
                        <button 
                            onClick={() => loadWorkflow(name)}
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
