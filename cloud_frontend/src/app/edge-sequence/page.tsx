"use client";


import { useState, useEffect, useRef } from 'react';
import { Play, Trash2, Settings2, Sun, Moon, Save, Code, Download, Upload, LayoutTemplate, X, Zap, AlertTriangle, Menu } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { WorkflowEditor, SequenceBlock, PythonCodeView, generatePythonCode } from '@ivoryos/shared-ui';

export default function DesignerPage() {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [statusData, setStatusData] = useState<any>(null);
  const [prepSequence, setPrepSequence] = useState<SequenceBlock[]>([]);
  const [sequence, setSequence] = useState<SequenceBlock[]>([]);
  const [cleanupSequence, setCleanupSequence] = useState<SequenceBlock[]>([]);
  const [currentWorkflowName, setCurrentWorkflowName] = useState<string>('');
  const [isUnsaved, setIsUnsaved] = useState(false);
  const isInitialMount = useRef(true);
  const [currentWorkflowDescription, setCurrentWorkflowDescription] = useState<string>('');
  const [executionState, setExecutionState] = useState<{
    isRunning: boolean;
    currentIndex: number;
    results: Record<string, any>;
  }>({
    isRunning: false,
    currentIndex: -1,
    results: {}
  });
  
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [viewMode, setViewMode] = useState<'canvas' | 'code'>('canvas');
  const [hasPendingRuns, setHasPendingRuns] = useState(false);
  const [instrumentMeta, setInstrumentMeta] = useState<Record<string, any>>({});
  const [isOffline, setIsOffline] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        
        // Auto-migrate legacy sequence format
        const migrateBlocks = (blocks: any[]): SequenceBlock[] => {
          return blocks.map(b => ({
            id: String(b.uuid || b.id || Math.random()),
            instrument: b.instrument ? b.instrument.replace('deck.', '') : 'unknown',
            method: b.action || b.method || 'unknown',
            params: b.args || b.params || {},
            returnVar: b.return || b.returnVar || '',
            schema: {},
            isExpanded: false
          }));
        };

        let newPrep, newSeq, newClean, name = '';

        if (json.script_dict) {
          // Legacy format detected
          newPrep = migrateBlocks(json.script_dict.prep || []);
          newSeq = migrateBlocks(json.script_dict.script || []);
          newClean = migrateBlocks(json.script_dict.cleanup || []);
          name = json.name || '';
        } else {
          // New format
          newPrep = json.prep || [];
          newSeq = json.sequence || json.script || [];
          newClean = json.cleanup || [];
          name = json.name || '';
        }

        setPrepSequence(newPrep);
        setSequence(newSeq);
        setCleanupSequence(newClean);
        if (name) setCurrentWorkflowName(name);
        if (json.description) setCurrentWorkflowDescription(json.description);

      } catch (error) {
        console.error("Failed to parse JSON file", error);
        alert("Failed to parse JSON file.");
      }
      
      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    };
    reader.readAsText(file);
  };

  const exportJSON = () => {
    const payload = {
      name: currentWorkflowName,
      description: currentWorkflowDescription,
      prep: prepSequence,
      script: sequence,
      cleanup: cleanupSequence
    };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(payload, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    dlAnchorElem.setAttribute("download", "ivoryos_sequence.json");
    dlAnchorElem.click();
  };


  // Fetch status on mount
  useEffect(() => {
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
        console.error(e);
      }
    }
    const savedPrepSeq = localStorage.getItem('ivoryos_prep_sequence');
    if (savedPrepSeq) {
      try { setPrepSequence(JSON.parse(savedPrepSeq)); } catch (e) { console.error(e); }
    }
    const savedCleanupSeq = localStorage.getItem('ivoryos_cleanup_sequence');
    if (savedCleanupSeq) {
      try { setCleanupSequence(JSON.parse(savedCleanupSeq)); } catch (e) { console.error(e); }
    }
    const editingWf = localStorage.getItem('ivoryos_editing_workflow');
    if (editingWf) {
      setCurrentWorkflowName(editingWf);
    }
    const editingWfDesc = localStorage.getItem('ivoryos_editing_workflow_desc');
    if (editingWfDesc) {
      setCurrentWorkflowDescription(editingWfDesc);
    }
    const unsaved = localStorage.getItem('ivoryos_is_unsaved');
    if (unsaved === 'true') {
      setIsUnsaved(true);
    }

    const processStatusData = async (data: any) => {
        // Fetch offline workflows from local storage
        try {
            const offlineWfsStr = localStorage.getItem('ivoryos_offline_workflows');
            const offlineWfs = offlineWfsStr ? JSON.parse(offlineWfsStr) : {};

            if (!data.instruments) data.instruments = {};
            
            // Inject Flow Control
            data.instruments["Flow Control"] = {
                If_Else_Block: { description: "If / Else conditional block", parameters: { condition: { type: "str", required: true } }, return_type: "None" },
                While_Loop: { description: "While loop block", parameters: { condition: { type: "str", required: true } }, return_type: "None" },
                Sleep: { description: "Pause execution for duration (s)", parameters: { duration_seconds: { type: "float", required: true } }, return_type: "None" }
            };

            data.instruments["Library Workflows"] = {};
            
            for (const [wfName, wfJson] of Object.entries<any>(offlineWfs)) {
                const dynamicParams: any = {};
                const scanBlocks = (blocks: any[]) => {
                    blocks.forEach((b: any) => {
                        if (b.args) {
                            Object.entries(b.args).forEach(([k, val]) => {
                                if (typeof val === 'string' && val.startsWith('#')) {
                                    const paramName = val.substring(1);
                                    const paramType = (b.arg_types && b.arg_types[k]) ? b.arg_types[k] : 'string';
                                    dynamicParams[paramName] = { type: paramType, required: true };
                                }
                            });
                        }
                    });
                };
                scanBlocks(wfJson.prep || []);
                scanBlocks(wfJson.script || []);
                scanBlocks(wfJson.cleanup || []);
                
                if (wfName === editingWf) {
                    continue; // Prevent recursion by hiding current workflow
                }
                
                data.instruments["Library Workflows"][wfName] = {
                    description: "Saved Workflow from Library",
                    parameters: dynamicParams,
                    return_type: "None"
                };
            }
        } catch (e) {
            console.error("Failed to load workflows for toolbox", e);
        }

        setStatusData(data);
        if (data.instrument_meta) setInstrumentMeta(data.instrument_meta);
    };

    const urlParams = new URLSearchParams(window.location.search);
    const targetDeviceId = urlParams.get('deviceId');
    setDeviceId(targetDeviceId);

    if (targetDeviceId) {
        fetch(`/api/devices`)
          .then(res => res.json())
          .then(async (devices: any[]) => {
              const targetDevice = devices.find(d => d.id === targetDeviceId);
              if (targetDevice && targetDevice.schema) {
                  await processStatusData({ instruments: targetDevice.schema.instruments || {} });
              } else {
                  console.error(`Device ${targetDeviceId} not found or has no schema. Falling back to static schema.`);
                  throw new Error("Device not found");
              }
          })
          .catch(err => {
              console.error(err);
              fetchStaticSchema();
          });
    } else {
        fetchStaticSchema();
    }

    function fetchStaticSchema() {
        fetch(`/ivoryos_schema.json`)
          .then(res => res.json())
          .then(async data => {
              localStorage.setItem('ivoryos_cached_schema', JSON.stringify(data));
              await processStatusData(data);
          })
          .catch(err => {
              console.error("Failed to fetch schema, loading cached schema...", err);
              setIsOffline(true);
              const cached = localStorage.getItem('ivoryos_cached_schema');
              if (cached) {
                  try {
                      const data = JSON.parse(cached);
                      processStatusData(data);
                  } catch (e) {
                      setStatusData({ instruments: {} });
                  }
              } else {
                  setStatusData({ instruments: {} });
              }
          });
    }
  }, []);

  // Save sequences on change
  useEffect(() => {
    localStorage.setItem('ivoryos_sequence', JSON.stringify(sequence));
    localStorage.setItem('ivoryos_prep_sequence', JSON.stringify(prepSequence));
    localStorage.setItem('ivoryos_cleanup_sequence', JSON.stringify(cleanupSequence));
    
    if (isInitialMount.current) {
      isInitialMount.current = false;
    } else {
      setIsUnsaved(true);
      localStorage.setItem('ivoryos_is_unsaved', 'true');
    }
  }, [sequence, prepSequence, cleanupSequence, currentWorkflowName, currentWorkflowDescription]);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const clearCanvas = () => {
    if (confirm("Are you sure you want to clear the canvas? All blocks will be removed.")) {
        setSequence([]);
        setPrepSequence([]);
        setCleanupSequence([]);
        setCurrentWorkflowName("");
        setCurrentWorkflowDescription("");
        localStorage.removeItem('ivoryos_sequence');
        localStorage.removeItem('ivoryos_prep_sequence');
        localStorage.removeItem('ivoryos_cleanup_sequence');
        localStorage.removeItem('ivoryos_editing_workflow');
        localStorage.removeItem('ivoryos_editing_workflow_desc');
        localStorage.removeItem('ivoryos_is_unsaved');
        setIsUnsaved(false);
        isInitialMount.current = true;
    }
  };

  const saveWorkflow = async () => {
    let name = currentWorkflowName;
    if (!name) {
        const inputName = prompt("Enter a name for this workflow:");
        if (!inputName) return;
        name = inputName;
    }

    const formatBlocks = (blocks: SequenceBlock[]) => blocks.map((block, idx) => {
        const argTypes: Record<string, string> = {};
        if (block.schema && block.schema.parameters) {
            for (const [key, paramObj] of Object.entries(block.schema.parameters)) {
                argTypes[key] = (paramObj as any).type || "str";
            }
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
    });

    // Convert sequence to Legacy IvoryOS JSON
    const legacyFormat = {
      name: name,
      description: currentWorkflowDescription,
      prep: formatBlocks(prepSequence),
      script: formatBlocks(sequence),
      cleanup: formatBlocks(cleanupSequence)
    };

    try {
      const offlineWfsStr = localStorage.getItem('ivoryos_offline_workflows');
      const offlineWfs = offlineWfsStr ? JSON.parse(offlineWfsStr) : {};
      offlineWfs[name] = legacyFormat;
      localStorage.setItem('ivoryos_offline_workflows', JSON.stringify(offlineWfs));

      setCurrentWorkflowName(name);
      localStorage.setItem('ivoryos_editing_workflow', name);
      localStorage.setItem('ivoryos_editing_workflow_desc', currentWorkflowDescription);
      localStorage.setItem('ivoryos_is_unsaved', 'false');
      setIsUnsaved(false);
      alert("Workflow saved locally to Library!");
    } catch (e: any) {
      alert("Error saving workflow: " + e.message);
    }
  };

  
  // Finds a '#' used as a dynamic parameter with no variable name after it (e.g. '#' instead of '#temperature'),
  // searching nested object parameters too.
  const findEmptyHashName = (blocks: SequenceBlock[]): string | null => {
    const scan = (obj: any): string | null => {
      if (!obj) return null;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.trim() === '#') return k;
        if (typeof v === 'object' && v !== null) {
          const nested = scan(v);
          if (nested) return nested;
        }
      }
      return null;
    };
    for (const block of blocks) {
      const badKey = scan(block.params);
      if (badKey) return `${block.instrument}.${block.method} → ${badKey}`;
    }
    return null;
  };

  const validateSequence = () => {
    const allBlocks = [...prepSequence, ...sequence, ...cleanupSequence];

    const emptyHashLocation = findEmptyHashName(allBlocks);
    if (emptyHashLocation) {
      alert(`'#' needs a variable name after it (e.g. '#temperature'). Found an empty one in ${emptyHashLocation}.`);
      return false;
    }

    for (const block of allBlocks) {
      if (block.schema?.parameters) {
        for (const [key, param] of Object.entries(block.schema.parameters)) {
          const val = block.params[key];
          // Allow dynamic variables (strings starting with #) to pass through here, they are checked in execution/optimizer
          if (typeof val === 'string' && val.startsWith('#')) continue;

          if (val === undefined || val === '') {
            alert(`Missing parameter '${key}' in ${block.instrument}.${block.method}`);
            return false;
          }

          // A param typed int/float has to resolve to an actual number — anything else would
          // only fail once the run tries to cast it, so catch it here instead.
          const typeStr = ((param as any)?.type || '').toLowerCase();
          if ((typeStr.includes('int') || typeStr.includes('float')) && isNaN(Number(val))) {
            alert(`Parameter '${key}' in ${block.instrument}.${block.method} expects a number (or '#variable'), got '${val}'`);
            return false;
          }
        }
      }
    }
    return true;
  };

  const runSequence = async () => {
    if (!validateSequence()) return;
    if (sequence.length === 0) return;



    try {
        alert("This is an offline Sequence Editor. Export your workflow or execute it on a connected Edge instance.");
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

  return (
    <div className="h-full w-full overflow-x-auto overflow-y-hidden bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans">
    {/* This designer is a dense, desktop-oriented workspace — rather than reflow/squish its
        panes at narrow widths (which just produces overlapping, clipped controls), it holds its
        natural minimum width and the page scrolls horizontally to reach whatever's off-screen. */}
    <div className="flex h-full min-w-[900px]">
      <div className="flex-1 flex flex-col overflow-hidden w-full h-full min-w-0">
        {deviceId && (
            <div className="bg-blue-500/10 border-b border-blue-500/20 px-6 py-2 text-sm text-blue-600 dark:text-blue-400 flex justify-between items-center z-10 shrink-0">
                <span className="font-medium">Targeting Edge Device: <strong className="font-bold">{deviceId}</strong></span>
            </div>
        )}
        <WorkflowEditor
          statusData={statusData}
          prepSequence={prepSequence}
          setPrepSequence={setPrepSequence}
          sequence={sequence}
          setSequence={setSequence}
          cleanupSequence={cleanupSequence}
          setCleanupSequence={setCleanupSequence}
          header={
            <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-50 relative">
              <div className="flex flex-col justify-center flex-1 mr-4 space-y-1">
                <div className="flex items-center space-x-3">
                  <input
                    type="text"
                    value={currentWorkflowName}
                    onChange={(e) => setCurrentWorkflowName(e.target.value)}
                    placeholder="Sequence Name"
                    className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300 bg-transparent border-none focus:outline-none focus:ring-0 p-0"
                  />
                  {isUnsaved && <span className="px-1.5 py-0.5 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 text-[10px] font-bold uppercase tracking-wider">Unsaved</span>}
                  {isOffline && (
                    <span className="flex items-center space-x-1 px-1.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 text-[10px] font-bold uppercase tracking-wider border border-purple-200 dark:border-purple-500/30">
                      <AlertTriangle className="w-3 h-3" />
                      <span>Offline Mode</span>
                    </span>
                  )}
                  <div className="flex items-center space-x-1.5 pl-2 border-l border-gray-200 dark:border-white/10">
                    <button
                      onClick={saveWorkflow}
                      disabled={sequence.length === 0}
                      title="Save"
                      className="flex items-center justify-center p-1.5 rounded transition-all bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Save className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={clearCanvas}
                      title="Clear"
                      className="flex items-center justify-center p-1.5 rounded transition-all bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-500/30"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <input
                  type="text"
                  value={currentWorkflowDescription}
                  onChange={(e) => setCurrentWorkflowDescription(e.target.value)}
                  placeholder="Add a short description..."
                  className="text-xs text-gray-400 dark:text-gray-500 bg-transparent border-none focus:outline-none focus:ring-0 p-0 w-full"
                />
              </div>
              <div className="flex items-center space-x-2">

                <div className="relative group">
                  <button className="flex items-center space-x-1 px-3 py-1.5 rounded text-sm font-medium transition-all bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10">
                    <Settings2 className="w-4 h-4" />
                    <span className="hidden sm:inline">Manage</span>
                  </button>
                  <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 rounded-xl shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 overflow-hidden">
                    <button 
                      onClick={exportJSON}
                      disabled={sequence.length === 0}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
                    >
                      <Download className="w-4 h-4" />
                      <span>Export JSON</span>
                    </button>
                    <button 
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5 flex items-center space-x-2 border-t border-gray-100 dark:border-white/5"
                    >
                      <Upload className="w-4 h-4" />
                      <span>Import JSON</span>
                    </button>
                  </div>
                </div>

                <input
                  type="file"
                  accept=".json"
                  className="hidden"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                />

                <button 
                  onClick={() => setViewMode(viewMode === 'canvas' ? 'code' : 'canvas')}
                  className="flex items-center space-x-1 px-3 py-1.5 rounded text-sm font-medium transition-all bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10"
                >
                  {viewMode === 'canvas' ? <Code className="w-4 h-4 text-indigo-500" /> : <LayoutTemplate className="w-4 h-4 text-indigo-500" />}
                  <span className="hidden sm:inline">{viewMode === 'canvas' ? 'Python' : 'Back'}</span>
                </button>
                {(() => {
                  const allBlocks = [...prepSequence, ...sequence, ...cleanupSequence];
                  const hasDynamicParams = allBlocks.some(block => 
                    Object.values(block.params).some(val => typeof val === 'string' && val.startsWith('#'))
                  );
                  return (
                    <>
                    <button 
                      onClick={() => {
                        if (!validateSequence()) return;
                        if (hasPendingRuns) {
                            if (!confirm("A task is already running. Add this sequence to the execution queue?")) {
                                return;
                            }
                        }
                        if (hasDynamicParams) window.location.href = '/execution';
                        else runSequence();
                      }}
                      disabled={sequence.length === 0}
                      className={`flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all ${
                        sequence.length === 0
                          ? 'bg-gray-50 text-gray-400 border border-gray-200 dark:bg-gray-900/30 dark:border-gray-800 dark:text-gray-600 cursor-not-allowed'
                          : hasDynamicParams
                            ? 'bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 dark:bg-blue-900/30 dark:border-blue-500/30 dark:text-blue-300 dark:hover:bg-blue-900/50 shadow-sm'
                            : 'bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 dark:bg-green-900/30 dark:border-green-500/30 dark:text-green-300 dark:hover:bg-green-900/50 shadow-sm'
                      }`}
                    >
                      {hasDynamicParams ? <Settings2 className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                      <span>{hasDynamicParams ? 'Configure' : (hasPendingRuns ? 'Add to Queue' : 'Run')}</span>
                    </button>
                    {hasDynamicParams && sequence.some(s => s.returnVar) && (
                      <a 
                        href="/optimize"
                        className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100 dark:bg-purple-900/30 dark:border-purple-500/30 dark:text-purple-300 dark:hover:bg-purple-900/50"
                      >
                        <Zap className="w-4 h-4" />
                        <span>Optimize</span>
                      </a>
                    )}
                    </>
                  );
                })()}
              </div>
            </header>
          }
          customView={
            viewMode === 'code' ? (
                <PythonCodeView
                  code={generatePythonCode(prepSequence, sequence, cleanupSequence, instrumentMeta)}
                  theme={theme}
                  fileName={currentWorkflowName || 'sequence'}
                />
            ) : null
          }
        />
      </div>
    </div>
    </div>
  );
}
