"use client";
import { unmodifiedSavedWorkflowName } from '@/savedWorkflow';
import { API_BASE } from '@/config';
import { useState, useEffect, useMemo, useRef } from 'react';
import { Settings2, Info, Zap, ChevronDown, ChevronRight, Plus, X, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import Sidebar from '@/components/Sidebar';
import RunTabs from '@/components/RunTabs';
import LiveRun from '@/components/LiveRun';
import { useQueueBusy } from '@/queueBusy';
import { editRunIdFromUrl, hydrateBlocks, leaveEdit, loadQueuedRun, saveQueuedRun, sourceBlock, type QueuedEdit } from '@/queuedEdit';
import { currentStages, loadStage, stageKeeper, type EmbeddedStage } from '@/stages';
import {
  buildRunName,
  getReturnLeaves,
  readNamedOutput,
  buildOptimizationParameters,
  resolveFixedBlock,
  getVarMode as sharedGetVarMode,
  getVarModeType as sharedGetVarModeType,
  isPerIteration as sharedIsPerIteration,
  getIterationValue as sharedGetIterationValue, useDocumentTheme, LIBRARY_INSTRUMENT, linkOutputBindings, runtimeVarNames, splitRepeatedLinks, mainOnlyLinks , confirmDialog , notify,
  guardHint, guardProblem, guardsFor, unitOf, type FieldGuard, type FieldRef } from '@ivoryos/shared-ui';

const OPTIMIZER_LABELS: Record<string, string> = {
  baybe: 'BayBE',
  ax: 'Ax (BoTorch)',
  nimo: 'NIMO'
};

// A run-on "(needs parameters: a, b, c; objectives: d, e)" sentence is hard to scan — pill tags
// read at a glance instead, and reuse the same visual language wherever these column names
// need explaining (the "no compatible runs" message and the CSV upload requirement).
// The Search Space and Objectives rows: a short field for a number, not a full-width box.
const compactInput = 'h-7 min-w-0 bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-md px-2 text-xs font-mono outline-none focus:border-accent';

const RequiredColumns = ({ params, objectives }: { params: string[]; objectives: string[] }) => (
  <div className="flex flex-wrap items-center gap-1.5">
    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide shrink-0">Requires</span>
    {params.map(p => (
      <span key={p} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400">{p}</span>
    ))}
    {objectives.map(o => (
      <span key={o} title="objective" className="text-[10px] font-mono px-1.5 py-0.5 rounded ring-1 ring-inset ring-gray-300 text-gray-800 dark:ring-white/20 dark:text-gray-200">{o}</span>
    ))}
  </div>
);

/**
 * The Run page's Optimize tab (app/optimize/page.tsx), and, given `stage`, the same configuration
 * drawn inside the Stages page for one stage of a design (src/stages.ts): that stage alone,
 * without the page around it, kept for the Stages page as it changes. There is no Start or Save
 * there: that page starts every stage together.
 */
export default function OptimizeRunPage({ stage }: { stage?: EmbeddedStage } = {}) {
  const theme = useDocumentTheme();
  const [variables, setVariables] = useState<string[]>([]);
  const [globalVariables, setGlobalVariables] = useState<string[]>([]);
  const [varTypes, setVarTypes] = useState<Record<string, string>>({});
  // A unit a driver itself declared for the field a '#variable' feeds (the Safety page's choices
  // arrive with the field's limit: varUnits, below), and for the return path an objective is
  // saved from.
  const [declaredUnits, setDeclaredUnits] = useState<Record<string, string>>({});
  const [returnUnits, setReturnUnits] = useState<Record<string, string>>({});
  const [globalValues, setGlobalValues] = useState<Record<string, string>>({});
  const [returns, setReturns] = useState<string[]>([]);
  // Variables a step saves that aren't numbers (a sample id, a status string). Still usable as
  // '#variables' by later steps, but an optimizer can't treat them as an objective, so they're
  // listed separately rather than silently dropped.
  const [nonNumericReturns, setNonNumericReturns] = useState<string[]>([]);
  const [sequence, setSequence] = useState<any[]>([]);
  const [prepSequence, setPrepSequence] = useState<any[]>([]);
  const [cleanupSequence, setCleanupSequence] = useState<any[]>([]);
  const [edgeStatus, setEdgeStatus] = useState<any>(null);
  // Which fields each '#variable' feeds, so the safety guard's limits on them are shown beside the
  // search space. The edge refuses a search range that reaches past a limit (safety.py check_run).
  const [varFields, setVarFields] = useState<Record<string, FieldRef[]>>({});
  const varGuards = useMemo(() => {
    const out: Record<string, FieldGuard[]> = {};
    for (const [name, refs] of Object.entries(varFields)) {
      const guards = guardsFor(edgeStatus?.safety, refs);
      if (guards.length) out[name] = guards;
    }
    return out;
  }, [varFields, edgeStatus]);
  // What each variable's numbers are in: the driver's declaration, else the Safety page's choice.
  const varUnits = useMemo(() => {
    const out: Record<string, string> = {};
    for (const name of new Set([...Object.keys(declaredUnits), ...Object.keys(varGuards)])) {
      const unit = unitOf(varGuards[name], declaredUnits[name]);
      if (unit) out[name] = unit;
    }
    return out;
  }, [declaredUnits, varGuards]);
  const [optimizerSchemas, setOptimizerSchemas] = useState<Record<string, any>>({});
  const [optimizersLoaded, setOptimizersLoaded] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const queueBusy = useQueueBusy();
  // Editing a queued optimization (?edit=<id>, queuedEdit.ts): its settings, not the last-used
  // ones, and nothing saved over the person's own while it is shown.
  const [editing, setEditing] = useState<QueuedEdit | null>(null);
  const [stageCount, setStageCount] = useState(0);
  // Keeps a stage's settings as they change (stages.ts stageKeeper); set once the stage is loaded.
  const keepStage = useRef<ReturnType<typeof stageKeeper> | null>(null);
  const editingRef = useRef(false);
  const [experimentName, setExperimentName] = useState('');
  const [historyRuns, setHistoryRuns] = useState<any[]>([]);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<number[]>([]);
  // Past runs to seed from are folded into one line until opened: twenty matching runs as twenty
  // rows buried the rest of the page.
  const [historyOpen, setHistoryOpen] = useState(false);
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
      budget: saved.budget ?? 25,
      batch_size: saved.batch_size ?? 1,
      bounds: saved.bounds || {},
      objectives: saved.objectives || {},
      optimizer_config: saved.optimizer_config || {},
      earlyStopMode: saved.earlyStopMode || 'any',
      constraints: saved.constraints || []
    };
  });

  useEffect(() => {
    if (typeof window === 'undefined' || editingRef.current) return;
    localStorage.setItem('ivoryos_optimize_config', JSON.stringify({
      optimizer: optConfig.optimizer,
      budget: optConfig.budget,
      batch_size: optConfig.batch_size,
      bounds: optConfig.bounds,
      objectives: optConfig.objectives,
      optimizer_config: optConfig.optimizer_config,
      earlyStopMode: optConfig.earlyStopMode,
      constraints: optConfig.constraints
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

    // Load sequence and extract variables: a queued run being edited, or the Designer's workflow.
    const editId = stage ? null : editRunIdFromUrl();
    const stageIndex = stage ? stage.index : null;
    const savedSequence = localStorage.getItem('ivoryos_sequence');
    const savedPrep = localStorage.getItem('ivoryos_prep_sequence');
    const savedCleanup = localStorage.getItem('ivoryos_cleanup_sequence');
    {
      const design = currentStages();
      setStageCount(!design.problem && design.stages.some(p => p.kind === 'workflow') ? design.stages.length : 0);
    }
    if (savedSequence || editId || stageIndex !== null) {
      (async () => {
      try {
        let parsedSeq: any[];
        let pSeq: any[];
        let cSeq: any[];
        let restoredGlobals: Record<string, string> | null = null;
        if (editId) {
          try {
            const { run, source, instruments } = await loadQueuedRun(editId);
            parsedSeq = hydrateBlocks(source.sequence, instruments);
            pSeq = hydrateBlocks(source.prep, instruments);
            cSeq = hydrateBlocks(source.cleanup, instruments);
            editingRef.current = true;
            if (source.optConfig) setOptConfig(source.optConfig);
            setSelectedHistoryIds(source.selectedHistoryIds || []);
            setUploadedExistingRows(source.uploaded?.rows || []);
            setUploadFileName(source.uploaded?.name || '');
            restoredGlobals = source.globalValues || {};
            setEditing({ id: run.id, name: run.name });
          } catch (e: any) {
            await notify(e.message, { title: 'Cannot edit this run', tone: 'error' });
            leaveEdit();
            return;
          }
        } else if (stageIndex !== null) {
          try {
            const loaded = await loadStage(stageIndex, 'optimize');
            editingRef.current = true;
            parsedSeq = loaded.stage.blocks.sequence;
            pSeq = loaded.stage.blocks.prep;
            cSeq = loaded.stage.blocks.cleanup;
            // What was last set for this stage's optimization, if anything.
            const kept = loaded.settings?.state || {};
            if (kept.optConfig) setOptConfig(kept.optConfig);
            setSelectedHistoryIds(kept.selectedHistoryIds || []);
            setUploadedExistingRows(kept.uploaded?.rows || []);
            setUploadFileName(kept.uploaded?.name || '');
            restoredGlobals = kept.globalValues || {};
            // From here on it is kept as it changes. Told what was just loaded, so that opening
            // a stage to look at it writes nothing.
            if (stage) keepStage.current = stageKeeper(loaded.stage, 'optimize', loaded.settings?.state, stage.onChange);
          } catch (e: any) {
            await notify(e.message, { title: 'Cannot set up this stage', tone: 'error' });
            return;
          }
        } else {
          parsedSeq = JSON.parse(savedSequence!);
          pSeq = savedPrep ? JSON.parse(savedPrep) : [];
          cSeq = savedCleanup ? JSON.parse(savedCleanup) : [];
        }
        setSequence(parsedSeq);
        setPrepSequence(pSeq);
        setCleanupSequence(cSeq);

        const vTypes: Record<string, string> = {};
        const vUnits: Record<string, string> = {};
        // A '#name' the run fills in itself (a User input's answer, or what an earlier step in
        // the trial saved) is read when its step runs, so it is not something to optimize or fix.
        const runtimeVars = runtimeVarNames(pSeq, parsedSeq, cSeq);
        const vFields: Record<string, FieldRef[]> = {};
        const extractVars = (block: any, obj: any, schemaObj: any, targetSet: Set<string>, prefix = '') => {
             if (!obj) return;
             Object.entries(obj).forEach(([k, v]) => {
                let pData: any = null;
                if (schemaObj?.parameters?.[k]) pData = schemaObj.parameters[k];
                else if (schemaObj?.fields?.[k]) pData = schemaObj.fields[k];

                if (typeof v === 'string' && v.startsWith('#')) {
                    const varName = v.substring(1);
                    if (runtimeVars.has(varName.trim())) return;
                    targetSet.add(varName);
                    if (pData?.type) vTypes[varName] = pData.type;
                    if (pData?.unit) vUnits[varName] = String(pData.unit);
                    (vFields[varName] ||= []).push({ instrument: block.instrument, method: block.method, param: `${prefix}${k}` });
                } else if (typeof v === 'object' && v !== null) {
                    extractVars(block, v, pData, targetSet, `${prefix}${k}.`);
                }
             });
        };

        const vars = new Set<string>();
        parsedSeq.forEach((block: any) => extractVars(block, block.params, block.schema, vars));
        setVariables(Array.from(vars));

        const gVars = new Set<string>();
        pSeq.forEach((block: any) => extractVars(block, block.params, block.schema, gVars));
        cSeq.forEach((block: any) => extractVars(block, block.params, block.schema, gVars));
        setVarFields(vFields);
        const gVarList = Array.from(gVars);
        setGlobalVariables(gVarList);
        setVarTypes(vTypes);
        setDeclaredUnits(vUnits);

        const savedGlobalValues = restoredGlobals ? JSON.stringify(restoredGlobals) : localStorage.getItem('ivoryos_global_values');
        if (savedGlobalValues) {
            setGlobalValues(JSON.parse(savedGlobalValues));
        } else {
            const initGVals: Record<string, string> = {};
            gVarList.forEach(v => initGVals[v] = '');
            setGlobalValues(initGVals);
        }

        // One step can now save several variables — one per field of a structured return — so
        // the objective list is the union of those names, keeping only the numeric ones (the
        // optimizer has nothing to do with a returned sample id). A block whose schema we no
        // longer have (an imported/legacy sequence) is assumed numeric, as before.
        const numericRet: string[] = [];
        const otherRet: string[] = [];
        const rUnits: Record<string, string> = {};
        parsedSeq.forEach((block: any) => {
          const leaves = getReturnLeaves(block.schema);
          // A linked workflow's outputs are kept under their own names unless renamed, so an
          // empty binding there means "the same name", not "not saved".
          const bindings: { path: string; var: string }[] = block.instrument === LIBRARY_INSTRUMENT
            ? linkOutputBindings(block)
            : block.returnBindings?.length
            ? block.returnBindings
            : String(block.returnVar || '').split(',').map((v: string) => v.trim()).filter(Boolean)
                .map((v: string, i: number) => ({ path: leaves[i]?.path ?? '', var: v }));
          bindings.forEach(b => {
            if (!b.var) return;
            const leaf = leaves.find(l => l.path === b.path);
            (leaf ? leaf.numeric : true) ? numericRet.push(b.var) : otherRet.push(b.var);
            if (leaf?.unit) rUnits[b.var] = leaf.unit;
          });
        });
        setReturns(Array.from(new Set(numericRet)));
        setReturnUnits(rUnits);
        setNonNumericReturns(Array.from(new Set(otherRet)));
      } catch (e) {
        console.error("Failed to load sequence", e);
      }
      })();
    }
  }, []);


  /**
   * The optimization this page makes, without its name. Throws saying what is incomplete.
   *
   * The Optimize/Fixed/Per-Iteration partition, the search-space and objective mapping, early-stop
   * and resolving Fixed vars to literals live in @ivoryos/shared-ui. The Cloud orchestrator builds
   * the same `parameters` for a node it dispatches, and a Cloud-launched optimization has to *be*
   * this run rather than a second implementation of it: a drifted copy would mean an optimizer
   * silently searching a different space depending on which screen started it.
   */
  const buildBody = () => {
    const parameters: Record<string, any> = buildOptimizationParameters({
        config: optConfig,
        variables,
        returns,
        sequence,
        existingData,
    });
    // Lets the edge time runs of a saved workflow (runtime.py).
    const savedName = unmodifiedSavedWorkflowName();
    if (savedName && !stage && !editing) parameters.workflow_name = savedName;
    // A stage is its workflow as a run: its own prep once, its main block per trial, its
    // cleanup once (splitRepeatedLinks, after Fixed values are filled in so they reach its
    // prep). In a design run as one, a linked workflow is its main steps only (mainOnlyLinks).
    const lists = { prep: prepSequence, sequence: parameters.sequence_template, cleanup: cleanupSequence };
    const split = stage ? splitRepeatedLinks(lists) : mainOnlyLinks(lists);
    parameters.sequence_template = split.sequence;
    // Prep/Cleanup run once for the whole campaign, so their #vars come from the Fixed Values
    // panel. Lenient numeric casting here preserves this page's long-standing behaviour —
    // the backend's own cast_arguments has the last word on a value it can't convert.
    const runtime = runtimeVarNames(prepSequence, sequence, cleanupSequence);
    const skip = (v: string) => runtime.has(v);
    const resolvedPrep = split.prep.map(b => resolveFixedBlock(b, globalValues, { numeric: 'lenient', skip }));
    const resolvedCleanup = split.cleanup.map(b => resolveFixedBlock(b, globalValues, { numeric: 'lenient', skip }));
    // What this page needs to show the run again while it waits (queuedEdit.ts): the workflow as
    // authored here, the settings, and which existing data was chosen.
    parameters._source = {
        page: 'optimize',
        prep: prepSequence.map(sourceBlock),
        sequence: sequence.map(sourceBlock),
        cleanup: cleanupSequence.map(sourceBlock),
        optConfig,
        globalValues,
        selectedHistoryIds,
        uploaded: uploadedExistingRows.length ? { rows: uploadedExistingRows, name: uploadFileName } : null,
    };
    return { parameters, prep: resolvedPrep, cleanup: resolvedCleanup, sequence: [] as any[] };
  };

  const startOptimization = async () => {
    if (isStarting) return; // guard against double-click while the request/optimizer init is in flight
    // Like Run everywhere else: with something queued or under way, this waits behind it, so ask.
    if (queueBusy && !editing && !await confirmDialog('A task is already running. Add this optimization to the execution queue?', {
      title: 'Queue this run?', confirmLabel: 'Add to queue',
    })) return;
    setIsStarting(true);

    let body: ReturnType<typeof buildBody>;
    try {
        body = buildBody();
    } catch (err: any) {
        // notify, not alert(): the desktop app's webview drops alert() without showing it.
        await notify(err.message, { title: 'Check the configuration', tone: 'error' });
        setIsStarting(false);
        return;
    }

    const payload = {
        // Editing keeps the queued run's name unless a new one is typed.
        name: editing ? experimentName.trim() : await buildRunName(`${localStorage.getItem('ivoryos_editing_workflow') || 'Optimization'} Run`, experimentName, API_BASE),
        ...body,
    };

    if (editing) {
        try {
            await saveQueuedRun(editing.id, payload);
            await notify(`"${editing.name}" is updated and keeps its place in the queue.`, { title: 'Queued run saved' });
            leaveEdit();
        } catch (e: any) {
            await notify(e.message, { title: 'Could not save the queued run', tone: 'error' });
            setIsStarting(false);
        }
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/queue/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
            // Stay here: the run shows at the top of this page (LiveRun), which scrolls itself
            // into view. Going to the Queue page was the trip that panel exists to save.
            setIsStarting(false);
        } else {
            await notify(data.error || 'The edge refused the run.', { title: 'Could not start the optimization', tone: 'error' });
            setIsStarting(false);
        }
    } catch(e: any) {
        await notify(e.message, { title: 'Could not start the optimization', tone: 'error' });
        setIsStarting(false);
    }
  };

  // A variable is either 'optimize' (default, left to the optimizer) or 'fixed' (one value used
  // every iteration) — that choice is a separate, independent toggle from "Per-Iteration", which
  // is a plain checkbox: checking it pulls the variable out of both of those entirely and into
  // the shared spreadsheet-style table below, one column per per-iteration variable. `excluded`
  // is the pre-existing on-disk shape (older saved configs) — read as 'fixed' for backward
  // compatibility, but never written anymore.
  // Delegated to @ivoryos/shared-ui so the rule this screen *reads* a variable by is literally the
  // rule buildOptimizationParameters *writes* it by — including the legacy `excluded` spelling.
  const getVarMode = (v: string): 'optimize' | 'fixed' => sharedGetVarMode(optConfig, v);
  // A single "Range / Choice / Fixed" dropdown, collapsing what used to be an Optimize/Fixed
  // toggle plus a separate Range/Choice select into one control — mode and bounds.type both
  // change from the same select, in one state update so they can't end up disagreeing mid-render.
  const getVarModeType = (v: string): 'range' | 'choice' | 'fixed' => sharedGetVarModeType(optConfig, v);
  const setVarModeType = (v: string, value: 'range' | 'choice' | 'fixed') => {
    setOptConfig({
      ...optConfig,
      bounds: {
        ...optConfig.bounds,
        [v]: {
          ...optConfig.bounds[v],
          mode: value === 'fixed' ? 'fixed' : 'optimize',
          ...(value !== 'fixed' ? { type: value } : {})
        }
      }
    });
  };
  const addConstraint = () => setOptConfig({ ...optConfig, constraints: [...(optConfig.constraints || []), ''] });
  const updateConstraint = (i: number, val: string) => {
    const next = [...(optConfig.constraints || [])];
    next[i] = val;
    setOptConfig({ ...optConfig, constraints: next });
  };
  const removeConstraint = (i: number) => {
    setOptConfig({ ...optConfig, constraints: (optConfig.constraints || []).filter((_: string, idx: number) => idx !== i) });
  };
  const isPerIteration = (v: string): boolean => sharedIsPerIteration(optConfig, v);
  const setPerIteration = (v: string, on: boolean) => {
    setOptConfig({ ...optConfig, bounds: { ...optConfig.bounds, [v]: { ...optConfig.bounds[v], perIteration: on } } });
  };
  const getIterationValue = (v: string, i: number): string => sharedGetIterationValue(optConfig, v, i);
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
        // readNamedOutput resolves the name through that step's return pointer, so an
        // objective bound to one field of a structured result seeds with that field's value
        // rather than with the whole result object.
        const value = readNamedOutput(name, seqTemplate, iterSteps);
        if (value !== '' && value !== undefined) row[name] = value;
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

  // A stage keeps its optimization as it is set: no Save. A moment after the last change, the
  // settings and the run they make (or what is still missing) go to the Stages page's draft.
  useEffect(() => {
    if (!keepStage.current) return;
    const timer = setTimeout(() => {
      keepStage.current?.(
        { optConfig, globalValues, selectedHistoryIds, uploaded: uploadedExistingRows.length ? { rows: uploadedExistingRows, name: uploadFileName } : null,
          // Not settings, but they change the run: which variables and objectives were found, and
          // how much existing data has loaded.
          found: [variables, returns, existingData.length] },
        () => {
          if (!optConfig.optimizer) throw new Error('No optimizer is chosen.');
          if (!returns.length) throw new Error('This stage saves nothing an optimizer could aim for.');
          return { name: '', ...buildBody() };
        },
      );
    }, 300);
    return () => clearTimeout(timer);
    // Below `existingData` on purpose: it is read here, in the dependencies, during render.
  }, [optConfig, globalValues, selectedHistoryIds, uploadedExistingRows, uploadFileName, variables, returns, existingData.length, sequence]); // eslint-disable-line react-hooks/exhaustive-deps

  // Embedded in the Stages page, only the configuration itself is drawn: that page has the
  // sidebar, the tabs and the run bar.
  return (
    <div className={stage ? 'text-gray-900 dark:text-white' : `flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {!stage && <Sidebar />}
      
      <div className={stage ? '' : 'flex-1 flex flex-col relative z-0'}>
        {!stage && <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-3 px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <RunTabs active="optimize" />
          {variables.length > 0 && returns.length > 0 && (
            <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-white/5 px-2 py-0.5 rounded-full">
              {optConfig.budget} {optConfig.budget === 1 ? 'iteration' : 'iterations'}
            </span>
          )}
        </header>}

        <div className={stage ? '' : 'p-8 flex-1 overflow-y-auto'}>
          {!stage && !editing && stageCount > 0 && (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs text-gray-600 dark:border-white/10 dark:bg-white/5 dark:text-gray-300">
              <span className="flex-1 min-w-0">
                This design uses saved workflows. Here only their main steps run, under one optimization; their own prep and cleanup do not.
                To run each one whole, with its own settings, set it up in stages.
              </span>
              <Link href="/stages" className="shrink-0 font-semibold text-accent-fg hover:underline">Set up in {stageCount} stages</Link>
            </div>
          )}
          {editing && (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-gray-300 bg-gray-100 px-4 py-2.5 text-sm text-gray-800 dark:border-white/15 dark:bg-white/10 dark:text-gray-100">
              <span className="flex-1 min-w-0">
                Editing the queued optimization <b className="font-semibold">{editing.name}</b>. Save changes to replace it; it keeps its place in the queue.
              </span>
              <button type="button" onClick={leaveEdit} className="shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-white dark:text-gray-300 dark:hover:bg-white/10">Cancel</button>
            </div>
          )}
          {variables.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-500 dark:text-gray-400 border-2 border-dashed border-gray-300 dark:border-white/10 rounded-2xl relative">
              <div className="flex items-center space-x-2">
                <p className="text-sm font-medium text-gray-600 dark:text-gray-300">Current workflow doesn't need optimization.</p>
                <div className="group relative flex items-center">
                  <Info className="w-4 h-4 text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white cursor-help transition-colors" />
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
                  <Info className="w-4 h-4 text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white cursor-help transition-colors" />
                  <div className="hidden group-hover:block absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-64 p-3 bg-gray-900 text-white dark:bg-white dark:text-gray-900 text-xs rounded-lg shadow-xl z-50 pointer-events-none">
                    Assign a return variable to at least one step in the Designer — that's the objective the optimizer will maximize or minimize.
                    <div className="absolute left-1/2 -bottom-1 -translate-x-1/2 w-2 h-2 bg-gray-900 dark:bg-white transform rotate-45"></div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="max-w-5xl mx-auto space-y-4 pb-16">
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
                           if (!editingRef.current) localStorage.setItem('ivoryos_global_values', JSON.stringify(updated));
                         }}
                         className="w-28 bg-white dark:bg-black/50 border border-amber-300 dark:border-amber-700/50 rounded-md px-2 py-1 text-sm focus:border-amber-500 outline-none"
                      />
                      {varUnits[v] && <span className="text-xs text-amber-700/80 dark:text-amber-300/80">{varUnits[v]}</span>}
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
                  {/* No error-recovery setting: a failed step pauses the run and the queue and waits
                      for a person (retry, skip or stop), as in every other run. An automatic skip
                      or retry on real hardware is the risky choice. */}
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

              {/* One parameter per line: name, how it is chosen, its values, Per-Iteration. */}
              <div className="bg-white dark:bg-[#111111] border border-gray-200 dark:border-white/10 rounded-xl shadow-sm p-4">
                <div className="flex items-center gap-1.5 mb-2">
                  <h3 className="text-sm font-bold text-gray-800 dark:text-white">Search Space</h3>
                  <div className="group relative flex items-center">
                    <Info className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-help transition-colors" />
                    <div className="hidden group-hover:block absolute left-0 top-full mt-2 w-64 p-2.5 bg-gray-900 text-white dark:bg-white dark:text-gray-900 text-xs rounded-lg shadow-xl z-50 pointer-events-none">
                      Range and Choice are searched by the optimizer; Fixed uses one value every iteration. Per-iteration gives a parameter its own value each iteration, entered in a table below.
                    </div>
                  </div>
                </div>
                <div className="divide-y divide-gray-100 dark:divide-white/5">
                  {variables.map(v => {
                    const mode = getVarMode(v);
                    const perIter = isPerIteration(v);
                    const bound = optConfig.bounds[v] || {};
                    const setBound = (patch: Record<string, any>) => setOptConfig({...optConfig, bounds: {...optConfig.bounds, [v]: {...optConfig.bounds[v], ...patch}}});
                    // The safety guard's limit on the field this variable feeds: a range, choice
                    // or fixed value reaching past it is refused when the run is started.
                    const guards = varGuards[v] || [];
                    const guardText = guards.map(g => guardHint(g, edgeStatus?.safety)).filter(Boolean).join(' · ');
                    const entered = perIter ? [] : mode === 'fixed' ? [bound.fixedValue]
                      : bound.type === 'choice' ? String(bound.min || '').split(',').map(x => x.trim()) : [bound.min, bound.max];
                    const refusedValue = entered.find(x => guardProblem(guards, x, edgeStatus?.safety));
                    const refused = refusedValue !== undefined ? `${refusedValue} ${guardProblem(guards, refusedValue, edgeStatus?.safety)}` : '';
                    return (
                    <div key={v} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 min-w-0">
                      <span className="w-40 shrink-0 font-mono text-[13px] font-semibold text-gray-800 dark:text-gray-100 truncate" title={v}>{v}</span>
                      {varUnits[v] && <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500" title={`Values are in ${varUnits[v]}`}>{varUnits[v]}</span>}
                      {perIter ? (
                        <span className="text-xs text-teal-600 dark:text-teal-400 italic">set per iteration, in the table below</span>
                      ) : (
                        <>
                          <select
                             value={getVarModeType(v)}
                             onChange={e => setVarModeType(v, e.target.value as 'range' | 'choice' | 'fixed')}
                             className={`h-7 w-[84px] shrink-0 border rounded-md px-1.5 text-xs font-semibold outline-none ${mode === 'fixed' ? 'bg-amber-50 border-amber-300 text-amber-700 dark:bg-amber-900/20 dark:border-amber-700/40 dark:text-amber-300' : 'bg-gray-50 border-gray-200 text-gray-800 dark:bg-white/5 dark:border-white/15 dark:text-gray-100'}`}
                          >
                             <option value="range">Range</option>
                             <option value="choice">Choice</option>
                             <option value="fixed">Fixed</option>
                          </select>
                          {mode === 'optimize' && bound.type !== 'choice' && (
                            <span className="inline-flex items-center gap-1">
                              <input type="text" placeholder="min" value={bound.min || ''} onChange={e => setBound({ min: e.target.value })} className={`${compactInput} w-20`} />
                              <span className="text-xs text-gray-400">to</span>
                              <input type="text" placeholder="max" value={bound.max || ''} onChange={e => setBound({ max: e.target.value })} className={`${compactInput} w-20`} />
                            </span>
                          )}
                          {mode === 'optimize' && bound.type === 'choice' && (
                            <input type="text" placeholder="e.g. 10, 20" value={bound.min || ''} onChange={e => setBound({ min: e.target.value })} className={`${compactInput} w-44`} />
                          )}
                          {mode === 'fixed' && (
                            <input type="text" placeholder="value" title="Used every iteration" value={bound.fixedValue || ''} onChange={e => setBound({ fixedValue: e.target.value })} className={`${compactInput} w-28 focus:border-amber-500`} />
                          )}
                        </>
                      )}
                      {guardText && (
                        <span title={refused ? `Safety guard: ${refused}` : 'What the safety guard allows for this value'}
                          className={`inline-flex items-center gap-1 text-[11px] ${refused ? 'font-semibold text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-gray-500'}`}>
                          <ShieldCheck className="w-3 h-3 shrink-0" />
                          {refused || guardText}
                        </span>
                      )}
                      <label className="ml-auto flex items-center gap-1.5 cursor-pointer select-none shrink-0" title="A different value each iteration, entered in a table below, instead of a range or one fixed value">
                        <input type="checkbox" checked={perIter} onChange={e => setPerIteration(v, e.target.checked)} className="w-3.5 h-3.5 accent-teal-600" />
                        <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">Per-iteration</span>
                      </label>
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
                            <th className="px-3 py-1.5 w-20 text-center">Iteration</th>
                            {perIterationVars.map(v => (
                              <th key={v} className="px-3 py-1.5 border-l border-gray-200 dark:border-white/10 font-mono text-teal-600 dark:text-teal-400">{v}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from({ length: budgetCount }).map((_, i) => (
                            <tr key={i} className="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50 dark:hover:bg-white/[0.02]">
                              <td className="px-3 py-0.5 text-center text-xs font-medium text-gray-500 dark:text-gray-400">{i + 1}</td>
                              {perIterationVars.map(v => (
                                <td key={v} className="px-2 py-0.5 border-l border-gray-100 dark:border-white/5">
                                  <input
                                     type="text"
                                     placeholder={varTypes[v] || `Enter ${v}...`}
                                     value={getIterationValue(v, i)}
                                     onChange={e => setIterationValue(v, i, e.target.value)}
                                     className="w-full bg-transparent border-b border-transparent hover:border-gray-300 focus:border-teal-500 dark:hover:border-white/20 dark:focus:border-teal-500 px-2 py-1 text-xs font-mono outline-none transition-colors"
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
                {nonNumericReturns.length > 0 && (
                  <div className="text-xs text-gray-400 dark:text-gray-500 mb-1">
                    Also saved, but not numeric so not available as an objective:{' '}
                    <span className="font-mono">{nonNumericReturns.join(', ')}</span>
                  </div>
                )}
                {returns.length === 0 ? (
                    <div className="text-sm text-gray-500">No return variables assigned in sequence.</div>
                ) : (
                    // One objective per line: name, direction, and an optional early-stop target.
                    <div className="divide-y divide-gray-100 dark:divide-white/5 mt-1">
                      {returns.map((v: string) => {
                        const objective = optConfig.objectives[v] || {};
                        const earlyStopOn = !!objective.earlyStop;
                        const setObjective = (patch: Record<string, any>) => setOptConfig({...optConfig, objectives: {...optConfig.objectives, [v]: {...optConfig.objectives[v], ...patch}}});
                        return (
                        <div key={v} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 min-w-0">
                          <span className="w-40 shrink-0 font-mono text-[13px] font-semibold text-gray-800 dark:text-gray-100 truncate" title={v}>{v}</span>
                          {returnUnits[v] && <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500" title={`Measured in ${returnUnits[v]}`}>{returnUnits[v]}</span>}
                          <select
                             value={objective.goal || 'maximize'}
                             onChange={e => setObjective({ goal: e.target.value })}
                             className="h-7 w-[100px] shrink-0 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/15 rounded-md px-1.5 text-xs font-semibold text-gray-800 dark:text-gray-100 outline-none focus:border-accent"
                          >
                             <option value="maximize">Maximize</option>
                             <option value="minimize">Minimize</option>
                          </select>
                          <label className="flex items-center gap-1.5 cursor-pointer select-none shrink-0">
                            <input type="checkbox" checked={earlyStopOn} onChange={e => setObjective({ earlyStop: e.target.checked })} className="w-3.5 h-3.5 accent-gray-900 dark:accent-white" />
                            <span className="text-xs text-gray-500 dark:text-gray-400">Stop early {objective.goal === 'minimize' ? 'at ≤' : 'at ≥'}</span>
                          </label>
                          {earlyStopOn && (
                            <input
                               type="text"
                               placeholder="target"
                               value={objective.threshold ?? ''}
                               onChange={e => setObjective({ threshold: e.target.value })}
                               className={`${compactInput} w-24`}
                            />
                          )}
                        </div>
                        );
                      })}
                    </div>
                )}
              </div>

              {optConfig.optimizer === 'ax' && (
                <div className="bg-white dark:bg-[#111111] border border-gray-200 dark:border-white/10 rounded-xl shadow-sm p-4">
                  <h3 className="text-sm font-bold text-gray-800 dark:text-white mb-1">Constraints <span className="text-xs font-normal text-gray-400">(optional, Ax only)</span></h3>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">Linear relationships between optimized parameters, e.g. <code className="font-mono text-[11px] bg-gray-100 dark:bg-white/5 px-1 py-0.5 rounded">flow_rate + temperature &lt;= 100</code>.</p>
                  <div className="space-y-2">
                    {(optConfig.constraints || []).map((c: string, i: number) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                           type="text"
                           value={c}
                           onChange={e => updateConstraint(i, e.target.value)}
                           placeholder="e.g. x + y <= 10"
                           className="flex-1 min-w-0 bg-white dark:bg-black border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-accent"
                        />
                        <button
                           type="button"
                           onClick={() => removeConstraint(i)}
                           title="Remove constraint"
                           className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                    <button
                       type="button"
                       onClick={addConstraint}
                       className="flex items-center gap-1.5 text-xs font-medium text-accent-fg hover:text-accent transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add constraint
                    </button>
                  </div>
                </div>
              )}

              <div className="bg-white dark:bg-[#111111] border border-gray-200 dark:border-white/10 rounded-xl shadow-sm p-4">
                <h3 className="text-sm font-bold text-gray-800 dark:text-white mb-1">Existing Data <span className="text-xs font-normal text-gray-400">(optional)</span></h3>
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">Warm-start the optimizer with prior results instead of starting from scratch.</p>

                {requiredParamNames.length === 0 || returns.length === 0 ? (
                  <div className="text-sm text-gray-500">Configure at least one optimized parameter and one objective above to attach existing data.</div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 block">From Data History</label>
                      {(() => {
                        // Only runs that would add a point: one with no completed trial is not listed.
                        const usable = compatibleHistoryRuns
                          .map((run: any) => ({ run, points: extractOptimizationRows(run).length }))
                          .filter(x => x.points > 0);
                        if (usable.length === 0) return (
                          <div className="space-y-1.5">
                            <p className="text-xs text-gray-400 dark:text-gray-500 italic">No past optimization runs with data for this search space and these objectives.</p>
                            <RequiredColumns params={requiredParamNames} objectives={returns} />
                          </div>
                        );
                        const picked = usable.filter(x => selectedHistoryIds.includes(x.run.id));
                        const pickedPoints = picked.reduce((n, x) => n + x.points, 0);
                        const allPicked = picked.length === usable.length;
                        return (
                          <div className="rounded-lg border border-gray-200 dark:border-white/10">
                            <button type="button" onClick={() => setHistoryOpen(o => !o)} aria-expanded={historyOpen}
                              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 rounded-lg">
                              {historyOpen ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
                              <span className="flex-1 min-w-0 truncate">
                                {picked.length
                                  ? <>{picked.length} of {usable.length} run{usable.length === 1 ? '' : 's'} selected · <span className="text-purple-600 dark:text-purple-400 font-medium">{pickedPoints} point{pickedPoints === 1 ? '' : 's'}</span></>
                                  : <>{usable.length} past run{usable.length === 1 ? '' : 's'} with data · none selected</>}
                              </span>
                            </button>
                            {historyOpen && (
                              <div className="border-t border-gray-100 dark:border-white/5 px-3 py-2 space-y-1.5">
                                <div className="flex items-center gap-3 text-xs">
                                  <button type="button" onClick={() => setSelectedHistoryIds(allPicked ? [] : usable.map(x => x.run.id))}
                                    className="font-medium text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white">{allPicked ? 'Select none' : 'Select all'}</button>
                                </div>
                                <div className="space-y-1.5 max-h-56 overflow-auto pr-1">
                                  {usable.map(({ run, points }) => (
                                    <label key={run.id} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                                      <input
                                        type="checkbox"
                                        checked={selectedHistoryIds.includes(run.id)}
                                        onChange={e => setSelectedHistoryIds(prev => e.target.checked ? [...prev, run.id] : prev.filter(id => id !== run.id))}
                                        className="w-3.5 h-3.5 accent-purple-600 shrink-0"
                                      />
                                      <span className="truncate min-w-0 flex-1">{run.name || `Run #${run.id}`}</span>
                                      {isSameWorkflow(run) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-50 dark:bg-teal-500/10 text-teal-600 dark:text-teal-400 shrink-0">same workflow</span>}
                                      <span className="text-xs text-gray-400 shrink-0">{points} pt{points === 1 ? '' : 's'}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    <div>
                      <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 block">Or Upload CSV</label>
                      <input
                        type="file"
                        accept=".csv"
                        onChange={e => e.target.files?.[0] && handleUploadCSV(e.target.files[0])}
                        className="text-xs text-gray-500 dark:text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-gray-100 dark:file:bg-white/10 file:text-gray-700 dark:file:text-gray-200 hover:file:bg-gray-200 dark:hover:file:bg-white/20"
                      />
                      <div className="mt-1.5">
                        <RequiredColumns params={requiredParamNames} objectives={returns} />
                      </div>
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
                  <p className="text-xs text-amber-600 dark:text-amber-400">No optimizer installed. In the IvoryOS app: this deck&apos;s Settings, Optimizers. Otherwise pip install ax-platform, baybe or nimo.</p>
                )}
                {!stage && <input
                  type="text"
                  value={experimentName}
                  onChange={e => setExperimentName(e.target.value)}
                  placeholder="Experiment name (optional)"
                  title="Shown in Data History instead of the default run label"
                  className="w-56 px-3 py-2 rounded-lg text-sm bg-white border border-gray-200 text-gray-700 placeholder:text-gray-400 focus:outline-none focus:border-purple-400 dark:bg-black/50 dark:border-white/10 dark:text-gray-200 dark:placeholder:text-gray-500"
                />}
                {!stage && <button
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
                      <span>{editing ? 'Save changes' : queueBusy ? 'Add to Queue' : 'Start Optimization'}</span>
                    </>
                  )}
                </button>}
              </div>
            </div>
          )}
        </div>
        {/* The idle chip, widening into the run bar when the run starts (LiveRun). */}
        {!stage && <LiveRun />}
      </div>
    </div>
  );
}
