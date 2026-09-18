"use client";
import { API_BASE, WS_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Database, Download, Sun, Moon, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { readNamedOutput } from '@ivoryos/shared-ui';

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

// A horizontal, time-scaled bar per logged step (Sequence steps, or every row's flattened
// details for Spreadsheet/Optimization runs) so it's obvious at a glance which steps dominated
// the run's wall-clock time and where errors landed, instead of only reading it out of a list.
const STATUS_BAR_COLOR: Record<string, string> = {
  completed: 'bg-green-500',
  error: 'bg-red-500',
  running: 'bg-indigo-500 animate-pulse',
};

type TimelineStep = {
  instrument?: string;
  method?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  /** Which trial/row this step belonged to, for runs that repeat the same sequence. */
  iteration?: number;
};

const stepLabel = (step: TimelineStep) =>
  (step.instrument === 'Flow_Control' || step.instrument === 'Flow Control')
    ? String(step.method)
    : `${step.instrument}.${step.method}`;

const ExecutionTimeline = ({ steps, iterationLabel }: { steps: TimelineStep[]; iterationLabel?: string }) => {
  const [hovered, setHovered] = useState<number | null>(null);

  const timed = steps.filter(s => s.start_time);
  if (timed.length === 0) return null;

  const starts = timed.map(s => new Date(s.start_time!).getTime());
  const ends = timed.map(s => new Date(s.end_time || s.start_time!).getTime());
  const minStart = Math.min(...starts);
  const maxEnd = Math.max(...ends);
  const totalMs = Math.max(maxEnd - minStart, 1);

  // Where the time actually went, which is the question the chart is meant to answer and could
  // not: a run of thirty slivers shows that something was slow without saying what.
  const byLabel = new Map<string, number>();
  timed.forEach((step, i) => {
    byLabel.set(stepLabel(step), (byLabel.get(stepLabel(step)) || 0) + (ends[i] - starts[i]));
  });
  const slowest = [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  // Iteration boundaries, drawn only while they are still distinguishable. A hundred-row
  // spreadsheet would otherwise be a wall of tick marks; the count still reaches the reader
  // through the hover readout and the caption.
  const iterations = [...new Set(timed.map(s => s.iteration).filter(v => v !== undefined))] as number[];
  const showBoundaries = iterations.length > 1 && iterations.length <= 40;
  const unit = iterationLabel || 'Iteration';

  const active = hovered !== null ? timed[hovered] : null;

  return (
    <div className="mb-6">
      <div className="flex items-baseline justify-between mb-2 gap-3">
        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Timeline</h3>
        {/* A fixed readout rather than a native title: a 0.6%-wide bar is close to
            unhoverable, and the browser tooltip needs a hover to be held still on top of it
            before it appears at all — so the information was effectively unreachable. */}
        <div className="text-[11px] font-mono truncate text-right flex-1 min-w-0">
          {active ? (
            <span className="text-gray-700 dark:text-gray-200">
              {active.iteration !== undefined && (
                <span className="text-indigo-600 dark:text-indigo-400 font-bold">{unit} {active.iteration} · </span>
              )}
              {stepLabel(active)}
              <span className="text-gray-400">
                {' · '}{((new Date(active.end_time || active.start_time!).getTime()
                        - new Date(active.start_time!).getTime()) / 1000).toFixed(2)}s
                {' · +'}{((new Date(active.start_time!).getTime() - minStart) / 1000).toFixed(1)}s
              </span>
              {active.status !== 'completed' && (
                <span className={active.status === 'error' ? ' text-red-500' : ' text-indigo-500'}>
                  {' · '}{active.status}
                </span>
              )}
            </span>
          ) : (
            <span className="text-gray-400 dark:text-gray-600">hover a bar for details</span>
          )}
        </div>
      </div>

      {/* Hover is resolved against the whole track rather than per bar. One slow step squeezes
          the rest to a few pixels each — in a typical run a 4s hold sits beside six sub-50ms
          calls — so a per-bar hover target makes exactly the steps you want to inspect the ones
          you cannot hit. Picking the step nearest the cursor's position in time makes every bar
          reachable regardless of how thin it was drawn. */}
      <div
        className="relative h-8 rounded-lg bg-gray-100 dark:bg-white/5 overflow-hidden cursor-crosshair"
        onMouseLeave={() => setHovered(null)}
        onMouseMove={e => {
          const rect = e.currentTarget.getBoundingClientRect();
          if (rect.width === 0) return;
          const at = minStart + ((e.clientX - rect.left) / rect.width) * totalMs;
          let best = 0;
          let bestDistance = Infinity;
          for (let i = 0; i < timed.length; i++) {
            // Zero when the cursor is inside the step's own span, so a real hit always wins.
            const distance = at < starts[i] ? starts[i] - at : at > ends[i] ? at - ends[i] : 0;
            if (distance < bestDistance) { bestDistance = distance; best = i; }
          }
          setHovered(best);
        }}
      >
        {showBoundaries && iterations.slice(1).map(iteration => {
          const first = timed.findIndex(s => s.iteration === iteration);
          if (first < 0) return null;
          return (
            <div
              key={`b-${iteration}`}
              className="absolute top-0 h-full w-px bg-gray-300 dark:bg-white/20 z-10"
              style={{ left: `${((starts[first] - minStart) / totalMs) * 100}%` }}
            />
          );
        })}
        {timed.map((step, idx) => {
          const leftPct = ((starts[idx] - minStart) / totalMs) * 100;
          // A near-instant step would otherwise round to an invisible sliver — floor its width
          // so every logged action stays hoverable, not just the slow ones.
          const widthPct = Math.max(((ends[idx] - starts[idx]) / totalMs) * 100, 0.6);
          return (
            <div
              key={idx}
              className={`absolute top-0 h-full pointer-events-none ${STATUS_BAR_COLOR[step.status || ''] || 'bg-gray-400'} transition-opacity border-r border-white/60 dark:border-black/40 ${
                hovered === idx ? 'opacity-100 ring-2 ring-inset ring-black/50 dark:ring-white/70 z-20' : 'opacity-90'
              }`}
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            />
          );
        })}
      </div>

      <div className="flex justify-between text-[10px] text-gray-400 mt-1 gap-2">
        <span>{new Date(minStart).toLocaleTimeString()}</span>
        <span className="text-center">
          {((maxEnd - minStart) / 1000).toFixed(1)}s total &middot; {timed.length} step{timed.length === 1 ? '' : 's'}
          {iterations.length > 1 && <> &middot; {iterations.length} {unit.toLowerCase()}s</>}
        </span>
        <span>{new Date(maxEnd).toLocaleTimeString()}</span>
      </div>

      {slowest.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[10px] text-gray-500 dark:text-gray-400">
          <span className="uppercase font-bold tracking-wider text-gray-400">Most time</span>
          {slowest.map(([label, ms]) => (
            <span key={label} className="font-mono">
              {label}
              <span className="text-gray-400"> {(ms / 1000).toFixed(1)}s ({Math.round((ms / totalMs) * 100)}%)</span>
            </span>
          ))}
        </div>
      )}
    </div>
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
  const [pendingDeleteRun, setPendingDeleteRun] = useState<any>(null);
  const [isDeletingRun, setIsDeletingRun] = useState(false);

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
              const objectiveValues = objectiveNames.map((name: string) =>
                  readNamedOutput(name, seqTemplate, iterSteps));

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
          // One step can save several named outputs (one per field of a structured return), so
          // each becomes its own column rather than the whole "a, b" list becoming one.
          const returnVars = seqTemplate.flatMap((t: any) =>
              t.returnBindings?.length
                  ? t.returnBindings.map((b: any) => b.var).filter(Boolean)
                  : String(t.returnVar || '').split(',').map((v: string) => v.trim()).filter(Boolean));
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
              const outputVals = returnVars.map((rv: string) => readNamedOutput(rv, seqTemplate, rowSteps));
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
  
  const deleteRun = async (run: any) => {
     setIsDeletingRun(true);
     try {
        const res = await fetch(`${API_BASE}/api/queue/runs/${run.id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to delete run');
        setHistory(prev => prev.filter(r => r.id !== run.id));
        setSelectedRun((prev: any) => (prev?.id === run.id ? null : prev));
        setPendingDeleteRun(null);
     } catch (e: any) {
        alert("Failed to delete run: " + e.message);
     } finally {
        setIsDeletingRun(false);
     }
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
      {pendingDeleteRun && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#1a1a1a] border border-red-200 dark:border-red-500/30 rounded-2xl shadow-2xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg bg-red-50 dark:bg-red-500/10 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-red-600 dark:text-red-400" />
              </div>
              <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">Delete this run?</h2>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              <span className="font-semibold text-gray-800 dark:text-gray-200">{pendingDeleteRun.name?.split(' - ')[0]}</span> and its recorded data will be permanently removed. This can&rsquo;t be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingDeleteRun(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteRun(pendingDeleteRun)}
                disabled={isDeletingRun}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white transition-colors"
              >
                {isDeletingRun ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
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
                           className={`group p-3 rounded-lg border cursor-pointer transition-all ${selectedRun?.id === run.id ? 'bg-indigo-50 border-indigo-200 dark:bg-indigo-900/20 dark:border-indigo-500/30' : 'bg-white dark:bg-white/5 border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/10'}`}
                        >
                           <div className="flex justify-between items-center mb-1 gap-2">
                               <span className="text-xs font-bold text-gray-800 dark:text-gray-200 truncate min-w-0">{run.name.split(' - ')[0]}</span>
                               <div className="flex items-center gap-1.5 shrink-0">
                                   <span className="text-[10px] text-gray-500">{new Date(run.timestamp).toLocaleString()}</span>
                                   <button
                                      onClick={(e) => { e.stopPropagation(); setPendingDeleteRun(run); }}
                                      title="Delete run"
                                      className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-opacity"
                                   >
                                       <Trash2 className="w-3.5 h-3.5" />
                                   </button>
                               </div>
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
                      <ExecutionTimeline
                          iterationLabel={selectedRun.type === 'Optimization' ? 'Trial' : 'Row'}
                          steps={selectedRun.type === 'Sequence'
                              ? (selectedRun.steps || [])
                              // Carry the row/trial number onto each step. Flattening without it
                              // left every repeated run as one undifferentiated band of bars.
                              : selectedRun.rows.flatMap((r: any) =>
                                  (r.details || []).map((d: any) => ({ ...d, iteration: r.row })))}
                      />
                      {selectedRun.type === 'Sequence' ? (
                          <div className="space-y-4 min-w-0">
                              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4">Execution Steps</h3>
                              {selectedRun.steps?.map((step: any, idx: number) => {
                                    const isFlowControl = step.instrument === 'Flow_Control' || step.instrument === 'Flow Control';
                                    const paramsWithoutPhase = { ...(step.parameters || {}) };
                                    const phase = paramsWithoutPhase._phase;
                                    delete paramsWithoutPhase._phase;

                                    // Return pointers read better as "name <- field" than as raw
                                    // JSON, and the flat _return_var list is redundant beside them.
                                    const bindings = paramsWithoutPhase._return_bindings;
                                    if (Array.isArray(bindings) && bindings.length > 0) {
                                        delete paramsWithoutPhase._return_bindings;
                                        delete paramsWithoutPhase._return_var;
                                        paramsWithoutPhase.saves = bindings
                                            .map((b: any) => (b.path ? `${b.var} \u2190 ${b.path}` : b.var))
                                            .join(', ');
                                    }
                                    
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
