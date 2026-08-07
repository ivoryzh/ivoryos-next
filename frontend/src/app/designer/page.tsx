"use client";
import { API_BASE, WS_BASE } from '@/config';

import { useState, useEffect, useRef } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { Play, GripVertical, Trash2, Settings2, ChevronDown, ChevronUp, Sun, Moon, Save, Code, Download, LayoutTemplate, X, Zap } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

type SequenceBlock = {
  id: string;
  instrument: string;
  method: string;
  schema: any;
  params: Record<string, any>;
  isExpanded?: boolean;
  returnVar?: string;
};

export default function DesignerPage() {
  const [statusData, setStatusData] = useState<any>(null);
  const [sequence, setSequence] = useState<SequenceBlock[]>([]);
  const [executionState, setExecutionState] = useState<{
    isRunning: boolean;
    currentIndex: number;
    results: Record<string, any>;
  }>({
    isRunning: false,
    currentIndex: -1,
    results: {}
  });
  
  const [expandedToolbox, setExpandedToolbox] = useState<Record<string, boolean>>({});
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [viewMode, setViewMode] = useState<'canvas' | 'code'>('canvas');
  const [instrumentMeta, setInstrumentMeta] = useState<Record<string, any>>({});
  const [showOptimizer, setShowOptimizer] = useState(false);
  const [optConfig, setOptConfig] = useState<any>({
    budget: 5,
    optimizer: 'baybe',
    error_recovery: 'stop',
    bounds: {},
    objectives: {}
  });

  const exportJSON = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(sequence, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    dlAnchorElem.setAttribute("download", "ivoryos_sequence.json");
    dlAnchorElem.click();
  };

  const generatePythonCode = () => {
    let code = "";
    let instruments = Array.from(new Set(sequence.map(s => s.instrument)));
    
    // Generate real imports for the instances directly
    if (instruments.length > 0) {
        // Group by module
        const moduleGroups: Record<string, string[]> = {};
        instruments.forEach(inst => {
            const meta = instrumentMeta[inst];
            const mod = meta ? meta.module : 'hardware';
            if (!moduleGroups[mod]) moduleGroups[mod] = [];
            moduleGroups[mod].push(inst);
        });
        
        Object.entries(moduleGroups).forEach(([mod, insts]) => {
            code += `from ${mod} import ${insts.join(', ')}\n`;
        });
        code += "\n";
    }
    
    code += "def run_workflow():\n";
    
    if (sequence.length === 0) {
      code += "    pass\n";
    }

    sequence.forEach((block) => {
      let params = Object.entries(block.params).map(([k, v]) => {
         if (typeof v === 'string' && !v.startsWith('#')) return `${k}="${v}"`;
         return `${k}=${v}`;
      }).join(', ');
      
      let returnStr = block.returnVar ? `${block.returnVar} = ` : "";
      code += `    ${returnStr}${block.instrument}.${block.method}(${params})\n`;
    });
    
    code += "\nif __name__ == '__main__':\n    run_workflow()\n";
    return code;
  };

  // Fetch status on mount
  useEffect(() => {
    // Theme init
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    
    // Load saved sequence if exists
    const savedSeq = localStorage.getItem('ivoryos_sequence');
    if (savedSeq) {
      try {
        setSequence(JSON.parse(savedSeq));
      } catch (e) {
        console.error("Failed to parse saved sequence", e);
      }
    }

    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => {
        setStatusData(data);
        if (data.instrument_meta) setInstrumentMeta(data.instrument_meta);
        
        // Initialize toolbox state (all collapsed)
        const insts: Record<string, boolean> = {};
        if (data.instruments) {
          Object.keys(data.instruments).forEach(k => insts[k] = false);
        }
        setExpandedToolbox(insts);
      })
      .catch(err => console.error(err));
  }, []);

  // Save sequence on change
  useEffect(() => {
    localStorage.setItem('ivoryos_sequence', JSON.stringify(sequence));
  }, [sequence]);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const onDragEnd = (result: DropResult) => {
    const { source, destination } = result;
    if (!destination) return;

    if (source.droppableId === 'toolbox' && destination.droppableId === 'canvas') {
      const [instrument, method] = result.draggableId.split('::');
      const methodSchema = statusData.instruments[instrument][method];
      
      const defaultParams: Record<string, any> = {};
      if (methodSchema.parameters) {
        Object.entries(methodSchema.parameters).forEach(([key, param]: [string, any]) => {
            if (param.default !== undefined) {
                defaultParams[key] = param.default;
            }
        });
      }

      const newBlock: SequenceBlock = {
        id: `block-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        instrument,
        method,
        schema: methodSchema,
        params: defaultParams,
        returnVar: ""
      };

      const newSequence = Array.from(sequence);
      newSequence.splice(destination.index, 0, newBlock);
      setSequence(newSequence);
      return;
    }

    if (source.droppableId === 'canvas' && destination.droppableId === 'canvas') {
      const newSequence = Array.from(sequence);
      const [removed] = newSequence.splice(source.index, 1);
      newSequence.splice(destination.index, 0, removed);
      setSequence(newSequence);
    }
  };

  const handleParamChange = (blockId: string, param: string, value: any, type: string) => {
    setSequence(prev => prev.map(block => {
      if (block.id !== blockId) return block;
      let parsedValue = value;
      // Do not cast to Number if it's a dynamic variable string (starts with #)
      if (typeof value === 'string' && !value.startsWith('#')) {
        if (type.includes('bool')) {
          if (value.toLowerCase() === 'true') parsedValue = true;
          else if (value.toLowerCase() === 'false') parsedValue = false;
        } else if (type.includes('int') || type.includes('float')) {
          if (!isNaN(Number(value)) && value !== '') {
            parsedValue = Number(value);
          }
        }
      }
      return { ...block, params: { ...block.params, [param]: parsedValue } };
    }));
  };

  const handleReturnVarChange = (blockId: string, value: string) => {
    setSequence(prev => prev.map(block => {
      if (block.id !== blockId) return block;
      return { ...block, returnVar: value };
    }));
  };

  const toggleExpand = (blockId: string) => {
    setSequence(prev => prev.map(block => 
      block.id === blockId ? { ...block, isExpanded: !block.isExpanded } : block
    ));
  };

  const toggleToolbox = (instName: string) => {
    setExpandedToolbox(prev => ({ ...prev, [instName]: !prev[instName] }));
  };

  const removeBlock = (index: number) => {
    setSequence(prev => {
      const next = [...prev];
      next.splice(index, 1);
      return next;
    });
  };

  const saveWorkflow = async () => {
    const name = prompt("Enter a name for this workflow:");
    if (!name) return;

    // Convert sequence to Legacy IvoryOS JSON
    const legacyFormat = {
      prep: [],
      script: sequence.map((block, idx) => {
        const argTypes: Record<string, string> = {};
        for (const [key, paramObj] of Object.entries(block.schema.parameters)) {
            argTypes[key] = (paramObj as any).type || "str";
        }
        
        return {
          id: idx + 1,
          uuid: Math.floor(Math.random() * 1000000000), // Random int UUID
          instrument: block.instrument,
          action: block.method,
          args: block.params,
          arg_types: argTypes,
          return: block.returnVar || "",
          batch_action: false,
          consolidate_batch_args: false
        };
      }),
      cleanup: []
    };

    try {
      const res = await fetch(`${API_BASE}/api/workflows/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(legacyFormat)
      });
      const data = await res.json();
      if (data.status === 'success') {
        alert("Workflow saved to Library!");
      } else {
        alert("Failed to save workflow: " + data.error);
      }
    } catch (e: any) {
      alert("Network error: " + e.message);
    }
  };

  const runSequence = async () => {
    if (sequence.length === 0) return;

    // Validate required parameters
    for (const block of sequence) {
      if (block.schema?.parameters) {
        for (const [key, param] of Object.entries(block.schema.parameters)) {
          if (block.params[key] === undefined || block.params[key] === '') {
            alert(`Missing parameter '${key}' in ${block.instrument}.${block.method}`);
            return;
          }
        }
      }
    }

    setExecutionState({ isRunning: false, currentIndex: -1, results: {} });

    try {
      // 1. Submit Sequence to Edge Queue
      const payload = {
        name: "Designer Run",
        parameters: { type: 'Sequence' },
        sequence: sequence.map(s => ({
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
         setExecutionState({ isRunning: false, currentIndex: -1, results: {} });
      } else {
         throw new Error(data.error || 'Failed to add to queue');
      }
    } catch (e: any) {
      setExecutionState({
        isRunning: false,
        currentIndex: -1,
        results: {}
      });
      alert(`Error starting execution: ${e.message}`);
    }
  };

  if (!statusData) return <div className="p-8 text-gray-900 dark:text-white bg-gray-50 dark:bg-[#0a0a0a] min-h-screen">Loading designer...</div>;

  const instruments = statusData.instruments || {};

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {/* Sidebar */}
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      {/* Main Designer Area */}
      <DragDropContext onDragEnd={onDragEnd}>
        <div className="flex-1 flex overflow-hidden">
          
          {/* Toolbox (Left) */}
          <div className="w-72 border-r border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 flex flex-col z-10">
            <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
              <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300">Toolbox</h2>
            </header>
            
            <Droppable droppableId="toolbox" isDropDisabled={true}>
              {(provided) => (
                <div ref={provided.innerRef} {...provided.droppableProps} className="flex-1 overflow-y-auto p-4 space-y-4">
                  {Object.entries(instruments).map(([instName, schema]: [string, any]) => (
                    <div key={instName} className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden bg-gray-50 dark:bg-white/[0.02]">
                      <button 
                        onClick={() => toggleToolbox(instName)}
                        className="w-full px-4 py-2 flex items-center justify-between bg-white dark:bg-white/5 hover:bg-gray-50 dark:hover:bg-white/10 transition-colors border-b border-gray-200 dark:border-white/5"
                      >
                        <span className="text-xs font-bold text-gray-700 dark:text-gray-300 tracking-wider capitalize">{instName.replace(/_/g, ' ')}</span>
                        {expandedToolbox[instName] ? <ChevronUp className="w-3 h-3 text-gray-500" /> : <ChevronDown className="w-3 h-3 text-gray-500" />}
                      </button>
                      
                      {expandedToolbox[instName] && (
                        <div className="p-2 space-y-2">
                          {Object.keys(schema).map((methodName, idx) => (
                            <Draggable key={`${instName}::${methodName}`} draggableId={`${instName}::${methodName}`} index={idx}>
                              {(provided, snapshot) => (
                                <div
                                  ref={provided.innerRef}
                                  {...provided.draggableProps}
                                  {...provided.dragHandleProps}
                                  className={`p-2.5 rounded-md border flex items-center space-x-3 text-sm
                                    ${snapshot.isDragging 
                                      ? 'bg-blue-100 dark:bg-blue-600 border-blue-300 dark:border-blue-500 shadow-xl' 
                                      : 'bg-white dark:bg-white/5 border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10'}`}
                                >
                                  <Settings2 className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400 shrink-0" />
                                  <span className="font-medium text-gray-700 dark:text-gray-200 truncate">{methodName.replace(/_/g, ' ')}</span>
                                </div>
                              )}
                            </Draggable>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </div>

          {/* Sequence Canvas (Right) */}
          <div className="flex-1 flex flex-col bg-gray-100 dark:bg-[#0f0f0f] relative">
            <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
              <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300">Execution Sequence</h2>
              <div className="flex items-center space-x-3">
                <button 
                  onClick={saveWorkflow}
                  disabled={sequence.length === 0}
                  className={`flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all ${
                    sequence.length === 0
                      ? 'bg-gray-200 text-gray-400 dark:bg-gray-800 dark:text-gray-500 cursor-not-allowed'
                      : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10'
                  }`}
                >
                  <Save className="w-4 h-4" />
                  <span>Save</span>
                </button>
                <button 
                  onClick={exportJSON}
                  disabled={sequence.length === 0}
                  className={`flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all ${
                    sequence.length === 0
                      ? 'bg-gray-200 text-gray-400 dark:bg-gray-800 dark:text-gray-500 cursor-not-allowed'
                      : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10'
                  }`}
                >
                  <Download className="w-4 h-4" />
                  <span>Export JSON</span>
                </button>
                <button 
                  onClick={() => setViewMode(viewMode === 'canvas' ? 'code' : 'canvas')}
                  className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10"
                >
                  {viewMode === 'canvas' ? <Code className="w-4 h-4 text-indigo-500" /> : <LayoutTemplate className="w-4 h-4 text-indigo-500" />}
                  <span>{viewMode === 'canvas' ? 'View Python' : 'Back to Designer'}</span>
                </button>
                {(() => {
                  const hasDynamicParams = sequence.some(block => 
                    Object.values(block.params).some(val => typeof val === 'string' && val.startsWith('#'))
                  );
                  return (
                    <>
                    <button 
                      onClick={hasDynamicParams ? () => window.location.href = '/execution' : runSequence}
                      disabled={sequence.length === 0}
                      className={`flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all ${
                        sequence.length === 0
                          ? 'bg-gray-200 text-gray-400 dark:bg-gray-800 dark:text-gray-500 cursor-not-allowed'
                          : hasDynamicParams
                            ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-md'
                            : 'bg-green-600 hover:bg-green-700 dark:hover:bg-green-500 text-white shadow-md'
                      }`}
                    >
                      {hasDynamicParams ? <Settings2 className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                      <span>{hasDynamicParams ? 'Configure Execution' : 'Add to Queue'}</span>
                    </button>
                    {hasDynamicParams && sequence.some(s => s.returnVar) && (
                      <button 
                        onClick={() => setShowOptimizer(true)}
                        className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-purple-600 hover:bg-purple-700 text-white shadow-md"
                      >
                        <Zap className="w-4 h-4" />
                        <span>Optimize</span>
                      </button>
                    )}
                    </>
                  );
                })()}
              </div>
            </header>
            {viewMode === 'code' ? (
                <div className="flex-1 overflow-auto p-8 bg-gray-900 text-gray-100 font-mono text-sm">
                    <pre className="p-6 rounded-xl bg-black/50 border border-white/10 shadow-inner">
                        <code>{generatePythonCode()}</code>
                    </pre>
                </div>
            ) : (
            <Droppable droppableId="canvas">
              {(provided, snapshot) => (
                <div 
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className={`flex-1 overflow-y-auto p-6 ${snapshot.isDraggingOver ? 'bg-blue-50/50 dark:bg-white/[0.02]' : ''}`}
                >
                  {sequence.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 border-2 border-dashed border-gray-300 dark:border-white/10 rounded-2xl">
                      <Settings2 className="w-10 h-10 mb-4 opacity-30" />
                      <p className="text-sm font-medium">Drag methods from the toolbox to build a sequence.</p>
                    </div>
                  ) : (
                    <div className="max-w-4xl mx-auto space-y-2 pb-48">
                      {sequence.map((block, index) => {
                        const isExpanded = block.isExpanded !== false;
                        
                        let borderClass = 'border-gray-200 dark:border-white/10';
                        let bgClass = 'bg-white dark:bg-black/40';
                        
                        return (
                          <Draggable key={block.id} draggableId={block.id} index={index}>
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                className={`rounded-xl border ${borderClass} ${bgClass} shadow-sm overflow-hidden transition-all ${
                                  snapshot.isDragging ? 'shadow-xl ring-2 ring-blue-500 scale-[1.02]' : ''
                                }`}
                              >
                                  {/* Top Row: Info & Controls */}
                                  <div className="flex items-center justify-between bg-gray-50/50 dark:bg-white/[0.02] border-b border-gray-100 dark:border-white/5 h-10">
                                    <div className="flex items-center h-full">
                                      <div {...provided.dragHandleProps} className="px-3 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-white cursor-grab h-full flex items-center border-r border-gray-100 dark:border-white/5">
                                        <GripVertical className="w-4 h-4" />
                                      </div>
                                      <div className="flex items-center space-x-2 px-3 overflow-hidden">
                                        <span className="text-[10px] font-bold px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 rounded capitalize whitespace-nowrap">
                                          {block.instrument.replace(/_/g, ' ')}
                                        </span>
                                        <span className="text-sm font-medium text-gray-800 dark:text-gray-100 whitespace-nowrap">{block.method.replace(/_/g, ' ')}</span>
                                      </div>
                                      {block.schema.return_type !== 'None' && (
                                        <div className="flex items-center space-x-2 px-3 border-l border-gray-100 dark:border-white/5 h-full">
                                          <label className="text-[9px] text-purple-600 dark:text-purple-400 font-bold tracking-wider uppercase">
                                            Return:
                                          </label>
                                          <input
                                            type="text"
                                            value={block.returnVar || ''}
                                            placeholder="var_name"
                                            onChange={(e) => handleReturnVarChange(block.id, e.target.value)}
                                            className="w-24 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-500/30 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-purple-500 text-purple-900 dark:text-purple-100 placeholder-purple-300 dark:placeholder-purple-700"
                                          />
                                        </div>
                                      )}
                                    </div>
                                    <div className="px-3 flex items-center space-x-3 border-l border-gray-100 dark:border-white/5 h-full">

                                      <button onClick={() => removeBlock(index)} className="text-gray-400 hover:text-red-500 dark:hover:text-red-400 p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/10 transition-colors">
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    </div>
                                  </div>

                                  {/* Bottom Row: Params */}
                                  <div className="p-2 px-3 flex flex-wrap gap-x-4 gap-y-2 items-center bg-white dark:bg-transparent min-h-[3rem]">
                                    {Object.keys(block.schema.parameters).length === 0 ? (
                                      <span className="text-xs text-gray-500 dark:text-gray-600 italic">No parameters required.</span>
                                    ) : (
                                      Object.entries(block.schema.parameters).map(([param, pData]: [string, any]) => (
                                        <div key={param} className="flex flex-col space-y-0.5 shrink-0">
                                          <label className="text-[10px] text-gray-500 dark:text-gray-400 capitalize font-medium flex items-center space-x-1">
                                            <span>{param.replace(/_/g, ' ')}</span>
                                            {pData.required && <span className="text-red-500/80 text-[8px] uppercase">Req</span>}
                                          </label>
                                          <input
                                            type="text"
                                            value={block.params[param] !== undefined ? block.params[param] : ''}
                                            placeholder={pData.type}
                                            onChange={(e) => handleParamChange(block.id, param, e.target.value, pData.type)}
                                            className="w-28 bg-gray-50 dark:bg-black/60 border border-gray-300 dark:border-white/10 rounded px-2 py-0.5 text-xs focus:outline-none focus:border-blue-500 dark:focus:border-blue-500 text-gray-800 dark:text-white"
                                          />
                                        </div>
                                      ))
                                    )}
                                  </div>
                              </div>
                            )}
                          </Draggable>
                        );
                      })}
                      {provided.placeholder}
                    </div>
                  )}
                </div>
              )}
            </Droppable>
            )}


          </div>
        </div>
      </DragDropContext>

      {/* Optimizer Sidebar */}
      {showOptimizer && (
        <div className="w-80 bg-white dark:bg-[#111111] border-l border-gray-200 dark:border-white/10 flex flex-col h-[calc(100vh-48px)] mt-12 fixed right-0 top-0 shadow-2xl z-40 transition-all">
          <div className="p-4 border-b border-gray-100 dark:border-white/5 flex items-center justify-between">
            <h2 className="text-sm font-bold text-gray-800 dark:text-white flex items-center">
              <Zap className="w-4 h-4 mr-2 text-purple-500" />
              Optimizer Settings
            </h2>
            <button onClick={() => setShowOptimizer(false)} className="p-1 hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg text-gray-500">
              <X className="w-4 h-4" />
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {(() => {
               const vars = Array.from(new Set(sequence.flatMap(s => Object.values(s.params)).filter(v => typeof v === 'string' && v.startsWith('#')).map((v: any) => v.slice(1))));
               const returns = Array.from(new Set(sequence.map(s => s.returnVar).filter(Boolean)));
               
               return (
                 <>
            <div>
               <h3 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-3 pb-2 border-b border-gray-100 dark:border-white/5">General Settings</h3>
               <div className="space-y-4">
                 <div>
                   <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Optimizer Engine</label>
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
                   <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Evaluation Budget</label>
                   <input 
                      type="number" 
                      min="1" max="1000"
                      value={optConfig.budget}
                      onChange={e => setOptConfig({...optConfig, budget: parseInt(e.target.value) || 1})}
                      className="w-full bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm focus:border-purple-500 outline-none"
                   />
                 </div>
                 <div>
                   <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Error Recovery</label>
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

            <div>
               <h3 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-3 pb-2 border-b border-gray-100 dark:border-white/5">Search Space</h3>
               {vars.length === 0 ? (
                   <div className="text-xs text-gray-500">No dynamic variables (e.g. #x) found in sequence.</div>
               ) : (
                   <div className="space-y-3">
                     {vars.map(v => (
                       <div key={v} className="bg-gray-50/50 dark:bg-white/[0.02] p-3 rounded-lg border border-gray-100 dark:border-white/5 space-y-2">
                         <div className="flex items-center justify-between">
                             <span className="font-mono text-sm font-bold text-blue-500">#{v}</span>
                             <select 
                                value={optConfig.bounds[v]?.type || 'range'}
                                onChange={e => setOptConfig({...optConfig, bounds: {...optConfig.bounds, [v]: {...optConfig.bounds[v], type: e.target.value}}})}
                                className="bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded px-2 py-1 text-xs outline-none"
                             >
                                <option value="range">Range</option>
                                <option value="choice">Choice</option>
                             </select>
                         </div>
                         <div className="flex space-x-2">
                             <input 
                                type="text" 
                                placeholder={optConfig.bounds[v]?.type === 'choice' ? "e.g. 10, 20" : "Min"}
                                value={optConfig.bounds[v]?.min || ''}
                                onChange={e => setOptConfig({...optConfig, bounds: {...optConfig.bounds, [v]: {...optConfig.bounds[v], min: e.target.value}}})}
                                className="flex-1 bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                             />
                             {optConfig.bounds[v]?.type !== 'choice' && (
                               <input 
                                  type="text" 
                                  placeholder="Max"
                                  value={optConfig.bounds[v]?.max || ''}
                                  onChange={e => setOptConfig({...optConfig, bounds: {...optConfig.bounds, [v]: {...optConfig.bounds[v], max: e.target.value}}})}
                                  className="flex-1 bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                               />
                             )}
                         </div>
                       </div>
                     ))}
                   </div>
               )}
            </div>

            <div>
               <h3 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-3 pb-2 border-b border-gray-100 dark:border-white/5">Objectives</h3>
               {returns.length === 0 ? (
                   <div className="text-xs text-gray-500">No return variables assigned in sequence.</div>
               ) : (
                   <div className="space-y-3">
                     {returns.map((v: any) => (
                       <div key={v} className="flex flex-col space-y-2 bg-gray-50/50 dark:bg-white/[0.02] p-3 rounded-lg border border-gray-100 dark:border-white/5">
                         <span className="font-mono text-sm font-bold text-green-500 truncate flex-1">{v}</span>
                         <select 
                            value={optConfig.objectives[v]?.goal || 'maximize'}
                            onChange={e => setOptConfig({...optConfig, objectives: {...optConfig.objectives, [v]: {...optConfig.objectives[v], goal: e.target.value}}})}
                            className="bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded px-2 py-1.5 text-xs outline-none focus:border-green-500 w-full"
                         >
                            <option value="maximize">Maximize</option>
                            <option value="minimize">Minimize</option>
                         </select>
                       </div>
                     ))}
                   </div>
               )}
            </div>
                 </>
               );
            })()}
          </div>
          
          <div className="p-4 border-t border-gray-100 dark:border-white/5 bg-gray-50 dark:bg-black/20">
             <button 
                  onClick={async () => {
                      const vars = Array.from(new Set(sequence.flatMap(s => Object.values(s.params)).filter(v => typeof v === 'string' && v.startsWith('#')).map((v: any) => v.slice(1))));
                      const paramSpace = vars.map((v: any) => {
                          const b = optConfig.bounds[v] || {};
                          if (b.type === 'choice') {
                              return { name: v, type: 'choice', bounds: (b.min || "").split(",").map((s: string) => {
                                  const n = parseFloat(s.trim());
                                  return isNaN(n) ? s.trim() : n;
                              }) };
                          }
                          return { name: v, type: 'range', bounds: [parseFloat(b.min || "0"), parseFloat(b.max || "1")] };
                      });
                      
                      const returns = Array.from(new Set(sequence.map(s => s.returnVar).filter(Boolean)));
                      const objConfig = returns.map((v: any) => ({
                          name: v, minimize: optConfig.objectives[v]?.goal === 'minimize'
                      }));
                      
                      const payload = {
                          name: "Optimization Run",
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
                              setShowOptimizer(false);
                              window.location.href = '/queue';
                          } else {
                              alert("Failed: " + data.error);
                          }
                      } catch(e: any) {
                          alert("Error: " + e.message);
                      }
                  }}
                 className="w-full flex items-center justify-center space-x-2 px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors font-bold text-sm shadow-lg shadow-purple-500/20"
             >
                 <Zap className="w-4 h-4" />
                 <span>Start Optimization</span>
             </button>
          </div>
        </div>
      )}

    </div>
  );
}
