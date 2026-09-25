/**
 * Turning one Orchestrator node into the run payload its target device will execute.
 *
 * The edge accepts exactly one description of a run — the body `POST /api/queue/runs` takes — and
 * since the refactor in `edge_server/ivoryos_edge/server.py` the MQTT `execute` topic accepts that
 * same body. So Cloud's job here is not to invent a distributed run format: it is to produce the
 * *same* payload a person would have produced standing at that bench. A spreadsheet dispatched
 * from Cloud is the same run as one started from the edge's Configure page, and an optimization
 * dispatched from Cloud is the same campaign the edge's Optimize page would have started.
 *
 * That is why every mapping below comes from `@ivoryos/shared-ui` rather than being written here:
 * `expandSpreadsheet` is the per-sample walk the Configure page uses, and
 * `buildOptimizationParameters` is the search-space mapping the Optimize page uses. A second copy
 * of either would mean the same graph meaning different things depending on which screen started
 * it — and for the optimizer that difference would be silent.
 *
 * Deliberately built at plan time, not at dispatch time. `daemon.js` has no build step and cannot
 * import this module, and a schedule that fires every ten minutes must replay a payload that was
 * validated once rather than re-derive one from a graph nobody is looking at.
 */

import {
  buildOptimizationParameters,
  buildSpreadsheetParameters,
  expandSpreadsheet,
  LIBRARY_INSTRUMENT,
  resolveFixedBlock,
  RunConfigError,
  scanLiveInputVars,
  toSequenceBlocks,
  toSubmittedStep,
  type OptimizeConfig,
  type SpreadsheetRow,
} from '@ivoryos/shared-ui';
import { blockOf, effectiveParamValue, isDynamicValue } from './dag';

/** How one node turns into work: once, once per row, or as a Bayesian campaign. */
export type RunMode = 'single' | 'spreadsheet' | 'optimization';

/**
 * Kept as the strings the form holds rather than numbers. The fields are text inputs, an empty one
 * has to stay distinguishable from a zero, and everything that consumes them coerces explicitly
 * (`repeatIntervalMs`, `repeatTotal`) — parsing at the edge of the form instead would make "the
 * user has not typed anything yet" and "the user typed 0" the same state.
 */
export interface NodeCadence {
  everyMinutes?: string;
  repeat?: string;
}

export interface NodeRunConfig {
  mode?: RunMode;
  spreadsheet?: {
    rows?: SpreadsheetRow[];
    /**
     * Rows per batch group, as on the edge's Configure page. Blank keeps the default: each sample
     * runs the whole workflow in turn. Set, the workflow's own per-sample / batch steps are walked
     * group by group (see `batchedWorkflowRun`).
     */
    batchSize?: string;
  };
  optimization?: OptimizeConfig & { objectives_order?: string[] };
  /**
   * Re-run this node on a fixed cadence within the run. Two devices on different timelines — one
   * every 20 minutes, one every 35 — is two nodes with different cadences in one graph, which is
   * the thing that is tedious to express as repeated triggering on a single edge.
   */
  schedule?: NodeCadence;
}

export const runConfigOf = (node: any): NodeRunConfig => (node?.data?.runConfig || {});

export function runModeOf(node: any): RunMode {
  const mode = runConfigOf(node).mode;
  return mode === 'spreadsheet' || mode === 'optimization' ? mode : 'single';
}

/** The values supplied for a single-mode node's `#names`, keyed by name. */
export const singleValuesOf = (node: any): Record<string, string> => (node?.data?.config || {});

/**
 * The distinct `#names` one node references, in the order its params declare them.
 *
 * Per node rather than per canvas, deliberately: two steps both written `#temperature` are two
 * screens of the same protocol, and putting the same sequence on the canvas twice is how you run
 * it at two temperatures. Collecting these globally by name quietly forces the two to be equal.
 */
export function dynamicVarsOf(node: any): string[] {
  const block = blockOf(node);
  const found: string[] = [];
  for (const key of Object.keys(block?.schema?.parameters || {})) {
    const value = effectiveParamValue(block, key);
    if (!isDynamicValue(value)) continue;
    const name = String(value).trim().slice(1);
    if (!name) continue; // a bare '#' names nothing and is reported separately
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

const isBlank = (v: unknown) => !String(v ?? '').trim();

/** Rows with at least one value in them — the ones a spreadsheet run would actually execute. */
export const activeRowsOf = (config: NodeRunConfig): SpreadsheetRow[] =>
  (config.spreadsheet?.rows || []).filter((row) => Object.values(row || {}).some((v) => !isBlank(v)));

/**
 * Everything wrong with one node's run configuration, as plain sentences.
 *
 * Returned rather than thrown so the panel can mark several nodes at once — a canvas with six
 * nodes should not need six Run clicks to discover six problems.
 */
export function validateNodeRunConfig(node: any, label: string): string[] {
  const problems: string[] = [];
  const config = runConfigOf(node);
  const vars = dynamicVarsOf(node);
  const mode = runModeOf(node);

  if (mode === 'single') {
    const values = singleValuesOf(node);
    const missing = vars.filter((v) => isBlank(values[v]));
    if (missing.length) {
      problems.push(`${label}: no value for ${missing.map((v) => '#' + v).join(', ')}.`);
    }
    return problems;
  }

  if (mode === 'spreadsheet') {
    const rows = activeRowsOf(config);
    if (rows.length === 0) {
      problems.push(`${label}: spreadsheet mode with no rows filled in.`);
      return problems;
    }
    rows.forEach((row, i) => {
      const missing = vars.filter((v) => isBlank(row[v]));
      if (missing.length) {
        problems.push(`${label}: row ${i + 1} is missing ${missing.map((v) => '#' + v).join(', ')}.`);
      }
    });
    return problems;
  }

  const opt = config.optimization;
  if (!opt?.optimizer) {
    problems.push(`${label}: pick an optimizer before running.`);
  }
  const objectives = opt?.objectives_order || [];
  if (objectives.length === 0) {
    problems.push(`${label}: an optimization needs at least one objective.`);
  }
  if (vars.length === 0) {
    problems.push(`${label}: an optimization needs at least one #variable to search over.`);
  }
  if (opt) {
    // Everything else — bounds, per-iteration completeness, early-stop targets — is exactly the
    // edge Optimize page's own validation, so ask it rather than restating it here.
    try {
      buildOptimizationParameters({
        config: opt,
        variables: vars,
        returns: objectives,
        sequence: [blockOf(node)],
      });
    } catch (e: any) {
      if (e instanceof RunConfigError) problems.push(`${label}: ${e.message}`);
      else throw e;
    }
  }
  return problems;
}

/**
 * A saved workflow's body as its device last published it, and that device's instrument schema.
 * Only needed for a batched spreadsheet node; the route that plans a run looks it up.
 */
export interface WorkflowSource {
  body: any;
  instruments: Record<string, any>;
}

/** Rows per batch for a spreadsheet node, or 0 when none is set. */
export function batchSizeOf(node: any): number {
  if (runModeOf(node) !== 'spreadsheet') return 0;
  const n = Number(runConfigOf(node).spreadsheet?.batchSize);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0;
}

/**
 * How many times a Once node runs back to back. A repeat count with no interval is one run of the
 * workflow iterated that many times -- prep once, the body N times, cleanup once -- not N separate
 * runs that each set up and tear down. With an interval the device is free in between, so those
 * stay separate occurrences (`repeatIntervalMs` / `repeatTotal`).
 */
export function iterationsOf(node: any): number {
  if (runModeOf(node) !== 'single' || repeatIntervalMs(node) > 0) return 1;
  const n = Number(runConfigOf(node).schedule?.repeat);
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 1;
}

/** A run payload in the shape `POST /api/queue/runs` (and the `execute` topic) accepts. */
export interface EdgeRunPayload {
  name: string;
  parameters: Record<string, any>;
  prep: any[];
  sequence: any[];
  cleanup: any[];
}

/**
 * Build the run payload for one node, or `null` when the node is a plain single step.
 *
 * `null` is not a failure — it means "this dispatches as the bare block it always did", which
 * keeps the common case off the wire at its original size. AWS IoT meters in 5KB increments, and
 * every ordinary instrument step would otherwise grow a run envelope around it for nothing.
 */
export function buildNodeRun(node: any, runName: string, source?: WorkflowSource | null): EdgeRunPayload | null {
  const mode = runModeOf(node);
  const block = blockOf(node);

  if (mode === 'single' && iterationsOf(node) > 1) {
    return iteratedRun(node, block, runName, iterationsOf(node));
  }

  if (mode === 'single') {
    if (String(block?.instrument || '') !== LIBRARY_INSTRUMENT) return null;
    // A linked workflow run once still goes out in its three phases, exactly as an iterated one
    // does. As one bare link the device expanded the whole body into the main sequence, so its
    // prep and cleanup were recorded as ordinary steps -- and Data History, which files a run by
    // phase, showed a Once run of a workflow differently from the same workflow iterated.
    // Params here are already resolved (resolveGraphForDispatch runs before planning).
    const params = Object.fromEntries(
      Object.entries(block.params || {}).filter(([k]) => !k.startsWith('_')),
    );
    return {
      name: runName,
      parameters: {},
      prep: [phaseLink(block, params, 'prep')],
      sequence: [{
        instrument: block.instrument,
        method: block.method,
        params,
        phases: ['script'],
        ...(block.ref ? { ref: block.ref } : {}),
      }],
      cleanup: [phaseLink(block, params, 'cleanup')],
    };
  }

  const config = runConfigOf(node);
  const vars = dynamicVarsOf(node);

  if (mode === 'spreadsheet' && batchSizeOf(node) && String(block?.instrument || '') === LIBRARY_INSTRUMENT) {
    if (!source?.body) {
      throw new RunConfigError(
        'Cloud does not have this workflow\'s steps from its device, so it cannot apply a batch size. ' +
        'Clear the batch size, or reconnect the device so it republishes its workflows.',
      );
    }
    return batchedWorkflowRun(block, activeRowsOf(config), vars, batchSizeOf(node), source, runName);
  }

  if (mode === 'spreadsheet') {
    const rows = activeRowsOf(config);
    // One node is one step (an instrument call, or a Library Workflows reference the edge expands
    // at dispatch), so the sequence walked per row is a single-element one. Batch steps are
    // deliberately not offered here: their per-sample/batch split lives *inside* a saved
    // workflow's body, and reading it from Cloud would mean a TypeScript twin of
    // `expand_workflow_blocks`.
    const sequence = expandSpreadsheet({ sequence: [block], rows, variables: vars });
    const isLinked = String(block?.instrument || '') === LIBRARY_INSTRUMENT;

    // A saved workflow has three phases, and iterating it must not iterate all three: setup runs
    // once, the body once per sample, teardown once. Without this split a two-row screen tared
    // the balance twice and cooled the reactor down twice, because a bare link stands for the
    // whole workflow and Cloud sent one link per row.
    //
    // Prep/cleanup take the FIRST row's values, matching the rule a batch step already follows.
    // They run once for the whole run, so no row owns them; if they reference a row variable at
    // all, row 1 is the only defensible answer and it is better than leaving it unresolved.
    // They carry no `_row`, so Data History files them under Prep/Cleanup rather than sample 1.
    const firstParams = sequence[0]?.params || {};

    return {
      name: runName,
      parameters: buildSpreadsheetParameters({ variables: vars, rows, sequence: [block] }),
      prep: isLinked ? [phaseLink(block, firstParams, 'prep')] : [],
      sequence: sequence.map((s) =>
        isLinked
          ? { ...toSubmittedStep(s), phases: ['script'], ...(block.ref ? { ref: block.ref } : {}) }
          : toSubmittedStep(s),
      ),
      cleanup: isLinked ? [phaseLink(block, firstParams, 'cleanup')] : [],
    };
  }

  const opt = config.optimization;
  if (!opt) throw new RunConfigError('This step is set to optimize but has no configuration.');
  const parameters = buildOptimizationParameters({
    config: opt,
    variables: vars,
    returns: opt.objectives_order || [],
    sequence: [block],
  });
  const isLinked = String(block?.instrument || '') === LIBRARY_INSTRUMENT;
  if (!isLinked) {
    return {
      name: runName,
      parameters,
      prep: [],
      // An Optimization run carries its steps in parameters.sequence_template; the budget loop on
      // the edge builds each trial's sequence from it, so the top-level one stays empty.
      sequence: [],
      cleanup: [],
    };
  }

  // Same split as a spreadsheet: every trial runs the workflow's body, but its setup and teardown
  // run once for the whole campaign. The edge's budget loop already executes `prep_template` once
  // before the first trial and `cleanup_template` once after the last, so all Cloud has to do is
  // put the phases in the right lists. `sequence_template` is rebuilt from instrument/method/params
  // only, which would also drop the link's pin -- restored here.
  const trial = parameters.sequence_template[0];
  parameters.sequence_template = [
    { ...trial, phases: ['script'], ...(block.ref ? { ref: block.ref } : {}) },
  ];
  // Only values that are already literal (fixed ones) can reach setup/teardown. A searched
  // variable has no value until the optimizer suggests one, and prep runs before that.
  const settled = Object.fromEntries(
    Object.entries(trial.params || {}).filter(([, v]) => !isDynamicValue(v)),
  );
  return {
    name: runName,
    parameters,
    prep: [phaseLink(block, settled, 'prep')],
    sequence: [],
    cleanup: [phaseLink(block, settled, 'cleanup')],
  };
}

/**
 * A Once node repeated back to back, as one run with N iterations.
 *
 * Shaped as a spreadsheet whose rows differ only in an `iteration` column, which is exactly what
 * it is: Data History then shows one row per iteration with its outputs, the Queue counts
 * iterations, and a linked workflow's prep and cleanup run once around them. The node's values
 * are already literal here (resolveGraphForDispatch), so they ride along as columns for the record.
 */
function iteratedRun(node: any, block: any, runName: string, n: number): EdgeRunPayload {
  const values = singleValuesOf(node);
  const variables = ['iteration', ...Object.keys(values)];
  const rows: SpreadsheetRow[] = Array.from({ length: n }, (_, i) => ({ ...values, iteration: String(i + 1) }));
  const sequence = expandSpreadsheet({ sequence: [block], rows, variables });
  const isLinked = String(block?.instrument || '') === LIBRARY_INSTRUMENT;
  const params = Object.fromEntries(Object.entries(block.params || {}).filter(([k]) => !k.startsWith('_')));
  return {
    name: runName,
    parameters: buildSpreadsheetParameters({ variables, rows, sequence: [block] }),
    prep: isLinked ? [phaseLink(block, params, 'prep')] : [],
    sequence: sequence.map((s) =>
      isLinked
        ? { ...toSubmittedStep(s), phases: ['script'], ...(block.ref ? { ref: block.ref } : {}) }
        : toSubmittedStep(s),
    ),
    cleanup: isLinked ? [phaseLink(block, params, 'cleanup')] : [],
  };
}

/**
 * A spreadsheet over a saved workflow with a batch size: the workflow's own per-sample and batch
 * steps walked group by group, as the edge's Configure page walks them.
 *
 * A batch step's split lives inside the workflow body, so this reads the body the device published
 * (its head) and runs it through the shared `expandSpreadsheet` -- the walk itself is not
 * re-implemented here. What Cloud does not do is expand links: a workflow linked *inside* this one
 * goes out as a link and the device expands it, acting as one step (its own batch flag applies to
 * it as a whole). The node's `#names` map onto the workflow's own parameters the same way a link's
 * params do on the device: a literal passes through, `#x` takes that row's `x`.
 */
function batchedWorkflowRun(
  block: any,
  rows: SpreadsheetRow[],
  vars: string[],
  batchSize: number,
  source: WorkflowSource,
  runName: string,
): EdgeRunPayload {
  const { body, instruments } = source;
  // Cloud has the workflow's latest body only. A step pinned to an older version would otherwise
  // run the newer steps under the older version's name.
  if (block.ref?.mode !== 'latest' && block.ref?.version && body.version && block.ref.version !== body.version) {
    throw new RunConfigError(
      `pinned to v${block.ref.version}, but its device now has v${body.version}. ` +
      'Click the step and switch it to the latest version to use a batch size.',
    );
  }
  const linkParams = Object.fromEntries(Object.entries(block.params || {}).filter(([k]) => !k.startsWith('_')));
  const bodyRows = rows.map((row) => Object.fromEntries(
    Object.entries(linkParams).map(([p, v]) => [p, isDynamicValue(v) ? row[String(v).trim().slice(1)] : v]),
  ));
  const main = toSequenceBlocks(body.script || body.sequence || [], instruments);
  const live = scanLiveInputVars(body);
  const steps = expandSpreadsheet({
    sequence: main,
    rows: bodyRows,
    variables: Object.keys(linkParams),
    batchSize,
    liveInputVars: live,
  });
  // Prep and cleanup run once and take the first row's values, as on the Configure page.
  const first = bodyRows[0] || {};
  const once = (saved: any[] | undefined) => toSequenceBlocks(saved || [], instruments).map((b) => ({
    ...resolveFixedBlock(b, first, { numeric: 'lenient' }),
    ...(b.ref ? { ref: b.ref } : {}),
  }));
  return {
    name: runName,
    parameters: {
      ...buildSpreadsheetParameters({ variables: vars, rows, sequence: main, batchSize }),
      // The workflow ran unmodified, so its device can time it (runtime.py).
      workflow_name: block.method,
      ...(body.version ? { workflow_version: body.version } : {}),
    },
    prep: once(body.prep),
    sequence: steps.map((s) => ({
      ...toSubmittedStep(s),
      ...(main[s.originalBlockIndex]?.ref ? { ref: main[s.originalBlockIndex].ref } : {}),
    })),
    cleanup: once(body.cleanup),
  };
}

/**
 * A link narrowed to one phase of the workflow it references.
 *
 * Expressed this way rather than by reading the body in Cloud: only the device can expand a link
 * (it may reference further links), so Cloud says *which phase* it wants and the device still
 * decides what that phase contains. `expand_workflow_blocks` honours `phases`.
 */
function phaseLink(block: any, params: Record<string, any>, phase: 'prep' | 'cleanup') {
  const { _row, _block, ...rest } = params;
  return {
    instrument: block.instrument,
    method: block.method,
    params: rest,
    phases: [phase],
    ...(block.ref ? { ref: block.ref } : {}),
  };
}

/** Minutes -> milliseconds, or 0 when the node has no cadence set. */
export function repeatIntervalMs(node: any): number {
  // Once-mode only, matching the panel: a cadence left over from before a node was switched to
  // Iterate or Optimize must not quietly re-run a whole campaign.
  if (runModeOf(node) !== 'single') return 0;
  const every = Number(runConfigOf(node).schedule?.everyMinutes);
  return Number.isFinite(every) && every > 0 ? Math.round(every * 60_000) : 0;
}

/**
 * How many times a repeating node is dispatched in total. Only with an interval: back to back is
 * one run with iterations (`iterationsOf`), not separate dispatches.
 */
export function repeatTotal(node: any): number {
  if (runModeOf(node) !== 'single' || repeatIntervalMs(node) === 0) return 0;
  const repeat = Number(runConfigOf(node).schedule?.repeat);
  return Number.isFinite(repeat) && repeat > 0 ? Math.floor(repeat) : 0;
}
