"use client";
import { API_BASE, WS_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { ListTodo, Play, Pause, XCircle, Settings2, Edit3, Check, X, Sun, Moon, Copy } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

export default function QueuePage() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [activeWorkflowId, setActiveWorkflowId] = useState<number | null>(null);
  const [workflow, setWorkflow] = useState<any>(null);
  const [editingStep, setEditingStep] = useState<number | null>(null);
  const [editParams, setEditParams] = useState<string>("");
  const [activeRun, setActiveRun] = useState<any>(null);
  const [pendingRuns, setPendingRuns] = useState<any[]>([]);

  useEffect(() => {
    // Theme init
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, []);

  const fetchQueue = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/queue/runs`);
        const data = await res.json();
        // Filter runs
        let active = data.runs?.find((r: any) => ['running', 'paused', 'cancelling', 'error'].includes(r.status));
        if (!active) {
            active = data.runs?.slice().reverse().find((r: any) => r.status === 'pending');
        }
        
        if (active) {
            const runDetails = await fetch(`${API_BASE}/api/queue/runs/${active.id}`);
            const detailsData = await runDetails.json();
            setActiveRun(detailsData);
            setWorkflow(detailsData);
        } else {
            setActiveRun(null);
            setWorkflow(null);
        }
        
        // Populate Up Next list
        const upNext = data.runs?.filter((r: any) => r.status === 'pending' && r.id !== active?.id).reverse() || [];
        setPendingRuns(upNext);
      } catch (e) {
        console.error("Failed to fetch queue status:", e);
      }
  };

  useEffect(() => {
    fetchQueue();
    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.runs) {
                let active = data.runs?.find((r: any) => ['running', 'paused', 'cancelling', 'error'].includes(r.status));
                if (!active) {
                    active = data.runs?.slice().reverse().find((r: any) => r.status === 'pending');
                }
                
                if (active) {
                    if (data.active_run && data.active_run.id === active.id) {
                        setActiveRun(data.active_run);
                        setWorkflow(data.active_run);
                    } else if (data.recent_run && data.recent_run.id === active.id) {
                        setActiveRun(data.recent_run);
                        setWorkflow(data.recent_run);
                    } else {
                        // Use the run data directly since it already contains steps from the DB
                        setActiveRun(active);
                        setWorkflow(active);
                    }
                } else {
                    setActiveRun(null);
                    setWorkflow(null);
                }
                
                // Populate Up Next list
                const upNext = data.runs?.filter((r: any) => r.status === 'pending' && r.id !== active?.id).reverse() || [];
                setPendingRuns(upNext);
            }
        } catch(e) {}
    };
    
    return () => {
        ws.close();
    };
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const handleRunControl = async (action: 'pause' | 'resume' | 'cancel', runId?: number) => {
    const targetId = runId || activeRun?.id;
    if (!targetId) return;

    // Optimistic UI update
    if (activeRun && targetId === activeRun.id) {
        if (action === 'pause') setActiveRun({ ...activeRun, status: 'pausing' });
        else if (action === 'resume') setActiveRun({ ...activeRun, status: 'running' });
        else if (action === 'cancel') setActiveRun({ ...activeRun, status: 'cancelling' });
    }
    if (workflow && targetId === workflow.id) {
        if (action === 'pause') setWorkflow({ ...workflow, status: 'pausing' });
        else if (action === 'resume') setWorkflow({ ...workflow, status: 'running' });
        else if (action === 'cancel') setWorkflow({ ...workflow, status: 'cancelling' });
    }

    try {
      await fetch(`${API_BASE}/api/queue/runs/${targetId}/${action}`, { method: 'POST' });
      fetchQueue();
    } catch (e) {
      alert(`Failed to ${action} run`);
    }
  };

  const startEdit = (step: any) => {
      setEditingStep(step.id);
      setEditParams(JSON.stringify(step.parameters, null, 2));
  };

  const saveEdit = async (stepId: number) => {
      try {
          const parsed = JSON.parse(editParams);
          const res = await fetch(`${API_BASE}/api/steps/${stepId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ parameters: parsed })
          });
          const data = await res.json();
          if (data.error) {
              alert("Error saving: " + data.error);
          } else {
              setEditingStep(null);
          }
      } catch (e: any) {
          alert("Invalid JSON parameters: " + e.message);
      }
  };

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      <div className="flex-1 flex flex-col relative z-0">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300  flex items-center space-x-2">
            <ListTodo className="w-5 h-5" />
            <span>Execution Queue</span>
          </h2>
          
          {activeRun && (
            <div className="flex items-center space-x-3">
              {activeRun.status === 'pausing' ? (
                <div className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-yellow-50 text-yellow-600 border border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-500/30 animate-pulse">
                    <Pause className="w-4 h-4" /><span>Pausing...</span>
                </div>
              ) : activeRun.status === 'paused' ? (
                <button onClick={() => handleRunControl('resume')} className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-green-50 text-green-700 hover:bg-green-100 border border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-500/30">
                    <Play className="w-4 h-4" /><span>Resume</span>
                </button>
              ) : (
                <button onClick={() => handleRunControl('pause')} className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-yellow-50 text-yellow-700 hover:bg-yellow-100 border border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-500/30">
                    <Pause className="w-4 h-4" /><span>Pause</span>
                </button>
              )}
              {activeRun.status === 'cancelling' ? (
                <div className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-red-50 text-red-500 border border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-500/30 animate-pulse">
                    <XCircle className="w-4 h-4" /><span>Cancelling...</span>
                </div>
              ) : (
                <button onClick={() => handleRunControl('cancel')} className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-500/30">
                    <XCircle className="w-4 h-4" /><span>Cancel Run</span>
                </button>
              )}
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-8">
            {!activeRun || !workflow ? (
                <div className="flex flex-col items-center justify-center h-[50vh] text-gray-500 dark:text-gray-400">
                    <ListTodo className="w-16 h-16 mb-4 opacity-20" />
                    <h3 className="text-lg font-medium">Queue is Empty</h3>
                    <p className="text-sm mt-2">Start a workflow from the Designer or Spreadsheet.</p>
                </div>
            ) : (
                <div className="max-w-4xl mx-auto space-y-10">
                    {/* Currently Executing Section */}
                    <div>
                        <h2 className="text-xs  tracking-wider font-bold text-gray-500 mb-4 ml-1 flex items-center space-x-2">
                           <Play className="w-4 h-4 text-indigo-500" /> <span>Currently Executing</span>
                        </h2>
                    <div className="bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-2xl p-6 shadow-sm">
                        <div className="flex items-center justify-between mb-4">
                            <div>
                                <h3 className="text-xl font-bold">{workflow.name}</h3>
                                <div className="text-sm text-gray-500 dark:text-gray-400 mt-1 flex items-center space-x-3">
                                    <span>Run ID: {workflow.id}</span>
                                    <span>•</span>
                                    <span>Started: {new Date(workflow.start_time).toLocaleTimeString()}</span>
                                </div>
                            </div>
                            <div className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                                workflow.status === 'running' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' :
                                ['paused', 'pausing'].includes(workflow.status) ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                                workflow.status === 'cancelling' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 animate-pulse' :
                                workflow.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                                'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                            }`}>
                                {workflow.status === 'cancelling' ? 'CANCELLING...' : workflow.status === 'pausing' ? 'PAUSING...' : workflow.status}
                            </div>
                        </div>

                        <div className="space-y-3">
                            {(() => {
                                let currentPhase: string | null = null;
                                let currentWorkflowGroup: string | null = null;
                                const isOptimization = workflow.parameters?.type === 'Optimization';
                                let hasRenderedOptimizerBanner = false;
                                
                                return workflow.steps?.map((step: any, idx: number) => {
                                    const phase = step.parameters?._phase || 'main';
                                    const parentWorkflow = step.parameters?._parent_workflow || null;
                                    
                                    const elements = [];
                                    
                                    // 1. Check if phase changed
                                    if (phase !== currentPhase) {
                                        currentPhase = phase;
                                        currentWorkflowGroup = null; // Reset group on phase change
                                        elements.push(
                                            <div key={`phase-${phase}-${idx}`} className="flex items-center space-x-2 pt-4 pb-1">
                                                <div className="h-px bg-gray-300 dark:bg-white/20 flex-1"></div>
                                                <span className="text-xs font-bold text-gray-500 uppercase tracking-widest">{phase} PHASE</span>
                                                <div className="h-px bg-gray-300 dark:bg-white/20 flex-1"></div>
                                            </div>
                                        );
                                    }
                                    
                                    // 2. Check Optimization (Repetitive Task)
                                    if (isOptimization && phase === 'main') {
                                        if (!hasRenderedOptimizerBanner) {
                                            hasRenderedOptimizerBanner = true;
                                            // Find the last completed/running step in the main phase to guess the iteration
                                            const mainSteps = workflow.steps.filter((s: any) => s.parameters?._phase === 'main');
                                            const completedMain = mainSteps.filter((s: any) => s.status === 'completed' || s.status === 'running');
                                            const stepsPerIteration = workflow.parameters?.sequence_template?.length || 1;
                                            const currentIter = Math.min(workflow.parameters?.budget || 1, Math.floor(completedMain.length / stepsPerIteration) + 1);
                                            
                                            elements.push(
                                                <div key={`opt-banner-${idx}`} className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-xl border border-purple-200 dark:border-purple-500/30 flex items-center justify-between">
                                                    <div>
                                                        <h4 className="font-bold text-purple-700 dark:text-purple-400">Optimization Loop (Repetitive Task)</h4>
                                                        <p className="text-xs text-purple-600 dark:text-purple-500 mt-1">Executing parameter search over {workflow.parameters?.budget} iterations.</p>
                                                    </div>
                                                    <div className="text-sm font-bold text-purple-700 dark:text-purple-400 bg-purple-100 dark:bg-purple-900/50 px-3 py-1 rounded-full">
                                                        Iteration {currentIter} / {workflow.parameters?.budget}
                                                    </div>
                                                </div>
                                            );
                                        }
                                        // Do not render the individual steps for optimization main phase
                                        return elements;
                                    }
                                    
                                    // 3. Check Library Workflow Grouping
                                    if (parentWorkflow !== currentWorkflowGroup) {
                                        currentWorkflowGroup = parentWorkflow;
                                        if (parentWorkflow) {
                                            elements.push(
                                                <div key={`wf-group-${parentWorkflow}-${idx}`} className="pt-2 pb-1 flex items-center space-x-2">
                                                    <ListTodo className="w-4 h-4 text-gray-400" />
                                                    <span className="text-xs font-bold text-gray-600 dark:text-gray-300">Workflow: {parentWorkflow}</span>
                                                </div>
                                            );
                                        }
                                    }
                                    
                                    // Filter out internal parameters for display
                                    const displayParams = { ...step.parameters };
                                    delete displayParams._phase;
                                    delete displayParams._parent_workflow;

                                    elements.push(
                                        <div key={step.id} className={`p-4 rounded-xl border ${
                                            step.status === 'running' ? 'bg-indigo-50 border-indigo-200 dark:bg-indigo-900/10 dark:border-indigo-500/30' :
                                            step.status === 'completed' ? 'bg-gray-50 border-gray-200 dark:bg-white/[0.02] dark:border-white/5 opacity-70' :
                                            step.status === 'error' ? 'bg-red-50 border-red-200 dark:bg-red-900/10 dark:border-red-500/30' :
                                            'bg-white border-gray-200 dark:bg-white/5 dark:border-white/10'
                                        } ${parentWorkflow ? 'ml-6 border-l-4 border-l-gray-300 dark:border-l-gray-700' : ''}`}>
                                            <div className="flex items-start justify-between">
                                                <div className="flex items-center space-x-4">
                                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                                                        step.status === 'running' ? 'bg-indigo-500 text-white' :
                                                        step.status === 'completed' ? 'bg-green-500 text-white' :
                                                        step.status === 'error' ? 'bg-red-500 text-white' :
                                                        'bg-gray-200 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                                                    }`}>
                                                        {idx + 1}
                                                    </div>
                                                    <div>
                                                        <h4 className="font-semibold text-gray-800 dark:text-gray-200">
                                                            {(step.instrument === 'Flow_Control' || step.instrument === 'Flow Control') ? (
                                                                <span className="text-indigo-600 dark:text-indigo-400">{step.method}</span>
                                                            ) : (
                                                                <>{step.instrument} <span className="text-gray-400 dark:text-gray-500 font-normal">.</span> <span className="text-indigo-600 dark:text-indigo-400">{step.method}</span></>
                                                            )}
                                                        </h4>
                                                        
                                                        {editingStep === step.id ? (
                                                            <div className="mt-2 space-y-2">
                                                                <textarea 
                                                                    className="w-full text-xs font-mono p-2 bg-gray-100 dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded resize-y outline-none focus:border-indigo-500"
                                                                    rows={3}
                                                                    value={editParams}
                                                                    onChange={(e) => setEditParams(e.target.value)}
                                                                />
                                                                <div className="flex space-x-2">
                                                                    <button onClick={() => saveEdit(step.id)} className="flex items-center space-x-1 px-3 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700 transition-colors"><Check className="w-3 h-3" /><span>Save</span></button>
                                                                    <button onClick={() => setEditingStep(null)} className="flex items-center space-x-1 px-3 py-1 bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded text-xs hover:bg-gray-300 dark:hover:bg-gray-700 transition-colors"><X className="w-3 h-3" /><span>Cancel</span></button>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div className="mt-1 flex flex-wrap gap-2">
                                                                {Object.entries(displayParams || {}).map(([k, v]) => (
                                                                    <span key={k} className="text-[10px] font-mono px-2 py-0.5 rounded bg-gray-100 dark:bg-black/40 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-white/5">
                                                                        <span className="text-gray-400">{k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}:</span> {JSON.stringify(v)}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>

                                                {step.status === 'pending' && editingStep !== step.id && (
                                                    <button 
                                                        onClick={() => startEdit(step)}
                                                        className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded transition-colors"
                                                    >
                                                        <Edit3 className="w-4 h-4" />
                                                    </button>
                                                )}
                                            </div>
                                            {step.error && (
                                                <div className="mt-3 p-3 text-xs font-mono bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 rounded-lg border border-red-100 dark:border-red-500/20 relative group">
                                                    {step.error}
                                                    <button
                                                        onClick={() => navigator.clipboard.writeText(step.error)}
                                                        className="absolute top-2 right-2 p-1.5 bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-200 dark:hover:bg-red-900/60"
                                                        title="Copy Error"
                                                    >
                                                        <Copy className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                    
                                    return elements;
                                });
                            })()}
                        </div>
                    </div>
                    </div>
                    
                    {/* Up Next Section */}
                    {pendingRuns.length > 0 && (
                        <div>
                            <h2 className="text-xs  tracking-wider font-bold text-gray-500 mb-4 ml-1 flex items-center space-x-2">
                               <ListTodo className="w-4 h-4 text-gray-400" /> <span>Up Next</span>
                            </h2>
                            <div className="space-y-3">
                                {pendingRuns.map((run: any) => (
                                    <div key={run.id} className="bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl p-4 flex items-center justify-between shadow-sm">
                                        <div>
                                            <h4 className="font-bold text-gray-900 dark:text-white">{run.name}</h4>
                                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 flex items-center space-x-3">
                                                <span>Run ID: {run.id}</span>
                                                <span>•</span>
                                                <span>Queued: {new Date(run.start_time || run.id).toLocaleTimeString()}</span>
                                                <span>•</span>
                                                <span>{run.steps?.length || 0} Steps</span>
                                            </div>
                                        </div>
                                        <button 
                                            onClick={() => handleRunControl('cancel', run.id)}
                                            className="px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40 rounded text-xs font-bold uppercase tracking-wider transition-colors border border-red-200 dark:border-red-500/20 flex items-center space-x-1"
                                        >
                                            <XCircle className="w-3.5 h-3.5" /> <span>Cancel</span>
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
      </div>
    </div>
  );
}
