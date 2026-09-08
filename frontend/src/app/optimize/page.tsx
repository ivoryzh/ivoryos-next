"use client";
import { API_BASE } from '@/config';
import { useState, useEffect } from 'react';
import { Settings2, Info, Zap, Sun, ChevronDown } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { buildRunName } from '@ivoryos/shared-ui';

const OPTIMIZER_LABELS: Record<string, string> = {
  baybe: 'BayBE',
  ax: 'Ax (BoTorch)',
  nimo: 'NIMO'
};

export default function OptimizePage() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [variables, setVariables] = useState<string[]>([]);
  const [globalVariables, setGlobalVariables] = useState<string[]>([]);
  const [varTypes, setVarTypes] = useState<Record<string, string>>({});
  const [globalValues, setGlobalValues] = useState<Record<string, string>>({});
  const [returns, setReturns] = useState<string[]>([]);
  const [sequence, setSequence] = useState<any[]>([]);
  const [prepSequence, setPrepSequence] = useState<any[]>([]);
  const [cleanupSequence, setCleanupSequence] = useState<any[]>([]);
  const [edgeStatus, setEdgeStatus] = useState<any>(null);
  const [optimizerSchemas, setOptimizerSchemas] = useState<Record<string, any>>({});
  const [optimizersLoaded, setOptimizersLoaded] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [experimentName, setExperimentName] = useState('');
  const [historyRuns, setHistoryRuns] = useState<any[]>([]);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<number[]>([]);
  const [uploadedExistingRows, setUploadedExistingRows] = useState<any[]>([]);
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [showStrategy, setShowStrategy] = useState(false);

  // Restores the last-used optimizer/budget/search-space bounds/objectives, keyed by variable
  // name — so re-running the same (or a similarly-named) sequence doesn't require re-typing
  // every min/max from scratch.
  const [optConfig, setOptConfig] = useState<any>(() => {
    let saved: any = {};
    if (typeof window !== 'undefined') {
      try {
        const raw = localStorage.getItem('ivoryos_optimize_config');
        if (raw) saved = JSON.parse(raw);
      } catch (e) { /* ignore corrupt/old saved config */ }
    }
    return {
      optimizer: saved.optimizer || '',
      budget: saved.budget ?? 10,
      batch_size: saved.batch_size ?? 1,
      error_recovery: saved.error_recovery || 'stop',
      bounds: saved.bounds || {},
      objectives: saved.objectives || {},
      optimizer_config: saved.optimizer_config || {},
      earlyStopMode: saved.earlyStopMode || 'any'
    };
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('ivoryos_optimize_config', JSON.stringify({
      optimizer: optConfig.optimizer,
      budget: optConfig.budget,
      batch_size: optConfig.batch_size,
      error_recovery: optConfig.error_recovery,
      bounds: optConfig.bounds,
      objectives: optConfig.objectives,
      optimizer_config: optConfig.optimizer_config,
      earlyStopMode: optConfig.earlyStopMode
    }));
  }, [optConfig]);

  // Builds a sensible default optimizer_config (first model choice per step) from a backend's real schema.
  const defaultOptimizerConfigFor = (schema: any) => {
    const cfg: Record<string, any> = {};
    const template = schema?.optimizer_config || {};
    Object.entries(template).forEach(([stepKey, stepDef]: [string, any]) => {
      cfg[stepKey] = { model: Array.isArray(stepDef?.model) ? stepDef.model[0] : stepDef?.model };
      if (stepDef && 'num_samples' in stepDef) cfg[stepKey].num_samples = stepDef.num_samples;
    });
    return cfg;
  };

  const selectOptimizer = (name: string) => {
    setOptConfig((prev: any) => ({
      ...prev,
      optimizer: name,
      optimizer_config: defaultOptimizerConfigFor(optimizerSchemas[name])
    }));
  };

  useEffect(() => {
    // Theme init
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');

    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => setEdgeStatus(data))
      .catch(err => console.error(err));

    fetch(`${API_BASE}/api/queue/runs`)
      .then(res => res.json())
      .then(data => {
        const optRuns = (data.runs || []).filter((r: any) => r.parameters?.type === 'Optimization');
        setHistoryRuns(optRuns);
      })
      .catch(err => console.error(err));

    fetch(`${API_BASE}/api/optimizers`)
      .then(res => res.json())
      .then(data => {
        setOptimizerSchemas(data || {});
        const names = Object.keys(data || {});
        if (names.length > 0) {
          setOptConfig((prev: any) => {
            // Keep the restored optimizer choice if it's still available; otherwise fall back.
            const chosen = prev.optimizer && names.includes(prev.optimizer)
              ? prev.optimizer
              : (names.includes('baybe') ? 'baybe' : names[0]);
            const hasSavedStrategyForChosen = chosen === prev.optimizer && prev.optimizer_config && Object.keys(prev.optimizer_config).length > 0;
            return {
              ...prev,
              optimizer: chosen,
              optimizer_config: hasSavedStrategyForChosen ? prev.optimizer_config : defaultOptimizerConfigFor(data[chosen])
            };
          });
        }
        setOptimizersLoaded(true);
      })
      .catch(err => { console.error(err); setOptimizersLoaded(true); });

    // Load sequence and extract variables
    const savedSequence = localStorage.getItem('ivoryos_sequence');
    const savedPrep = localStorage.getItem('ivoryos_prep_sequence');
    const savedCleanup = localStorage.getItem('ivoryos_cleanup_sequence');
    if (savedSequence) {
      try {
        const parsedSeq = JSON.parse(savedSequence);
        setSequence(parsedSeq);
        const pSeq = savedPrep ? JSON.parse(savedPrep) : [];
        const cSeq = savedCleanup ? JSON.parse(savedCleanup) : [];
        setPrepSequence(pSeq);
        setCleanupSequence(cSeq);

        const vTypes: Record<string, string> = {};
        const extractVars = (obj: any, schemaObj: any, targetSet: Set<string>) => {
             if (!obj) return;
             Object.entries(obj).forEach(([k, v]) => {
                let pData: any = null;
                if (schemaObj?.parameters?.[k]) pData = schemaObj.parameters[k];
                else if (schemaObj?.fields?.[k]) pData = schemaObj.fields[k];

                if (typeof v === 'string' && v.startsWith('#')) {
                    const varName = v.substring(1);
                    targetSet.add(varName);
                    if (pData?.type) vTypes[varName] = pData.type;
                } else if (typeof v === 'object' && v !== null) {
                    extractVars(v, pData, targetSet);
                }
             });
        };

        const vars = new Set<string>();
        parsedSeq.forEach((block: any) => extractVars(block.params, block.schema, vars));
        setVariables(Array.from(vars));

        const gVars = new Set<string>();
        pSeq.forEach((block: any) => extractVars(block.params, block.schema, gVars));
        cSeq.forEach((block: any) => extractVars(block.params, block.schema, gVars));
        const gVarList = Array.from(gVars);
        setGlobalVariables(gVarList);
        setVarTypes(vTypes);

        const savedGlobalValues = localStorage.getItem('ivoryos_global_values');
        if (savedGlobalValues) {
            setGlobalValues(JSON.parse(savedGlobalValues));
        } else {
            const initGVals: Record<string, string> = {};
            gVarList.forEach(v => initGVals[v] = '');
            setGlobalValues(initGVals);
        }

        const retVars = Array.from(new Set(parsedSeq.map((s: any) => s.returnVar).filter(Boolean))) as string[];
        setReturns(retVars);
      } catch (e) {
        console.error("Failed to load sequence", e);
      }
    }
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const startOptimization = async () => {
    if (isStarting) return; // guard against double-click while the request/optimizer init is in flight
    setIsStarting(true);

    // Every backend (Ax, BayBE, NIMO) requires a value_type per parameter — infer it rather
    // than force the user to pick, since getting this wrong for a 'choice' list (e.g. treating
    // "20, 25, 30" as ints when the user meant continuous floats) is easy to do by accident.
    const inferValueType = (bounds: any[]): 'int' | 'float' | 'str' => {
        if (bounds.every((b: any) => typeof b === 'number')) {
            return bounds.every((b: number) => Number.isInteger(b)) ? 'int' : 'float';
        }
        return 'str';
    };

    // A variable can be pulled out of the search space three ways: left to the optimizer
    // (default), given one fixed value used on every iteration, or — independent of that
    // Optimize/Fixed choice, via the separate "Per-Iteration" checkbox — given its own value per
    // iteration (spreadsheet-style, in the shared table) — e.g. a "vial index" that's dynamic but
    // stepped through manually rather than searched over. Per-Iteration wins if checked, since it
    // pulls the variable out of the Optimize/Fixed toggle entirely.
    const perIterationVars = variables.filter(v => isPerIteration(v));
    const remainingVars = variables.filter(v => !isPerIteration(v));
    const optimizedVars = remainingVars.filter(v => getVarMode(v) === 'optimize');
    const fixedVars = remainingVars.filter(v => getVarMode(v) === 'fixed');

    const missingFixed = fixedVars.filter(v => !optConfig.bounds[v]?.fixedValue);
    if (missingFixed.length > 0) {
        alert(`Please provide a fixed value for: ${missingFixed.join(', ')}`);
        setIsStarting(false);
        return;
    }

    const budgetCount = Math.max(1, optConfig.budget || 1);
    const incompletePerIteration = perIterationVars.filter(v =>
        Array.from({ length: budgetCount }).some((_, i) => !getIterationValue(v, i))
    );
    if (incompletePerIteration.length > 0) {
        alert(`Please fill in a value for every iteration (1-${budgetCount}) for: ${incompletePerIteration.join(', ')}`);
        setIsStarting(false);
        return;
    }

    const paramSpace = optimizedVars.map((v: any) => {
        const b = optConfig.bounds[v] || {};
        if (b.type === 'choice') {
            const bounds = (b.min || "").split(",").map((s: string) => {
                const n = parseFloat(s.trim());
                return isNaN(n) ? s.trim() : n;
            });
            return { name: v, type: 'choice', bounds, value_type: inferValueType(bounds) };
        }
        // Range bounds are always numeric here; default to 'float' rather than inferring from
        // whole-number min/max (e.g. 20-80 for a temperature range), which would otherwise
        // silently restrict a continuous parameter to integer-only values.
        return { name: v, type: 'range', bounds: [parseFloat(b.min || "0"), parseFloat(b.max || "1")], value_type: 'float' };
    });

    const objConfig = returns.map((v: any) => ({
        name: v, minimize: optConfig.objectives[v]?.goal === 'minimize'
    }));

    // Each objective can carry its own optional early-stop target; when 2+ are enabled,
    // earlyStopMode decides whether ANY one of them or ALL of them must be met to stop early.
    const earlyStopEnabledVars = returns.filter((v: string) => optConfig.objectives[v]?.earlyStop);
    const invalidEarlyStop = earlyStopEnabledVars.filter((v: string) => isNaN(parseFloat(optConfig.objectives[v]?.threshold)));
    if (invalidEarlyStop.length > 0) {
        alert(`Early stop is enabled for ${invalidEarlyStop.join(', ')} but missing a target value.`);
        setIsStarting(false);
        return;
    }
    let earlyStop: { mode: 'any' | 'all'; criteria: { metric: string; threshold: number }[] } | undefined;
    if (earlyStopEnabledVars.length > 0) {
        earlyStop = {
            mode: optConfig.earlyStopMode === 'all' ? 'all' : 'any',
            criteria: earlyStopEnabledVars.map((v: string) => ({ metric: v, threshold: parseFloat(optConfig.objectives[v]?.threshold) }))
        };
    }

    // Fixed (non-optimized) #vars get resolved to their literal value client-side, exactly like
    // Prep/Cleanup global values. Per-iteration vars can't be resolved client-side the same way —
    // the sequence_template is one shared template the backend loop reuses every iteration, so a
    // value that has to differ per iteration has to be resolved backend-side (see iteration_values
    // in the payload below); only #vars still in the search space or per-iteration are left as
    // '#name' placeholders in the template for the backend to substitute.
    const fixedValues: Record<string, string> = {};
    fixedVars.forEach(v => { fixedValues[v] = optConfig.bounds[v]?.fixedValue ?? ''; });

    const iterationValues: Record<string, string[]> = {};
    perIterationVars.forEach(v => {
        iterationValues[v] = Array.from({ length: budgetCount }, (_, i) => getIterationValue(v, i));
    });

    const resolveFixedVarsInBlock = (block: any) => {
        const args = JSON.parse(JSON.stringify(block.params || {}));
        const resolveArgs = (obj: any, schemaObj: any) => {
            Object.keys(obj).forEach(key => {
                const val = obj[key];
                let pData: any = null;
                if (schemaObj?.parameters?.[key]) pData = schemaObj.parameters[key];
                else if (schemaObj?.fields?.[key]) pData = schemaObj.fields[key];

                if (typeof val === 'string' && val.startsWith('#')) {
                    const varName = val.substring(1);
                    if (!(varName in fixedValues)) return; // still optimized — leave for the backend
                    let subVal: any = fixedValues[varName];
                    const typeHint = pData?.type || '';
                    if (typeHint.includes('int') || typeHint.includes('float')) {
                        if (subVal !== '' && !isNaN(Number(subVal))) subVal = Number(subVal);
                    }
                    obj[key] = subVal;
                } else if (typeof val === 'object' && val !== null) {
                    resolveArgs(val, pData);
                }
            });
        };
        resolveArgs(args, block.schema);
        return { instrument: block.instrument, method: block.method, params: args, returnVar: block.returnVar };
    };

    const resolveGlobalBlock = (block: any) => {
        const args = JSON.parse(JSON.stringify(block.params || {}));
        const resolveArgs = (obj: any, schemaObj: any) => {
            Object.keys(obj).forEach(key => {
                const val = obj[key];
                let pData = null;
                if (schemaObj?.parameters?.[key]) pData = schemaObj.parameters[key];
                else if (schemaObj?.fields?.[key]) pData = schemaObj.fields[key];
                
                if (typeof val === 'string' && val.startsWith('#')) {
                    const varName = val.substring(1);
                    let subVal: any = globalValues[varName];
                    if (subVal === undefined || subVal === null || subVal === '') {
                        throw new Error(`Missing global value for variable '${varName}'`);
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
        resolveArgs(args, block.schema);
        return {
            instrument: block.instrument,
            method: block.method,
            params: args,
            returnVar: block.returnVar
        };
    };

    let resolvedPrep: any[] = [];
    let resolvedCleanup: any[] = [];
    try {
        resolvedPrep = prepSequence.map(resolveGlobalBlock);
        resolvedCleanup = cleanupSequence.map(resolveGlobalBlock);
    } catch (err: any) {
        alert(err.message);
        setIsStarting(false);
        return;
    }

    const payload = {
        name: await buildRunName(`${localStorage.getItem('ivoryos_editing_workflow') || 'Optimization'} Run`, experimentName, API_BASE),
        parameters: { 
            type: "Optimization",
            optimizer: optConfig.optimizer,
            budget: optConfig.budget,
            batch_size: Math.max(1, optConfig.batch_size || 1),
            error_recovery: optConfig.error_recovery,
            optimizer_config: optConfig.optimizer_config,
            parameter_space: paramSpace,
            objective_config: objConfig,
            ...(earlyStop ? { early_stop: earlyStop } : {}),
            ...(perIterationVars.length > 0 ? { iteration_values: iterationValues } : {}),
            ...(existingData.length > 0 ? { existing_data: existingData } : {}),
            sequence_template: sequence.map(resolveFixedVarsInBlock)
        },
        prep: resolvedPrep,
        cleanup: resolvedCleanup,
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
            window.location.href = '/queue';
            // Deliberately leave isStarting true — the page is navigating away, and resetting
            // it here would let the button flash back to enabled for an instant before that happens.
        } else {
            alert("Failed: " + data.error);
            setIsStarting(false);
        }
    } catch(e: any) {
        alert("Error: " + e.message);
        setIsStarting(false);
    }
  };

  // A variable is either 'optimize' (default, left to the optimizer) or 'fixed' (one value used
  // every iteration) — that choice is a separate, independent toggle from "Per-Iteration", which
  // is a plain checkbox: checking it pulls the variable out of both of those entirely and into
  // the shared spreadsheet-style table below, one column per per-iteration variable. `excluded`
  // is the pre-existing on-disk shape (older saved configs) — read as 'fixed' for backward
  // compatibility, but never written anymore.
  const getVarMode = (v: string): 'optimize' | 'fixed' => {
    const b = optConfig.bounds[v];
    if (b?.mode === 'fixed' || b?.mode === 'optimize') return b.mode;
    return b?.excluded ? 'fixed' : 'optimize';
  };
  const setVarMode = (v: string, mode: 'optimize' | 'fixed') => {
    setOptConfig({ ...optConfig, bounds: { ...optConfig.bounds, [v]: { ...optConfig.bounds[v], mode } } });
  };
  const isPerIteration = (v: string): boolean => !!optConfig.bounds[v]?.perIteration;
  const setPerIteration = (v: string, on: boolean) => {
    setOptConfig({ ...optConfig, bounds: { ...optConfig.bounds, [v]: { ...optConfig.bounds[v], perIteration: on } } });
  };
  const getIterationValue = (v: string, i: number): string => (optConfig.bounds[v]?.iterationValues || [])[i] ?? '';
  const setIterationValue = (v: string, i: number, val: string) => {
    const current = [...(optConfig.bounds[v]?.iterationValues || [])];
    while (current.length <= i) current.push('');
    current[i] = val;
    setOptConfig({ ...optConfig, bounds: { ...optConfig.bounds, [v]: { ...optConfig.bounds[v], iterationValues: current } } });
  };

  // A past optimization run can only warm-start this one if its recorded search space and
  // objectives are exactly the ones currently configured — append_existing_data feeds the
  // DataFrame straight to the optimizer backend, so mismatched columns would silently corrupt it.
  const sameNameSet = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const sa = [...a].sort(), sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  };

  const requiredParamNames = variables.filter(v => !isPerIteration(v) && getVarMode(v) === 'optimize');

  const compatibleHistoryRuns = requiredParamNames.length === 0 || returns.length === 0 ? [] : historyRuns.filter((run: any) => {
    const paramNames = (run.parameters?.parameter_space || []).map((p: any) => p.name);
    const objNames = (run.parameters?.objective_config || []).map((o: any) => o.name);
    return sameNameSet(paramNames, requiredParamNames) && sameNameSet(objNames, returns);
  });

  // Mirrors data/page.tsx's Optimization row-extraction, but returns structured {param: value}
  // rows instead of display strings, and only completed iterations (a partial/errored iteration
  // has no objective value to seed the optimizer with).
  const extractOptimizationRows = (run: any): Record<string, any>[] => {
    const paramSpace = run.parameters?.parameter_space || [];
    const objectiveConfig = run.parameters?.objective_config || [];
    const seqTemplate = run.parameters?.sequence_template || [];
    const seqLength = seqTemplate.length;
    if (seqLength === 0) return [];
    const paramNames = paramSpace.map((p: any) => p.name);
    const objectiveNames = objectiveConfig.map((o: any) => o.name);
    const iterationCount = Math.floor((run.steps?.length || 0) / seqLength);
    const rows: Record<string, any>[] = [];
    for (let i = 0; i < iterationCount; i++) {
      const iterSteps = run.steps?.slice(i * seqLength, (i + 1) * seqLength) || [];
      if (!iterSteps.every((s: any) => s.status === 'completed')) continue;
      const row: Record<string, any> = {};
      paramNames.forEach((name: string) => {
        const step = iterSteps.find((s: any) => s.parameters && name in (s.parameters || {}));
        if (step) row[name] = step.parameters[name];
      });
      objectiveNames.forEach((name: string) => {
        const tmplIdx = seqTemplate.findIndex((t: any) => t.returnVar === name);
        const step = tmplIdx >= 0 ? iterSteps[tmplIdx] : null;
        if (step?.outputs?.result !== undefined) row[name] = step.outputs.result;
      });
      if (paramNames.every((n: string) => n in row) && objectiveNames.every((n: string) => n in row)) {
        rows.push(row);
      }
    }
    return rows;
  };

  const isSameWorkflow = (run: any): boolean => {
    const tmpl = run.parameters?.sequence_template || [];
    return tmpl.length === sequence.length && tmpl.every((t: any, i: number) =>
      t.instrument === sequence[i]?.instrument && t.method === sequence[i]?.method);
  };

  const handleUploadCSV = (file: File) => {
    setUploadError('');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || '');
        const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
        if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row.');
        const headers = lines[0].split(',').map(h => h.trim());
        const missing = [...requiredParamNames, ...returns].filter(n => !headers.includes(n));
        if (missing.length > 0) throw new Error(`CSV is missing column(s): ${missing.join(', ')}`);
        const rows = lines.slice(1).map(line => {
          const cells = line.split(',').map(c => c.trim());
          const row: Record<string, any> = {};
          headers.forEach((h, i) => {
            const raw = cells[i];
            const num = Number(raw);
            row[h] = raw !== '' && !isNaN(num) ? num : raw;
          });
          return row;
        });
        setUploadedExistingRows(rows);
        setUploadFileName(file.name);
      } catch (e: any) {
        setUploadError(e.message);
        setUploadedExistingRows([]);
        setUploadFileName('');
      }
    };
    reader.readAsText(file);
  };

  const existingData: Record<string, any>[] = [
    ...selectedHistoryIds.flatMap(id => {
      const run = historyRuns.find((r: any) => r.id === id);
      return run ? extractOptimizationRows(run) : [];
    }),
    ...uploadedExistingRows
  ];

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      <Sidebar theme={theme} toggleTheme={toggleTheme} />
      
      <div className="flex-1 flex flex-col relative z-0">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-3 px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 className="text-base font-medium text-gray-800 dark:text-gray-200">Optimization Setup</h2>
          {variables.length > 0 && returns.length > 0 && (
            <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-white/5 px-2 py-0.5 rounded-full">
              {optConfig.budget} {optConfig.budget === 1 ? 'iteration' : 'iterations'}
            </span>
          )}
        </header>

        <div className="p-8 flex-1 overflow-y-auto">
          {variables.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-500 dark:text-gray-400 border-2 border-dashed border-gray-300 dark:border-white/10 rounded-2xl relative">
              <div className="flex items-center space-x-2">
                <p className="text-sm font-medium text-gray-600 dark:text-gray-300">Current workflow doesn't need optimization.</p>
                <div className="group relative flex items-center">
                  <Info className="w-4 h-4 text-indigo-500 hover:text-indigo-600 cursor-help transition-colors" />
                  <div className="hidden group-hover:block absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-64 p-3 bg-gray-900 text-white dark:bg-white dark:text-gray-900 text-xs rounded-lg shadow-xl z-50 pointer-events-none">
                    You need to define at least one variable parameter (e.g. #param) in the Designer to use optimization.
                    <div className="absolute left-1/2 -bottom-1 -translate-x-1/2 w-2 h-2 bg-gray-900 dark:bg-white transform rotate-45"></div>
                  </div>
                </div>
              </div>
            </div>
          ) : returns.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-500 dark:text-gray-400 border-2 border-dashed border-gray-300 dark:border-white/10 rounded-2xl relative">
              <div className="flex items-center space-x-2">
                <p className="text-sm font-medium text-gray-600 dark:text-gray-300">Current workflow has no output value to optimize toward.</p>
                <div className="group relative flex items-center">
                  <Info className="w-4 h-4 text-indigo-500 hover:text-indigo-600 cursor-help transition-colors" />
                  <div className="hidden group-hover:block absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-64 p-3 bg-gray-900 text-white dark:bg-white dark:text-gray-900 text-xs rounded-lg shadow-xl z-50 pointer-events-none">
                    Assign a return variable to at least one step in the Designer — that's the objective the optimizer will maximize or minimize.
                    <div className="absolute left-1/2 -bottom-1 -translate-x-1/2 w-2 h-2 bg-gray-900 dark:bg-white transform rotate-45"></div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto space-y-4 pb-16">
              {globalVariables.length > 0 && (
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 rounded-lg px-4 py-3 flex items-center gap-4 flex-wrap">
                  <span className="text-xs font-bold text-amber-700 dark:text-amber-300 uppercase tracking-wider whitespace-nowrap shrink-0">Fixed Values</span>
                  {globalVariables.map(v => (
                    <div key={v} className="flex items-center gap-1.5">
                      <label className="text-xs font-medium text-amber-800 dark:text-amber-200 whitespace-nowrap">
                        {v}
                      </label>
                      <input
                         type="text"
                         placeholder={varTypes[v] || ''}
                         value={globalValues[v] || ''}
                         onChange={e => {
                           const updated = {...globalValues, [v]: e.target.value};
                           setGlobalValues(updated);
                           localStorage.setItem('ivoryos_global_values', JSON.stringify(updated));
                         }}
                         className="w-28 bg-white dark:bg-black/50 border border-amber-300 dark:border-amber-700/50 rounded-md px-2 py-1 text-sm focus:border-amber-500 outline-none"
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="bg-white dark:bg-[#111111] border border-gray-200 dark:border-white/10 rounded-xl shadow-sm p-4">
                <h3 className="text-sm font-bold text-gray-800 dark:text-white mb-3 flex items-center">
                  <Zap className="w-5 h-5 mr-2 text-purple-500" />
                  General Settings
                </h3>
                
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div>
                    <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 block">Optimizer Engine</label>
                    <select
                       value={optConfig.optimizer}
                       onChange={e => selectOptimizer(e.target.value)}
                       disabled={Object.keys(optimizerSchemas).length === 0}
                       className="w-full bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm focus:border-purple-500 outline-none disabled:opacity-50"
                    >
                      {Object.keys(optimizerSchemas).length === 0 && <option value="">No optimizer backends installed</option>}
                      {Object.keys(optimizerSchemas).map(name => (
                        <option key={name} value={name}>{OPTIMIZER_LABELS[name] || name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 block">Evaluation Budget</label>
                    <input
                       type="number"
                       min="1" max="1000"
                       value={optConfig.budget}
                       onChange={e => setOptConfig({...optConfig, budget: parseInt(e.target.value) || 1})}
                       className="w-full bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm focus:border-purple-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 block" title="How many trials the optimizer suggests, runs, and reports back together per round. 1 = ask/run/tell one at a time.">Batch Size</label>
                    <input
                       type="number"
                       min="1" max={optConfig.budget || 1000}
                       value={optConfig.batch_size}
                       onChange={e => setOptConfig({...optConfig, batch_size: parseInt(e.target.value) || 1})}
                       className="w-full bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm focus:border-purple-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 block">Error Recovery</label>
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

              {Object.keys(optimizerSchemas[optConfig.optimizer]?.optimizer_config || {}).length > 0 && (
                <div className="bg-white dark:bg-[#111111] border border-gray-200 dark:border-white/10 rounded-xl shadow-sm p-4">
                  <button
                     type="button"
                     onClick={() => setShowStrategy(s => !s)}
                     className="w-full flex items-center justify-between gap-2 text-left"
                  >
                    <div>
                      <h3 className="text-sm font-bold text-gray-800 dark:text-white">Optimization Strategy</h3>
                      <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Advanced &mdash; the model/sampling choices {OPTIMIZER_LABELS[optConfig.optimizer] || optConfig.optimizer} exposes for each phase. Defaults are fine for most runs.</p>
                    </div>
                    <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${showStrategy ? 'rotate-180' : ''}`} />
                  </button>
                  {showStrategy && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                      {Object.entries(optimizerSchemas[optConfig.optimizer].optimizer_config).map(([stepKey, stepDef]: [string, any]) => (
                        <div key={stepKey} className="bg-gray-50/50 dark:bg-white/[0.02] p-4 rounded-xl border border-gray-100 dark:border-white/5 space-y-3">
                          <span className="text-xs font-bold text-purple-500 uppercase tracking-wider">{stepKey.replace('_', ' ')}</span>
                          <div className="flex space-x-3">
                            <select
                               value={optConfig.optimizer_config?.[stepKey]?.model || ''}
                               onChange={e => setOptConfig({...optConfig, optimizer_config: {...optConfig.optimizer_config, [stepKey]: {...optConfig.optimizer_config?.[stepKey], model: e.target.value}}})}
                               className="flex-1 bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-purple-500"
                            >
                              {(stepDef.model || []).map((m: string) => <option key={m} value={m}>{m}</option>)}
                            </select>
                            {'num_samples' in stepDef && (
                              <input
                                 type="number"
                                 min="0"
                                 title="Number of trials for this phase"
                                 value={optConfig.optimizer_config?.[stepKey]?.num_samples ?? stepDef.num_samples}
                                 onChange={e => setOptConfig({...optConfig, optimizer_config: {...optConfig.optimizer_config, [stepKey]: {...optConfig.optimizer_config?.[stepKey], num_samples: parseInt(e.target.value) || 0}}})}
                                 className="w-24 bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-purple-500"
                              />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="bg-white dark:bg-[#111111] border border-gray-200 dark:border-white/10 rounded-xl shadow-sm p-4">
                <h3 className="text-sm font-bold text-gray-800 dark:text-white mb-3">Search Space</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {variables.map(v => {
                    const mode = getVarMode(v);
                    const perIter = isPerIteration(v);
                    return (
                    <div key={v} className="bg-gray-50/50 dark:bg-white/[0.02] p-4 rounded-xl border border-gray-100 dark:border-white/5 space-y-3 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-base font-bold text-indigo-500 truncate min-w-0">{v}</span>
                          <div className="flex items-center gap-1 shrink-0">
                            <label className="flex items-center gap-1.5 cursor-pointer select-none">
                              <input
                                 type="checkbox"
                                 checked={perIter}
                                 onChange={e => setPerIteration(v, e.target.checked)}
                                 className="w-3.5 h-3.5 accent-teal-600"
                              />
                              <span className="text-[11px] font-bold text-teal-700 dark:text-teal-400">Per-Iteration</span>
                            </label>
                            <div className="group relative flex items-center">
                              <Info className="w-3.5 h-3.5 text-teal-500 hover:text-teal-600 cursor-help transition-colors" />
                              <div className="hidden group-hover:block absolute right-0 bottom-full mb-2 w-56 p-2.5 bg-gray-900 text-white dark:bg-white dark:text-gray-900 text-xs rounded-lg shadow-xl z-50 pointer-events-none">
                                Give this parameter a different value each iteration, entered in a spreadsheet below &mdash; instead of searching over a range or using one fixed value.
                                <div className="absolute right-3 -bottom-1 w-2 h-2 bg-gray-900 dark:bg-white transform rotate-45"></div>
                              </div>
                            </div>
                          </div>
                      </div>

                      {perIter ? (
                          <p className="text-xs text-teal-600 dark:text-teal-400 italic">Configured in the table below.</p>
                      ) : (
                      <>
                      <div className="flex items-center gap-2">
                            <button
                               type="button"
                               title={mode === 'fixed' ? "Use a fixed value instead of optimizing this parameter" : "Search over this parameter"}
                               onClick={() => setVarMode(v, mode === 'fixed' ? 'optimize' : 'fixed')}
                               className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border transition-colors ${mode === 'fixed' ? 'bg-amber-50 border-amber-300 text-amber-700 dark:bg-amber-900/20 dark:border-amber-700/40 dark:text-amber-300' : 'bg-indigo-50 border-indigo-200 text-indigo-600 dark:bg-indigo-900/20 dark:border-indigo-700/40 dark:text-indigo-300'}`}
                            >
                              {mode === 'fixed' ? 'Fixed' : 'Optimize'}
                            </button>
                            {mode === 'optimize' && (
                              <select
                                 value={optConfig.bounds[v]?.type || 'range'}
                                 onChange={e => setOptConfig({...optConfig, bounds: {...optConfig.bounds, [v]: {...optConfig.bounds[v], type: e.target.value}}})}
                                 className="bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1 text-sm outline-none"
                              >
                                 <option value="range">Range</option>
                                 <option value="choice">Choice</option>
                              </select>
                            )}
                      </div>

                      {mode === 'optimize' && (
                      <div className="flex gap-3 min-w-0">
                          <input
                             type="text"
                             placeholder={optConfig.bounds[v]?.type === 'choice' ? "e.g. 10, 20" : "Min"}
                             value={optConfig.bounds[v]?.min || ''}
                             onChange={e => setOptConfig({...optConfig, bounds: {...optConfig.bounds, [v]: {...optConfig.bounds[v], min: e.target.value}}})}
                             className="flex-1 min-w-0 bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
                          />
                          {optConfig.bounds[v]?.type !== 'choice' && (
                            <input
                               type="text"
                               placeholder="Max"
                               value={optConfig.bounds[v]?.max || ''}
                               onChange={e => setOptConfig({...optConfig, bounds: {...optConfig.bounds, [v]: {...optConfig.bounds[v], max: e.target.value}}})}
                               className="flex-1 min-w-0 bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
                            />
                          )}
                      </div>
                      )}

                      {mode === 'fixed' && (
                          <input
                             type="text"
                             placeholder="Value used every iteration"
                             value={optConfig.bounds[v]?.fixedValue || ''}
                             onChange={e => setOptConfig({...optConfig, bounds: {...optConfig.bounds, [v]: {...optConfig.bounds[v], fixedValue: e.target.value}}})}
                             className="w-full bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-500"
                          />
                      )}
                      </>
                      )}
                    </div>
                    );
                  })}
                </div>
              </div>

              {(() => {
                const perIterationVars = variables.filter(v => isPerIteration(v));
                if (perIterationVars.length === 0) return null;
                const budgetCount = Math.max(1, optConfig.budget || 1);
                return (
                  <div className="bg-white dark:bg-[#111111] border border-gray-200 dark:border-white/10 rounded-xl shadow-sm overflow-hidden">
                    <div className="p-4 pb-3">
                      <h3 className="text-sm font-bold text-gray-800 dark:text-white">Per-Iteration Values</h3>
                      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">One row per iteration — fill in the value each Per-Iteration parameter should use that iteration.</p>
                    </div>
                    <div className="overflow-auto max-h-[420px] border-t border-gray-200 dark:border-white/10">
                      <table className="w-full text-left border-collapse">
                        <thead className="sticky top-0 z-10">
                          <tr className="bg-gray-50 dark:bg-white/5 border-b border-gray-200 dark:border-white/10 text-xs tracking-wider text-gray-500 dark:text-gray-400 font-semibold">
                            <th className="p-3 w-24 text-center">Iteration</th>
                            {perIterationVars.map(v => (
                              <th key={v} className="p-3 border-l border-gray-200 dark:border-white/10 font-mono text-teal-600 dark:text-teal-400">{v}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from({ length: budgetCount }).map((_, i) => (
                            <tr key={i} className="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50 dark:hover:bg-white/[0.02]">
                              <td className="p-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{i + 1}</td>
                              {perIterationVars.map(v => (
                                <td key={v} className="p-2 border-l border-gray-100 dark:border-white/5">
                                  <input
                                     type="text"
                                     placeholder={varTypes[v] || `Enter ${v}...`}
                                     value={getIterationValue(v, i)}
                                     onChange={e => setIterationValue(v, i, e.target.value)}
                                     className="w-full bg-transparent border-b border-transparent hover:border-gray-300 focus:border-teal-500 dark:hover:border-white/20 dark:focus:border-teal-500 px-2 py-1 text-sm outline-none transition-colors"
                                  />
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              <div className="bg-white dark:bg-[#111111] border border-gray-200 dark:border-white/10 rounded-xl shadow-sm p-4">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <h3 className="text-sm font-bold text-gray-800 dark:text-white shrink-0">Objectives</h3>
                  {returns.length > 1 && (
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">Stop early when</span>
                      <select
                         value={optConfig.earlyStopMode || 'any'}
                         onChange={e => setOptConfig({...optConfig, earlyStopMode: e.target.value})}
                         className="bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs outline-none"
                      >
                        <option value="any">any criterion is met</option>
                        <option value="all">all criteria are met</option>
                      </select>
                    </div>
                  )}
                </div>
                {returns.length === 0 ? (
                    <div className="text-sm text-gray-500">No return variables assigned in sequence.</div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                      {returns.map((v: string) => {
                        const earlyStopOn = !!optConfig.objectives[v]?.earlyStop;
                        return (
                        <div key={v} className="bg-gray-50/50 dark:bg-white/[0.02] p-4 rounded-xl border border-gray-100 dark:border-white/5 space-y-3 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-base font-bold text-green-500 truncate min-w-0">{v}</span>
                            <select
                               value={optConfig.objectives[v]?.goal || 'maximize'}
                               onChange={e => setOptConfig({...optConfig, objectives: {...optConfig.objectives, [v]: {...optConfig.objectives[v], goal: e.target.value}}})}
                               className="bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-green-500 w-32 shrink-0"
                            >
                               <option value="maximize">Maximize</option>
                               <option value="minimize">Minimize</option>
                            </select>
                          </div>
                          <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input
                               type="checkbox"
                               checked={earlyStopOn}
                               onChange={e => setOptConfig({...optConfig, objectives: {...optConfig.objectives, [v]: {...optConfig.objectives[v], earlyStop: e.target.checked}}})}
                               className="w-3.5 h-3.5 accent-purple-600"
                            />
                            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Stop early once this reaches a target</span>
                          </label>
                          {earlyStopOn && (
                            <input
                               type="text"
                               placeholder={optConfig.objectives[v]?.goal === 'minimize' ? "Target (stop once ≤)" : "Target (stop once ≥)"}
                               value={optConfig.objectives[v]?.threshold ?? ''}
                               onChange={e => setOptConfig({...optConfig, objectives: {...optConfig.objectives, [v]: {...optConfig.objectives[v], threshold: e.target.value}}})}
                               className="w-full bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-purple-500"
                            />
                          )}
                        </div>
                        );
                      })}
                    </div>
                )}
              </div>

              <div className="bg-white dark:bg-[#111111] border border-gray-200 dark:border-white/10 rounded-xl shadow-sm p-4">
                <h3 className="text-sm font-bold text-gray-800 dark:text-white mb-1">Existing Data <span className="text-xs font-normal text-gray-400">(optional)</span></h3>
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">Warm-start the optimizer with prior results instead of starting from scratch.</p>

                {requiredParamNames.length === 0 || returns.length === 0 ? (
                  <div className="text-sm text-gray-500">Configure at least one optimized parameter and one objective above to attach existing data.</div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 block">From Data History</label>
                      {compatibleHistoryRuns.length === 0 ? (
                        <div className="text-xs text-gray-400 dark:text-gray-500 italic">No compatible past optimization runs found (needs parameters: {requiredParamNames.join(', ')}; objectives: {returns.join(', ')}).</div>
                      ) : (
                        <div className="space-y-1.5 max-h-40 overflow-auto pr-1">
                          {compatibleHistoryRuns.map((run: any) => {
                            const checked = selectedHistoryIds.includes(run.id);
                            const rowCount = extractOptimizationRows(run).length;
                            return (
                              <label key={run.id} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={e => setSelectedHistoryIds(prev => e.target.checked ? [...prev, run.id] : prev.filter(id => id !== run.id))}
                                  className="w-3.5 h-3.5 accent-purple-600 shrink-0"
                                />
                                <span className="truncate min-w-0 flex-1">{run.name || `Run #${run.id}`}</span>
                                {isSameWorkflow(run) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-50 dark:bg-teal-500/10 text-teal-600 dark:text-teal-400 shrink-0">same workflow</span>}
                                <span className="text-xs text-gray-400 shrink-0">{rowCount} pt{rowCount === 1 ? '' : 's'}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div>
                      <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 block">Or Upload CSV</label>
                      <input
                        type="file"
                        accept=".csv"
                        onChange={e => e.target.files?.[0] && handleUploadCSV(e.target.files[0])}
                        className="text-xs text-gray-500 dark:text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-gray-100 dark:file:bg-white/10 file:text-gray-700 dark:file:text-gray-200 hover:file:bg-gray-200 dark:hover:file:bg-white/20"
                      />
                      <p className="text-[11px] text-gray-400 mt-1">Needs a column per parameter ({requiredParamNames.join(', ')}) and per objective ({returns.join(', ')}).</p>
                      {uploadFileName && !uploadError && (
                        <p className="text-xs text-teal-600 dark:text-teal-400 mt-1">{uploadFileName}: {uploadedExistingRows.length} row(s) loaded.</p>
                      )}
                      {uploadError && <p className="text-xs text-red-500 mt-1">{uploadError}</p>}
                    </div>

                    {existingData.length > 0 && (
                      <p className="text-xs text-purple-600 dark:text-purple-400 font-medium">{existingData.length} existing data point{existingData.length === 1 ? '' : 's'} will seed this run before the first suggestion.</p>
                    )}
                  </div>
                )}
              </div>

              <div className="flex flex-col items-end pt-4 gap-2">
                {optimizersLoaded && Object.keys(optimizerSchemas).length === 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">No optimizer backends are installed on this edge server (ax-platform, baybe, or nimo).</p>
                )}
                <input
                  type="text"
                  value={experimentName}
                  onChange={e => setExperimentName(e.target.value)}
                  placeholder="Experiment name (optional)"
                  title="Shown in Data History instead of the default run label"
                  className="w-56 px-3 py-2 rounded-lg text-sm bg-white border border-gray-200 text-gray-700 placeholder:text-gray-400 focus:outline-none focus:border-purple-400 dark:bg-black/50 dark:border-white/10 dark:text-gray-200 dark:placeholder:text-gray-500"
                />
                <button
                  onClick={startOptimization}
                  disabled={!optConfig.optimizer || isStarting}
                  className="flex items-center space-x-2 px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl transition-colors font-bold shadow-lg shadow-purple-500/20"
                >
                  {isStarting ? (
                    <>
                      <div className="w-5 h-5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                      <span>Starting…</span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-5 h-5" />
                      <span>Start Optimization</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
