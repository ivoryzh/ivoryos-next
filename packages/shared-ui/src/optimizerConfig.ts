/**
 * Turning an Optimize screen's state into the `parameters` blob `/api/queue/runs` accepts.
 *
 * Extracted from the edge Optimize page because the Cloud orchestrator now configures Bayesian
 * runs per node, and the payload it produces has to be byte-for-byte the shape the edge already
 * knows how to execute — the whole point of the dispatch decision is that a Cloud-launched
 * optimization is the *same* run, arriving by a different door. A second copy of this mapping
 * would be the one place a drift is invisible until an optimizer silently searches the wrong
 * space.
 *
 * Only the mapping and its validation live here. The two screens' layouts genuinely differ — the
 * edge page is one campaign filling a viewport, Cloud is one compact card per node among many —
 * so the JSX stays with each host. See AGENTS.md section 6 for what each field means to the
 * backend.
 */

import { RunConfigError, resolveBlockParams, ResolvedStep } from './runConfig';

/** Per-variable search-space configuration, keyed by the `#name` without its `#`. */
export interface VarBound {
  /**
   * `optimize` (default) puts the variable in the search space; `fixed` gives it one value for
   * the whole run. `excluded` is the older on-disk spelling of `fixed`, still read so a saved
   * config from before the rename keeps working, but never written.
   */
  mode?: 'optimize' | 'fixed';
  excluded?: boolean;
  type?: 'range' | 'choice';
  /** Range minimum, or the comma-separated list of options when `type` is `choice`. */
  min?: string;
  max?: string;
  fixedValue?: string;
  /** Independent of, and takes priority over, `mode` — one value per iteration, from a table. */
  perIteration?: boolean;
  iterationValues?: string[];
}

export interface ObjectiveConfig {
  goal?: 'maximize' | 'minimize';
  earlyStop?: boolean;
  threshold?: string;
}

export interface OptimizeConfig {
  optimizer: string;
  budget: number;
  batch_size: number;
  error_recovery: string;
  bounds: Record<string, VarBound>;
  objectives: Record<string, ObjectiveConfig>;
  optimizer_config: Record<string, any>;
  earlyStopMode?: 'any' | 'all';
  constraints?: string[];
}

export const emptyOptimizeConfig = (): OptimizeConfig => ({
  optimizer: '',
  budget: 25,
  batch_size: 1,
  error_recovery: 'stop',
  bounds: {},
  objectives: {},
  optimizer_config: {},
  earlyStopMode: 'any',
  constraints: [],
});

/** Whether a variable goes to the optimizer or is pinned to one value for the run. */
export function getVarMode(config: OptimizeConfig, v: string): 'optimize' | 'fixed' {
  const b = config.bounds?.[v];
  if (b?.mode === 'fixed' || b?.mode === 'optimize') return b.mode;
  return b?.excluded ? 'fixed' : 'optimize';
}

/** The single Range/Choice/Fixed control's value — mode and bounds type collapsed into one. */
export function getVarModeType(config: OptimizeConfig, v: string): 'range' | 'choice' | 'fixed' {
  if (getVarMode(config, v) === 'fixed') return 'fixed';
  return config.bounds?.[v]?.type === 'choice' ? 'choice' : 'range';
}

export const isPerIteration = (config: OptimizeConfig, v: string) => !!config.bounds?.[v]?.perIteration;

export const getIterationValue = (config: OptimizeConfig, v: string, i: number): string =>
  (config.bounds?.[v]?.iterationValues || [])[i] ?? '';

/**
 * A choice list of whole numbers is an int parameter, of any other numbers a float, otherwise a
 * categorical. Ranges are deliberately NOT inferred this way — see `buildParameterSpace`.
 */
function inferValueType(bounds: any[]): 'int' | 'float' | 'str' {
  if (bounds.every((b) => typeof b === 'number')) {
    return bounds.every((b: number) => Number.isInteger(b)) ? 'int' : 'float';
  }
  return 'str';
}

/** How each `#variable` is treated this run, once Per-Iteration's priority is applied. */
export function partitionVariables(config: OptimizeConfig, variables: string[]) {
  const perIteration = variables.filter((v) => isPerIteration(config, v));
  const remaining = variables.filter((v) => !isPerIteration(config, v));
  return {
    perIteration,
    optimized: remaining.filter((v) => getVarMode(config, v) === 'optimize'),
    fixed: remaining.filter((v) => getVarMode(config, v) === 'fixed'),
  };
}

function buildParameterSpace(config: OptimizeConfig, optimizedVars: string[]) {
  return optimizedVars.map((v) => {
    const b = config.bounds?.[v] || {};
    if (b.type === 'choice') {
      const bounds = String(b.min || '')
        .split(',')
        .map((s) => {
          const n = parseFloat(s.trim());
          return isNaN(n) ? s.trim() : n;
        });
      return { name: v, type: 'choice', bounds, value_type: inferValueType(bounds) };
    }
    // Range bounds default to 'float' rather than being inferred from whole-number min/max
    // (e.g. 20-80 for a temperature range), which would silently restrict a continuous
    // parameter to integer-only values.
    return {
      name: v,
      type: 'range',
      bounds: [parseFloat(b.min || '0'), parseFloat(b.max || '1')],
      value_type: 'float',
    };
  });
}

export interface BuildOptimizationOptions {
  config: OptimizeConfig;
  /** Every `#name` the Main sequence references. */
  variables: string[];
  /** Objective names — the return variables the sequence produces. */
  returns: string[];
  /** The authored Main sequence, which becomes `sequence_template`. */
  sequence: any[];
  /** Prior rows to seed the optimizer with, already in `{column: value}` shape. */
  existingData?: any[];
}

/**
 * Validate the configuration and produce the run's `parameters`.
 *
 * Throws `RunConfigError` — one message, naming every variable at fault — rather than returning a
 * partial payload. Callers surface the message verbatim.
 */
export function buildOptimizationParameters(opts: BuildOptimizationOptions): Record<string, any> {
  const { config, variables, returns, sequence, existingData = [] } = opts;
  const { perIteration: perIterationVars, optimized: optimizedVars, fixed: fixedVars } =
    partitionVariables(config, variables);

  const missingFixed = fixedVars.filter((v) => !config.bounds?.[v]?.fixedValue);
  if (missingFixed.length > 0) {
    throw new RunConfigError(`Please provide a fixed value for: ${missingFixed.join(', ')}`);
  }

  const budgetCount = Math.max(1, config.budget || 1);
  const incompletePerIteration = perIterationVars.filter((v) =>
    Array.from({ length: budgetCount }).some((_, i) => !getIterationValue(config, v, i)),
  );
  if (incompletePerIteration.length > 0) {
    throw new RunConfigError(
      `Please fill in a value for every iteration (1-${budgetCount}) for: ${incompletePerIteration.join(', ')}`,
    );
  }

  const earlyStopEnabledVars = returns.filter((v) => config.objectives?.[v]?.earlyStop);
  const invalidEarlyStop = earlyStopEnabledVars.filter((v) =>
    isNaN(parseFloat(String(config.objectives?.[v]?.threshold))),
  );
  if (invalidEarlyStop.length > 0) {
    throw new RunConfigError(
      `Early stop is enabled for ${invalidEarlyStop.join(', ')} but missing a target value.`,
    );
  }

  const earlyStop =
    earlyStopEnabledVars.length > 0
      ? {
          mode: config.earlyStopMode === 'all' ? 'all' : 'any',
          criteria: earlyStopEnabledVars.map((v) => ({
            metric: v,
            threshold: parseFloat(String(config.objectives?.[v]?.threshold)),
          })),
        }
      : undefined;

  // A Fixed variable is resolved to its literal here, client-side, so the backend never learns it
  // existed. A Per-Iteration one cannot be: `sequence_template` is one template the budget loop
  // reuses every iteration, so a value that differs per iteration has to be substituted backend
  // side from `iteration_values`.
  const fixedValues: Record<string, string> = {};
  fixedVars.forEach((v) => { fixedValues[v] = config.bounds?.[v]?.fixedValue ?? ''; });

  const iterationValues: Record<string, string[]> = {};
  perIterationVars.forEach((v) => {
    iterationValues[v] = Array.from({ length: budgetCount }, (_, i) => getIterationValue(config, v, i));
  });

  const sequenceTemplate: ResolvedStep[] = sequence.map((block) => ({
    instrument: block.instrument,
    method: block.method,
    params: resolveBlockParams(block, {
      lookup: (v) => (v in fixedValues ? fixedValues[v] : undefined),
      describe: (v) => `fixed value '${v}'`,
      // Anything still in the search space, or per-iteration, stays as '#name' for the backend.
      onMissing: 'leave',
      numeric: 'lenient',
    }),
    returnVar: block.returnVar,
    returnBindings: block.returnBindings,
  }));

  return {
    type: 'Optimization',
    optimizer: config.optimizer,
    budget: config.budget,
    batch_size: Math.max(1, config.batch_size || 1),
    error_recovery: config.error_recovery,
    optimizer_config: config.optimizer_config,
    parameter_space: buildParameterSpace(config, optimizedVars),
    objective_config: returns.map((v) => ({
      name: v,
      minimize: config.objectives?.[v]?.goal === 'minimize',
    })),
    ...(earlyStop ? { early_stop: earlyStop } : {}),
    ...(perIterationVars.length > 0 ? { iteration_values: iterationValues } : {}),
    ...(existingData.length > 0 ? { existing_data: existingData } : {}),
    // Only Ax's client actually applies parameter_constraints today (BayBE/NIMO accept and store
    // it but never use it) — see AGENTS.md's Optimizer wiring section.
    ...(config.optimizer === 'ax' && (config.constraints || []).some((c) => c.trim())
      ? { parameter_constraints: (config.constraints || []).filter((c) => c.trim()) }
      : {}),
    sequence_template: sequenceTemplate,
  };
}
