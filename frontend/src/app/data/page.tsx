"use client";
import { API_BASE, WS_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Database, Download, Sun, Moon, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

// Every step's outputs get wrapped as {"result": <value>} regardless of what the method actually
// returned. When that value is a plain scalar — the overwhelmingly common case, since that's the
// only thing an optimizer can ever act on — show it bare instead of as a one-key JSON object.
// A dataclass/dict/list result (multiple fields, or a non-scalar 'result') still gets the full dump.
const formatStepOutput = (outputs: any): string => {
  if (outputs === null || outputs === undefined) return '';
  if (typeof outputs === 'object' && !Array.isArray(outputs)) {
    const keys = Object.keys(outputs);
    if (keys.length === 1 && keys[0] === 'result') {
      const val = outputs.result;
      if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') {
        return String(val);
      }
    }
  }
  return JSON.stringify(outputs, null, 2);
};

// The optimizer backends return each plot as a Plotly HTML fragment generated with
// include_plotlyjs=False, so it needs its own Plotly.js and its own document to run in —
// an iframe srcDoc executes <script> tags normally, unlike dangerouslySetInnerHTML in the main page.
const PlotFrame = ({ html }: { html: string }) => {
  const doc = `<!doctype html><html><head><meta charset="utf-8"/><script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script><style>body{margin:0;font-family:sans-serif;}</style></head><body>${html}</body></html>`;
  return (
    <iframe
      srcDoc={doc}
      sandbox="allow-scripts"
      className="w-full h-[420px] border border-gray-100 dark:border-white/5 rounded-lg bg-white"
    />
  );
};

export default function DataPage() {
  const [history, setHistory] = useState<any[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [edgeStatus, setEdgeStatus] = useState<any>(null);
  const [selectedRun, setSelectedRun] = useState<any>(null);
  const [plots, setPlots] = useState<Record<string, string> | null>(null);
  const [plotsError, setPlotsError] = useState<string | null>(null);
  const [plotsLoading, setPlotsLoading] = useState(false);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const formatRuns = (runs: any[]) => runs.map((r: any) => {
      let vars = r.parameters?.variables || [];
      let type = r.parameters?.type || (vars.length > 0 ? 'Spreadsheet' : 'Sequence');
      
      let rows = [];
      if (type === 'Sequence') {
          rows = [{
              row: 1,
              status: r.status,
              data: r.steps?.map((s: any) => s.status === 'completed' ? JSON.stringify(s.outputs?.result || '').replace(/,/g, ';') : (s.error || s.status)).join(',')
          }];
          vars = r.steps?.map((s: any) => `${s.instrument}.${s.method}`) || [];
      } else if (type === 'Optimization') {
          const paramSpace = r.parameters?.parameter_space || [];
          const objectiveConfig = r.parameters?.objective_config || [];
          const seqTemplate = r.parameters?.sequence_template || [];
          const seqLength = seqTemplate.length;
          const paramNames = paramSpace.map((p: any) => p.name);
          const objectiveNames = objectiveConfig.map((o: any) => o.name);
          vars = [...paramNames, ...objectiveNames.map((n: string) => `${n} (objective)`)];

          const iterationCount = seqLength > 0 ? Math.ceil((r.steps?.length || 0) / seqLength) : 0;
          for (let i = 0; i < iterationCount; i++) {
              const iterSteps = r.steps?.slice(i * seqLength, (i + 1) * seqLength) || [];
              const hasError = iterSteps.some((s: any) => s.status === 'error');
              const isRunning = iterSteps.some((s: any) => s.status === 'running');
              const isPending = iterSteps.every((s: any) => s.status === 'pending');
              const status = hasError ? 'error' : isRunning ? 'running' : isPending ? 'pending' : 'completed';

              // The suggested value for each search-space parameter shows up as a step argument
              // somewhere in this iteration's steps (whichever templated call actually used it).
              const paramValues = paramNames.map((name: string) => {
                  const step = iterSteps.find((s: any) => s.parameters && name in (s.parameters || {}));
                  return step ? step.parameters[name] : '';
              });
              // The objective's value is whatever step in the template was configured with that
              // returnVar — match by template position since steps themselves don't store returnVar.
              const objectiveValues = objectiveNames.map((name: string) => {
                  const tmplIdx = seqTemplate.findIndex((t: any) => t.returnVar === name);
                  const step = tmplIdx >= 0 ? iterSteps[tmplIdx] : null;
                  return step?.outputs?.result !== undefined ? step.outputs.result : '';
              });

              rows.push({
                  row: i + 1,
                  status,
                  data: [...paramValues, ...objectiveValues].join(','),
                  details: iterSteps.map((s: any) => ({
                      instrument: s.instrument,
                      method: s.method,
                      status: s.status,
                      result: s.outputs,
                      error: s.error,
                      start_time: s.start_time,
                      end_time: s.end_time
                  }))
              });
          }
      } else if (type === 'Spreadsheet') {
          const inputVars = vars;
          const rowCount = r.parameters?.rows?.length || 0;
          // Only present on runs submitted after this was added — older persisted runs have no
          // record of which step is "the" output, so they fall back to input-only columns below
          // (their outputs are still visible per-row in the UI, and via Export Log).
          const seqTemplate = r.parameters?.sequence_template || [];
          const returnVars = seqTemplate.filter((t: any) => t.returnVar).map((t: any) => t.returnVar);
          const seqLength = seqTemplate.length || (rowCount > 0 && r.steps?.length ? Math.floor(r.steps.length / rowCount) : 0);
          vars = [...inputVars, ...returnVars];

          for(let i=0; i<rowCount; i++) {
              const rowSteps = r.steps?.slice(i * seqLength, (i+1) * seqLength) || [];
              const hasError = rowSteps.some((s: any) => s.status === 'error');
              const isRunning = rowSteps.some((s: any) => s.status === 'running');
              const isPending = rowSteps.every((s: any) => s.status === 'pending');
              const status = hasError ? 'error' : isRunning ? 'running' : isPending ? 'pending' : 'completed';

              const inputVals = inputVars.map((v: string) => r.parameters.rows[i][v]);
              // Match each returnVar to the step at the same position in the per-row template —
              // rowSteps mirrors seqTemplate's order since every row repeats the same block sequence.
              const outputVals = returnVars.map((rv: string) => {
                  const tmplIdx = seqTemplate.findIndex((t: any) => t.returnVar === rv);
                  const step = tmplIdx >= 0 ? rowSteps[tmplIdx] : null;
                  return step?.outputs?.result !== undefined ? step.outputs.result : '';
              });
              const dataStr = [...inputVals, ...outputVals].join(',');

              rows.push({
                  row: i + 1,
                  status,
                  data: dataStr,
                  details: rowSteps.map((s:any) => ({
                      instrument: s.instrument,
                      method: s.method,
                      status: s.status,
                      result: s.outputs,
                      error: s.error,
                      start_time: s.start_time,
                      end_time: s.end_time
                  }))
              });
          }
      }
      
      return {
          id: r.id,
          name: r.name || 'Unnamed Workflow',
          type,
          timestamp: r.start_time || new Date().toISOString(),
          variables: vars,
          rows,
          steps: r.steps,
          config: type === 'Optimization' ? {
              optimizer: r.parameters?.optimizer,
              budget: r.parameters?.budget,
              error_recovery: r.parameters?.error_recovery,
              optimizer_config: r.parameters?.optimizer_config || {},
              parameter_space: r.parameters?.parameter_space || [],
              objective_config: r.parameters?.objective_config || []
          } : null
      };
  });

  useEffect(() => {
    // Theme init
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');

    const fetchRuns = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/queue/runs`);
            const data = await res.json();
            const formatted = formatRuns(data.runs);
            setHistory(formatted);
            setSelectedRun((prev: any) => prev ? formatted.find((f: any) => f.id === prev.id) || prev : formatted[0]);
        } catch(e) {}
    };

    fetchRuns();
    
    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => setEdgeStatus(data))
      .catch(err => console.error(err));

    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.status) setEdgeStatus(data.status);
            if (data.runs) {
                const formatted = formatRuns(data.runs);
                setHistory(formatted);
                setSelectedRun((prev: any) => prev ? formatted.find((f: any) => f.id === prev.id) || prev : formatted[0]);
            }
        } catch(e) {}
    };
      
    return () => {
        ws.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedRun || selectedRun.type !== 'Optimization') {
      setPlots(null);
      setPlotsError(null);
      return;
    }
    let cancelled = false;
    setPlots(null);
    setPlotsError(null);
    setPlotsLoading(true);
    fetch(`${API_BASE}/api/queue/runs/${selectedRun.id}/plots`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        if (data && typeof data === 'object' && data.error) {
          setPlotsError(data.error);
        } else if (data && typeof data === 'object') {
          setPlots(data);
        } else {
          setPlotsError('Plots are not viewable in the browser for this optimizer.');
        }
      })
      .catch(() => { if (!cancelled) setPlotsError('Failed to load plots.'); })
      .finally(() => { if (!cancelled) setPlotsLoading(false); });
    return () => { cancelled = true; };
  }, [selectedRun?.id, selectedRun?.type]);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };
  
  const clearHistory = async () => {
     if(confirm("Are you sure you want to clear all history? (Not implemented in DB yet)")) {
         // Future: call DELETE /api/queue/runs
         alert("Clearing history directly from the Edge database will be added soon.");
     }
  };
  
  const downloadRunDataCSV = (run: any) => {
     if (!run || run.type !== 'Spreadsheet') return;
     
     const header = run.variables.join(',');
     const csvRows = run.rows.map((r: any) => {
         const escapedData = r.data.split(',').map((d: string) => `"${d}"`).join(',');
         return escapedData;
     });
     
     const csvContent = "data:text/csv;charset=utf-8," + header + "\n" + csvRows.join("\n");
     const encodedUri = encodeURI(csvContent);
     const link = document.createElement("a");
     link.setAttribute("href", encodedUri);
     link.setAttribute("download", `ivoryos_data_${run.id}.csv`);
     document.body.appendChild(link);
     link.click();
     link.remove();
  };

  const downloadRunLogCSV = (run: any) => {
     if (!run || !run.steps) return;
     
     const paramKeys = new Set<string>();
     const outputKeys = new Set<string>();
     
     const flattenObj = (obj: any, prefix = ''): Record<string, string> => {
         const res: Record<string, string> = {};
         if (!obj) return res;
         Object.entries(obj).forEach(([k, v]) => {
             const newKey = prefix ? `${prefix}.${k}` : k;
             if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
                 Object.assign(res, flattenObj(v, newKey));
             } else {
                 res[newKey] = String(v);
             }
         });
         return res;
     };

     run.steps.forEach((step: any) => {
         const params = { ...(step.parameters || {}) };
         delete params._phase;
         const flatParams = flattenObj(params);
         Object.keys(flatParams).forEach(k => paramKeys.add(`Param:${k}`));
         
         const flatOutputs = flattenObj(step.outputs);
         Object.keys(flatOutputs).forEach(k => outputKeys.add(`Output:${k}`));
     });
     
     const pKeys = Array.from(paramKeys).sort();
     const oKeys = Array.from(outputKeys).sort();
     
     const header = ["Step Index", "Phase", "Iteration", "Instrument", "Method", "Status", "Start Time", "End Time", "Error", ...pKeys, ...oKeys].join(',');
     
     let phaseCounts: Record<string, number> = {};
     let currentPhaseStr = '';
     
     const csvRows = run.steps.map((step: any, idx: number) => {
         const params = { ...(step.parameters || {}) };
         const phase = params._phase || 'Main';
         delete params._phase;
         
         if (phase !== currentPhaseStr) {
             currentPhaseStr = phase;
             phaseCounts = {};
         }
         
         const stepKey = `${step.instrument}.${step.method}`;
         phaseCounts[stepKey] = (phaseCounts[stepKey] || 0) + 1;
         const iteration = phaseCounts[stepKey];
         
         const escapeCSV = (s: any) => {
             if (s === null || s === undefined) return '';
             const str = String(s);
             if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                 return `"${str.replace(/"/g, '""')}"`;
             }
             return str;
         };
         
         const flatParams = flattenObj(params);
         const flatOutputs = flattenObj(step.outputs);
         
         const pVals = pKeys.map(k => escapeCSV(flatParams[k.replace('Param:', '')]));
         const oVals = oKeys.map(k => escapeCSV(flatOutputs[k.replace('Output:', '')]));
         
         const formatDate = (dateString: string) => {
             if (!dateString) return '';
             try {
                 const d = new Date(dateString);
                 const pad = (n: number) => n.toString().padStart(2, '0');
                 return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
             } catch (e) {
                 return dateString;
             }
         };
         
         return [
             idx + 1,
             phase,
             iteration,
             step.instrument,
             step.method,
             step.status,
             formatDate(step.start_time),
             formatDate(step.end_time),
             escapeCSV(step.error),
             ...pVals,
             ...oVals
         ].join(',');
     });
     
     const csvContent = "data:text/csv;charset=utf-8," + header + "\n" + csvRows.join("\n");
     const encodedUri = encodeURI(csvContent);
     const link = document.createElement("a");
     link.setAttribute("href", encodedUri);
     link.setAttribute("download", `ivoryos_log_${run.id}.csv`);
     document.body.appendChild(link);
     link.click();
     link.remove();
  };

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {/* Sidebar */}
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden min-w-0">
         <div className="w-80 min-w-[20rem] max-w-[20rem] flex-none border-r border-gray-200 dark:border-white/10 bg-white/50 dark:bg-black/20 flex flex-col">
            <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
               <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300">Run History</h2>
               <button onClick={clearHistory} className="text-red-500 hover:text-red-600 p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20" title="Clear All History">
                  <Trash2 className="w-4 h-4" />
               </button>
            </header>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {history.length === 0 ? (
                    <div className="text-gray-500 dark:text-gray-600 italic text-sm text-center mt-10">No history found.</div>
                ) : (
                    history.map(run => (
                        <div 
                           key={run.id}
                           onClick={() => setSelectedRun(run)}
                           className={`p-3 rounded-lg border cursor-pointer transition-all ${selectedRun?.id === run.id ? 'bg-indigo-50 border-indigo-200 dark:bg-indigo-900/20 dark:border-indigo-500/30' : 'bg-white dark:bg-white/5 border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/10'}`}
                        >
                           <div className="flex justify-between items-center mb-1">
                               <span className="text-xs font-bold text-gray-800 dark:text-gray-200">{run.name.split(' - ')[0]}</span>
                               <span className="text-[10px] text-gray-500">{new Date(run.timestamp).toLocaleString()}</span>
                           </div>
                           <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                               {run.variables.length} variables • {run.rows.length} rows
                           </div>
                        </div>
                    ))
                )}
            </div>
         </div>
         
         <div className="flex-1 flex flex-col relative z-0 min-w-0 overflow-hidden">
            {selectedRun ? (
                <>
                <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
                  <div className="flex items-center space-x-3">
                    <Database className="w-5 h-5 text-indigo-500" />
                    <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300">{selectedRun.name.split(' - ')[0]}</h2>
                  </div>
                  <div className="flex items-center space-x-2">
                    {selectedRun.type === 'Spreadsheet' && (
                        <button 
                            onClick={() => downloadRunDataCSV(selectedRun)}
                            className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-green-50 border border-green-200 text-green-700 hover:bg-green-100 dark:bg-green-900/30 dark:border-green-500/30 dark:text-green-300 dark:hover:bg-green-900/50"
                        >
                          <Download className="w-4 h-4" />
                          <span>Export Data</span>
                        </button>
                    )}
                    <button 
                        onClick={() => downloadRunLogCSV(selectedRun)}
                        className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:border-indigo-500/30 dark:text-indigo-300 dark:hover:bg-indigo-900/50"
                    >
                      <Download className="w-4 h-4" />
                      <span>Export Log</span>
                    </button>
                  </div>
                </header>
                <div className="p-8 flex-1 overflow-y-auto overflow-x-hidden pb-24 min-w-0 w-full relative">
                  <div className="max-w-5xl mx-auto space-y-4 w-full min-w-0">
                      {selectedRun.type === 'Optimization' && selectedRun.config && (
                          <div className="bg-white dark:bg-black/40 rounded-xl border border-gray-200 dark:border-white/10 p-5 shadow-sm min-w-0">
                              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4">Configuration</h3>
                              <div className="flex flex-wrap gap-x-8 gap-y-3 mb-4">
                                  <div>
                                      <div className="text-[10px] uppercase font-bold text-gray-400">Optimizer</div>
                                      <div className="text-sm font-mono text-gray-800 dark:text-gray-200">{selectedRun.config.optimizer || '—'}</div>
                                  </div>
                                  <div>
                                      <div className="text-[10px] uppercase font-bold text-gray-400">Budget</div>
                                      <div className="text-sm font-mono text-gray-800 dark:text-gray-200">{selectedRun.config.budget ?? '—'}</div>
                                  </div>
                                  <div>
                                      <div className="text-[10px] uppercase font-bold text-gray-400">Error Recovery</div>
                                      <div className="text-sm font-mono text-gray-800 dark:text-gray-200">{selectedRun.config.error_recovery || '—'}</div>
                                  </div>
                                  {Object.entries(selectedRun.config.optimizer_config || {}).map(([stepKey, stepDef]: [string, any]) => (
                                      <div key={stepKey}>
                                          <div className="text-[10px] uppercase font-bold text-gray-400">{stepKey.replace('_', ' ')}</div>
                                          <div className="text-sm font-mono text-gray-800 dark:text-gray-200">{stepDef?.model}{stepDef?.num_samples !== undefined ? ` (${stepDef.num_samples})` : ''}</div>
                                      </div>
                                  ))}
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                                  {selectedRun.config.parameter_space.map((p: any) => (
                                      <div key={p.name} className="flex flex-col space-y-1 p-3 bg-gray-50/50 dark:bg-white/[0.02] rounded-lg border border-gray-100 dark:border-white/5">
                                          <span className="text-[11px] font-bold text-indigo-500 font-mono truncate">#{p.name}</span>
                                          <span className="text-xs text-gray-600 dark:text-gray-300">
                                              {p.type === 'choice' ? `choice: ${(p.bounds || []).join(', ')}` : `range: ${p.bounds?.[0]} – ${p.bounds?.[1]}`}
                                              <span className="text-gray-400"> ({p.value_type})</span>
                                          </span>
                                      </div>
                                  ))}
                                  {selectedRun.config.objective_config.map((o: any) => (
                                      <div key={o.name} className="flex flex-col space-y-1 p-3 bg-gray-50/50 dark:bg-white/[0.02] rounded-lg border border-gray-100 dark:border-white/5">
                                          <span className="text-[11px] font-bold text-green-500 font-mono truncate">{o.name}</span>
                                          <span className="text-xs text-gray-600 dark:text-gray-300">objective — {o.minimize ? 'minimize' : 'maximize'}</span>
                                      </div>
                                  ))}
                              </div>
                          </div>
                      )}
                      {selectedRun.type === 'Optimization' && (
                          <div className="bg-white dark:bg-black/40 rounded-xl border border-gray-200 dark:border-white/10 p-5 shadow-sm min-w-0">
                              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4">Optimizer Plots</h3>
                              {plotsLoading ? (
                                  <div className="text-sm text-gray-400 dark:text-gray-500">Loading plots…</div>
                              ) : plotsError ? (
                                  <div className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5 rounded-lg p-3">
                                      {plotsError}
                                      {plotsError.toLowerCase().includes('no optimizer plots available') && (
                                          <div className="mt-1 text-xs text-gray-400">Plots are only kept in memory for the most recently completed optimization run in this server session — run this optimization again to see fresh plots here.</div>
                                      )}
                                  </div>
                              ) : plots ? (
                                  <div className="space-y-6">
                                      {Object.entries(plots).map(([plotName, plotHtml]) => (
                                          <div key={plotName}>
                                              <div className="text-[10px] uppercase font-bold text-gray-400 mb-2">{plotName}</div>
                                              <PlotFrame html={plotHtml} />
                                          </div>
                                      ))}
                                  </div>
                              ) : (
                                  <div className="text-sm text-gray-400 dark:text-gray-500">No plots available.</div>
                              )}
                          </div>
                      )}
                      {selectedRun.type === 'Sequence' ? (
                          <div className="space-y-4 min-w-0">
                              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4">Execution Steps</h3>
                              {selectedRun.steps?.map((step: any, idx: number) => {
                                    const isFlowControl = step.instrument === 'Flow_Control' || step.instrument === 'Flow Control';
                                    const paramsWithoutPhase = { ...(step.parameters || {}) };
                                    const phase = paramsWithoutPhase._phase;
                                    delete paramsWithoutPhase._phase;
                                    
                                    const prevPhase = idx > 0 ? selectedRun.steps[idx - 1].parameters?._phase : null;
                                    const showPhaseDivider = phase && phase !== prevPhase;
                                    
                                    const hasParams = Object.keys(paramsWithoutPhase).length > 0;
                                    const hasResult = step.outputs && Object.keys(step.outputs).length > 0 && !(Object.keys(step.outputs).length === 1 && step.outputs.result === null);
                                    
                                    return (
                                        <div key={idx}>
                                            {showPhaseDivider && (
                                                <div className="flex items-center space-x-4 my-6">
                                                    <div className="flex-1 border-t border-gray-200 dark:border-white/10"></div>
                                                    <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">{phase} Phase</span>
                                                    <div className="flex-1 border-t border-gray-200 dark:border-white/10"></div>
                                                </div>
                                            )}
                                            <div className={`bg-white dark:bg-black/40 rounded-xl border border-gray-200 dark:border-white/10 ${(!isFlowControl && (hasParams || hasResult || step.error)) ? 'p-4' : 'px-4 py-3'} shadow-sm min-w-0 mb-3`}>
                                                <div className={`flex items-center justify-between ${(!isFlowControl && (hasParams || hasResult || step.error)) ? 'mb-3' : ''}`}>
                                                    <div className="flex items-center space-x-3">
                                                        <span className="text-gray-400 font-mono text-xs">[{idx + 1}]</span>
                                                        <span className="font-bold text-indigo-600 dark:text-indigo-400 break-words">
                                                            {isFlowControl ? step.method : `${step.instrument}.${step.method}`}
                                                            {isFlowControl && step.method === 'If' && <span className="ml-2 font-mono text-xs text-indigo-500 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 px-1.5 py-0.5 rounded border border-indigo-100 dark:border-indigo-500/30">condition: {paramsWithoutPhase.condition}</span>}
                                                            {isFlowControl && step.method === 'While' && <span className="ml-2 font-mono text-xs text-indigo-500 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 px-1.5 py-0.5 rounded border border-indigo-100 dark:border-indigo-500/30">condition: {paramsWithoutPhase.condition}</span>}
                                                            {isFlowControl && step.method === 'Sleep' && <span className="ml-2 font-mono text-xs text-indigo-500 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 px-1.5 py-0.5 rounded border border-indigo-100 dark:border-indigo-500/30">{paramsWithoutPhase.duration_seconds}s</span>}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center space-x-4">
                                                        <span className="text-[10px] text-gray-400 hidden sm:block">
                                                            {step.start_time && `${new Date(step.start_time).toLocaleTimeString()}`}
                                                            {step.end_time && ` - ${new Date(step.end_time).toLocaleTimeString()}`}
                                                        </span>
                                                        <span className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${
                                                            step.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 
                                                            step.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : 
                                                            step.status === 'running' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' :
                                                            'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                                                        }`}>
                                                            {step.status}
                                                        </span>
                                                    </div>
                                                </div>
                                                
                                                {!isFlowControl && (hasParams || hasResult || step.error) && (
                                                    <div className="grid grid-cols-2 gap-4 min-w-0 mt-3">
                                                        {hasParams && (
                                                            <div className="min-w-0 col-span-2 md:col-span-1">
                                                                <div className="text-[10px] uppercase font-bold text-gray-400 mb-1">Parameters</div>
                                                                <pre className="text-xs bg-gray-50 dark:bg-white/[0.02] p-2 rounded border border-gray-100 dark:border-white/5 overflow-hidden text-gray-600 dark:text-gray-300 max-w-full whitespace-pre-wrap break-all" style={{overflowWrap: 'anywhere'}}>
                                                                    {Object.entries(paramsWithoutPhase).map(([key, val]) => `${key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}: ${typeof val === 'object' ? JSON.stringify(val) : val}`).join('\n')}
                                                                </pre>
                                                            </div>
                                                        )}
                                                        {(hasResult || step.error) && (
                                                            <div className={`min-w-0 ${!hasParams ? 'col-span-2' : 'col-span-2 md:col-span-1'}`}>
                                                                <div className="text-[10px] uppercase font-bold text-gray-400 mb-1">Result / Output</div>
                                                                <pre className={`text-xs p-2 rounded border overflow-hidden max-w-full whitespace-pre-wrap break-all ${step.error ? 'bg-red-50 dark:bg-red-900/10 border-red-100 dark:border-red-500/20 text-red-600 dark:text-red-400' : 'bg-gray-50 dark:bg-white/[0.02] border-gray-100 dark:border-white/5 text-gray-600 dark:text-gray-300'}`} style={{overflowWrap: 'anywhere'}}>
                                                                    {step.error || formatStepOutput(step.outputs)}
                                                                </pre>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                                

                                            </div>
                                        </div>
                                    );
                                })}
                          </div>
                      ) : (
                          selectedRun.rows.map((row: any, idx: number) => {
                          const dataCols = row.data.split(',');
                          const isExpanded = expandedRow === idx;
                          return (
                              <div key={idx} className="bg-white dark:bg-black/40 rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden shadow-sm transition-all hover:border-gray-300 dark:hover:border-white/20 min-w-0">
                                  <div 
                                     onClick={() => setExpandedRow(isExpanded ? null : idx)}
                                     className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-white/[0.02]"
                                  >
                                      <div className="flex items-center space-x-6 min-w-0">
                                          <div className="flex flex-col items-center justify-center w-12 shrink-0">
                                              <span className="text-[10px] uppercase font-bold text-gray-400 dark:text-gray-500 mb-0.5">Row</span>
                                              <span className="text-lg font-mono font-bold text-gray-700 dark:text-gray-300">{row.row}</span>
                                          </div>
                                          <div className="h-8 w-px bg-gray-200 dark:bg-white/10 shrink-0"></div>
                                          <span className={`px-2.5 py-1 rounded text-xs font-bold uppercase tracking-wider ${row.status === 'success' || row.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : row.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'}`}>
                                             {row.status}
                                          </span>
                                      </div>
                                      <div className="flex items-center space-x-4 text-gray-500">
                                          <span className="text-sm font-medium hidden sm:block">{selectedRun.variables.length} Variables</span>
                                          <div className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-white/10">
                                            {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                                          </div>
                                      </div>
                                  </div>
                                  
                                  {isExpanded && (
                                      <div className="p-6 bg-gray-50/50 dark:bg-white/[0.02] border-t border-gray-100 dark:border-white/5 min-w-0 overflow-hidden">
                                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6 mb-6 min-w-0">
                                              {selectedRun.variables.map((v: string, i: number) => (
                                                  <div key={v} className="flex flex-col space-y-1.5 min-w-0">
                                                      <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider truncate">{v}</span>
                                                      <div className="text-sm font-mono text-gray-800 dark:text-gray-200 p-2.5 bg-white dark:bg-black/50 rounded-lg border border-gray-200 dark:border-white/10 break-all shadow-sm overflow-hidden">
                                                          {dataCols[i]}
                                                      </div>
                                                  </div>
                                              ))}
                                          </div>
                                          
                                          {row.details && row.details.length > 0 && (
                                              <div className="space-y-3 w-full min-w-0">
                                                  <h4 className="text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-100 dark:border-white/5 pb-2">Execution Steps</h4>
                                                  {row.details.map((step: any, sIdx: number) => (
                                                      <div key={sIdx} className="bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-lg p-3 text-sm shadow-sm w-full min-w-0 overflow-hidden">
                                                           <div className="flex justify-between items-center mb-1 min-w-0">
                                                              <div className="flex items-center space-x-2 min-w-0">
                                                                  <span className="text-gray-400 font-mono text-[10px] shrink-0">[{sIdx + 1}]</span>
                                                                  <span className="font-bold text-indigo-600 dark:text-indigo-400 text-xs truncate">{step.instrument}.{step.method}</span>
                                                              </div>
                                                              <span className={`px-2 py-0.5 rounded text-[9px] uppercase tracking-wider font-bold shrink-0 ml-2 ${step.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : step.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-500'}`}>{step.status}</span>
                                                           </div>
                                                           {(step.result || step.error) && (
                                                              <pre className={`mt-2 p-2 rounded text-xs overflow-hidden w-full max-w-full whitespace-pre-wrap break-all ${step.error ? 'bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-400 border border-red-100 dark:border-red-500/20' : 'bg-gray-50 dark:bg-white/[0.02] text-gray-600 dark:text-gray-300 border border-gray-100 dark:border-white/5'}`} style={{overflowWrap: 'anywhere'}}>
                                                                  {step.error || formatStepOutput(step.result)}
                                                              </pre>
                                                           )}
                                                      </div>
                                                  ))}
                                              </div>
                                          )}
                                      </div>
                                  )}
                              </div>
                          );
                      })
                      )}
                  </div>
                </div>
                </>
            ) : (
                <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm">
                    Select a run from the history list to view details.
                </div>
            )}
         </div>
      </main>
    </div>
  );
}
