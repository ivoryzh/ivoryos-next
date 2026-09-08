"use client";
import { API_BASE, WS_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Play, Plus, Trash2, Sun, Moon, Download, Upload, ArrowUp, ArrowDown, GripVertical, AlertTriangle, Layers } from 'lucide-react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import Sidebar from '@/components/Sidebar';
import { buildRunName } from '@ivoryos/shared-ui';

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


    fetch(`${API_BASE}/api/queue/runs`)
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
      try {
        const parsedSeq = JSON.parse(savedSequence);
        setSequence(parsedSeq);

        const savedPrep = localStorage.getItem('ivoryos_prep_sequence');
        const savedCleanup = localStorage.getItem('ivoryos_cleanup_sequence');
        let pSeq = [];
        let cSeq = [];
        if (savedPrep) pSeq = JSON.parse(savedPrep);
        if (savedCleanup) cSeq = JSON.parse(savedCleanup);
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

  const moveRowUp = (idx: number) => {
    if (idx === 0) return;
    const newRows = [...rows];
    const temp = newRows[idx];
    newRows[idx] = newRows[idx - 1];
    newRows[idx - 1] = temp;
    setRows(newRows);
  };

  const moveRowDown = (idx: number) => {
    if (idx === rows.length - 1) return;
    const newRows = [...rows];
    const temp = newRows[idx];
    newRows[idx] = newRows[idx + 1];
    newRows[idx + 1] = temp;
    setRows(newRows);
  };

  const onDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    const newRows = Array.from(rows);
    const [reorderedItem] = newRows.splice(result.source.index, 1);
    newRows.splice(result.destination.index, 0, reorderedItem);
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
    const returnVars = sequence.filter(b => b.returnVar).map(b => b.returnVar);
    const headerCols = [...variables, ...returnVars];
    const header = headerCols.join(',');
    
    const csvRows = rows.map((row, idx) => {
      const log = executionState.results.find(l => l.row === idx);
      const outputValues: Record<string, string> = {};
      
      if (log && log.status === 'success') {
        log.details.forEach((d: any, i: number) => {
           const block = sequence[i];
           if (block && block.returnVar) {
               outputValues[block.returnVar] = d.result !== undefined ? JSON.stringify(d.result).replace(/,/g, ';') : '';
           }
        });
      }

      const inputCols = variables.map(v => row[v] || '');
      const outputCols = returnVars.map(v => outputValues[v] || '');
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
      // Resolves every '#var' in a block's params via `getValue(varName)`, casting to a number
      // when the schema says int/float and throwing a clear error (via `describeVar`) if the
      // value is missing or not a valid number. Shared by per-sample rows, batch steps (which
      // pull from the batch group's first row via `groupFirstRowValue` below), and Prep/Cleanup blocks
      // (which pull from the Fixed Values panel) — all "resolve this #var from some source",
      // just a different source and a different missing-value message per case.
      const resolveArgs = (block: any, getValue: (varName: string) => any, describeVar: (varName: string) => string) => {
          const args = JSON.parse(JSON.stringify(block.params || {}));
          const walk = (obj: any, schemaObj: any) => {
              Object.keys(obj).forEach(key => {
                  const val = obj[key];
                  let pData = null;
                  if (schemaObj?.parameters?.[key]) pData = schemaObj.parameters[key];
                  else if (schemaObj?.fields?.[key]) pData = schemaObj.fields[key];

                  if (typeof val === 'string' && val.startsWith('#')) {
                      const varName = val.substring(1).trim();
                      if (varName === '') {
                          throw new Error(`A parameter uses '#' with no variable name — fix it in the Designer before running.`);
                      }
                      if (liveInputVars.has(varName)) return; // resolved live on the edge server, leave as '#varName'
                      let subVal: any = getValue(varName);
                      if (subVal === undefined || subVal === null || subVal === '') {
                          throw new Error(`Missing value for ${describeVar(varName)}`);
                      }

                      const typeHint = (pData?.type || '').toLowerCase();
                      if (typeHint.includes('int') || typeHint.includes('float')) {
                          if (isNaN(Number(subVal))) {
                              throw new Error(`${describeVar(varName)} expects a number (${pData?.type}), got '${subVal}'`);
                          }
                          subVal = Number(subVal);
                      }
                      obj[key] = subVal;
                  } else if (typeof val === 'object' && val !== null) {
                      walk(val, pData);
                  }
              });
          };
          walk(args, block.schema);
          return args;
      };

      const resolveGlobalBlock = (block: any) => ({
          instrument: block.instrument,
          method: block.method,
          params: resolveArgs(block, v => globalValues[v], v => `global value '${v}'`),
          returnVar: block.returnVar
      });

      // A batch step's value still comes from the spreadsheet — but strictly from the group's
      // FIRST row, not "whichever row happens to have it." This has to be a hard rule, not a
      // best-effort scan: the table visually mutes every other row in the group as "not used for
      // this row," and that label has to be literally true, or filling in a later row instead of
      // the first would silently work anyway and make the muted styling a lie.
      const groupFirstRowValue = (groupRows: Record<string, any>[], varName: string) => groupRows[0]?.[varName];

      const fullSequence: any[] = [];

      if (variables.length > 0) {
        // Row-based execution, chunked into batch groups of `batchSize` rows by plain row
        // POSITION (not "whichever rows happen to have data") — this has to match the table's
        // display exactly (group boundaries, the "1/batch" designated row), or the two silently
        // drift apart the way they did before. Within each group, the sequence is walked once: a
        // per-sample step expands into one call per active row IN THAT GROUP (blank rows in the
        // group are just skipped, same leniency as before), a batch step fires exactly once for
        // the whole group, reading its value from the group's literal first row. The group loop
        // then repeats for the next group — e.g. 24 rows with batch size 4 runs the per-sample/
        // batch walk 6 times, 4 rows each, not once for all 24.
        const isRowActive = (row: Record<string, any>) => Object.values(row).some(v => v !== undefined && v !== null && v !== '');
        if (!rows.some(isRowActive)) {
            setExecutionState({ isRunning: false, currentRow: -1, results: [] });
            alert("No active rows to execute.");
            return;
        }
        const groupSize = Math.max(1, parseInt(batchSize) || rows.length);
        const groups: { rows: Record<string, any>[]; start: number }[] = [];
        for (let g = 0; g < rows.length; g += groupSize) {
            const slice = rows.slice(g, g + groupSize);
            if (slice.some(isRowActive)) groups.push({ rows: slice, start: g }); // drop groups that are entirely blank (e.g. unused trailing rows)
        }

        try {
          for (let gi = 0; gi < groups.length; gi++) {
            const { rows: groupRows, start: groupStart } = groups[gi];
            // Numbered by raw position (Math.floor(groupStart / groupSize) + 1), not by index among
            // the non-blank groups, so this always matches the "Batch N" label shown in the table.
            const groupDesc = groups.length > 1 ? `batch ${Math.floor(groupStart / groupSize) + 1} (rows ${groupStart + 1}-${groupStart + groupRows.length})` : 'the batch';
            for (let i = 0; i < sequence.length; i++) {
              const block = sequence[i];
              if (block.isBatchAction) {
                fullSequence.push({
                  instrument: block.instrument,
                  method: block.method,
                  params: resolveArgs(block, v => groupFirstRowValue(groupRows, v), v => `'${v}' for ${groupDesc} — fill it in on the first row of that group (row ${groupStart + 1})`),
                  originalRow: groupStart,
                  originalBlockIndex: i
                });
                continue;
              }
              for (let r = 0; r < groupRows.length; r++) {
                const rowData = groupRows[r];
                if (!isRowActive(rowData)) continue; // unused row within the group — nothing to run for it
                const rowIndex = groupStart + r;
                fullSequence.push({
                  instrument: block.instrument,
                  method: block.method,
                  params: resolveArgs(block, v => rowData[v], v => `'${v}' in row ${rowIndex + 1}`),
                  originalRow: rowIndex,
                  originalBlockIndex: i
                });
              }
            }
          }
        } catch (err: any) {
            alert(err.message);
            setExecutionState({ isRunning: false, currentRow: -1, results: [] });
            return;
        }
      } else {
        // No spreadsheet variables — run sequence once as-is
        for (let i = 0; i < sequence.length; i++) {
          const block = sequence[i];
          fullSequence.push({
            instrument: block.instrument,
            method: block.method,
            params: JSON.parse(JSON.stringify(block.params || {})),
            originalRow: 0,
            originalBlockIndex: i
          });
        }
      }

      let resolvedPrep: any[] = [];
      let resolvedCleanup: any[] = [];
      try {
          resolvedPrep = prepSequence.map(resolveGlobalBlock);
          resolvedCleanup = cleanupSequence.map(resolveGlobalBlock);
      } catch (err: any) {
          alert(err.message);
          setExecutionState({ isRunning: false, currentRow: -1, results: [] });
          return;
      }

      // Submit
      const payload = {
        name: await buildRunName(`${localStorage.getItem('ivoryos_editing_workflow') || 'Spreadsheet'} Run`, experimentName, API_BASE),
        parameters: {
          type: variables.length > 0 ? 'Spreadsheet' : 'Simple',
          variables,
          rows: variables.length > 0 ? rows.filter(row => Object.values(row).some(v => v !== undefined && v !== null && v !== '')) : [],
          // Records which step (by position within one row's block sequence) is tagged with a
          // returnVar, so Data History can later match a row's output back to a named column —
          // the persisted run otherwise has no way to tell which step produced "the" result.
          sequence_template: sequence.map(b => ({ instrument: b.instrument, method: b.method, returnVar: b.returnVar || null }))
        },
        prep: resolvedPrep,
        sequence: fullSequence.map(s => ({
          instrument: s.instrument,
          method: s.method,
          params: s.params
        })),
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
      alert(`Error starting execution: ${e.message}`);
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

  // Maps each row to its position among "active" (non-blank) rows, or -1 if the row is blank —
  // mirrors executeSpreadsheet()'s activeRows filter so the group divider/muted-cell hints line
  // up with the groups that will actually run, even if a blank row sits in the middle.
  const hasBatchStep = sequence.some(b => b.isBatchAction);
  // Grouping is by plain row position, not by "which rows happen to have data yet" — a fresh,
  // still-empty spreadsheet has to show its batch grouping immediately (5 rows, batch size 4
  // must show a group boundary before row 5 right away), not only once the user starts typing.
  // executeSpreadsheet() below chunks the same way, for the same reason the batch resolver was
  // just made strict about "first row of the group": the display and the real behavior must
  // always agree, or a hint like "not used for this row" becomes actively misleading.
  const groupSize = Math.max(1, parseInt(batchSize) || rows.length);

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {/* Sidebar */}
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      {/* Main Area */}
      <div className="flex-1 flex flex-col relative z-0">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-3 px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 className="text-base font-medium text-gray-800 dark:text-gray-200">Spreadsheet Editor</h2>
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
            <div className="bg-white dark:bg-black/40 rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden shadow-sm dark:shadow-none">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-gray-50 dark:bg-white/5 border-b border-gray-200 dark:border-white/10 text-xs tracking-wider text-gray-500 dark:text-gray-400 font-semibold">
                            <th className="p-3 w-16 text-center">Row</th>
                            {variables.map(v => (
                                <th key={v} className="p-3 border-l border-gray-200 dark:border-white/10">
                                  <div className="flex flex-col">
                                    <div className="flex items-center gap-1">
                                      <span>{v}</span>
                                      {batchVariables.includes(v) && (
                                        <span title="Batch step value — only needs to be filled in on one row per batch group" className="inline-flex items-center gap-0.5 text-[9px] font-bold text-teal-600 dark:text-teal-400 bg-teal-50 dark:bg-teal-500/10 px-1 py-0.5 rounded normal-case">
                                          <Layers className="w-2.5 h-2.5" /> 1/batch
                                        </span>
                                      )}
                                    </div>
                                    {varTypes[v] && <span className="text-[10px] text-gray-400 dark:text-gray-500 font-normal normal-case">{varTypes[v]}</span>}
                                  </div>
                                </th>
                            ))}
                            <th className="p-3 w-28 text-center border-l border-gray-200 dark:border-white/10">Action</th>
                        </tr>
                    </thead>
                    <DragDropContext onDragEnd={onDragEnd}>
                        <Droppable droppableId="spreadsheet-rows">
                            {(provided) => (
                                <tbody {...provided.droppableProps} ref={provided.innerRef}>
                                    {rows.map((row, idx) => {
                                      const isGroupStart = hasBatchStep && rows.length > groupSize && idx > 0 && idx % groupSize === 0;
                                      const groupNumber = isGroupStart ? Math.floor(idx / groupSize) + 1 : null;
                                      return (
                                        <Draggable key={`row-${idx}`} draggableId={`row-${idx}`} index={idx}>
                                            {(provided) => (
                                                <tr
                                                    ref={provided.innerRef}
                                                    {...provided.draggableProps}
                                                    className={`border-b border-gray-100 dark:border-white/5 bg-white dark:bg-transparent hover:bg-gray-50 dark:hover:bg-white/[0.02] ${isGroupStart ? 'border-t-2 border-t-teal-300 dark:border-t-teal-700/60' : ''}`}
                                                >
                                                    <td className="p-3 border-l border-gray-100 dark:border-white/5">
                                                        <div className="flex items-center justify-center space-x-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-grab" {...provided.dragHandleProps}>
                                                            <GripVertical className="w-4 h-4" />
                                                            <div className="flex flex-col items-center leading-none">
                                                              <span className="text-sm font-medium">{idx + 1}</span>
                                                              {groupNumber && <span className="text-[8px] font-bold text-teal-600 dark:text-teal-400 uppercase tracking-wider mt-0.5">Batch {groupNumber}</span>}
                                                            </div>
                                                        </div>
                                                    </td>
                                                    {variables.map(v => {
                                                      const isBatchVar = batchVariables.includes(v);
                                                      const isDesignatedRow = !isBatchVar || idx % groupSize === 0;
                                                      return (
                                                        <td key={v} className="p-2 border-l border-gray-100 dark:border-white/5">
                                                            {varOptions[v] ? (
                                                                <select
                                                                    value={row[v] || ''}
                                                                    onChange={(e) => updateRow(idx, v, e.target.value)}
                                                                    className="w-full bg-transparent border-b border-transparent hover:border-gray-300 focus:border-indigo-500 dark:hover:border-white/20 dark:focus:border-indigo-500 px-2 py-1 text-sm outline-none transition-colors cursor-pointer"
                                                                >
                                                                    <option value="" disabled>Select {v}</option>
                                                                    {varOptions[v].map(opt => <option key={String(opt)} value={String(opt)}>{String(opt)}</option>)}
                                                                </select>
                                                            ) : (
                                                                <input
                                                                    type="text"
                                                                    value={row[v] || ''}
                                                                    onChange={(e) => updateRow(idx, v, e.target.value)}
                                                                    placeholder={isDesignatedRow ? `Enter ${v}...` : 'not used for this row'}
                                                                    title={isInvalidNumericCell(v, row[v]) ? `Expects a number (${varTypes[v]})` : (isDesignatedRow ? undefined : `Only needed once per batch group — this row's value (if any) is ignored.`)}
                                                                    className={`w-full border-b px-2 py-1 text-sm outline-none transition-colors ${
                                                                      isInvalidNumericCell(v, row[v])
                                                                        ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-500/50'
                                                                        : isDesignatedRow
                                                                          ? 'bg-transparent border-transparent hover:border-gray-300 focus:border-indigo-500 dark:hover:border-white/20 dark:focus:border-indigo-500'
                                                                          : 'bg-gray-50 dark:bg-white/[0.03] border-transparent text-gray-400 dark:text-gray-600 italic placeholder:text-gray-300 dark:placeholder:text-gray-600 hover:border-gray-200 focus:border-gray-300'
                                                                    }`}
                                                                />
                                                            )}
                                                        </td>
                                                      );
                                                    })}
                                                    <td className="p-3 text-center border-l border-gray-100 dark:border-white/5">
                                                        <button onClick={() => removeRow(idx)} disabled={rows.length === 1} className="text-gray-400 hover:text-red-500 disabled:opacity-50">
                                                            <Trash2 className="w-4 h-4 mx-auto" />
                                                        </button>
                                                    </td>
                                                </tr>
                                            )}
                                        </Draggable>
                                      );
                                    })}
                                    {provided.placeholder}
                                </tbody>
                            )}
                        </Droppable>
                    </DragDropContext>
                </table>
                <div className="p-3 bg-gray-50 dark:bg-white/5 border-t border-gray-200 dark:border-white/10">
                    <button onClick={addRow} className="flex items-center space-x-2 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 px-2 py-1">
                        <Plus className="w-4 h-4" />
                        <span>Add Row</span>
                    </button>
                </div>
            </div>
          )}

          {(variables.length > 0 || globalVariables.length > 0) && (
            <div className="flex flex-col items-end pt-4 gap-2">
              <div className="flex items-center gap-2">
                {sequence.some(b => b.isBatchAction) && (
                  <div className="flex items-center gap-2" title="How many spreadsheet rows make up one batch. Batch steps run once per group of this many rows instead of once per row.">
                    <Layers className="w-4 h-4 text-teal-600 dark:text-teal-400" />
                    <label className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider whitespace-nowrap">Batch Size</label>
                    <input
                      type="number"
                      min="1"
                      placeholder={String(rows.length)}
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
              </div>
              <button
                  onClick={() => {
                      if (hasPendingRuns) {
                          if (!confirm("A task is already running. Add this sequence to the execution queue?")) return;
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
    </div>
  );
}
