"use client";

import React, { useMemo, useState } from 'react';
import { X, Copy, Play, AlertCircle, Repeat, Rows3, Hash, FlaskConical, CalendarClock, CheckCircle2 } from 'lucide-react';
import {
  SpreadsheetTable,
  estimateRunSeconds,
  formatDuration,
  runtimeSummary,
  getIterationValue,
  getVarModeType,
  isPerIteration,
  type OptimizeConfig,
  type SpreadsheetRow,
  type WorkflowRuntime,
} from '@ivoryos/shared-ui';
import type { NodeCadence, RunMode } from '@/lib/runPayload';

/**
 * Supplies what a run needs from each node before it is dispatched.
 *
 * The load-bearing decision here is that configuration is **per node, not per variable name**.
 * Two steps both written as `#temperature` are two separate screens of the same protocol, and the
 * whole reason to drop the same sequence onto the canvas twice is to run it at two different
 * temperatures. Keying these values globally by variable name — which is what the first pass did —
 * silently forces them to be equal, and the graph gives no hint that it happened. So each node
 * owns its own values, and identical configuration between two nodes is something you ask for
 * (`Copy from`) rather than something you cannot escape.
 *
 * A node can be configured three ways, and the choice is the node's, not the canvas's — which is
 * the real difference between this and the edge's Configure page. The edge screen configures *one*
 * workflow, so it can afford a full viewport per control. Here, one graph routinely holds a
 * spreadsheet screen on one instrument and a Bayesian campaign on another, so each node gets a
 * compact card and only the mode it is actually in is expanded. The controls inside those cards
 * are the edge's own (`SpreadsheetTable`, and the same `OptimizeConfig` shape its Optimize page
 * builds), so the two screens cannot come to disagree about what a configuration means.
 */

export interface ConfigurableNode {
  id: string;
  label: string;
  deviceId: string;
  /** Distinct #names this node references, in the order its params declare them. */
  vars: string[];
  /** Declared type per #name, where the schema states one — drives the numeric warnings. */
  varTypes: Record<string, string>;
  /** How this node turns into work. */
  mode: RunMode;
  /** Single mode: one value per #name. */
  values: Record<string, string>;
  /** Spreadsheet mode: one row per sample. */
  rows: SpreadsheetRow[];
  /** Spreadsheet mode: rows per batch group (blank = each sample runs the whole workflow in turn). */
  batchSize: string;
  /** Whether this node runs a saved workflow (only those have batch steps to group). */
  isWorkflow: boolean;
  /** Optimization mode: the same config shape the edge Optimize page builds. */
  optimization: OptimizeConfig & { objectives_order?: string[] };
  /** Optimizer backends the *target device* actually has, from its published schema. */
  optimizerCatalog: Record<string, any>;
  /** Output variable names this node can optimize against. */
  objectiveOptions: string[];
  /** Per-node cadence: re-run this step every N minutes, M times, inside the one run. */
  schedule: NodeCadence;
  /** How long this workflow usually takes on its device, from the device's own runs. */
  runtime?: WorkflowRuntime | null;
}

interface Props {
  nodes: ConfigurableNode[];
  onChange: (nodeId: string, varName: string, value: string) => void;
  onCopy: (fromNodeId: string, toNodeId: string) => void;
  onModeChange: (nodeId: string, mode: RunMode) => void;
  onRowsChange: (nodeId: string, rows: SpreadsheetRow[]) => void;
  onOptimizationChange: (nodeId: string, config: OptimizeConfig & { objectives_order?: string[] }) => void;
  onScheduleChange: (nodeId: string, schedule: NodeCadence) => void;
  onBatchSizeChange: (nodeId: string, batchSize: string) => void;
  /** The experiment's name: the whole run, every step on every device, goes by it. */
  experimentName: string;
  experimentNamePlaceholder: string;
  onExperimentNameChange: (name: string) => void;
  onCancel: () => void;
  onRun: () => void;
  /** Offered alongside Run so a configured graph can become a recurring trigger without retyping. */
  onSchedule?: () => void;
}

const isBlank = (v: unknown) => !String(v ?? '').trim();
const rowHasContent = (row: SpreadsheetRow) => Object.values(row || {}).some((v) => !isBlank(v));

const MODE_LABELS: Record<RunMode, { label: string; hint: string; icon: React.ReactNode }> = {
  single: {
    label: 'Once',
    hint: 'Run this step one time with the values below.',
    icon: <Hash size={12} />,
  },
  spreadsheet: {
    label: 'Iterate',
    hint: 'Run this step once per row — the edge Configure page’s spreadsheet, for one node.',
    icon: <Rows3 size={12} />,
  },
  optimization: {
    label: 'Optimize',
    hint: 'Run a Bayesian campaign on the target device: it suggests, runs, observes, repeats.',
    icon: <FlaskConical size={12} />,
  },
};

const input =
  'rounded border border-gray-300 bg-transparent px-2 py-1 text-sm outline-none focus:border-blue-500 dark:border-gray-600';
const sectionTitle = 'text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1.5';
/** The inside of a Field: borderless, so the Field's own box is the only outline. */
const fieldInput =
  'bg-transparent text-xs text-gray-800 outline-none placeholder:text-gray-300 dark:text-gray-100 dark:placeholder:text-gray-600';
const smallControl =
  'min-w-0 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-400 dark:border-white/10 dark:bg-black/40';

/**
 * A labelled value in one small box -- the same `name | value` field a step's arguments use in the
 * Designer, so a form here reads like the step it configures rather than like a separate page.
 */
function Field({ label, title, invalid, children }: {
  label: string; title?: string; invalid?: boolean; children: React.ReactNode;
}) {
  return (
    <label
      title={title}
      className={`flex items-center gap-2 rounded-md border bg-white px-2 py-1 dark:bg-[#1a1a1a] ${
        invalid ? 'border-red-400 dark:border-red-500/70' : 'border-gray-200 dark:border-white/10'
      }`}
    >
      <span className="whitespace-nowrap text-[11px] font-medium text-gray-500 dark:text-gray-400">{label}</span>
      <span className="flex items-center border-l border-gray-200 pl-2 dark:border-white/10">{children}</span>
    </label>
  );
}

/**
 * What this node's configured run will take, from the device's own history of the workflow.
 * Null when there is no history yet -- a guess would be worse than saying nothing.
 */
function estimateFor(node: ConfigurableNode): string | null {
  const rt = node.runtime;
  if (!rt?.runs) return null;
  if (node.mode === 'spreadsheet') {
    const rows = node.rows.filter(rowHasContent).length || 1;
    return `≈ ${formatDuration(estimateRunSeconds(rt, rows))} for ${rows} row${rows === 1 ? '' : 's'}`;
  }
  if (node.mode === 'optimization') {
    const trials = Math.max(1, node.optimization?.budget || 1);
    return `≈ ${formatDuration(estimateRunSeconds(rt, trials))} for ${trials} trial${trials === 1 ? '' : 's'}`;
  }
  if (backToBackIterations(node) > 1) {
    const n = backToBackIterations(node);
    return `≈ ${formatDuration(estimateRunSeconds(rt, n))} for ${n} iterations`;
  }
  return null;
}

/** Back to back (no interval): one run of this many iterations. 1 when it is not repeated. */
function backToBackIterations(node: ConfigurableNode) {
  return isBlank(node.schedule.everyMinutes) && Number(node.schedule.repeat) >= 2 ? Math.floor(Number(node.schedule.repeat)) : 1;
}

/**
 * What a repeat cadence adds up to, given how long one run takes. The wait is counted from when a
 * run *finishes*, so "every 5 min" on a 10-minute workflow starts one about every 15 minutes --
 * which is exactly the kind of thing to say before it runs, not discover after.
 */
function cadenceNote(node: ConfigurableNode): { text: string; warn: boolean } | null {
  const rt = node.runtime;
  const count = Number(node.schedule.repeat);
  if (!rt?.runs || !(count >= 2)) return null;
  const run = rt.typical_s;
  const wait = Math.max(0, Number(node.schedule.everyMinutes) || 0) * 60;
  const total = count * run + (count - 1) * wait;
  if (!wait) {
    return {
      text: `One run: prep once, ${count} iterations, cleanup once ≈ ${formatDuration(estimateRunSeconds(rt, count))}.`,
      warn: false,
    };
  }
  const period = formatDuration(run + wait);
  return {
    text: `Each run takes ~${formatDuration(run)} and the wait starts when it ends, so one begins about every ${period}; ${count} runs ≈ ${formatDuration(total)}.`,
    warn: wait < run,
  };
}

/** Everything still unanswered for one node, so Run can say how much is left in one number. */
function unfilledCount(node: ConfigurableNode): number {
  if (node.mode === 'single') return node.vars.filter((v) => isBlank(node.values[v])).length;
  if (node.mode === 'spreadsheet') {
    const rows = node.rows.filter(rowHasContent);
    if (rows.length === 0) return Math.max(1, node.vars.length);
    return rows.reduce((n, row) => n + node.vars.filter((v) => isBlank(row[v])).length, 0);
  }
  let missing = node.optimization?.optimizer ? 0 : 1;
  if (!(node.optimization?.objectives_order || []).length) missing += 1;
  for (const v of node.vars) {
    const bound = node.optimization?.bounds?.[v] || {};
    if (isPerIteration(node.optimization, v)) {
      const budget = Math.max(1, node.optimization?.budget || 1);
      for (let i = 0; i < budget; i++) if (isBlank(getIterationValue(node.optimization, v, i))) missing += 1;
      continue;
    }
    const kind = getVarModeType(node.optimization, v);
    if (kind === 'fixed' && isBlank(bound.fixedValue)) missing += 1;
    if (kind === 'range' && (isBlank(bound.min) || isBlank(bound.max))) missing += 1;
    if (kind === 'choice' && isBlank(bound.min)) missing += 1;
  }
  return missing;
}

export default function RunConfigPanel({
  nodes,
  onChange,
  onCopy,
  onModeChange,
  onRowsChange,
  onOptimizationChange,
  onScheduleChange,
  onBatchSizeChange,
  experimentName,
  experimentNamePlaceholder,
  onExperimentNameChange,
  onCancel,
  onRun,
  onSchedule,
}: Props) {
  const [copySource, setCopySource] = useState<Record<string, string>>({});

  const unfilled = useMemo(() => nodes.reduce((n, node) => n + unfilledCount(node), 0), [nodes]);

  // A node can only take another's values if they describe the same inputs. Same-named variables
  // in a different order are still the same set, so compare as a set rather than by position.
  const donorsFor = (node: ConfigurableNode) => {
    const key = [...node.vars].sort().join(' ');
    return nodes.filter((other) =>
      other.id !== node.id
      && [...other.vars].sort().join(' ') === key
      && other.vars.some((v) => !isBlank(other.values[v])));
  };

  const patchOptimization = (node: ConfigurableNode, patch: Partial<OptimizeConfig & { objectives_order?: string[] }>) =>
    onOptimizationChange(node.id, { ...node.optimization, ...patch });

  const patchBound = (node: ConfigurableNode, varName: string, patch: Record<string, any>) =>
    patchOptimization(node, {
      bounds: { ...node.optimization.bounds, [varName]: { ...node.optimization.bounds?.[varName], ...patch } },
    });

  const setIterationValue = (node: ConfigurableNode, varName: string, index: number, value: string) => {
    const values = [...(node.optimization.bounds?.[varName]?.iterationValues || [])];
    while (values.length <= index) values.push('');
    values[index] = value;
    patchBound(node, varName, { iterationValues: values });
  };

  /** max / min set the direction and make it an objective; none removes it from the objectives. */
  const setObjectiveGoal = (node: ConfigurableNode, name: string, goal: 'maximize' | 'minimize' | 'none') => {
    const order = node.optimization.objectives_order || [];
    if (goal === 'none') {
      patchOptimization(node, { objectives_order: order.filter((n) => n !== name) });
      return;
    }
    patchOptimization(node, {
      objectives_order: order.includes(name) ? order : [...order, name],
      objectives: { ...node.optimization.objectives, [name]: { ...node.optimization.objectives?.[name], goal } },
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-xl bg-white shadow-2xl dark:bg-[#1a1a1a]">
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold">Configure run</h2>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              Each step is configured separately: once (or repeated), once per row, or as a
              search. The whole run is one experiment, named below.
            </p>
          </div>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {nodes.map((node) => {
            const donors = donorsFor(node);
            return (
              <div key={node.id} className="rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{node.label}</div>
                    <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                      {node.deviceId || 'Unassigned'}
                      {node.runtime?.runs ? (
                        <span
                          title={`Median of its recent completed runs on this device: prep ${formatDuration(node.runtime.prep_s)}, body ${formatDuration(node.runtime.iteration_s)} per pass, cleanup ${formatDuration(node.runtime.cleanup_s)}`}
                        >
                          {' · '}{runtimeSummary(node.runtime)}
                        </span>
                      ) : null}
                      {estimateFor(node) && (
                        <span className="text-gray-700 dark:text-gray-300">{' · '}{estimateFor(node)}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    {/* Iterate and optimize need something that varies; a step with no #values
                        can only run once (or repeat). */}
                    {node.vars.length > 0 && (
                    <div className="flex rounded-md border border-gray-300 p-0.5 dark:border-gray-600">
                      {(Object.keys(MODE_LABELS) as RunMode[]).map((mode) => (
                        <button
                          key={mode}
                          title={MODE_LABELS[mode].hint}
                          onClick={() => onModeChange(node.id, mode)}
                          className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                            node.mode === mode
                              ? 'bg-blue-600 text-white'
                              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                          }`}
                        >
                          {MODE_LABELS[mode].icon}
                          {MODE_LABELS[mode].label}
                        </button>
                      ))}
                    </div>
                    )}

                    {node.mode === 'single' && donors.length > 0 && (
                      <div className="flex items-center gap-1.5">
                        <Copy size={13} className="text-gray-400" />
                        <select
                          aria-label={`Copy configuration into ${node.label}`}
                          className="max-w-[150px] rounded border border-gray-300 bg-transparent px-1.5 py-1 text-xs dark:border-gray-600"
                          value={copySource[node.id] || ''}
                          onChange={(e) => {
                            const from = e.target.value;
                            setCopySource((sourceMap) => ({ ...sourceMap, [node.id]: from }));
                            if (from) onCopy(from, node.id);
                          }}
                        >
                          <option value="">Copy from…</option>
                          {donors.map((d) => {
                            // Told apart by device, not by internal node id; a number only when two
                            // steps share both a name and a device.
                            const twins = donors.filter((o) => o.label === d.label && o.deviceId === d.deviceId);
                            const nth = twins.length > 1 ? ` (${twins.indexOf(d) + 1})` : '';
                            return (
                              <option key={d.id} value={d.id}>{d.label} · {d.deviceId || 'Unassigned'}{nth}</option>
                            );
                          })}
                        </select>
                      </div>
                    )}
                  </div>
                </div>

                {node.mode === 'single' && node.vars.length > 0 && (
                  <div className="flex flex-wrap gap-2 px-4 py-3">
                    {node.vars.map((varName) => (
                      <Field key={varName} label={varName} invalid={isBlank(node.values[varName])}>
                        <input
                          type="text"
                          value={node.values[varName] ?? ''}
                          placeholder={node.varTypes[varName] || 'value'}
                          onChange={(e) => onChange(node.id, varName, e.target.value)}
                          className={`${fieldInput} w-28`}
                        />
                      </Field>
                    ))}
                  </div>
                )}

                {node.mode === 'spreadsheet' && (
                  <div className="space-y-2 px-4 py-3">
                    <SpreadsheetTable
                      compact
                      idPrefix={`cloud-${node.id}`}
                      variables={node.vars}
                      varTypes={node.varTypes}
                      rows={node.rows}
                      batchSize={node.batchSize}
                      showBatchGrouping={!isBlank(node.batchSize)}
                      onRowChange={(rowIndex, varName, value) => {
                        const next = node.rows.map((r, i) => (i === rowIndex ? { ...r, [varName]: value } : r));
                        onRowsChange(node.id, next);
                      }}
                      onAddRow={() => onRowsChange(node.id, [...node.rows, {}])}
                      onRemoveRow={(rowIndex) =>
                        onRowsChange(node.id, node.rows.filter((_, i) => i !== rowIndex))}
                    />
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                      {node.isWorkflow && (
                        <>
                          <span>batch size</span>
                          <input
                            type="number"
                            min={1}
                            placeholder="—"
                            value={node.batchSize}
                            onChange={(e) => onBatchSizeChange(node.id, e.target.value)}
                            title="Rows per batch: the workflow's per-sample steps run for each row of a batch, its batch steps once per batch"
                            className={`${input} w-16`}
                          />
                        </>
                      )}
                      <span className="basis-full sm:basis-auto">
                        {node.isWorkflow && !isBlank(node.batchSize)
                          ? `Rows run in batches of ${node.batchSize}: each step of the workflow runs for every row in the batch, batch steps once per batch.`
                          : `Each row runs the whole ${node.isWorkflow ? 'workflow' : 'step'} on ${node.deviceId || 'its device'}, in order.`}
                      </span>
                    </div>
                  </div>
                )}

                {node.mode === 'optimization' && (() => {
                  const opt = node.optimization;
                  const catalog = Object.keys(node.optimizerCatalog || {});
                  const perIterationVars = node.vars.filter((v) => isPerIteration(opt, v));
                  const budget = Math.max(1, opt.budget || 1);
                  // Laid out like the edge Optimize page -- search-space cards with a per-iteration
                  // switch, a per-iteration table, objective cards -- at a size that fits several
                  // nodes in one dialog.
                  return (
                    <div className="space-y-3 px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Field label="optimizer" invalid={!opt.optimizer}>
                          <select
                            value={opt.optimizer || ''}
                            onChange={(e) => patchOptimization(node, { optimizer: e.target.value })}
                            className={`${fieldInput} w-28`}
                          >
                            <option value="">choose…</option>
                            {catalog.map((name) => <option key={name} value={name}>{name}</option>)}
                          </select>
                        </Field>
                        <Field label="budget" title="How many trials this campaign runs in total">
                          <input
                            type="number" min={1} value={opt.budget ?? 25}
                            onChange={(e) => patchOptimization(node, { budget: parseInt(e.target.value) || 1 })}
                            className={`${fieldInput} w-12`}
                          />
                        </Field>
                        <Field label="batch" title="Trials suggested and observed together as one round">
                          <input
                            type="number" min={1} value={opt.batch_size ?? 1}
                            onChange={(e) => patchOptimization(node, { batch_size: parseInt(e.target.value) || 1 })}
                            className={`${fieldInput} w-10`}
                          />
                        </Field>
                        {catalog.length === 0 && (
                          <span className="text-xs text-amber-600 dark:text-amber-400">
                            {node.deviceId || 'This device'} has not reported any optimizer backends.
                          </span>
                        )}
                      </div>

                      <div>
                        <div className={sectionTitle}>Search space</div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {node.vars.map((varName) => {
                            const bound = opt.bounds?.[varName] || {};
                            const kind = getVarModeType(opt, varName);
                            const perIter = isPerIteration(opt, varName);
                            return (
                              <div key={varName} className="min-w-0 space-y-1.5 rounded-lg border border-gray-100 bg-gray-50/60 p-2.5 dark:border-white/5 dark:bg-white/[0.02]">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-400">{varName}</span>
                                  <label
                                    className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-[11px] font-medium text-teal-700 dark:text-teal-400"
                                    title="A different value each iteration, from the table below, instead of a search range or one fixed value"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={perIter}
                                      onChange={(e) => patchBound(node, varName, { perIteration: e.target.checked })}
                                      className="h-3 w-3 accent-teal-600"
                                    />
                                    per-iteration
                                  </label>
                                </div>
                                {perIter ? (
                                  <p className="text-[11px] italic text-teal-600 dark:text-teal-400">set in the table below</p>
                                ) : (
                                  <div className="flex gap-1.5">
                                    <select
                                      aria-label={`How ${varName} is searched`}
                                      value={kind}
                                      onChange={(e) => {
                                        const value = e.target.value as 'range' | 'choice' | 'fixed';
                                        patchBound(node, varName, {
                                          mode: value === 'fixed' ? 'fixed' : 'optimize',
                                          ...(value !== 'fixed' ? { type: value } : {}),
                                        });
                                      }}
                                      className={`${smallControl} w-20 shrink-0`}
                                    >
                                      <option value="range">range</option>
                                      <option value="choice">choice</option>
                                      <option value="fixed">fixed</option>
                                    </select>
                                    {kind === 'range' && (
                                      <>
                                        <input
                                          aria-label={`${varName} minimum`} placeholder="min" value={bound.min ?? ''}
                                          onChange={(e) => patchBound(node, varName, { min: e.target.value })}
                                          className={`${smallControl} flex-1`}
                                        />
                                        <input
                                          aria-label={`${varName} maximum`} placeholder="max" value={bound.max ?? ''}
                                          onChange={(e) => patchBound(node, varName, { max: e.target.value })}
                                          className={`${smallControl} flex-1`}
                                        />
                                      </>
                                    )}
                                    {kind === 'choice' && (
                                      <input
                                        aria-label={`${varName} options`} placeholder="e.g. 10, 20"
                                        value={bound.min ?? ''}
                                        onChange={(e) => patchBound(node, varName, { min: e.target.value })}
                                        className={`${smallControl} flex-1`}
                                      />
                                    )}
                                    {kind === 'fixed' && (
                                      <input
                                        aria-label={`${varName} fixed value`}
                                        placeholder={node.varTypes[varName] || 'value'}
                                        value={bound.fixedValue ?? ''}
                                        onChange={(e) => patchBound(node, varName, { fixedValue: e.target.value })}
                                        className={`${smallControl} flex-1`}
                                      />
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {perIterationVars.length > 0 && (
                        <div>
                          <div className={sectionTitle}>Per-iteration values</div>
                          <div className="max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-white/10">
                            <table className="w-full border-collapse text-left text-xs">
                              <thead className="sticky top-0 bg-gray-50 dark:bg-[#141414]">
                                <tr className="border-b border-gray-200 text-gray-500 dark:border-white/10 dark:text-gray-400">
                                  <th className="w-16 p-1.5 text-center font-medium">iteration</th>
                                  {perIterationVars.map((v) => (
                                    <th key={v} className="border-l border-gray-200 p-1.5 font-mono font-medium text-teal-600 dark:border-white/10 dark:text-teal-400">{v}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {Array.from({ length: budget }).map((_, i) => (
                                  <tr key={i} className="border-b border-gray-100 dark:border-white/5">
                                    <td className="p-1 text-center text-gray-400">{i + 1}</td>
                                    {perIterationVars.map((v) => (
                                      <td key={v} className="border-l border-gray-100 p-0.5 dark:border-white/5">
                                        <input
                                          value={getIterationValue(opt, v, i)}
                                          placeholder={node.varTypes[v] || 'value'}
                                          onChange={(e) => setIterationValue(node, v, i, e.target.value)}
                                          className={`${fieldInput} w-full px-1.5 py-1`}
                                        />
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}

                      <div>
                        <div className={sectionTitle}>Objectives</div>
                        {node.objectiveOptions.length === 0 ? (
                          <p className="text-xs text-amber-600 dark:text-amber-400">
                            This step records no output variable, so there is nothing to optimise
                            against. Give a step in the workflow a return variable first.
                          </p>
                        ) : (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {node.objectiveOptions.map((name) => {
                              const chosen = (opt.objectives_order || []).includes(name);
                              const goal = chosen ? (opt.objectives?.[name]?.goal || 'maximize') : 'none';
                              return (
                                <div key={name} className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-gray-100 bg-gray-50/60 px-2.5 py-1.5 dark:border-white/5 dark:bg-white/[0.02]">
                                  <span className={`truncate font-mono text-xs font-semibold ${chosen ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}`}>{name}</span>
                                  <select
                                    aria-label={`Objective direction for ${name}`}
                                    value={goal}
                                    onChange={(e) => setObjectiveGoal(node, name, e.target.value as 'maximize' | 'minimize' | 'none')}
                                    className={`${smallControl} w-20 shrink-0`}
                                  >
                                    <option value="maximize">max</option>
                                    <option value="minimize">min</option>
                                    <option value="none">none</option>
                                  </select>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Per-node cadence. Two instruments on different timelines is the case this
                    exists for: one node every 20 minutes and another every 35, in one graph,
                    instead of someone re-triggering each of them by hand on its own edge.
                    Once-mode only: an iterating step already repeats, row by row or trial by
                    trial, and its run is a whole campaign rather than one call to put on a clock. */}
                {node.mode === 'single' && (
                <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 px-4 py-2 text-xs dark:border-gray-700">
                  <Repeat size={13} className="text-gray-400" />
                  <span className="text-gray-500 dark:text-gray-400">Repeat this step every</span>
                  <input
                    type="number"
                    min={1}
                    aria-label={`Minutes between runs of ${node.label}`}
                    title="Left empty, it runs as one run with this many iterations (prep and cleanup once)"
                    placeholder="0"
                    value={node.schedule.everyMinutes ?? ''}
                    onChange={(e) => onScheduleChange(node.id, { ...node.schedule, everyMinutes: e.target.value })}
                    className={`${input} w-16`}
                  />
                  <span className="text-gray-500 dark:text-gray-400">min,</span>
                  <input
                    type="number"
                    min={2}
                    aria-label={`How many times ${node.label} runs`}
                    placeholder="—"
                    value={node.schedule.repeat ?? ''}
                    onChange={(e) => onScheduleChange(node.id, { ...node.schedule, repeat: e.target.value })}
                    className={`${input} w-16`}
                  />
                  <span
                    className="text-gray-500 dark:text-gray-400"
                    title="Nothing downstream of this step starts until it has run this many times."
                  >
                    times in total
                  </span>
                  {!isBlank(node.schedule.everyMinutes) && Number(node.schedule.repeat) < 2 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      Needs a count of 2 or more to repeat at all.
                    </span>
                  )}
                  {cadenceNote(node) && (
                    <span className={`basis-full pl-5 ${cadenceNote(node)!.warn ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}`}>
                      {cadenceNote(node)!.text}
                    </span>
                  )}
                </div>
                )}
              </div>
            );
          })}
        </div>

        {/* One row, fixed columns: the status message is the only part whose text changes, so it
            takes the flexible middle and truncates. With flex-wrap, the longer "all supplied"
            message pushed the buttons onto a second line and the whole dialog jumped. */}
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          {/* One name for the whole experiment: it is what every step's run is called on its
              device, and what the experiment is listed under in Results. */}
          <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            experiment
            <input
              type="text"
              value={experimentName}
              placeholder={experimentNamePlaceholder}
              onChange={(e) => onExperimentNameChange(e.target.value)}
              className={`${input} w-56`}
            />
          </label>
          <div
            className="flex min-w-0 items-center justify-end gap-1.5 text-xs text-gray-500 dark:text-gray-400"
            title={unfilled > 0 ? undefined : 'All values supplied. They are saved with the workflow.'}
          >
            {unfilled > 0
              ? <AlertCircle size={14} className="shrink-0 text-red-500" />
              : <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />}
            <span className="truncate">
              {unfilled > 0
                ? `${unfilled} value${unfilled === 1 ? '' : 's'} still needed`
                : 'All values supplied'}
            </span>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={onCancel}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
            >
              Cancel
            </button>
            {onSchedule && (
              <button
                onClick={onSchedule}
                disabled={unfilled > 0}
                title="Run this graph on a recurring trigger instead of right now"
                className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600"
              >
                <CalendarClock size={14} />
                Schedule…
              </button>
            )}
            <button
              onClick={onRun}
              disabled={unfilled > 0}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play size={14} />
              Run
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
