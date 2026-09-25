/**
 * A finished (or running) run, as the flattened datasheet Data History shows and "Export Data"
 * writes: one row per iteration (spreadsheet row, optimizer trial, or the single pass of a plain
 * run), columns = inputs, typed-in answers, then named outputs.
 *
 * Moved here from the edge Data History page so Cloud can show the same table for the results
 * a device syncs back after a Cloud-dispatched run — one reading of a run record, not two that
 * can disagree about which output belongs to which sample (AGENTS.md section 3).
 */

import { readNamedOutput } from './returnValues';

/**
 * Which phase a logged step ran in. Everything carries `_phase` since `expand_workflow_blocks`
 * stamps it; a step without one predates that and was part of the main body.
 */
export const phaseOf = (step: any): 'prep' | 'main' | 'cleanup' => {
  const p = String(step?.parameters?._phase || 'main').toLowerCase();
  return p === 'prep' || p === 'cleanup' ? p : 'main';
};

export const toDetail = (s: any) => ({
  instrument: s.instrument,
  method: s.method,
  params: s.parameters || {},
  status: s.status,
  result: s.outputs,
  error: s.error,
  start_time: s.start_time,
  end_time: s.end_time,
});

/** One cell of the flattened data table, as text. The on-screen table and the CSV share it. */
export const cellText = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

export const csvField = (v: unknown) => `"${cellText(v).replace(/"/g, '""')}"`;

export const isFlowStep = (step: any) => step.instrument === 'Flow_Control' || step.instrument === 'Flow Control';

/** Each step's saved-output names, as a template `readNamedOutput` can resolve against. */
export const templateOf = (steps: any[]) => steps.map((s: any) => ({
  instrument: s.instrument,
  method: s.method,
  returnVar: s.parameters?._return_var || null,
  returnBindings: s.parameters?._return_bindings || null,
}));

/** Every named output these steps save, in order. */
export const namedOutputsOf = (steps: any[]): string[] => {
  const names: string[] = [];
  for (const t of templateOf(steps)) {
    const own = t.returnBindings?.length
      ? t.returnBindings.map((b: any) => b.var).filter(Boolean)
      : String(t.returnVar || '').split(',').map((v: string) => v.trim()).filter(Boolean);
    for (const n of own) if (!names.includes(n)) names.push(n);
  }
  return names;
};

export const isUserInputStep = (s: any) => isFlowStep(s) && s.method === 'User_Input';

/** Names a person typed in during the run (User Input steps) -- recorded as data columns too. */
export const userInputVarsOf = (steps: any[]): string[] => {
  const names: string[] = [];
  for (const s of steps) {
    const n = String(s.parameters?.variable_name || '').trim();
    if (isUserInputStep(s) && n && !names.includes(n)) names.push(n);
  }
  return names;
};

export const userInputValue = (steps: any[], name: string) => {
  const step = steps.find((s: any) => isUserInputStep(s) && String(s.parameters?.variable_name || '').trim() === name);
  return step?.outputs?.result ?? '';
};

export const aggregateStatus = (steps: any[]) =>
  steps.some(s => s.status === 'error') ? 'error'
    : steps.some(s => s.status === 'running' || s.status === 'waiting_input') ? 'running'
      : steps.length > 0 && steps.every(s => s.status === 'completed' || s.status === 'skipped') ? 'completed'
        : 'pending';

export type RunRow = { row: number; status: string; values: unknown[]; details: ReturnType<typeof toDetail>[] };

export type FormattedRun = {
  id: any;
  name: string;
  type: 'Sequence' | 'Spreadsheet' | 'Optimization';
  timestamp: string;
  variables: string[];
  rows: RunRow[];
  steps: any[];
  deckVersion: number | null;
  /** Rows per batch group, as submitted (Configure records it since batches were drawn). */
  batchSize: number | null;
  prep: ReturnType<typeof toDetail>[];
  cleanup: ReturnType<typeof toDetail>[];
  config: any;
};

/** A raw run record (`/api/queue/runs` shape: parameters + steps) as its datasheet. */
export function formatRun(r: any): FormattedRun {
  let vars = r.parameters?.variables || [];
  let type = r.parameters?.type || (vars.length > 0 ? 'Spreadsheet' : 'Sequence');
  // A run that neither iterates nor optimizes ('Simple', or no type at all) is a run with one
  // iteration, and is shown exactly like the others rather than as a different page.
  if (type !== 'Spreadsheet' && type !== 'Optimization') type = 'Sequence';

  // A repeated run is prep once, the body once per row/trial, cleanup once. Rows and trials
  // are derived from the body alone: sliced from the full list, row 1 (or trial 1) began with
  // the prep steps and every later one was shifted by their count.
  const allSteps = r.steps || [];
  const prepSteps = allSteps.filter((s: any) => phaseOf(s) === 'prep');
  const cleanupSteps = allSteps.filter((s: any) => phaseOf(s) === 'cleanup');
  const mainSteps = allSteps.filter((s: any) => phaseOf(s) === 'main');

  let rows: RunRow[] = [];
  if (type === 'Sequence') {
    // Data columns: what was typed in at User Input prompts, then every named output.
    const inputs = userInputVarsOf(mainSteps);
    const outputs = namedOutputsOf(mainSteps).filter((n) => !inputs.includes(n));
    const template = templateOf(mainSteps);
    vars = [...inputs, ...outputs];
    rows = mainSteps.length === 0 ? [] : [{
      row: 1,
      status: aggregateStatus(mainSteps),
      values: [
        ...inputs.map((n) => userInputValue(mainSteps, n)),
        ...outputs.map((n) => readNamedOutput(n, template, mainSteps)),
      ],
      details: mainSteps.map(toDetail),
    }];
  } else if (type === 'Optimization') {
    const paramSpace = r.parameters?.parameter_space || [];
    const objectiveConfig = r.parameters?.objective_config || [];
    const seqTemplate = r.parameters?.sequence_template || [];
    const seqLength = seqTemplate.length;
    const paramNames = paramSpace.map((p: any) => p.name);
    const objectiveNames = objectiveConfig.map((o: any) => o.name);
    vars = [...paramNames, ...objectiveNames.map((n: string) => `${n} (objective)`)];

    const iterationCount = seqLength > 0 ? Math.ceil(mainSteps.length / seqLength) : 0;
    for (let i = 0; i < iterationCount; i++) {
      const iterSteps = mainSteps.slice(i * seqLength, (i + 1) * seqLength);
      const hasError = iterSteps.some((s: any) => s.status === 'error');
      const isRunning = iterSteps.some((s: any) => s.status === 'running');
      const isPending = iterSteps.every((s: any) => s.status === 'pending');
      const status = hasError ? 'error' : isRunning ? 'running' : isPending ? 'pending' : 'completed';

      // The suggested value for each search-space parameter shows up as a step argument
      // somewhere in this iteration's steps (whichever templated call actually used it).
      const paramValues = paramNames.map((name: string) => {
        const step = iterSteps.find((s: any) => s.parameters && name in (s.parameters || {}));
        return step ? step.parameters[name] : '';
      });
      // The objective's value is whatever step in the template was configured with that
      // returnVar — match by template position since steps themselves don't store returnVar.
      const objectiveValues = objectiveNames.map((name: string) =>
        readNamedOutput(name, seqTemplate, iterSteps));

      rows.push({
        row: i + 1,
        status,
        values: [...paramValues, ...objectiveValues],
        details: iterSteps.map(toDetail),
      });
    }
  } else if (type === 'Spreadsheet') {
    const inputVars = vars;
    const rowCount = r.parameters?.rows?.length || 0;
    // Only present on runs submitted after this was added — older persisted runs have no
    // record of which step is "the" output, so they fall back to input-only columns below
    // (their outputs are still visible per-row in the UI, and via Export Log).
    const seqTemplate = r.parameters?.sequence_template || [];
    // One step can save several named outputs (one per field of a structured return), so
    // each becomes its own column rather than the whole "a, b" list becoming one.
    const returnVars = seqTemplate.flatMap((t: any) =>
      t.returnBindings?.length
        ? t.returnBindings.map((b: any) => b.var).filter(Boolean)
        : String(t.returnVar || '').split(',').map((v: string) => v.trim()).filter(Boolean));
    const seqLength = seqTemplate.length || (rowCount > 0 && mainSteps.length ? Math.floor(mainSteps.length / rowCount) : 0);
    // Answers typed at a User Input prompt are per-row data like any column.
    const promptVars = userInputVarsOf(mainSteps).filter((n) => !inputVars.includes(n) && !returnVars.includes(n));
    vars = [...inputVars, ...promptVars, ...returnVars];

    // Which steps belong to row i. Runs submitted since `toSubmittedStep` say so outright
    // (`_row`); older ones are sliced into equal chunks the way this always did.
    //
    // Slicing was never right for a run with more than one block AND more than one row:
    // within a batch group the flattening is block-major (A(r1) A(r2) B(r1) B(r2)), so
    // chunking by template length handed row 1 `A(r1), A(r2)` — one of its own steps and
    // one belonging to another sample. Every step still read "completed", so the record
    // looked healthy while attributing one sample's measurement to a different sample.
    //
    // Only the body is checked for tags: prep and cleanup belong to no row and never carry one,
    // so requiring it of every step sent any run that had them down the slicing path.
    const hasRowTags = mainSteps.length > 0
      && mainSteps.every((s: any) => s.parameters?._row !== undefined);
    const stepsForRow = (i: number) => (hasRowTags
      ? mainSteps.filter((s: any) => s.parameters._row === i)
      : mainSteps.slice(i * seqLength, (i + 1) * seqLength));

    // Outputs are read from the step at the same position as in the template, and the template
    // is one row's expansion (the first row's, see `_per_row_template` on the edge). Position
    // stops meaning anything as soon as rows differ in which steps they have -- and with a batch
    // step they always do: it runs once per group, under the group's first row only, so every
    // later row in the group is one step shorter and each output after the batch step was read
    // from its neighbour (a mass read as `false`, a temperature as 0). Align by where each step
    // came from instead: `_block` plus its count within that block (a linked workflow expands one
    // block into several), keyed against the first row. A step a row does not have is a hole,
    // which reads as an empty cell rather than someone else's value.
    const blockKeys = (steps: any[]) => {
      const seen = new Map<any, number>();
      return steps.map((s: any) => {
        const b = s.parameters?._block;
        const k = seen.get(b) ?? 0;
        seen.set(b, k + 1);
        return `${b}:${k}`;
      });
    };
    const hasBlockTags = hasRowTags && mainSteps.every((s: any) => typeof s.parameters?._block === 'number');
    const firstRow = hasBlockTags ? Math.min(...mainSteps.map((s: any) => s.parameters._row)) : 0;
    const templateKeys = hasBlockTags ? blockKeys(stepsForRow(firstRow)) : [];
    const aligned = (rowSteps: any[]) => {
      if (!hasBlockTags || templateKeys.length !== seqTemplate.length) return rowSteps;
      const keys = blockKeys(rowSteps);
      const byKey = new Map(keys.map((k, i) => [k, rowSteps[i]]));
      return templateKeys.map((k) => byKey.get(k));
    };

    for (let i = 0; i < rowCount; i++) {
      const rowSteps = stepsForRow(i);
      const hasError = rowSteps.some((s: any) => s.status === 'error');
      const isRunning = rowSteps.some((s: any) => s.status === 'running');
      const isPending = rowSteps.every((s: any) => s.status === 'pending');
      const status = hasError ? 'error' : isRunning ? 'running' : isPending ? 'pending' : 'completed';

      const inputVals = inputVars.map((v: string) => r.parameters.rows[i][v]);
      // Match each returnVar to the step at the same position in the per-row template —
      // rowSteps mirrors seqTemplate's order since every row repeats the same block sequence.
      const outputVals = returnVars.map((rv: string) => readNamedOutput(rv, seqTemplate, aligned(rowSteps) as any[]));

      rows.push({
        row: i + 1,
        status,
        values: [...inputVals, ...promptVars.map((n: string) => userInputValue(rowSteps, n)), ...outputVals],
        details: rowSteps.map(toDetail),
      });
    }
  }

  return {
    id: r.id,
    name: r.name || 'Unnamed Workflow',
    type,
    timestamp: r.start_time || new Date().toISOString(),
    variables: vars,
    rows,
    steps: r.steps,
    // The deck (driver schema) version this run executed against -- see the Instruments page.
    deckVersion: r.parameters?.deck_version ?? null,
    batchSize: Number(r.parameters?.batch_size) || null,
    prep: prepSteps.map(toDetail),
    cleanup: cleanupSteps.map(toDetail),
    config: type === 'Optimization' ? {
      optimizer: r.parameters?.optimizer,
      budget: r.parameters?.budget,
      error_recovery: r.parameters?.error_recovery,
      optimizer_config: r.parameters?.optimizer_config || {},
      parameter_space: r.parameters?.parameter_space || [],
      objective_config: r.parameters?.objective_config || []
    } : null,
  };
}

/** The datasheet as CSV — exactly what the on-screen table shows. */
export const datasheetCsv = (run: { variables: string[]; rows: { values?: unknown[] }[] }) => [
  run.variables.map(csvField).join(','),
  ...run.rows.map((r) => run.variables.map((_: string, i: number) => csvField(r.values?.[i])).join(',')),
].join('\n');
