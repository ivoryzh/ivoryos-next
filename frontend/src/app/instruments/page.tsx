"use client";
import { API_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

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
        if (data.instruments && Object.keys(data.instruments).length > 0) {
          setActiveTab(Object.keys(data.instruments)[0]);
        }
      })
      .catch(err => console.error(err));
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
    setFormValues(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        [param]: value
      }
    }));
  };

  const handleExecute = async (instrument: string, method: string) => {
    const key = `${instrument}.${method}`;
    const methodSchema = statusData?.instruments?.[instrument]?.[method] || { parameters: {} };
    const rawArgs = formValues[key] || {};
    
    // Fill defaults and validate
    const argsToSubmit: Record<string, any> = {};
    for (const [paramName, pData] of Object.entries(methodSchema.parameters)) {
       let val = rawArgs[paramName];
       if (val === undefined || val === '') {
           if ((pData as any).default !== undefined) {
               val = (pData as any).default;
           } else {
               alert(`Missing parameter '${paramName}'`);
               return;
           }
       }
       argsToSubmit[paramName] = val;
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

  if (!statusData) return <div className="p-8 text-gray-900 dark:text-white bg-gray-50 dark:bg-[#0a0a0a] min-h-screen">Loading instruments...</div>;

  const instruments = statusData.instruments || {};

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {/* Sidebar */}
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden bg-gray-100 dark:bg-transparent">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300 ">Connected Instruments</h2>
        </header>

        <div className="p-8 space-y-6 overflow-y-auto pb-48">
          {Object.entries(instruments).length === 0 ? (
            <div className="text-gray-500 dark:text-gray-400">No instruments detected. Ensure they are initialized before calling ivoryos_edge.run().</div>
          ) : (
            <>
              {/* Tabs */}
              <div className="flex space-x-2 border-b border-gray-200 dark:border-white/10 mb-6 overflow-x-auto">
                {Object.keys(instruments).map(instName => (
                  <button
                    key={instName}
                    onClick={() => setActiveTab(instName)}
                    className={`px-4 py-2 font-medium text-sm transition-colors border-b-2 whitespace-nowrap capitalize ${
                      activeTab === instName
                        ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                        : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                    }`}
                  >
                    {instName.replace(/_/g, ' ')}
                  </button>
                ))}
              </div>

              {/* Active Tab Content */}
              {activeTab && instruments[activeTab] && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {Object.entries(instruments[activeTab]).map(([methodName, methodData]: [string, any]) => {
                    const instName = activeTab;
                    const key = `${instName}.${methodName}`;
                    return (
                      <div key={methodName} className="p-5 rounded-2xl bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 flex flex-col shadow-sm dark:shadow-none">
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="font-semibold text-blue-600 dark:text-blue-400 truncate pr-2 capitalize">{methodName.replace(/_/g, ' ')}</h4>
                          {methodData.is_coroutine && <span className="text-[10px] bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">Async</span>}
                        </div>
                        
                        {methodData.description && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 line-clamp-2">{methodData.description}</p>
                        )}
                        
                        <div className="flex-1 space-y-3 mb-5">
                          {Object.entries(methodData.parameters).map(([param, pData]: [string, any]) => (
                            <div key={param} className="space-y-1">
                              <label className="text-[11px] text-gray-600 dark:text-gray-400 capitalize flex items-center justify-between font-medium">
                                <span>{param} <span className="text-gray-400 dark:text-gray-600 lowercase font-normal">({pData.type})</span></span>
                                {pData.required && <span className="text-red-500/80 dark:text-red-400/70 text-[9px] uppercase tracking-wider">Req</span>}
                              </label>
                              <input 
                                type="text"
                                value={formValues[key]?.[param] !== undefined ? formValues[key][param] : (pData.default !== undefined ? pData.default : '')}
                                className="w-full bg-gray-50 dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-blue-500 transition-colors text-gray-900 dark:text-white"
                                placeholder={`Enter ${param}...`}
                                onChange={(e) => {
                                  let val: any = e.target.value;
                                  if (pData.type.includes('bool')) {
                                    if (val.toLowerCase() === 'true') val = true;
                                    else if (val.toLowerCase() === 'false') val = false;
                                  } else if (pData.type.includes('int') || pData.type.includes('float')) {
                                    if (val !== '' && !isNaN(Number(val))) val = Number(val);
                                  }
                                  handleInputChange(instName, methodName, param, val);
                                }}
                              />
                            </div>
                          ))}
                        </div>

                        <div className="mt-auto">
                          <button 
                            onClick={() => handleExecute(instName, methodName)}
                            disabled={executing[key]}
                            className={`w-full py-2 text-sm rounded-lg font-medium transition-all shadow-sm ${
                              executing[key] 
                                ? 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400 cursor-not-allowed' 
                                : 'bg-gray-100 hover:bg-blue-600 hover:text-white dark:bg-white/10 dark:hover:bg-blue-600 text-gray-700 dark:text-white border border-gray-200 dark:border-transparent'
                            }`}
                          >
                            {executing[key] ? 'Executing...' : 'Execute'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Global Task / Log Bar at Bottom */}
        <div className="absolute bottom-0 left-0 right-0 h-40 bg-white/95 dark:bg-black/90 border-t border-gray-200 dark:border-white/10 backdrop-blur-2xl flex flex-col z-50 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] dark:shadow-none">
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
                    <span className="text-blue-600 dark:text-blue-400 font-semibold truncate flex-1" title={log.key}>{log.key}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-bold ${
                      log.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : 
                      log.status === 'started' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                      'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    }`}>
                      {log.status === 'error' ? 'Error' : log.status === 'started' ? 'Running' : 'Success'}
                    </span>
                  </div>
                  <div className="w-full pl-[52px] pr-4 break-words leading-tight text-gray-600 dark:text-gray-400 text-[11px]">
                    {log.result?.task_id && (
                      <span className="text-[9px] text-gray-400 dark:text-gray-600 block mb-1">Task ID: {log.result.task_id}</span>
                    )}
                    {log.status === 'error' ? (
                      <span className="text-red-600 dark:text-red-400">{log.result?.error || log.result?.message || (typeof log.result === 'string' ? log.result : 'Unknown Error')}</span>
                    ) : log.status === 'started' ? (
                      <span className="text-yellow-600 dark:text-yellow-400 animate-pulse">{log.result}</span>
                    ) : (
                      <span>{log.result?.return_value !== undefined ? JSON.stringify(log.result.return_value) : (log.result?.status === 'queued' ? 'Task queued in background...' : 'Executed successfully.')}</span>
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
