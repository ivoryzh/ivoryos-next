"use client";
import { API_BASE } from '@/config';
import { useState, useEffect } from 'react';
import { Settings2, Info, Zap } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

export default function OptimizePage() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [variables, setVariables] = useState<string[]>([]);
  const [returns, setReturns] = useState<string[]>([]);
  const [sequence, setSequence] = useState<any[]>([]);
  const [prepSequence, setPrepSequence] = useState<any[]>([]);
  const [cleanupSequence, setCleanupSequence] = useState<any[]>([]);
  const [edgeStatus, setEdgeStatus] = useState<any>(null);

  const [optConfig, setOptConfig] = useState<any>({
    optimizer: 'baybe',
    budget: 10,
    error_recovery: 'stop',
    bounds: {},
    objectives: {}
  });

  useEffect(() => {
    // Theme init
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');

    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => setEdgeStatus(data))
      .catch(err => console.error(err));

    // Load sequence and extract variables
    const savedSequence = localStorage.getItem('ivoryos_sequence');
    const savedPrep = localStorage.getItem('ivoryos_prep_sequence');
    const savedCleanup = localStorage.getItem('ivoryos_cleanup_sequence');
    if (savedSequence) {
      try {
        const parsedSeq = JSON.parse(savedSequence);
        setSequence(parsedSeq);
        if (savedPrep) setPrepSequence(JSON.parse(savedPrep));
        if (savedCleanup) setCleanupSequence(JSON.parse(savedCleanup));

        const vars = new Set<string>();
        parsedSeq.forEach((block: any) => {
          Object.entries(block.params).forEach(([key, val]: [string, any]) => {
            if (typeof val === 'string' && val.startsWith('#')) {
              vars.add(val.substring(1));
            }
          });
        });
        setVariables(Array.from(vars));

        const retVars = Array.from(new Set(parsedSeq.map((s: any) => s.returnVar).filter(Boolean))) as string[];
        setReturns(retVars);
      } catch (e) {
        console.error("Failed to load sequence", e);
      }
    }
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const startOptimization = async () => {
    const paramSpace = variables.map((v: any) => {
        const b = optConfig.bounds[v] || {};
        if (b.type === 'choice') {
            return { name: v, type: 'choice', bounds: (b.min || "").split(",").map((s: string) => {
                const n = parseFloat(s.trim());
                return isNaN(n) ? s.trim() : n;
            }) };
        }
        return { name: v, type: 'range', bounds: [parseFloat(b.min || "0"), parseFloat(b.max || "1")] };
    });
    
    const objConfig = returns.map((v: any) => ({
        name: v, minimize: optConfig.objectives[v]?.goal === 'minimize'
    }));
    
    const payload = {
        name: `${localStorage.getItem('ivoryos_sequence_name') || 'Optimization'} Run - ${new Date().toLocaleString()}`,
        parameters: { 
            type: "Optimization",
            optimizer: optConfig.optimizer,
            budget: optConfig.budget,
            error_recovery: optConfig.error_recovery,
            parameter_space: paramSpace,
            objective_config: objConfig,
            sequence_template: sequence.map(s => ({
                instrument: s.instrument,
                method: s.method,
                params: s.params,
                returnVar: s.returnVar
            }))
        },
        prep: prepSequence.map(s => ({
            instrument: s.instrument,
            method: s.method,
            params: s.params,
            returnVar: s.returnVar
        })),
        cleanup: cleanupSequence.map(s => ({
            instrument: s.instrument,
            method: s.method,
            params: s.params,
            returnVar: s.returnVar
        })),
        sequence: []
    };
    
    try {
        const res = await fetch(`${API_BASE}/api/queue/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
            window.location.href = '/queue';
        } else {
            alert("Failed: " + data.error);
        }
    } catch(e: any) {
        alert("Error: " + e.message);
    }
  };

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      <Sidebar theme={theme} toggleTheme={toggleTheme} />
      
      <div className="flex-1 flex flex-col relative z-0">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <div className="flex items-center space-x-2">
            <Settings2 className="w-5 h-5 text-gray-400" />
            <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300 uppercase">Optimization Setup</h2>
          </div>
        </header>

        <div className="p-8 flex-1 overflow-y-auto">
          {variables.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-500 dark:text-gray-400 border-2 border-dashed border-gray-300 dark:border-white/10 rounded-2xl relative">
              <div className="flex items-center space-x-2">
                <p className="text-sm font-medium text-gray-600 dark:text-gray-300">Current workflow doesn't need optimization.</p>
                <div className="group relative flex items-center">
                  <Info className="w-4 h-4 text-blue-500 hover:text-blue-600 cursor-help transition-colors" />
                  <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-64 p-3 bg-gray-900 text-white dark:bg-white dark:text-gray-900 text-xs rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 pointer-events-none">
                    You need to define at least one variable parameter (e.g. #param) in the Designer to use optimization.
                    <div className="absolute left-1/2 -bottom-1 -translate-x-1/2 w-2 h-2 bg-gray-900 dark:bg-white transform rotate-45"></div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto space-y-6 pb-24">
              <div className="bg-white dark:bg-[#111111] border border-gray-200 dark:border-white/10 rounded-2xl shadow-sm p-6">
                <h3 className="text-sm font-bold text-gray-800 dark:text-white mb-6 flex items-center">
                  <Zap className="w-5 h-5 mr-2 text-purple-500" />
                  General Settings
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 block">Optimizer Engine</label>
                    <select 
                       value={optConfig.optimizer} 
                       onChange={e => setOptConfig({...optConfig, optimizer: e.target.value})}
                       className="w-full bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm focus:border-purple-500 outline-none"
                    >
                      <option value="baybe">BayBE</option>
                      <option value="ax">Ax (BoTorch)</option>
                      <option value="nimo">NIMO</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 block">Evaluation Budget</label>
                    <input 
                       type="number" 
                       min="1" max="1000"
                       value={optConfig.budget}
                       onChange={e => setOptConfig({...optConfig, budget: parseInt(e.target.value) || 1})}
                       className="w-full bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm focus:border-purple-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 block">Error Recovery</label>
                    <select 
                       value={optConfig.error_recovery} 
                       onChange={e => setOptConfig({...optConfig, error_recovery: e.target.value})}
                       className="w-full bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm focus:border-purple-500 outline-none"
                    >
                      <option value="stop">Stop immediately</option>
                      <option value="skip">Skip (Continue)</option>
                      <option value="retry">Retry step</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="bg-white dark:bg-[#111111] border border-gray-200 dark:border-white/10 rounded-2xl shadow-sm p-6">
                <h3 className="text-sm font-bold text-gray-800 dark:text-white mb-6">Search Space</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {variables.map(v => (
                    <div key={v} className="bg-gray-50/50 dark:bg-white/[0.02] p-4 rounded-xl border border-gray-100 dark:border-white/5 space-y-4">
                      <div className="flex items-center justify-between">
                          <span className="font-mono text-base font-bold text-blue-500">#{v}</span>
                          <select 
                             value={optConfig.bounds[v]?.type || 'range'}
                             onChange={e => setOptConfig({...optConfig, bounds: {...optConfig.bounds, [v]: {...optConfig.bounds[v], type: e.target.value}}})}
                             className="bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1 text-sm outline-none"
                          >
                             <option value="range">Range</option>
                             <option value="choice">Choice</option>
                          </select>
                      </div>
                      <div className="flex space-x-3">
                          <input 
                             type="text" 
                             placeholder={optConfig.bounds[v]?.type === 'choice' ? "e.g. 10, 20" : "Min"}
                             value={optConfig.bounds[v]?.min || ''}
                             onChange={e => setOptConfig({...optConfig, bounds: {...optConfig.bounds, [v]: {...optConfig.bounds[v], min: e.target.value}}})}
                             className="flex-1 bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
                          />
                          {optConfig.bounds[v]?.type !== 'choice' && (
                            <input 
                               type="text" 
                               placeholder="Max"
                               value={optConfig.bounds[v]?.max || ''}
                               onChange={e => setOptConfig({...optConfig, bounds: {...optConfig.bounds, [v]: {...optConfig.bounds[v], max: e.target.value}}})}
                               className="flex-1 bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
                            />
                          )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white dark:bg-[#111111] border border-gray-200 dark:border-white/10 rounded-2xl shadow-sm p-6">
                <h3 className="text-sm font-bold text-gray-800 dark:text-white mb-6">Objectives</h3>
                {returns.length === 0 ? (
                    <div className="text-sm text-gray-500">No return variables assigned in sequence.</div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {returns.map((v: string) => (
                        <div key={v} className="flex items-center justify-between bg-gray-50/50 dark:bg-white/[0.02] p-4 rounded-xl border border-gray-100 dark:border-white/5">
                          <span className="font-mono text-base font-bold text-green-500 truncate pr-4">{v}</span>
                          <select 
                             value={optConfig.objectives[v]?.goal || 'maximize'}
                             onChange={e => setOptConfig({...optConfig, objectives: {...optConfig.objectives, [v]: {...optConfig.objectives[v], goal: e.target.value}}})}
                             className="bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-green-500 w-32"
                          >
                             <option value="maximize">Maximize</option>
                             <option value="minimize">Minimize</option>
                          </select>
                        </div>
                      ))}
                    </div>
                )}
              </div>
              
              <div className="flex justify-end pt-4">
                <button 
                  onClick={startOptimization}
                  className="flex items-center space-x-2 px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-xl transition-colors font-bold shadow-lg shadow-purple-500/20"
                >
                  <Zap className="w-5 h-5" />
                  <span>Start Optimization</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
