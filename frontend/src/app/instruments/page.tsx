"use client";
import { API_BASE } from '@/config';

import { useState, useEffect, useRef } from 'react';
import { Sun, Moon, Info, Search } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { ResultView, confirmDialog } from '@ivoryos/shared-ui';
import { WS_BASE } from '@/config';

type LogEntry = {
  time: string;
  key: string;
  result: any;
  status: 'success' | 'error';
};

export default function InstrumentsPage() {
  const [statusData, setStatusData] = useState<any>(null);
  const [formValues, setFormValues] = useState<Record<string, any>>({});
  const [executing, setExecuting] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<any[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [activeTab, setActiveTab] = useState<string>('');
  // The log used to be a fixed 160px strip, which is fine for "Executed successfully" and far too
  // short for a structured result — the thing you ran the method to read scrolled inside a box two
  // lines tall. Drag its top edge; the size is remembered.
  const [logHeight, setLogHeight] = useState(176);
  const logHeightRef = useRef(logHeight);
  logHeightRef.current = logHeight;
  const dragFrom = useRef<{ y: number; h: number } | null>(null);
  // Which required fields a method is missing, keyed 'instrument.method' -> dotted param paths.
  // Populated on a blocked Execute and cleared per field as it is filled.
  const [missingArgs, setMissingArgs] = useState<Record<string, string[]>>({});
  const [methodSearch, setMethodSearch] = useState('');
  // Manual instrument actions bypass the queue and drive hardware directly. If a workflow is
  // mid-run, firing one can collide with whatever the run is doing — legacy IvoryOS made you
  // confirm the override first, so this page watches the queue for the same reason.
  const [busyState, setBusyState] = useState<{ running: boolean; paused: boolean }>({ running: false, paused: false });

  useEffect(() => {
    // Theme init
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');

    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => {
        setStatusData(data);
        setBusyState({ running: !!data.active_workflow_id, paused: !!data.queue_paused });
        if (data.instruments && Object.keys(data.instruments).length > 0) {
          setActiveTab(Object.keys(data.instruments)[0]);
        }
      })
      .catch(err => console.error(err));

    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const run = data.active_run;
        const busy = !!(run && ['running', 'pausing', 'waiting_input', 'cancelling'].includes(run.status));
        const paused = !!(run && run.status === 'paused') || !!data.status?.queue_paused;
        setBusyState({ running: busy, paused });
      } catch (e) { }
    };
    return () => ws.close();
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const handleInputChange = (instrument: string, method: string, param: string, value: any) => {
    const key = `${instrument}.${method}`;
    // Filling a field answers its complaint; leaving the marker up until the next Execute makes
    // the form feel like it is arguing with you.
    setMissingArgs(prev => {
      const forKey = prev[key];
      if (!forKey || !forKey.includes(param)) return prev;
      const next = forKey.filter(p => p !== param);
      if (next.length) return { ...prev, [key]: next };
      const rest = { ...prev };
      delete rest[key];
      return rest;
    });
    setFormValues(prev => {
      const existing = prev[key] || {};
      // A dotted path (e.g. 'config.mode') means this belongs to a nested object parameter —
      // build/merge the nested structure rather than storing a literal 'config.mode' key.
      if (param.includes('.')) {
        const keys = param.split('.');
        const newParams = JSON.parse(JSON.stringify(existing));
        let curr = newParams;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!curr[keys[i]]) curr[keys[i]] = {};
          curr = curr[keys[i]];
        }
        curr[keys[keys.length - 1]] = value;
        return { ...prev, [key]: newParams };
      }
      return { ...prev, [key]: { ...existing, [param]: value } };
    });
  };

  /** The bits of an introspected parameter this form needs; the schema carries more. */
  type ParamSchema = {
    required?: boolean;
    default?: unknown;
    is_object?: boolean;
    fields?: Record<string, ParamSchema>;
  };

  const handleExecute = async (instrument: string, method: string) => {
    const key = `${instrument}.${method}`;
    const methodSchema = statusData?.instruments?.[instrument]?.[method] || { parameters: {} };
    const rawArgs = formValues[key] || {};
    
    // Fill defaults and collect *every* missing required field, not just the first. Reporting
    // them one at a time turns a four-field form into four rejected attempts.
    const argsToSubmit: Record<string, unknown> = {};
    const missing: string[] = [];

    const walk = (schemaParams: Record<string, ParamSchema>, values: Record<string, unknown> | undefined, prefix: string, sink: Record<string, unknown>) => {
      for (const [paramName, pData] of Object.entries(schemaParams || {})) {
        const path = prefix ? `${prefix}.${paramName}` : paramName;
        let val: unknown = values?.[paramName];

        if (pData?.is_object && pData?.fields) {
          const nested: Record<string, unknown> = {};
          walk(pData.fields, val as Record<string, unknown> | undefined, path, nested);
          sink[paramName] = nested;
          continue;
        }

        if (val === undefined || val === '') {
          if (pData?.default !== undefined) {
            val = pData.default;
          } else if (pData?.required) {
            missing.push(path);
            continue;
          } else {
            continue;
          }
        }
        sink[paramName] = val;
      }
    };

    walk(methodSchema.parameters, rawArgs, '', argsToSubmit);

    if (missing.length > 0) {
      // Marked on the fields themselves rather than announced. alert() is a silent no-op in the
      // desktop app's webview, so this check was invisible there and a browser popup everywhere
      // else — neither of which shows you *which* box to go fill in.
      setMissingArgs(prev => ({ ...prev, [key]: missing }));
      return;
    }
    setMissingArgs(prev => {
      if (!prev[key]) return prev;
      const rest = { ...prev };
      delete rest[key];
      return rest;
    });

    if (busyState.running || busyState.paused) {
      const state = busyState.running ? 'running a workflow' : 'paused mid-workflow';
      // confirmDialog, not confirm(): the native one returns false immediately in the webview, so
      // this override could never be granted there — the run was simply dropped.
      const proceed = await confirmDialog(
        `The platform is currently ${state}. Running "${key}" by hand now could conflict with it.`,
        { title: 'Override and run anyway?', confirmLabel: 'Run anyway', tone: 'danger' },
      );
      if (!proceed) return;
    }

    setExecuting(prev => ({ ...prev, [key]: true }));

    // Push a "Started" log
    const logId = Date.now().toString();
    setLogs(prev => [...prev, {
      id: logId,
      time: new Date().toLocaleTimeString(),
      key,
      result: "Task dispatched...",
      status: 'started'
    }]);

    try {
      const res = await fetch(`${API_BASE}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: instrument, method: method, args: argsToSubmit })
      });
      
      const initData = await res.json();

      if (initData.error) {
        setLogs(prev => prev.map(log => log.id === logId ? {
          ...log,
          time: new Date().toLocaleTimeString(),
          result: initData.error,
          status: 'error'
        } : log));
        return;
      }

      const taskId = initData.task_id;
      let finalData = initData;

      if (taskId) {
        while (true) {
          await new Promise(r => setTimeout(r, 500));
          const pollRes = await fetch(`${API_BASE}/api/execute/${taskId}`);
          const pollData = await pollRes.json();
          
          if (pollData.status === 'completed' || pollData.status === 'error') {
            finalData = pollData;
            break;
          }
        }
      }

      setLogs(prev => prev.map(log => log.id === logId ? {
        ...log,
        time: new Date().toLocaleTimeString(),
        result: finalData.status === 'error' ? (finalData.error || finalData.result) : finalData,
        status: finalData.status === 'error' ? 'error' : 'success'
      } : log));
    } catch (err: any) {
      setLogs(prev => prev.map(log => log.id === logId ? {
        ...log,
        time: new Date().toLocaleTimeString(),
        result: err.message,
        status: 'error'
      } : log));
    } finally {
      setExecuting(prev => ({ ...prev, [key]: false }));
    }
  };

  const clampLogHeight = (h: number) =>
    Math.min(Math.max(h, 96), typeof window === 'undefined' ? 600 : window.innerHeight * 0.75);

  useEffect(() => {
    const saved = Number(localStorage.getItem('ivoryos_log_height'));
    if (saved) setLogHeight(clampLogHeight(saved));
  }, []);

  // Listeners on window, not the handle: a fast drag outruns the 6px grip and the resize would
  // stop dead the moment the pointer left it.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragFrom.current) return;
      e.preventDefault();
      setLogHeight(clampLogHeight(dragFrom.current.h + (dragFrom.current.y - e.clientY)));
    };
    const onUp = () => {
      if (!dragFrom.current) return;
      dragFrom.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('ivoryos_log_height', String(logHeightRef.current));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  if (!statusData) return <div className="p-8 text-gray-900 dark:text-white bg-gray-50 dark:bg-[#0a0a0a] min-h-screen">Loading instruments...</div>;

  const instruments = statusData.instruments || {};

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {/* Sidebar */}
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden bg-gray-100 dark:bg-transparent">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 className="text-base font-medium text-gray-800 dark:text-gray-200">Connected Instruments</h2>
          <div className="ml-auto flex items-center gap-3">
            {(busyState.running || busyState.paused) && (
              <span className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-500/30">
                {busyState.running ? 'Workflow running' : 'Workflow paused'}
              </span>
            )}
            <div className="relative w-56">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <input
                type="text"
                value={methodSearch}
                onChange={e => setMethodSearch(e.target.value)}
                placeholder="Search methods..."
                className="w-full pl-9 pr-3 py-2 bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-lg text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>
        </header>

        <div className="flex-1 flex min-h-0">
          {Object.entries(instruments).length === 0 ? (
            <div className="p-8 text-gray-500 dark:text-gray-400">No instruments detected. Ensure they are initialized before calling ivoryos_edge.run().</div>
          ) : (
            <>
              {/* A rail, not a tab strip. Instruments are a list that grows with the lab, and a
                  horizontal strip either wraps or scrolls sideways once there are a dozen of them.
                  Vertical is also where the Designer already puts them, so the two pages agree on
                  where you go to pick a device. */}
              <nav className="w-52 shrink-0 border-r border-gray-200 dark:border-white/10 overflow-y-auto bg-white/60 dark:bg-white/[0.02] py-3">
                {Object.keys(instruments).map(instName => (
                  <button
                    key={instName}
                    onClick={() => setActiveTab(instName)}
                    className={`w-full flex items-center justify-between gap-2 text-left px-4 py-2 text-sm transition-colors capitalize border-l-2 ${
                      activeTab === instName
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-700 font-semibold dark:bg-indigo-500/10 dark:text-indigo-300'
                        : 'border-transparent text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-200'
                    }`}
                  >
                    <span className="truncate">{instName.replace(/_/g, ' ')}</span>
                    <span className="shrink-0 text-[10px] font-normal text-gray-400 dark:text-gray-600">
                      {Object.keys(instruments[instName] || {}).length}
                    </span>
                  </button>
                ))}
              </nav>

              <div className="flex-1 min-w-0 overflow-y-auto p-8 space-y-6">
              {/* Active instrument */}
              {activeTab && instruments[activeTab] && (() => {
                const query = methodSearch.trim().toLowerCase();
                const visibleMethods = Object.entries(instruments[activeTab]).filter(([methodName, methodData]: [string, any]) =>
                  !query ||
                  methodName.toLowerCase().replace(/_/g, ' ').includes(query) ||
                  (methodData.description || '').toLowerCase().includes(query)
                );
                if (visibleMethods.length === 0) {
                  return (
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      No methods on <span className="font-semibold">{activeTab.replace(/_/g, ' ')}</span> match &ldquo;{methodSearch}&rdquo;.
                    </div>
                  );
                }
                return (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {visibleMethods.map(([methodName, methodData]: [string, any]) => {
                    const instName = activeTab;
                    const key = `${instName}.${methodName}`;
                    return (
                      <div key={methodName} className="p-5 rounded-2xl bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 flex flex-col shadow-sm dark:shadow-none">
                        <div className="flex items-center justify-between mb-5">
                          <div className="flex items-center space-x-2">
                            <h4 className="font-semibold text-indigo-600 dark:text-indigo-400 break-all capitalize">{methodName.replace(/_/g, ' ')}</h4>
                            {methodData.description && (
                              <div className="relative group">
                                <Info className="w-4 h-4 text-gray-400 hover:text-indigo-500 cursor-help" />
                                <div className="hidden group-hover:block absolute left-1/2 -translate-x-1/2 top-full mt-2 w-64 p-3 bg-gray-900 text-white dark:bg-white dark:text-gray-900 text-xs rounded-lg shadow-xl z-50 whitespace-pre-wrap max-h-48 overflow-y-auto">
                                  {methodData.description}
                                </div>
                              </div>
                            )}
                          </div>
                          {methodData.is_coroutine && <span className="text-[10px] bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">Async</span>}
                        </div>
                        
                        <div className="flex-1 space-y-3 mb-5">
                          {(() => {
                            const renderParamField = (pData: any, paramPath: string, paramLabel: string): React.ReactNode => {
                              if (pData.is_object && pData.fields) {
                                return (
                                  <div key={paramPath} className="space-y-2">
                                    <span className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider capitalize break-all">{paramLabel}</span>
                                    <div className="space-y-2 pl-3 border-l-2 border-gray-200 dark:border-white/10">
                                      {Object.entries(pData.fields).map(([subKey, subData]) => renderParamField(subData, `${paramPath}.${subKey}`, subKey))}
                                    </div>
                                  </div>
                                );
                              }

                              const displayType = (pData.type || '').replace(/<class '([^']+)'>/, '$1').replace('typing.', '');
                              const isMissing = (missingArgs[key] || []).includes(paramPath);
                              const fieldBorder = isMissing
                                ? 'border-red-400 dark:border-red-500/60 focus:border-red-500'
                                : 'border-gray-300 dark:border-white/10 focus:border-indigo-500';
                              const currentValue = paramPath.split('.').reduce((acc: any, part: string) => acc && acc[part] !== undefined ? acc[part] : undefined, formValues[key]);

                              return (
                                <div key={paramPath} className="space-y-1">
                                  <label className={`text-[11px] capitalize flex items-start font-medium mb-1 ${isMissing ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}`}>
                                    <span className="break-all">{paramLabel}</span>
                                    {pData.required && <span className="text-red-500/80 dark:text-red-400/70 ml-1 text-sm leading-none shrink-0">*</span>}
                                  </label>
                                  {displayType.includes('bool') ? (
                                    <select
                                      value={currentValue !== undefined ? currentValue.toString() : (pData.default !== undefined ? pData.default.toString() : '')}
                                      className={`w-full bg-gray-50 dark:bg-black/40 border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none transition-colors text-gray-900 dark:text-white ${fieldBorder}`}
                                      onChange={(e) => handleInputChange(instName, methodName, paramPath, e.target.value === 'true')}
                                    >
                                      <option value="">Select boolean...</option>
                                      <option value="true">True</option>
                                      <option value="false">False</option>
                                    </select>
                                  ) : (
                                    <>
                                      <input
                                        type={displayType.includes('int') || displayType.includes('float') ? 'number' : 'text'}
                                        step={displayType.includes('float') ? 'any' : '1'}
                                        // Enum / Literal parameters know their accepted values, so offer them as
                                        // suggestions instead of leaving the operator to guess the spelling.
                                        list={pData.options ? `inst-opts-${key}-${paramPath}` : undefined}
                                        value={currentValue !== undefined ? currentValue : (pData.default !== undefined ? pData.default : '')}
                                        className={`w-full bg-gray-50 dark:bg-black/40 border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none transition-colors text-gray-900 dark:text-white ${fieldBorder}`}
                                        placeholder={displayType}
                                        onChange={(e) => {
                                          let val: any = e.target.value;
                                          if (displayType.includes('int') || displayType.includes('float')) {
                                            if (val !== '' && !isNaN(Number(val))) val = Number(val);
                                          }
                                          handleInputChange(instName, methodName, paramPath, val);
                                        }}
                                      />
                                      {pData.options && (
                                        <datalist id={`inst-opts-${key}-${paramPath}`}>
                                          {pData.options.map((opt: any) => (
                                            <option key={String(opt)} value={String(opt)} />
                                          ))}
                                        </datalist>
                                      )}
                                    </>
                                  )}
                                  {isMissing && (
                                    <p className="text-[10px] font-medium text-red-600 dark:text-red-400">Required</p>
                                  )}
                                </div>
                              );
                            };

                            return Object.entries(methodData.parameters).map(([param, pData]: [string, any]) => renderParamField(pData, param, param));
                          })()}
                        </div>

                        <div className="mt-auto">
                          {(missingArgs[key] || []).length > 0 && (
                            <p className="mb-2 text-[11px] text-red-600 dark:text-red-400">
                              Fill in {(missingArgs[key] || []).length === 1
                                ? 'the required field'
                                : `${(missingArgs[key] || []).length} required fields`} above.
                            </p>
                          )}
                          <button 
                            onClick={() => handleExecute(instName, methodName)}
                            disabled={executing[key]}
                            className={`w-full py-2 text-sm rounded-lg font-medium transition-all shadow-sm ${
                              executing[key] 
                                ? 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400 cursor-not-allowed' 
                                : 'bg-gray-100 hover:bg-indigo-600 hover:text-white dark:bg-white/10 dark:hover:bg-indigo-600 text-gray-700 dark:text-white border border-gray-200 dark:border-transparent'
                            }`}
                          >
                            {executing[key] ? 'Executing...' : 'Execute'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                );
              })()}
              </div>
            </>
          )}
        </div>

        {/* Action log. A flex sibling rather than an absolutely-positioned overlay, so resizing it
            gives the content above the space back instead of hiding underneath it. */}
        <div
          style={{ height: logHeight }}
          className="shrink-0 bg-white/95 dark:bg-black/90 border-t border-gray-200 dark:border-white/10 backdrop-blur-2xl flex flex-col z-50 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] dark:shadow-none"
        >
          <div
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize the log"
            onMouseDown={e => {
              e.preventDefault();
              dragFrom.current = { y: e.clientY, h: logHeightRef.current };
              // Set on body, not the handle: without this the drag selects text across the page
              // and the cursor flickers back to default whenever it leaves the grip.
              document.body.style.cursor = 'ns-resize';
              document.body.style.userSelect = 'none';
            }}
            onDoubleClick={() => {
              const next = clampLogHeight(logHeight > 200 ? 176 : Math.round(window.innerHeight * 0.5));
              setLogHeight(next);
              localStorage.setItem('ivoryos_log_height', String(next));
            }}
            className="group h-1.5 -mt-1.5 shrink-0 cursor-ns-resize flex items-center justify-center"
          >
            <span className="h-0.5 w-10 rounded-full bg-gray-300 dark:bg-white/20 group-hover:bg-indigo-400 transition-colors" />
          </div>
          <header className="h-10 shrink-0 border-b border-gray-200 dark:border-white/5 flex items-center justify-between px-4 bg-white/80 dark:bg-black/20 backdrop-blur-md">
            <h3 className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest">Action Log</h3>
            <button onClick={() => setLogs([])} className="text-[10px] font-semibold text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-white uppercase tracking-wider">Clear</button>
          </header>
          <div className="flex-1 p-4 overflow-y-auto space-y-2 font-mono text-xs flex flex-col-reverse">
            {logs.length === 0 ? (
              <div className="text-gray-500 dark:text-gray-600 italic">No actions executed yet.</div>
            ) : (
              [...logs].reverse().map((log, i) => (
                <div key={i} className="flex flex-col text-gray-700 dark:text-gray-300 items-start border-b border-gray-100 dark:border-white/5 pb-2 mb-2 last:border-0 last:mb-0 last:pb-0">
                  <div className="flex w-full space-x-3 items-center mb-1">
                    <span className="text-gray-400 dark:text-gray-600 shrink-0 text-[10px]">[{log.time}]</span>
                    <span className="text-indigo-600 dark:text-indigo-400 font-semibold truncate flex-1" title={log.key}>{log.key}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-bold ${
                      log.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : 
                      log.status === 'started' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                      'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    }`}>
                      {log.status === 'error' ? 'Error' : log.status === 'started' ? 'Running' : 'Success'}
                    </span>
                  </div>
                  {/* Capped, not full-bleed. On a wide screen a key/value row stretched the
                      whole window, so the label and its value ended up a screen apart with a
                      hand-span of dotted leader between them. */}
                  <div className="w-full max-w-2xl pl-[52px] pr-4 break-words leading-tight text-gray-600 dark:text-gray-400 text-[11px]">
                    {log.result?.task_id && (
                      <span className="text-[9px] text-gray-400 dark:text-gray-600 block mb-1">Task ID: {log.result.task_id}</span>
                    )}
                    {log.status === 'error' ? (
                      <span className="text-red-600 dark:text-red-400">{log.result?.error || log.result?.message || (typeof log.result === 'string' ? log.result : 'Unknown Error')}</span>
                    ) : log.status === 'started' ? (
                      <span className="text-yellow-600 dark:text-yellow-400 animate-pulse">{log.result}</span>
                    ) : (
                      <span>
                        {/* The poll response is {status, result}. This read `return_value`, a key
                            the server has never sent, so every successful action rendered the
                            fallback and the method's actual output was thrown away. */}
                        {log.result?.status === 'queued'
                          ? 'Task queued in background...'
                          : log.result?.result === undefined || log.result?.result === null
                            ? 'Executed successfully (no value returned).'
                            : <ResultView value={log.result.result} />}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
