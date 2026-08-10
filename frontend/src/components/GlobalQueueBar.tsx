"use client";
import { API_BASE, WS_BASE } from '@/config';
import { useState, useEffect } from 'react';
import { Play, Pause, XCircle, Activity, ChevronUp, ChevronDown, RefreshCcw, FastForward, Copy } from 'lucide-react';

export default function GlobalQueueBar() {
  const [activeRun, setActiveRun] = useState<any>(null);
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const [queue, setQueue] = useState<any[]>([]);

  useEffect(() => {
    const fetchInitial = async () => {
        try {
            const [statusRes, queueRes] = await Promise.all([
                fetch(`${API_BASE}/api/status`),
                fetch(`${API_BASE}/api/queue/runs`)
            ]);
            const statusData = await statusRes.json();
            const queueData = await queueRes.json();
            
            setStatus(statusData);
            setQueue(queueData.runs.slice(0, 3));
            if (statusData.active_workflow_id) {
                const runDetails = await fetch(`${API_BASE}/api/queue/runs/${statusData.active_workflow_id}`);
                if (runDetails.ok) {
                    const detailsData = await runDetails.json();
                    setActiveRun(detailsData);
                }
            } else {
                setActiveRun(null);
            }
        } catch(e) {}
    };
    
    fetchInitial();

    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.status) setStatus(data.status);
            if (data.runs) {
                setQueue(data.runs.slice(0, 3));
            }
            if (data.active_run) {
                setActiveRun(data.active_run);
            } else if (data.recent_run) {
                setActiveRun(data.recent_run);
            } else if (data.status && !data.status.active_workflow_id) {
                setActiveRun(null);
            }
        } catch(e) {}
    };

    return () => {
        ws.close();
    };
  }, []);

  const handleRunControl = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!activeRun) return;
    
    // Optimistic UI update
    if (action === 'pause') setActiveRun({ ...activeRun, status: 'pausing' });
    else if (action === 'resume') setActiveRun({ ...activeRun, status: 'running' });
    else if (action === 'cancel') setActiveRun({ ...activeRun, status: 'cancelling' });

    try {
      await fetch(`${API_BASE}/api/queue/runs/${activeRun.id}/${action}`, { method: 'POST' });
    } catch (e) {
      alert(`Failed to ${action} run`);
    }
  };

  const resolveError = async (action: 'retry' | 'skip') => {
    if (!activeRun) return;
    try {
      await fetch(`${API_BASE}/api/queue/runs/${activeRun.id}/resolve`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ action })
      });
    } catch (e) {
      alert(`Failed to ${action} error`);
    }
  };

  if (!activeRun) return null; // Only show if there's an active run

  // Calculate Progress
  let totalSteps = activeRun.steps?.length || 0;
  let startedSteps = activeRun.status === 'completed' ? totalSteps : (activeRun.steps?.filter((s: any) => s.status !== 'pending').length || 0);

  if (activeRun.parameters?.type === 'Optimization') {
      const budget = activeRun.parameters?.budget || 1;
      const seqTemplateLen = activeRun.parameters?.sequence_template?.length || 1;
      const prepLen = activeRun.parameters?.prep_template?.length || 0;
      const cleanLen = activeRun.parameters?.cleanup_template?.length || 0;
      totalSteps = prepLen + cleanLen + (budget * seqTemplateLen);
  }

  const progressPercent = activeRun.status === 'completed' ? 100 : (totalSteps > 0 ? (startedSteps / totalSteps) * 100 : 0);
  
  const currentStep = activeRun.steps?.find((s: any) => s.status === 'running' || s.status === 'pending');

  return (
    <div className={`fixed bottom-4 right-4 z-[9999] transition-all duration-300 ease-in-out ${expanded ? 'w-[400px]' : 'w-[320px]'}`}>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-white/10 shadow-2xl overflow-hidden flex flex-col">
        {/* Progress Bar (Top edge) */}
        <div className="h-1.5 w-full bg-gray-100 dark:bg-white/5">
            <div 
                className="h-full bg-blue-500 transition-all duration-500 ease-in-out" 
                style={{ width: `${progressPercent}%` }}
            />
        </div>

        {/* Header */}
        <div 
           className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-white/[0.02] transition-colors"
           onClick={() => setExpanded(!expanded)}
        >
            <div className="flex items-center space-x-3 truncate">
                <div className={`p-1.5 rounded-full ${['paused', 'pausing'].includes(activeRun.status) ? 'bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400' : activeRun.status === 'error' ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' : activeRun.status === 'cancelling' ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 animate-pulse' : activeRun.status === 'completed' ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400' : 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 animate-pulse'}`}>
                   <Activity className="w-4 h-4" />
                </div>
                <div className="flex flex-col truncate">
                    <span className="text-sm font-bold text-gray-900 dark:text-white truncate">{activeRun.name}</span>
                    <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">
                       {activeRun.status === 'cancelling' ? 'Cancelling...' : activeRun.status === 'pausing' ? 'Pausing...' : activeRun.status} • {startedSteps}/{totalSteps} Tasks
                    </span>
                </div>
            </div>
            {expanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronUp className="w-4 h-4 text-gray-400" />}
        </div>

        {/* Expanded View */}
        {expanded && (
            <div className="px-4 pb-4 pt-1 border-t border-gray-100 dark:border-white/5">
                {activeRun.status === 'error' ? (
                    <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-500/30 text-xs font-mono text-red-700 dark:text-red-400 overflow-y-auto max-h-32 whitespace-pre-wrap relative group">
                        {activeRun.steps?.find((s:any) => s.status === 'error')?.error || 'Unknown error occurred.'}
                        <button
                            onClick={() => {
                                const errorText = activeRun.steps?.find((s:any) => s.status === 'error')?.error || 'Unknown error occurred.';
                                navigator.clipboard.writeText(errorText);
                            }}
                            className="absolute top-2 right-2 p-1.5 bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-200 dark:hover:bg-red-900/60"
                            title="Copy Error"
                        >
                            <Copy className="w-3.5 h-3.5" />
                        </button>
                    </div>
                ) : currentStep ? (
                    <div className="mb-4 p-3 bg-gray-50 dark:bg-black/20 rounded-lg border border-gray-200 dark:border-white/10">
                        <div className="text-[10px] uppercase font-bold text-gray-500 mb-1">Current Task {currentStep.parameters?._phase ? `(${currentStep.parameters._phase} phase)` : ''}</div>
                        <div className="text-sm font-mono text-gray-800 dark:text-gray-200 truncate">
                            {currentStep.instrument}.{currentStep.method}
                        </div>
                    </div>
                ) : (
                    <div className="mb-4 p-3 bg-gray-50 dark:bg-black/20 rounded-lg border border-gray-200 dark:border-white/10 text-center text-sm text-gray-500">
                        {activeRun.status === 'completed' ? 'Run finished successfully.' : 'Preparing next task...'}
                    </div>
                )}
                
                <div className="flex items-center justify-end space-x-2">
                    {activeRun.status === 'cancelling' ? (
                        <div className="text-xs font-bold text-red-500 animate-pulse px-3 py-1.5">Waiting for current task to abort...</div>
                    ) : activeRun.status === 'pausing' ? (
                        <div className="text-xs font-bold text-yellow-600 dark:text-yellow-400 animate-pulse px-3 py-1.5">Pausing after current task...</div>
                    ) : (
                      <>
                        {activeRun.status === 'paused' ? (
                            <button onClick={() => handleRunControl('resume')} className="flex-1 flex items-center justify-center space-x-1.5 px-3 py-1.5 bg-green-50 text-green-700 hover:bg-green-100 border border-green-200 rounded transition-colors text-xs font-bold dark:bg-green-900/30 dark:text-green-300 dark:border-green-500/30">
                                <Play className="w-3.5 h-3.5" /> <span>Resume</span>
                            </button>
                        ) : activeRun.status === 'error' ? (
                            <>
                            <button onClick={() => resolveError('retry')} className="flex-1 flex items-center justify-center space-x-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 rounded transition-colors text-xs font-bold dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-500/30">
                                <RefreshCcw className="w-3.5 h-3.5" /> <span>Retry</span>
                            </button>
                            <button onClick={() => resolveError('skip')} className="flex-1 flex items-center justify-center space-x-1.5 px-3 py-1.5 bg-yellow-50 text-yellow-700 hover:bg-yellow-100 border border-yellow-200 rounded transition-colors text-xs font-bold dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-500/30">
                                <FastForward className="w-3.5 h-3.5" /> <span>Skip</span>
                            </button>
                            </>
                        ) : activeRun.status === 'completed' || activeRun.status === 'cancelled' ? (
                             null
                        ) : (
                            <button onClick={() => handleRunControl('pause')} className="flex-1 flex items-center justify-center space-x-1.5 px-3 py-1.5 bg-yellow-50 text-yellow-700 hover:bg-yellow-100 border border-yellow-200 rounded transition-colors text-xs font-bold dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-500/30">
                                <Pause className="w-3.5 h-3.5" /> <span>Pause</span>
                            </button>
                        )}
                        {activeRun.status === 'completed' || activeRun.status === 'cancelled' ? (
                            <button onClick={() => setActiveRun(null)} className="flex-1 flex items-center justify-center space-x-1.5 px-3 py-1.5 bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200 rounded transition-colors text-xs font-bold dark:bg-gray-900/30 dark:text-gray-300 dark:border-gray-500/30">
                                <XCircle className="w-3.5 h-3.5" /> <span>Dismiss</span>
                            </button>
                        ) : (
                            <button onClick={() => handleRunControl('cancel')} className="flex-1 flex items-center justify-center space-x-1.5 px-3 py-1.5 bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 rounded transition-colors text-xs font-bold dark:bg-red-900/30 dark:text-red-300 dark:border-red-500/30">
                                <XCircle className="w-3.5 h-3.5" /> <span>Cancel</span>
                            </button>
                        )}
                      </>
                    )}
                </div>
            </div>
        )}
      </div>
    </div>
  );
}
