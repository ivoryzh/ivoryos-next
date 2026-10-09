"use client";
import { unmodifiedSavedWorkflowName } from '@/savedWorkflow';
import { API_BASE } from '@/config';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Play, Download, Upload, AlertTriangle, Layers, ListTree, Grid3x3, Target, Plus, X } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import RunTabs from '@/components/RunTabs';
import LiveRun from '@/components/LiveRun';
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
  toWireBlock, useDocumentTheme, runtimeVarNames, splitRepeatedLinks, mainOnlyLinks,
  TrayPicker, guardHint, guardProblem, guardSuggestions, guardsFor, trayForGuards, unitOf, SuggestInput,
  formatReference, referenceStart, rowListVariables, RunConfigError,
  type FieldGuard, type FieldRef } from '@ivoryos/shared-ui';
import Link from 'next/link';
import { useQueueBusy } from '@/queueBusy';
import { editRunIdFromUrl, hydrateBlocks, leaveEdit, loadQueuedRun, saveQueuedRun, sourceBlock, type QueuedEdit } from '@/queuedEdit';
import { currentStages, loadStage, stageKeeper, type EmbeddedStage } from '@/stages';

/** One condition of Iterate's "Stop early": a saved result compared with a number. */
type StopCondition = { metric: string; op: '>=' | '<='; threshold: string };
type StopEarly = { on: boolean; mode: 'any' | 'all'; conditions: StopCondition[] };
const STOP_EARLY_KEY = 'ivoryos_iterate_stop_early';

/** A run's `early_stop` (edge queue.py target_reached) as this page edits it. */
function stopEarlyFrom(early: any): StopEarly | null {
  if (!early?.criteria?.length) return null;
  return {
    on: true,
    mode: early.mode === 'all' ? 'all' : 'any',
    conditions: early.criteria.map((c: any) => ({ metric: String(c.metric || ''), op: c.op === '<=' ? '<=' : '>=', threshold: String(c.threshold ?? '') })),
  };
}

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

/**
 * The Run page's Once and Iterate tabs: one page in two modes, so both fill a workflow's
 * '#variables' and submit through the same walk (expandSpreadsheet) and the same checks.
 * Iterate is the spreadsheet, a row per sample. Once is that walk with one row, drawn as a form:
 * run the workflow a single time from here rather than only from the Designer's Run button
 * (Cloud's Once / Iterate / Optimize, on the bench).
 */
export default function RunWorkflowPage({ mode, stage }: {
  mode: 'once' | 'iterate';
  /**
   * Set when this is drawn inside the Stages page to set up one stage of a design (src/stages.ts):
   * it then shows that stage alone, without the page around it, and keeps what is typed for the
   * Stages page as it changes. There is no Run or Save here: that page starts every stage together.
   */
  stage?: EmbeddedStage;
}) {
  const once = mode === 'once';
  const [experimentName, setExperimentName] = useState('');
  // Editing a run that waits in the queue (?edit=<id>, queuedEdit.ts): the page shows that run, and
  // saves nothing over the person's own spreadsheet or fixed values while it does.
  const [editing, setEditing] = useState<QueuedEdit | null>(null);
  const editingRef = useRef(false);
  // How many stages the Designer's workflow would make, for the hint that offers them.
  const [stageCount, setStageCount] = useState(0);
  // Keeps a stage's settings as they change (stages.ts stageKeeper); set once the stage is loaded.
  const keepStage = useRef<ReturnType<typeof stageKeeper> | null>(null);
  const [sequence, setSequence] = useState<any[]>([]);
  const [prepSequence, setPrepSequence] = useState<any[]>([]);
  const [cleanupSequence, setCleanupSequence] = useState<any[]>([]);
  const [variables, setVariables] = useState<string[]>([]);
  const [globalVariables, setGlobalVariables] = useState<string[]>([]);
  const [globalValues, setGlobalValues] = useState<Record<string, string>>({});
  const [varTypes, setVarTypes] = useState<Record<string, string>>({});
  // A unit a driver itself declared for the field a '#variable' feeds (`unit` in the schema);
  // the ones chosen on the Safety page arrive with the field's limit (varUnits, below).
  const [declaredUnits, setDeclaredUnits] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Record<string, any>[]>([{}]);
  // Vars used by a "batch" step — still spreadsheet columns, but only need one row per batch
  // group filled in (see batchSize below), not every row.
  const [batchVariables, setBatchVariables] = useState<string[]>([]);
  // Columns a batch step takes from every row of its group, in one call (spreadsheetRun.ts).
  const [listVariables, setListVariables] = useState<string[]>([]);
  const [batchSize, setBatchSize] = useState<string>('');
  // Iterate's "Stop early": end the run once a sample's results reach a target (queue.py
  // target_reached). Kept per browser like the batch size; a queued run being edited brings its own.
  const [stopEarly, setStopEarly] = useState<StopEarly>({ on: false, mode: 'any', conditions: [] });
  // Set once the page has read what it starts from. The batch size is saved only after that: saved
  // on mount, the empty starting value removed the one kept from the last visit before the load
  // (which awaits) could read it, so every visit began at batch size 1.
  const [hasLoaded, setHasLoaded] = useState(false);
  
  const [executionState, setExecutionState] = useState<{
    isRunning: boolean;
    currentRow: number;
    results: any[];
  }>({ isRunning: false, currentRow: -1, results: [] });

  const theme = useDocumentTheme();
  // Something queued or under way: Run becomes "Add to queue" and asks first.
  const hasPendingRuns = useQueueBusy();
  const [edgeStatus, setEdgeStatus] = useState<any>(null);

  const [varOptions, setVarOptions] = useState<Record<string, any[]>>({});
  // Which fields each '#variable' feeds, so the safety guard's limits on those fields can be shown
  // on the variable (shared-ui safety.ts). The edge enforces them; this marks a value as it is typed.
  const [varFields, setVarFields] = useState<Record<string, FieldRef[]>>({});
  const safety = edgeStatus?.safety;
  const varGuards = useMemo(() => {
    const out: Record<string, FieldGuard[]> = {};
    for (const [name, refs] of Object.entries(varFields)) {
      const guards = guardsFor(safety, refs);
      if (guards.length) out[name] = guards;
    }
    return out;
  }, [varFields, safety]);
  // What each column's numbers are in: the driver's declaration, else the Safety page's choice.
  const varUnits = useMemo(() => {
    const out: Record<string, string> = {};
    for (const name of new Set([...Object.keys(declaredUnits), ...Object.keys(varGuards)])) {
      const unit = unitOf(varGuards[name], declaredUnits[name]);
      if (unit) out[name] = unit;
    }
    return out;
  }, [declaredUnits, varGuards]);
  // The Once form's tray picker: which variable it is open for.
  const [pickingTray, setPickingTray] = useState<string | null>(null);
  // Where a '#' with no name sits ("pump_1.dispense → volume_ml"), if anywhere.
  const [hasEmptyHashVar, setHasEmptyHashVar] = useState<string | null>(null);
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
    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => setEdgeStatus(data))
      .catch(err => console.error(err));

    // Load sequence and extract variables
    const editId = stage ? null : editRunIdFromUrl();
    const stageIndex = stage ? stage.index : null;
    const savedSequence = localStorage.getItem('ivoryos_sequence');
    {
      const design = currentStages();
      setStageCount(!design.problem && design.stages.some(p => p.kind === 'workflow') ? design.stages.length : 0);
    }
    if (savedSequence || editId || stageIndex !== null) {
      (async () => {
      try {
        // What the page starts from: a queued run being edited, or the Designer's workflow.
        let restored: { rows: any[]; batchSize: string; globalValues: Record<string, string> } | null = null;
        let restoredStop: StopEarly | null = null;
        let parsedSeq: any[] = [];
        let pSeq: any[] = [];
        let cSeq: any[] = [];
        let stageLoaded: Awaited<ReturnType<typeof loadStage>> | null = null;
        if (editId) {
          try {
            const { run, source, instruments } = await loadQueuedRun(editId);
            parsedSeq = hydrateBlocks(source.sequence, instruments);
            pSeq = hydrateBlocks(source.prep, instruments);
            cSeq = hydrateBlocks(source.cleanup, instruments);
            const size = Number(run.parameters?.batch_size) || 1;
            restored = { rows: run.parameters?.rows || [], batchSize: size > 1 ? String(size) : '', globalValues: source.globalValues || {} };
            restoredStop = stopEarlyFrom(run.parameters?.early_stop);
            editingRef.current = true;
            setEditing({ id: run.id, name: run.name });
          } catch (e: any) {
            await notify(e.message, { title: 'Cannot edit this run', tone: 'error' });
            leaveEdit();
            return;
          }
        } else if (stageIndex !== null) {
          try {
            const loaded = await loadStage(stageIndex, mode);
            editingRef.current = true;
            // The stage's own steps, with its linked workflow opened out the way a run of that
            // workflow is: its setup and teardown once, its body per row.
            parsedSeq = loaded.stage.blocks.sequence;
            pSeq = loaded.stage.blocks.prep;
            cSeq = loaded.stage.blocks.cleanup;
            const expanded = await expandLinkedBlocks(splitRepeatedLinks({ prep: pSeq, sequence: parsedSeq, cleanup: cSeq }));
            if (expanded) {
              parsedSeq = expanded.sequence;
              pSeq = expanded.prep;
              cSeq = expanded.cleanup;
            }
            // What was last typed for this stage in this mode, if anything.
            const kept = loaded.settings?.state || {};
            restored = { rows: kept.rows || [], batchSize: kept.batchSize || '', globalValues: kept.globalValues || {} };
            stageLoaded = loaded;
          } catch (e: any) {
            await notify(e.message, { title: 'Cannot set up this stage', tone: 'error' });
            return;
          }
        } else {
        parsedSeq = JSON.parse(savedSequence!);

        const savedPrep = localStorage.getItem('ivoryos_prep_sequence');
        const savedCleanup = localStorage.getItem('ivoryos_cleanup_sequence');
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
        //
        // A linked workflow used as a step is its main steps only (shared-ui mainOnlyLinks): its
        // own prep and cleanup belong to it as a run, which here it is not. A stage, above, is
        // that run, and keeps them.
        const expanded = await expandLinkedBlocks(mainOnlyLinks({ prep: pSeq, sequence: parsedSeq, cleanup: cSeq }));
        if (expanded) {
          parsedSeq = expanded.sequence;
          pSeq = expanded.prep;
          cSeq = expanded.cleanup;
        }
        }

        setSequence(parsedSeq);
        setPrepSequence(pSeq);
        setCleanupSequence(cSeq);

        // A '#name' the run fills in itself (a User input's answer, or what an earlier step saved)
        // is substituted on the edge when its step runs, so it is not a column here
        // (shared-ui runtimeVarNames; the spreadsheet walk leaves it untouched for the edge).
        const liveVars = runtimeVarNames(pSeq, parsedSeq, cSeq);
        setLiveInputVars(liveVars);

        // Extract # variables and types
        const vars = new Set<string>();
        const gVars = new Set<string>();
        const batchVars = new Set<string>();
        const vTypes: Record<string, string> = {};
        const vUnits: Record<string, string> = {};
        const vOptions: Record<string, any[]> = {};
        const vFields: Record<string, FieldRef[]> = {};
        let sawEmptyHash: string | null = null;
        let scanning = '';
        let scanningBlock: any = null;

        const extractVars = (obj: any, schemaObj: any, targetSet: Set<string>, prefix = '') => {
            if (!obj) return;
            Object.entries(obj).forEach(([k, v]) => {
                let pData = null;
                if (schemaObj?.parameters?.[k]) pData = schemaObj.parameters[k];
                else if (schemaObj?.fields?.[k]) pData = schemaObj.fields[k];

                if (typeof v === 'string' && v.startsWith('#')) {
                    const varName = v.substring(1).trim();
                    if (varName === '') {
                        sawEmptyHash = sawEmptyHash || `${scanning} → ${k}`;
                        return;
                    }
                    if (liveVars.has(varName)) return; // filled in by the run itself, not by this page
                    targetSet.add(varName);

                    if (pData?.type) vTypes[varName] = pData.type;
                    if (pData?.unit) vUnits[varName] = String(pData.unit);
                    if (pData?.options) vOptions[varName] = pData.options;
                    const ref: FieldRef = { instrument: scanningBlock.instrument, method: scanningBlock.method, param: `${prefix}${k}` };
                    // A wells column holds `plate[A1]` per row (shared-ui labware.ts): it gets a
                    // picker for the instrument's plates, and is checked against them as it is typed.
                    if (pData?.wells) ref.wells = { labware: pData.wells.labware || [] };
                    const known = (vFields[varName] ||= []);
                    if (!known.some(f => f.instrument === ref.instrument && f.method === ref.method && f.param === ref.param)) known.push(ref);
                } else if (typeof v === 'object' && v !== null) {
                    extractVars(v, pData, targetSet, `${prefix}${k}.`);
                }
            });
        };
        const scan = (block: any, targetSet: Set<string>) => {
            scanning = `${block.instrument}.${block.method}`;
            scanningBlock = block;
            extractVars(block.params, block.schema, targetSet);
        };

        parsedSeq.forEach((block: any) => {
            // A batch step's #vars still come from the spreadsheet — they just only need to be
            // filled in on one row per batch group instead of every row (see batchVars below).
            scan(block, vars);
            if (block.isBatchAction) scan(block, batchVars);
        });

        pSeq.forEach((block: any) => scan(block, gVars));
        cSeq.forEach((block: any) => scan(block, gVars));

        setHasEmptyHashVar(sawEmptyHash);
        setVarFields(vFields);

        const varList = Array.from(vars);
        const gVarList = Array.from(gVars);
        setVariables(varList);
        setGlobalVariables(gVarList);
        setBatchVariables(Array.from(batchVars));
        setListVariables(rowListVariables(parsedSeq, (v) => liveVars.has(v)));
        setVarTypes(vTypes);
        setDeclaredUnits(vUnits);
        setVarOptions(vOptions);
        
        const savedGlobalValues = restored ? JSON.stringify(restored.globalValues) : localStorage.getItem('ivoryos_global_values');
        let initialGlobals: Record<string, string> = {};
        if (savedGlobalValues) {
            initialGlobals = JSON.parse(savedGlobalValues);
        } else {
            gVarList.forEach(v => initialGlobals[v] = '');
        }
        setGlobalValues(initialGlobals);
        
        // Init rows from memory or empty
        const savedRows = restored ? (restored.rows.length ? JSON.stringify(restored.rows) : null) : localStorage.getItem('ivoryos_spreadsheet');
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

        const savedBatchSize = restored ? restored.batchSize : localStorage.getItem('ivoryos_batch_size');
        if (savedBatchSize) setBatchSize(savedBatchSize);
        if (!stage) {
          let savedStop: StopEarly | null = restoredStop;
          if (!editId) {
            try { savedStop = JSON.parse(localStorage.getItem(STOP_EARLY_KEY) || 'null'); } catch { /* defaults */ }
          }
          if (savedStop?.conditions) setStopEarly(savedStop);
        }
        // From here on, what is typed for a stage is kept as it changes. Told what was just
        // loaded, so that opening a stage to look at it writes nothing.
        if (stage && stageLoaded) {
          keepStage.current = stageKeeper(stageLoaded.stage, mode,
            { rows: initialRows, batchSize: savedBatchSize || '', globalValues: initialGlobals }, stage.onChange);
        }
      } catch (e) {
        console.error("Failed to load sequence", e);
      } finally {
        setHasLoaded(true);
      }
      })();
    } else {
      setHasLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!hasLoaded || editingRef.current) return;
    if (batchSize) localStorage.setItem('ivoryos_batch_size', batchSize);
    else localStorage.removeItem('ivoryos_batch_size');
  }, [batchSize, hasLoaded]);

  useEffect(() => {
    if (!hasLoaded || editingRef.current || stage) return;
    localStorage.setItem(STOP_EARLY_KEY, JSON.stringify(stopEarly));
  }, [stopEarly, hasLoaded, stage]);

  // What steps save, by name: what a "Stop early" condition can compare.
  const resultNames = useMemo(() => Array.from(new Set(sequence.flatMap(b =>
    b.returnBindings?.length
      ? b.returnBindings.map((bind: { path: string; var: string }) => bind.var).filter(Boolean)
      : String(b.returnVar || '').split(',').map((v: string) => v.trim()).filter(Boolean)
  ))) as string[], [sequence]);
  const setCondition = (i: number, patch: Partial<StopCondition>) =>
    setStopEarly(s => ({ ...s, conditions: s.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  useEffect(() => {
    if (editingRef.current) return;
    if (rows.length > 0 && Object.keys(rows[0]).length > 0) {
      localStorage.setItem('ivoryos_spreadsheet', JSON.stringify(rows));
    }
  }, [rows]);


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

  // Positions picked on a tray become the column, one row each, in visiting order. Rows are added
  // as needed; a row past the last position loses this column's value, and is dropped when that
  // leaves it empty at the end of the table.
  const fillColumn = (variable: string, values: string[]) => {
    const next = rows.map(r => ({ ...r }));
    values.forEach((value, i) => {
      if (!next[i]) next[i] = Object.fromEntries(variables.map(v => [v, '']));
      next[i][variable] = value;
    });
    const isEmpty = (r: Record<string, any>) => variables.every(v => r[v] === undefined || r[v] === null || r[v] === '');
    for (let i = values.length; i < next.length; i++) next[i][variable] = '';
    while (next.length > Math.max(1, values.length) && isEmpty(next[next.length - 1])) next.pop();
    setRows(next);
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

  // Once runs the first row only, start to finish.
  const runRows = once ? rows.slice(0, 1) : rows;
  const runBatchSize = once ? '' : batchSize;

  /**
   * The run this page makes, without its name. Throws RunConfigError saying what is missing.
   *
   * The per-sample/batch walk, the `#var` resolution and the numeric checks all live in
   * @ivoryos/shared-ui — the Cloud orchestrator dispatches spreadsheet runs through the very same
   * functions, so a distributed run and a bench run expand identically. The table above draws its
   * group boundaries from the same `groupSizeFor`, which is what keeps the "not used for this row"
   * hint from ever becoming a lie.
   */
  const buildBody = () => {
    // "Stop early" (Iterate only): conditions with a result and a number; one without a number is
    // said rather than dropped, since a run that never stops would be the surprise.
    let earlyStop: Record<string, any> | null = null;
    if (!once && !stage && stopEarly.on) {
      const conditions = stopEarly.conditions.filter(c => c.metric && c.threshold.trim() !== '');
      const unreadable = conditions.filter(c => !Number.isFinite(Number(c.threshold)));
      if (unreadable.length) {
        throw new RunConfigError(`Stop early: ${unreadable.map(c => c.metric).join(', ')} needs a number to compare with.`);
      }
      if (conditions.length) {
        earlyStop = { mode: stopEarly.mode, criteria: conditions.map(c => ({ metric: c.metric, op: c.op, threshold: Number(c.threshold) })) };
      }
    }
    const fullSequence = expandSpreadsheet({ sequence, rows: runRows, variables, batchSize: runBatchSize, liveInputVars });
    const skip = (v: string) => liveInputVars.has(v);
    const resolvedPrep = prepSequence.map(b => resolveFixedBlock(b, globalValues, { skip }));
    const resolvedCleanup = cleanupSequence.map(b => resolveFixedBlock(b, globalValues, { skip }));
    return {
      parameters: {
        ...buildSpreadsheetParameters({ variables, rows: runRows, sequence, batchSize: runBatchSize }),
        ...(earlyStop ? { early_stop: earlyStop } : {}),
        // Lets the edge time runs of a saved workflow (runtime.py).
        ...(!editing && !stage && unmodifiedSavedWorkflowName() ? { workflow_name: unmodifiedSavedWorkflowName() } : {}),
        // What this page needs to show the run again while it waits (queuedEdit.ts).
        _source: {
          page: mode,
          prep: prepSequence.map(sourceBlock),
          sequence: sequence.map(sourceBlock),
          cleanup: cleanupSequence.map(sourceBlock),
          globalValues,
        },
      },
      prep: resolvedPrep,
      // `toSubmittedStep` stamps each step with the row it came from. Data History used to
      // recover that by slicing the flat list into equal chunks, which assumes a row-major
      // flattening this walk does not produce — see toSubmittedStep for the full story.
      sequence: fullSequence.map(toSubmittedStep),
      cleanup: resolvedCleanup,
    };
  };

  // A stage keeps what is typed as it is typed: no Save. A moment after the last keystroke, the
  // values and the run they make (or what is still missing) go to the Stages page's draft.
  useEffect(() => {
    if (!keepStage.current) return;
    const timer = setTimeout(() => {
      keepStage.current?.({ rows, batchSize, globalValues }, () => ({ name: '', ...buildBody() }));
    }, 300);
    return () => clearTimeout(timer);
  }, [rows, batchSize, globalValues, sequence]); // eslint-disable-line react-hooks/exhaustive-deps

  const executeSpreadsheet = async () => {
    if (sequence.length === 0 && prepSequence.length === 0 && cleanupSequence.length === 0) return;
    
    setExecutionState({ isRunning: true, currentRow: -1, results: [] });

    try {
      let body: ReturnType<typeof buildBody>;
      try {
        body = buildBody();
      } catch (err: any) {
        setExecutionState({ isRunning: false, currentRow: -1, results: [] });
        await notify(err.message, {
          title: err.message.startsWith('Fill in') ? 'Nothing to run' : 'Missing a value',
          tone: 'error',
        });
        return;
      }

      // Submit
      const payload = {
        // Editing keeps the queued run's name unless a new one is typed.
        name: editing ? experimentName.trim() : await buildRunName(`${localStorage.getItem('ivoryos_editing_workflow') || 'Spreadsheet'} Run`, experimentName, API_BASE),
        ...body,
      };

      if (editing) {
        await saveQueuedRun(editing.id, payload);
        await notify(`"${editing.name}" is updated and keeps its place in the queue.`, { title: 'Queued run saved' });
        leaveEdit();
        return;
      }

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

  // Embedded in the Stages page, only the configuration itself is drawn: that page has the
  // sidebar, the tabs and the run bar.
  return (
    <div className={stage ? 'text-gray-900 dark:text-white' : `flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {/* Sidebar */}
      {!stage && <Sidebar />}

      {/* Main Area */}
      <div className={stage ? '' : 'flex-1 flex flex-col relative z-0'}>
        {!stage && <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-3 px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <RunTabs active={once ? 'once' : 'configure'} />
          {!once && variables.length > 0 && (
            <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-white/5 px-2 py-0.5 rounded-full">
              {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
            </span>
          )}
        </header>}

        <div className={stage ? '' : 'p-8 flex-1 overflow-y-auto pb-12'}>
          {editing && (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-gray-300 bg-gray-100 px-4 py-2.5 text-sm text-gray-800 dark:border-white/15 dark:bg-white/10 dark:text-gray-100">
              <span className="flex-1 min-w-0">
                Editing the queued run <b className="font-semibold">{editing.name}</b>. Save changes to replace it; it keeps its place in the queue.
              </span>
              <button type="button" onClick={leaveEdit} className="shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-white dark:text-gray-300 dark:hover:bg-white/10">Cancel</button>
            </div>
          )}
          {!stage && !editing && stageCount > 0 && (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs text-gray-600 dark:border-white/10 dark:bg-white/5 dark:text-gray-300">
              <span className="flex-1 min-w-0">
                This design uses saved workflows. Here only their main steps run, sharing one {once ? 'form' : 'table'}; their own prep and cleanup do not.
                To run each one whole, with its own settings, set it up in stages.
              </span>
              <Link href="/stages" className="shrink-0 font-semibold text-accent-fg hover:underline">Set up in {stageCount} stages</Link>
            </div>
          )}
          {/* The Designer marks the step itself; this only says why the run below would fail. */}
          {hasEmptyHashVar && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span className="min-w-0 truncate"><span className="font-mono text-xs">{hasEmptyHashVar}</span> has a <code className="font-mono">#</code> with no name.</span>
              <Link href="/designer" className="ml-auto shrink-0 font-semibold underline-offset-2 hover:underline">Fix in Designer</Link>
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
                       if (!editingRef.current) localStorage.setItem('ivoryos_global_values', JSON.stringify(updated));
                     }}
                     title={guardProblem(varGuards[v], globalValues[v], safety)
                       ? `${globalValues[v]} ${guardProblem(varGuards[v], globalValues[v], safety)}`
                       : isInvalidNumericCell(v, globalValues[v]) ? `Expects a number (${varTypes[v]})`
                       : (varGuards[v] || []).map(g => guardHint(g, safety)).filter(Boolean).join(' · ') || undefined}
                     className={`w-36 bg-white dark:bg-black/50 border rounded-md px-2 py-1 text-sm outline-none ${
                       isInvalidNumericCell(v, globalValues[v]) || guardProblem(varGuards[v], globalValues[v], safety)
                         ? 'border-red-400 dark:border-red-500/60'
                         : 'border-amber-300 dark:border-amber-700/50 focus:border-amber-500'
                     }`}
                  />
                  {varUnits[v] && <span className="text-xs text-amber-700/80 dark:text-amber-300/80">{varUnits[v]}</span>}
                </div>
              ))}
            </div>
          )}

          {!once && <div className="flex items-center gap-3 mb-4">
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
          </div>}

          {once ? (
            variables.length === 0 ? (
              <div className="rounded-xl border-2 border-dashed border-gray-300 dark:border-white/10 px-6 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                {sequence.length || prepSequence.length || cleanupSequence.length
                  ? (globalVariables.length ? 'Fill in the fixed values above, then run.' : 'Nothing to fill in: this workflow runs as it is.')
                  : <>Nothing to run yet. Build a workflow in the <Link href="/designer" className="underline underline-offset-2">Designer</Link>.</>}
              </div>
            ) : (
              <section className="max-w-xl rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">Values for this run</h3>
                {variables.map(v => {
                  const value = String(rows[0]?.[v] ?? '');
                  const field = 'flex-1 min-w-0 px-3 py-2 rounded-lg text-sm bg-white border border-gray-200 text-gray-800 focus:outline-none focus:border-accent dark:bg-black/40 dark:border-white/10 dark:text-gray-100';
                  // What the safety guard allows for this value, said under the field as it is typed.
                  const guards = varGuards[v] || [];
                  const refused = guardProblem(guards, value, safety);
                  const hint = guards.map(g => guardHint(g, safety)).filter(Boolean).join(' · ');
                  const tray = trayForGuards(guards, safety);
                  return (
                    <div key={v}>
                    <div className="flex items-center gap-3">
                      <label htmlFor={`once-${stage ? `${stage.index}-` : ''}${v}`} className="w-40 shrink-0 truncate font-mono text-sm text-gray-800 dark:text-gray-200" title={v}>{v}</label>
                      {varOptions[v] ? (
                        <select id={`once-${stage ? `${stage.index}-` : ''}${v}`} value={value} onChange={e => updateRow(0, v, e.target.value)} className={`${field} ${refused ? '!border-red-400' : ''}`}>
                          <option value="" disabled>Select {v}</option>
                          {varOptions[v].map((opt: any) => <option key={String(opt)} value={String(opt)}>{String(opt)}</option>)}
                        </select>
                      ) : (
                        <SuggestInput id={`once-${stage ? `${stage.index}-` : ''}${v}`} value={value} onChange={e => updateRow(0, v, e.target.value)}
                          suggestions={guards.flatMap(g => guardSuggestions(g, safety))}
                          className={`${field} ${isInvalidNumericCell(v, value) || refused ? '!border-red-400' : ''}`} />
                      )}
                      {tray && (
                        <button type="button" onClick={() => setPickingTray(v)} title={tray.choices ? 'Pick a plate and its wells' : `Pick a position on ${tray.tray.label}`}
                          className="shrink-0 rounded-lg border border-gray-200 p-2 text-gray-500 hover:bg-gray-50 hover:text-gray-800 dark:border-white/10 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-100">
                          <Grid3x3 className="h-4 w-4" />
                        </button>
                      )}
                      {(varTypes[v] || varUnits[v]) && <span className="shrink-0 whitespace-nowrap text-xs text-gray-400">{[varTypes[v], varUnits[v]].filter(Boolean).join(' · ')}</span>}
                    </div>
                    {(refused || hint) && (
                      <p className={`mt-1 pl-[10.75rem] text-xs ${refused ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-gray-500'}`}>
                        {refused ? `${value} ${refused}` : hint}
                      </p>
                    )}
                    </div>
                  );
                })}
              </section>
            )
          ) : variables.length === 0 && globalVariables.length === 0 ? (
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
              varUnits={varUnits}
              varOptions={varOptions}
              batchVariables={batchVariables}
              rowListVariables={listVariables}
              batchSize={batchSize}
              showBatchGrouping={hasBatchStep || hasBatchSize}
              idPrefix={stage ? `stage-${stage.index}` : 'configure'}
              varGuards={varGuards}
              safety={safety}
              onFillColumn={fillColumn}
            />
          )}

          {!once && !stage && variables.length > 0 && (
            // Advanced: end the run once a sample reaches a target, instead of running every row.
            <div className="mt-4 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111111] p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={stopEarly.on}
                  onChange={e => setStopEarly(s => ({
                    ...s, on: e.target.checked,
                    conditions: e.target.checked && !s.conditions.length && resultNames.length ? [{ metric: resultNames[0], op: '>=', threshold: '' }] : s.conditions,
                  }))}
                  className="w-3.5 h-3.5 accent-gray-900 dark:accent-white"
                />
                <Target className="w-4 h-4 text-gray-400" />
                Stop early when a sample reaches a target
                <span className="text-xs font-normal text-gray-400">(optional)</span>
              </label>
              {stopEarly.on && (
                <div className="mt-2 pl-6 space-y-2">
                  {resultNames.length === 0 ? (
                    <p className="text-xs text-gray-500 dark:text-gray-400">No step saves a result to compare. Save one in the Designer (a step&apos;s output name), then come back.</p>
                  ) : (
                    <>
                      {stopEarly.conditions.map((c, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          <select value={c.metric} onChange={e => setCondition(i, { metric: e.target.value })}
                            className="h-8 bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-md px-2 text-xs font-mono outline-none focus:border-accent">
                            {!resultNames.includes(c.metric) && <option value={c.metric}>{c.metric || 'choose a result'}</option>}
                            {resultNames.map(name => <option key={name} value={name}>{name}</option>)}
                          </select>
                          <select value={c.op} onChange={e => setCondition(i, { op: e.target.value === '<=' ? '<=' : '>=' })}
                            className="h-8 bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-md px-2 text-xs outline-none focus:border-accent">
                            <option value=">=">at least (≥)</option>
                            <option value="<=">at most (≤)</option>
                          </select>
                          <input type="text" inputMode="decimal" placeholder="value" value={c.threshold} onChange={e => setCondition(i, { threshold: e.target.value })}
                            className={`h-8 w-24 bg-white dark:bg-black border rounded-md px-2 text-xs font-mono outline-none focus:border-accent ${c.threshold.trim() && !Number.isFinite(Number(c.threshold)) ? 'border-red-300 dark:border-red-500/50' : 'border-gray-200 dark:border-white/10'}`} />
                          <button type="button" title="Remove this condition" onClick={() => setStopEarly(s => ({ ...s, conditions: s.conditions.filter((_, j) => j !== i) }))}
                            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                        <button type="button" onClick={() => setStopEarly(s => ({ ...s, conditions: [...s.conditions, { metric: resultNames[0], op: '>=', threshold: '' }] }))}
                          className="inline-flex items-center gap-1 font-medium text-accent-fg hover:text-accent">
                          <Plus className="w-3.5 h-3.5" /> Add condition
                        </button>
                        {stopEarly.conditions.length > 1 && (
                          <label className="inline-flex items-center gap-1.5">
                            Stop when
                            <select value={stopEarly.mode} onChange={e => setStopEarly(s => ({ ...s, mode: e.target.value === 'all' ? 'all' : 'any' }))}
                              className="h-7 bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-md px-1.5 text-xs outline-none">
                              <option value="any">any one is met</option>
                              <option value="all">all are met</option>
                            </select>
                            by the same sample
                          </label>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 dark:text-gray-500">
                        Checked as each sample finishes (in batches, once its batch has). The samples after it are skipped; cleanup still runs.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {(once || variables.length > 0 || globalVariables.length > 0) && (
            // Once: under its form, not at the far edge of the page.
            <div className={`flex flex-col items-end pt-4 gap-2 ${once ? 'max-w-xl' : ''}`}>
              <div className="flex items-center gap-2">
                {!once && variables.length > 0 && (
                  <div className="flex items-center gap-2" title={`How many spreadsheet rows make up one batch. Within a batch, each step runs for every row before the next step starts${hasBatchStep ? ', and batch steps run once for the whole batch' : ''}. Blank or 1 runs each row start to finish.`}>
                    <Layers className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                    <label className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider whitespace-nowrap">Batch Size</label>
                    <input
                      type="number"
                      min="1"
                      placeholder="1"
                      value={batchSize}
                      onChange={e => setBatchSize(e.target.value)}
                      className="w-16 px-2 py-2 rounded-lg text-sm bg-white border border-gray-200 text-gray-700 focus:outline-none focus:border-purple-400 dark:bg-black/50 dark:border-white/10 dark:text-gray-200"
                    />
                  </div>
                )}
                {!stage && <input
                  type="text"
                  value={experimentName}
                  onChange={e => setExperimentName(e.target.value)}
                  placeholder="Experiment name (optional)"
                  title="Shown in Data History instead of the default run label"
                  className="w-56 px-3 py-2 rounded-lg text-sm bg-white border border-gray-200 text-gray-700 placeholder:text-gray-400 focus:outline-none focus:border-green-400 dark:bg-black/50 dark:border-white/10 dark:text-gray-200 dark:placeholder:text-gray-500"
                />}
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
              {!stage && <button
                  onClick={async () => {
                      if (hasPendingRuns && !editing) {
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
                  <span>{editing ? 'Save changes' : hasPendingRuns ? 'Add to Queue' : 'Run'}</span>
                </button>}
            </div>
          )}
        </div>
        {/* Below the scrolling page, where the idle chip is: pressing Run widens the chip into the
            run bar, so it is watched where it started and never a scroll away. */}
        {!stage && <LiveRun />}
      </div>

      {pickingTray && trayForGuards(varGuards[pickingTray], safety) && (() => {
        const found = trayForGuards(varGuards[pickingTray], safety)!;
        const value = String(rows[0]?.[pickingTray] ?? '');
        // A wells value names its plate too (`plate[A1:H1]`): choose both, and any number of wells.
        const start = found.choices ? referenceStart(value, found.choices) : null;
        return (
          <TrayPicker
            tray={start?.choice?.tray ?? found.tray}
            choices={found.choices}
            title={pickingTray}
            multiple={!!found.choices}
            initial={start ? start.positions : [value]}
            onPick={(positions, choice) => updateRow(0, pickingTray, choice && found.choices
              ? formatReference(choice, positions)
              : positions[0])}
            onClose={() => setPickingTray(null)}
          />
        );
      })()}

      <WorkflowMap
        isOpen={isMapOpen}
        onClose={() => setIsMapOpen(false)}
        fetchExpansion={fetchExpansion}
        spreadsheet={once ? { rows: 1, batchSize: 1 } : {
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
