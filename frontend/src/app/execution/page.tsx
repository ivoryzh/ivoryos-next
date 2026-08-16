"use client";
import { API_BASE, WS_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Play, Plus, Trash2, Sun, Moon, Download, Upload, ArrowUp, ArrowDown, GripVertical } from 'lucide-react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import Sidebar from '@/components/Sidebar';

export default function ExecutionPage() {
  const [sequence, setSequence] = useState<any[]>([]);
  const [variables, setVariables] = useState<string[]>([]);
  const [varTypes, setVarTypes] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Record<string, any>[]>([{}]);
  
  const [executionState, setExecutionState] = useState<{
    isRunning: boolean;
    currentRow: number;
    results: any[];
  }>({ isRunning: false, currentRow: -1, results: [] });

  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [hasPendingRuns, setHasPendingRuns] = useState(false);
  const [edgeStatus, setEdgeStatus] = useState<any>(null);

  const [varOptions, setVarOptions] = useState<Record<string, any[]>>({});

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
        
        // Extract # variables and types
        const vars = new Set<string>();
        const vTypes: Record<string, string> = {};
        const vOptions: Record<string, any[]> = {};
        
        const extractVars = (obj: any, schemaObj: any) => {
            if (!obj) return;
            Object.entries(obj).forEach(([k, v]) => {
                let pData = null;
                if (schemaObj?.parameters?.[k]) pData = schemaObj.parameters[k];
                else if (schemaObj?.fields?.[k]) pData = schemaObj.fields[k];
                
                if (typeof v === 'string' && v.startsWith('#')) {
                    const varName = v.substring(1);
                    vars.add(varName);
                    
                    if (pData?.type) vTypes[varName] = pData.type;
                    if (pData?.options) vOptions[varName] = pData.options;
                } else if (typeof v === 'object' && v !== null) {
                    extractVars(v, pData);
                }
            });
        };
        
        parsedSeq.forEach((block: any) => {
            extractVars(block.params, block.schema);
        });
        const varList = Array.from(vars);
        setVariables(varList);
        setVarTypes(vTypes);
        setVarOptions(vOptions);
        
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
      } catch (e) {
        console.error("Failed to load sequence", e);
      }
    }
  }, []);

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
    if (sequence.length === 0 || variables.length === 0) return;
    
    setExecutionState({ isRunning: true, currentRow: -1, results: [] });

    try {
      const activeRows = rows.filter(row => Object.values(row).some(v => v !== undefined && v !== null && v !== ''));
      if (activeRows.length === 0) {
          setExecutionState({ isRunning: false, currentRow: -1, results: [] });
          alert("No active rows to execute.");
          return;
      }
      
      const fullSequence = [];
      // Build the unrolled sequence
      for (let r = 0; r < activeRows.length; r++) {
        const rowData = activeRows[r];
        for (let i = 0; i < sequence.length; i++) {
          const block = sequence[i];
          const args = JSON.parse(JSON.stringify(block.params || {}));
          
          const resolveArgs = (obj: any, schemaObj: any) => {
              Object.keys(obj).forEach(key => {
                  const val = obj[key];
                  let pData = null;
                  if (schemaObj?.parameters?.[key]) pData = schemaObj.parameters[key];
                  else if (schemaObj?.fields?.[key]) pData = schemaObj.fields[key];
                  
                  if (typeof val === 'string' && val.startsWith('#')) {
                      const varName = val.substring(1);
                      let subVal: any = rowData[varName];
                      if (subVal === undefined || subVal === null || subVal === '') {
                          throw new Error(`Missing value for variable '${varName}' in row ${r + 1}`);
                      }
                      
                      const typeHint = pData?.type || '';
                      if (typeHint.includes('int') || typeHint.includes('float')) {
                          if (!isNaN(Number(subVal)) && subVal !== '') subVal = Number(subVal);
                      }
                      obj[key] = subVal;
                  } else if (typeof val === 'object' && val !== null) {
                      resolveArgs(val, pData);
                  }
              });
          };
          
          try {
              resolveArgs(args, block.schema);
          } catch (err: any) {
              alert(err.message);
              setExecutionState({ isRunning: false, currentRow: -1, results: [] });
              return;
          }
          fullSequence.push({
            instrument: block.instrument,
            method: block.method,
            params: args,
            originalRow: r,
            originalBlockIndex: i
          });
        }
      }

      // Submit
      const payload = {
        name: `${localStorage.getItem('ivoryos_sequence_name') || 'Spreadsheet'} Run - ${new Date().toLocaleString()}`,
        parameters: { type: 'Spreadsheet', variables, rows: activeRows },
        sequence: fullSequence.map(s => ({
          instrument: s.instrument,
          method: s.method,
          params: s.params
        }))
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

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {/* Sidebar */}
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      {/* Main Area */}
      <div className="flex-1 flex flex-col relative z-0">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300">Spreadsheet Editor</h2>
          <div className="flex space-x-3">
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
            <button 
                onClick={() => {
                    if (hasPendingRuns) {
                        if (!confirm("A task is already running. Add this sequence to the execution queue?")) return;
                    }
                    executeSpreadsheet();
                }}
                disabled={variables.length === 0}
                className={`flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all ${
                  variables.length === 0
                    ? 'bg-gray-200 text-gray-400 dark:bg-gray-800 dark:text-gray-500 cursor-not-allowed'
                    : 'bg-green-600 hover:bg-green-700 dark:hover:bg-green-500 text-white shadow-md'
                }`}
              >
                <Play className="w-4 h-4" />
                <span>{hasPendingRuns ? 'Add to Queue' : 'Run Sequence'}</span>
              </button>
          </div>
        </header>

        <div className="p-8 flex-1 overflow-y-auto pb-48">
          {variables.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-500 dark:text-gray-400 border-2 border-dashed border-gray-300 dark:border-white/10 rounded-2xl">
              <p className="text-sm font-medium">No dynamic variables found in current sequence.</p>
              <p className="text-xs mt-2">Go to the Designer and set a parameter to #variable_name.</p>
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
                                    <span>{v}</span>
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
                                    {rows.map((row, idx) => (
                                        <Draggable key={`row-${idx}`} draggableId={`row-${idx}`} index={idx}>
                                            {(provided) => (
                                                <tr 
                                                    ref={provided.innerRef}
                                                    {...provided.draggableProps}
                                                    className="border-b border-gray-100 dark:border-white/5 bg-white dark:bg-transparent hover:bg-gray-50 dark:hover:bg-white/[0.02]"
                                                >
                                                    <td className="p-3 border-l border-gray-100 dark:border-white/5">
                                                        <div className="flex items-center justify-center space-x-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-grab" {...provided.dragHandleProps}>
                                                            <GripVertical className="w-4 h-4" />
                                                            <span className="text-sm font-medium">{idx + 1}</span>
                                                        </div>
                                                    </td>
                                                    {variables.map(v => (
                                                        <td key={v} className="p-2 border-l border-gray-100 dark:border-white/5">
                                                            {varOptions[v] ? (
                                                                <select
                                                                    value={row[v] || ''}
                                                                    onChange={(e) => updateRow(idx, v, e.target.value)}
                                                                    className="w-full bg-transparent border-b border-transparent hover:border-gray-300 focus:border-blue-500 dark:hover:border-white/20 dark:focus:border-blue-500 px-2 py-1 text-sm outline-none transition-colors cursor-pointer"
                                                                >
                                                                    <option value="" disabled>Select {v}</option>
                                                                    {varOptions[v].map(opt => <option key={String(opt)} value={String(opt)}>{String(opt)}</option>)}
                                                                </select>
                                                            ) : (
                                                                <input 
                                                                    type="text" 
                                                                    value={row[v] || ''}
                                                                    onChange={(e) => updateRow(idx, v, e.target.value)}
                                                                    placeholder={`Enter ${v}...`}
                                                                    className="w-full bg-transparent border-b border-transparent hover:border-gray-300 focus:border-blue-500 dark:hover:border-white/20 dark:focus:border-blue-500 px-2 py-1 text-sm outline-none transition-colors"
                                                                />
                                                            )}
                                                        </td>
                                                    ))}
                                                    <td className="p-3 text-center border-l border-gray-100 dark:border-white/5">
                                                        <button onClick={() => removeRow(idx)} disabled={rows.length === 1} className="text-gray-400 hover:text-red-500 disabled:opacity-50">
                                                            <Trash2 className="w-4 h-4 mx-auto" />
                                                        </button>
                                                    </td>
                                                </tr>
                                            )}
                                        </Draggable>
                                    ))}
                                    {provided.placeholder}
                                </tbody>
                            )}
                        </Droppable>
                    </DragDropContext>
                </table>
                <div className="p-3 bg-gray-50 dark:bg-white/5 border-t border-gray-200 dark:border-white/10">
                    <button onClick={addRow} className="flex items-center space-x-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 px-2 py-1">
                        <Plus className="w-4 h-4" />
                        <span>Add Row</span>
                    </button>
                </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
