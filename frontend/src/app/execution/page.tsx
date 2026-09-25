"use client";
import { unmodifiedSavedWorkflowName } from '@/savedWorkflow';
import { API_BASE, WS_BASE } from '@/config';

import { useState, useEffect, useCallback } from 'react';
import { Play, Download, Upload, AlertTriangle, Layers, ListTree } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import RunTabs from '@/components/RunTabs';
import {
  buildRunName,
  LIBRARY_INSTRUMENT,
  WorkflowMap,
  confirmDialog,
  notify,
  readNamedOutput,
  SpreadsheetTable,
  buildSpreadsheetParameters,
  expandSpreadsheet,
  resolveFixedBlock,
  toSubmittedStep,
  toWireBlock,
} from '@ivoryos/shared-ui';

/**
 * Resolve any `Library Workflows` blocks into the steps they stand for, via the server's own
 * expander, and re-attach each resulting step's parameter schema from the live instrument schema.
 *
 * Returns null when there is nothing to expand, or when the call fails — the Configure page has to
 * keep working offline against a cached sequence, and an un-expanded link is still runnable (the
 * edge server expands it again at dispatch); it just can't show the inner steps' batch flags.
 */
async function expandLinkedBlocks(seqs: { prep: any[]; sequence: any[]; cleanup: any[] }) {
  const all = [...seqs.prep, ...seqs.sequence, ...seqs.cleanup];
  if (!all.some(b => b?.instrument === LIBRARY_INSTRUMENT)) return null;

  try {
    const [expandRes, statusRes] = await Promise.all([
      fetch(`${API_BASE}/api/workflows/expand`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prep: seqs.prep.map(toWireBlock),
          sequence: seqs.sequence.map(toWireBlock),
          cleanup: seqs.cleanup.map(toWireBlock),
        }),
      }),
      fetch(`${API_BASE}/api/status`),
    ]);
    if (!expandRes.ok) return null;

    const expanded = await expandRes.json();
    const instruments = (await statusRes.json().catch(() => ({})))?.instruments || {};

    // The expander returns raw steps; this page needs `schema` for its type hints and `#var`
    // validation, so look each one back up in the live schema.
    const hydrate = (steps: any[]) => (steps || []).map((step: any) => ({
      id: `expanded-${Math.random().toString(36).slice(2, 11)}`,
      instrument: step.instrument,
      method: step.method,
      schema: instruments?.[step.instrument]?.[step.method] || { parameters: {} },
      params: Object.fromEntries(
        Object.entries(step.params || {}).filter(([k]) => !k.startsWith('_'))
      ),
      returnVar: step.params?._return_var || step.returnVar || '',
      ...(step.params?._return_bindings || step.returnBindings
        ? { returnBindings: step.params?._return_bindings || step.returnBindings }
        : {}),
      isBatchAction: !!(step.batch_action ?? step.isBatchAction),
      // Steps expanded out of the same linked workflow are grouped, so the spreadsheet table can
      // still show which saved workflow a step came from. The id keys on `_expansion_id` rather
      // than the name: two uses of the same workflow are two groups, and sharing an id would
      // make them collapse and move as one.
      group: step.params?._parent_workflow
        ? {
            id: `expanded-${step.params._expansion_id ?? step.params._parent_workflow}`,
            name: step.params._parent_workflow,
          }
        : undefined,
    }));

    return {
      prep: hydrate(expanded.prep),
      sequence: hydrate(expanded.sequence),
      cleanup: hydrate(expanded.cleanup),
    };
  } catch {
    return null;
  }
}

export default function ExecutionPage() {
  const [experimentName, setExperimentName] = useState('');
  const [sequence, setSequence] = useState<any[]>([]);
  const [prepSequence, setPrepSequence] = useState<any[]>([]);
  const [cleanupSequence, setCleanupSequence] = useState<any[]>([]);
  const [variables, setVariables] = useState<string[]>([]);
  const [globalVariables, setGlobalVariables] = useState<string[]>([]);
  const [globalValues, setGlobalValues] = useState<Record<string, string>>({});
  const [varTypes, setVarTypes] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Record<string, any>[]>([{}]);
  // Vars used by a "batch" step — still spreadsheet columns, but only need one row per batch
  // group filled in (see batchSize below), not every row.
  const [batchVariables, setBatchVariables] = useState<string[]>([]);
  const [batchSize, setBatchSize] = useState<string>('');
  
  const [executionState, setExecutionState] = useState<{
    isRunning: boolean;
    currentRow: number;
    results: any[];
  }>({ isRunning: false, currentRow: -1, results: [] });

  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [hasPendingRuns, setHasPendingRuns] = useState(false);
  const [edgeStatus, setEdgeStatus] = useState<any>(null);

  const [varOptions, setVarOptions] = useState<Record<string, any[]>>({});
  const [hasEmptyHashVar, setHasEmptyHashVar] = useState(false);
  const [liveInputVars, setLiveInputVars] = useState<Set<string>>(new Set());
  const [isMapOpen, setIsMapOpen] = useState(false);

  // Feeds the preview panel. The sequence here is already link-resolved (see expandLinkedBlocks),
  // so this round trip mostly just re-derives the same flat list through the server — which is the
  // point: the number the user is shown comes from the expander that dispatch uses, not from a
  // second count computed here.
  const fetchExpansion = useCallback(async () => {
    const res = await fetch(`${API_BASE}/api/workflows/expand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prep: prepSequence.map(toWireBlock),
        sequence: sequence.map(toWireBlock),
        cleanup: cleanupSequence.map(toWireBlock),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not expand this sequence.');
    return data;
  }, [prepSequence, sequence, cleanupSequence]);

  useEffect(() => {
    // Theme init
    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.runs) {
                const hasPending = data.runs.some((r: any) => r.status === 'pending');
                const hasActive = data.runs.some((r: any) => ['running', 'paused', 'cancelling'].includes(r.status));
                setHasPendingRuns(hasPending || hasActive);
            }
        } catch(e) {}
    };

    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');


    fetch(`${API_BASE}/api/queue/runs?recent=1`)
      .then(res => res.json())
      .then(data => {
        if (data.runs) {
            const hasPending = data.runs.some((r: any) => r.status === 'pending');
            const hasActive = data.runs.some((r: any) => ['running', 'paused', 'cancelling'].includes(r.status));
            setHasPendingRuns(hasPending || hasActive);
        }
      });

    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => setEdgeStatus(data))
      .catch(err => console.error(err));

    // Load sequence and extract variables
    const savedSequence = localStorage.getItem('ivoryos_sequence');
    if (savedSequence) {
      (async () => {
      try {
        let parsedSeq = JSON.parse(savedSequence);

        const savedPrep = localStorage.getItem('ivoryos_prep_sequence');
        const savedCleanup = localStorage.getItem('ivoryos_cleanup_sequence');
        let pSeq = [];
        let cSeq = [];
        if (savedPrep) pSeq = JSON.parse(savedPrep);
        if (savedCleanup) cSeq = JSON.parse(savedCleanup);

        // Resolve linked workflows into their real steps *before* this page reads anything from
        // the sequence. Everything below — the #var scan, the per-sample/batch walk in
        // executeSpreadsheet, the submitted payload — works block by block, and a link left
        // collapsed reads as exactly one block. That is what made a linked subworkflow behave
        // differently from the same steps copied inline: its inner per-sample/batch flags were
        // invisible here and silently ignored, so the whole subworkflow ran as a single
        // per-sample or batch unit. Expanding through the server's own expander makes the two
        // identical, and keeps this page agreeing with the Designer's preview.
        const expanded = await expandLinkedBlocks({ prep: pSeq, sequence: parsedSeq, cleanup: cSeq });
        if (expanded) {
          parsedSeq = expanded.sequence;
          pSeq = expanded.prep;
          cSeq = expanded.cleanup;
        }

        setSequence(parsedSeq);
        setPrepSequence(pSeq);
        setCleanupSequence(cSeq);

        // Variables produced by a 'User_Input' step are resolved live on the edge server while the
        // workflow runs, so they must not be treated as parameters this page needs pre-filled.
        const liveVars = new Set<string>();
        [...parsedSeq, ...pSeq, ...cSeq].forEach((block: any) => {
            const isUserInput = (block.instrument === 'Flow_Control' || block.instrument === 'Flow Control') && block.method === 'User_Input';
            if (isUserInput && block.params?.variable_name) {
                liveVars.add(String(block.params.variable_name).trim());
            }
        });
        setLiveInputVars(liveVars);

        // Extract # variables and types
        const vars = new Set<string>();
        const gVars = new Set<string>();
        const batchVars = new Set<string>();
        const vTypes: Record<string, string> = {};
        const vOptions: Record<string, any[]> = {};
        let sawEmptyHash = false;

        const extractVars = (obj: any, schemaObj: any, targetSet: Set<string>) => {
            if (!obj) return;
            Object.entries(obj).forEach(([k, v]) => {
                let pData = null;
                if (schemaObj?.parameters?.[k]) pData = schemaObj.parameters[k];
                else if (schemaObj?.fields?.[k]) pData = schemaObj.fields[k];

                if (typeof v === 'string' && v.startsWith('#')) {
                    const varName = v.substring(1).trim();
                    if (varName === '') {
                        sawEmptyHash = true;
                        return;
                    }
                    if (liveVars.has(varName)) return; // resolved live by a User_Input step, not by this page
                    targetSet.add(varName);

                    if (pData?.type) vTypes[varName] = pData.type;
                    if (pData?.options) vOptions[varName] = pData.options;
                } else if (typeof v === 'object' && v !== null) {
                    extractVars(v, pData, targetSet);
                }
            });
        };

        parsedSeq.forEach((block: any) => {
            // A batch step's #vars still come from the spreadsheet — they just only need to be
            // filled in on one row per batch group instead of every row (see batchVars below).
            extractVars(block.params, block.schema, vars);
            if (block.isBatchAction) extractVars(block.params, block.schema, batchVars);
        });

        pSeq.forEach((block: any) => extractVars(block.params, block.schema, gVars));
        cSeq.forEach((block: any) => extractVars(block.params, block.schema, gVars));

        setHasEmptyHashVar(sawEmptyHash);

        const varList = Array.from(vars);
        const gVarList = Array.from(gVars);
        setVariables(varList);
        setGlobalVariables(gVarList);
        setBatchVariables(Array.from(batchVars));
        setVarTypes(vTypes);
        setVarOptions(vOptions);
        
        const savedGlobalValues = localStorage.getItem('ivoryos_global_values');
        if (savedGlobalValues) {
            setGlobalValues(JSON.parse(savedGlobalValues));
        } else {
            const initGVals: Record<string, string> = {};
            gVarList.forEach(v => initGVals[v] = '');
            setGlobalValues(initGVals);
        }
        
        // Init rows from memory or empty
        const savedRows = localStorage.getItem('ivoryos_spreadsheet');
        let initialRows = [];
        if (savedRows) {
            initialRows = JSON.parse(savedRows);
        } else {
            for (let i = 0; i < 5; i++) {
                const initRow: Record<string, any> = {};
                varList.forEach(v => initRow[v] = '');
                initialRows.push(initRow);
            }
        }
        setRows(initialRows);

        const savedBatchSize = localStorage.getItem('ivoryos_batch_size');
        if (savedBatchSize) setBatchSize(savedBatchSize);
      } catch (e) {
        console.error("Failed to load sequence", e);
      }
      })();
    }
  }, []);

  useEffect(() => {
    if (batchSize) localStorage.setItem('ivoryos_batch_size', batchSize);
    else localStorage.removeItem('ivoryos_batch_size');
  }, [batchSize]);

  useEffect(() => {
    if (rows.length > 0 && Object.keys(rows[0]).length > 0) {
      localStorage.setItem('ivoryos_spreadsheet', JSON.stringify(rows));
    }
  }, [rows]);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const addRow = () => {
    const newRow: Record<string, any> = {};
    variables.forEach(v => newRow[v] = '');
    setRows([...rows, newRow]);
  };

  const removeRow = (idx: number) => {
    if (rows.length === 1) return;
    const newRows = [...rows];
    newRows.splice(idx, 1);
    setRows(newRows);
  };

  const reorderRows = (from: number, to: number) => {
    const newRows = Array.from(rows);
    const [moved] = newRows.splice(from, 1);
    newRows.splice(to, 0, moved);
    setRows(newRows);
  };

  const updateRow = (idx: number, variable: string, value: string) => {
    const newRows = [...rows];
    newRows[idx][variable] = value;
    setRows(newRows);
  };

  const downloadCSV = () => {
    if (variables.length === 0) return;
    const header = variables.join(',');
    const csvContent = "data:text/csv;charset=utf-8," 
      + header + "\n"
      + rows.map(e => variables.map(v => e[v] || '').join(',')).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "ivoryos_spreadsheet.csv");
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const downloadResultsCSV = () => {
    if (executionState.results.length === 0) return;
    // One step can save several named outputs (one per field of a structured return value), so
    // each name is its own column and each is read back through its own return pointer.
    const returnVars = sequence.flatMap(b =>
      b.returnBindings?.length
        ? b.returnBindings.map((bind: { path: string; var: string }) => bind.var).filter(Boolean)
        : String(b.returnVar || '').split(',').map(v => v.trim()).filter(Boolean)
    );
    const headerCols = [...variables, ...returnVars];
    const header = headerCols.join(',');

    const csvRows = rows.map((row, idx) => {
      const log = executionState.results.find(l => l.row === idx);
      const steps = (log && log.status === 'success')
        ? log.details.map((d: any) => ({ outputs: { result: d.result } }))
        : [];

      const inputCols = variables.map(v => row[v] || '');
      const outputCols = returnVars.map(v => {
        const value = readNamedOutput(v, sequence, steps);
        if (value === '' || value === undefined) return '';
        return (typeof value === 'object' ? JSON.stringify(value) : String(value)).replace(/,/g, ';');
      });
      return [...inputCols, ...outputCols].join(',');
    });

    const csvContent = "data:text/csv;charset=utf-8," 
      + header + "\n"
      + csvRows.join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "ivoryos_execution_results.csv");
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      if (text) {
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length > 0) {
          const headers = lines[0].split(',');
          const newRows = [];
          for (let i = 1; i < lines.length; i++) {
            const vals = lines[i].split(',');
            const row: Record<string, any> = {};
            variables.forEach(v => {
              const hIdx = headers.indexOf(v);
              row[v] = hIdx !== -1 ? vals[hIdx] : '';
            });
            newRows.push(row);
          }
          if (newRows.length > 0) setRows(newRows);
        }
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const executeSpreadsheet = async () => {
    if (sequence.length === 0 && prepSequence.length === 0 && cleanupSequence.length === 0) return;
    
    setExecutionState({ isRunning: true, currentRow: -1, results: [] });

    try {
      // The per-sample/batch walk, the `#var` resolution and the numeric checks all live in
      // @ivoryos/shared-ui now — the Cloud orchestrator dispatches spreadsheet runs through the
      // very same functions, so a distributed run and a bench run expand identically. The table
      // above draws its group boundaries from the same `groupSizeFor`, which is what keeps the
      // "not used for this row" hint from ever becoming a lie.
      let fullSequence: any[] = [];
      try {
        fullSequence = expandSpreadsheet({
          sequence,
          rows,
          variables,
          batchSize,
          liveInputVars,
        });
      } catch (err: any) {
        setExecutionState({ isRunning: false, currentRow: -1, results: [] });
        await notify(err.message, {
          title: err.message.startsWith('Fill in') ? 'Nothing to run' : 'Missing a value',
          tone: 'error',
        });
        return;
      }

      let resolvedPrep: any[] = [];
      let resolvedCleanup: any[] = [];
      try {
          resolvedPrep = prepSequence.map(b => resolveFixedBlock(b, globalValues));
          resolvedCleanup = cleanupSequence.map(b => resolveFixedBlock(b, globalValues));
      } catch (err: any) {
          await notify(err.message, { title: 'Missing a value', tone: 'error' });
          setExecutionState({ isRunning: false, currentRow: -1, results: [] });
          return;
      }

      // Submit
      const payload = {
        name: await buildRunName(`${localStorage.getItem('ivoryos_editing_workflow') || 'Spreadsheet'} Run`, experimentName, API_BASE),
        parameters: {
          ...buildSpreadsheetParameters({ variables, rows, sequence, batchSize }),
          // Lets the edge time runs of a saved workflow (runtime.py).
          ...(unmodifiedSavedWorkflowName() ? { workflow_name: unmodifiedSavedWorkflowName() } : {}),
        },
        prep: resolvedPrep,
        // `toSubmittedStep` stamps each step with the row it came from. Data History used to
        // recover that by slicing the flat list into equal chunks, which assumes a row-major
        // flattening this walk does not produce — see toSubmittedStep for the full story.
        sequence: fullSequence.map(toSubmittedStep),
        cleanup: resolvedCleanup
      };

      const res = await fetch(`${API_BASE}/api/queue/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      const data = await res.json();
      
      if (res.ok) {
         setExecutionState({ isRunning: false, currentRow: -1, results: [] });
      } else {
         throw new Error(data.error || 'Failed to add to queue');
      }
    } catch (e: any) {
      setExecutionState({
        isRunning: false,
        currentRow: -1,
        results: []
      });
      await notify(e.message, { title: 'Could not start the run', tone: 'error' });
    }
  };

  // A cell is only flagged once it has real content — an empty/untouched cell isn't wrong yet,
  // it's just unfilled (that's caught separately as "missing value" when Run is actually clicked).
  const isInvalidNumericCell = (v: string, val: any) => {
    const typeHint = (varTypes[v] || '').toLowerCase();
    if (!typeHint.includes('int') && !typeHint.includes('float')) return false;
    if (val === undefined || val === null || val === '') return false;
    return isNaN(Number(val));
  };

  // Whether the table shows any batch affordances at all. The grouping itself (boundaries, the
  // designated first row, the "Batch N" label) is computed inside SpreadsheetTable from the same
  // `groupSizeFor` that `expandSpreadsheet` uses — that shared call is what keeps the display and
  // the real behaviour from drifting apart, which they have done before.
  const hasBatchStep = sequence.some(b => b.isBatchAction);
  // Batch size is not only about batch steps: within a batch the walk is step-major (every row's
  // step 1, then every row's step 2), so it also decides whether rows interleave. Blank is 1 —
  // each row start to finish — and the field shows whenever there are rows to group.
  const hasBatchSize = parseInt(batchSize) > 1;
  const activeRowCount = rows.filter(r => Object.values(r || {}).some(v => v !== undefined && v !== null && v !== '')).length;

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {/* Sidebar */}
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      {/* Main Area */}
      <div className="flex-1 flex flex-col relative z-0">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-3 px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <RunTabs active="configure" />
          {variables.length > 0 && (
            <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-white/5 px-2 py-0.5 rounded-full">
              {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
            </span>
          )}
        </header>

        <div className="p-8 flex-1 overflow-y-auto pb-48">
          {hasEmptyHashVar && (
            <div className="mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/30 rounded-lg px-4 py-3 flex items-start gap-3 text-sm text-red-700 dark:text-red-300">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                One or more parameters use <code className="px-1 py-0.5 rounded bg-red-100 dark:bg-red-900/40 font-mono text-xs">#</code> with
                no variable name after it, so they&apos;re excluded here and will fail if run. Go back to the Designer and give each one a name
                (e.g. <code className="px-1 py-0.5 rounded bg-red-100 dark:bg-red-900/40 font-mono text-xs">#temperature</code>).
              </span>
            </div>
          )}
          {globalVariables.length > 0 && (
            <div className="mb-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 rounded-lg px-4 py-3 flex items-center gap-4 flex-wrap">
              <span className="text-xs font-bold text-amber-700 dark:text-amber-300 uppercase tracking-wider whitespace-nowrap shrink-0">Fixed Values</span>
              {globalVariables.map(v => (
                <div key={v} className="flex items-center gap-2">
                  <label className="text-xs font-medium text-amber-800 dark:text-amber-200 whitespace-nowrap">{v}</label>
                  <input
                     type="text"
                     value={globalValues[v] || ''}
                     onChange={e => {
                       const updated = {...globalValues, [v]: e.target.value};
                       setGlobalValues(updated);
                       localStorage.setItem('ivoryos_global_values', JSON.stringify(updated));
                     }}
                     title={isInvalidNumericCell(v, globalValues[v]) ? `Expects a number (${varTypes[v]})` : undefined}
                     className={`w-36 bg-white dark:bg-black/50 border rounded-md px-2 py-1 text-sm outline-none ${
                       isInvalidNumericCell(v, globalValues[v])
                         ? 'border-red-400 dark:border-red-500/60'
                         : 'border-amber-300 dark:border-amber-700/50 focus:border-amber-500'
                     }`}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3 mb-4">
            <label className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10 cursor-pointer">
              <Upload className="w-4 h-4" />
              <span>Import CSV</span>
              <input type="file" accept=".csv" className="hidden" onChange={handleFileUpload} />
            </label>
            <button
                onClick={downloadCSV}
                className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10"
            >
              <Download className="w-4 h-4" />
              <span>Export CSV</span>
            </button>
            {executionState.results.length > 0 && (
              <button
                  onClick={downloadResultsCSV}
                  className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-green-50 border border-green-200 text-green-700 hover:bg-green-100 dark:bg-green-900/30 dark:border-green-500/30 dark:text-green-300 dark:hover:bg-green-900/50"
              >
                <Download className="w-4 h-4" />
                <span>Export Results</span>
              </button>
            )}
          </div>

          {variables.length === 0 && globalVariables.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-500 dark:text-gray-400 border-2 border-dashed border-gray-300 dark:border-white/10 rounded-2xl">
              <p className="text-sm font-medium">No dynamic variables found in current sequence.</p>
              <p className="text-xs mt-2">Go to the Designer and set a parameter to #variable_name.</p>
            </div>
          ) : variables.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-gray-500 dark:text-gray-400 border-2 border-dashed border-gray-300 dark:border-white/10 rounded-2xl">
              <p className="text-sm font-medium">No iterative variables in main sequence.</p>
              <p className="text-xs mt-2">Only prep/cleanup fixed values are configured above.</p>
            </div>
          ) : (
            <SpreadsheetTable
              variables={variables}
              rows={rows}
              onRowChange={updateRow}
              onAddRow={addRow}
              onRemoveRow={removeRow}
              onReorder={reorderRows}
              varTypes={varTypes}
              varOptions={varOptions}
              batchVariables={batchVariables}
              batchSize={batchSize}
              showBatchGrouping={hasBatchStep || hasBatchSize}
              idPrefix="configure"
            />
          )}

          {(variables.length > 0 || globalVariables.length > 0) && (
            <div className="flex flex-col items-end pt-4 gap-2">
              <div className="flex items-center gap-2">
                {variables.length > 0 && (
                  <div className="flex items-center gap-2" title={`How many spreadsheet rows make up one batch. Within a batch, each step runs for every row before the next step starts${hasBatchStep ? ', and batch steps run once for the whole batch' : ''}. Blank or 1 runs each row start to finish.`}>
                    <Layers className="w-4 h-4 text-teal-600 dark:text-teal-400" />
                    <label className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider whitespace-nowrap">Batch Size</label>
                    <input
                      type="number"
                      min="1"
                      placeholder="1"
                      value={batchSize}
                      onChange={e => setBatchSize(e.target.value)}
                      className="w-16 px-2 py-2 rounded-lg text-sm bg-white border border-gray-200 text-gray-700 focus:outline-none focus:border-teal-400 dark:bg-black/50 dark:border-white/10 dark:text-gray-200"
                    />
                  </div>
                )}
                <input
                  type="text"
                  value={experimentName}
                  onChange={e => setExperimentName(e.target.value)}
                  placeholder="Experiment name (optional)"
                  title="Shown in Data History instead of the default run label"
                  className="w-56 px-3 py-2 rounded-lg text-sm bg-white border border-gray-200 text-gray-700 placeholder:text-gray-400 focus:outline-none focus:border-green-400 dark:bg-black/50 dark:border-white/10 dark:text-gray-200 dark:placeholder:text-gray-500"
                />
                {/* "24 rows x batch 4" is otherwise impossible to turn into a real call count
                    without simulating the whole per-sample/batch walk in your head. */}
                <button
                  onClick={() => setIsMapOpen(true)}
                  title="Preview every step and every call this run will make"
                  className="flex items-center space-x-2 px-3 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-black/50 dark:border-white/10 dark:text-gray-200 dark:hover:bg-white/10"
                >
                  <ListTree className="w-4 h-4 text-emerald-500" />
                  <span>Preview</span>
                </button>
              </div>
              <button
                  onClick={async () => {
                      if (hasPendingRuns) {
                          const ok = await confirmDialog("A task is already running. Add this sequence to the execution queue?", {
                            title: 'Queue this run?',
                            confirmLabel: 'Add to queue',
                          });
                          if (!ok) return;
                      }
                      executeSpreadsheet();
                  }}
                  className="flex items-center space-x-2 px-6 py-3 bg-green-600 hover:bg-green-700 dark:hover:bg-green-500 text-white rounded-xl transition-colors font-bold shadow-lg shadow-green-500/20"
                >
                  <Play className="w-5 h-5" />
                  <span>{hasPendingRuns ? 'Add to Queue' : 'Run'}</span>
                </button>
            </div>
          )}
        </div>
      </div>

      <WorkflowMap
        isOpen={isMapOpen}
        onClose={() => setIsMapOpen(false)}
        fetchExpansion={fetchExpansion}
        spreadsheet={{
          rows: activeRowCount,
          batchSize: parseInt(batchSize) || 1,
          // Bound to the page's real setting rather than a private what-if, so the grouping the
          // preview shows is always the grouping that will run.
          onBatchSizeChange: (size: number) => setBatchSize(String(size)),
        }}
      />
    </div>
  );
}
