/**
 * How long a saved workflow takes, as the edge measures it from its own completed runs
 * (`edge_server/ivoryos_edge/runtime.py`) -- read on the edge Library and, via the workflow's
 * retained MQTT message, in Cloud. Medians, per phase, so an iterated run can be estimated too.
 */
export interface WorkflowRuntime {
  /** Completed runs the numbers come from. */
  runs: number;
  prep_s: number;
  /** One pass of the body: a spreadsheet row, an optimization trial, or a plain run's body. */
  iteration_s: number;
  cleanup_s: number;
  /** prep + one iteration + cleanup -- one Once run. */
  typical_s: number;
  last_at?: string | null;
}

/** "45 s", "8.5 min", "2 h 10 min". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes < 10 ? minutes.toFixed(1).replace(/\.0$/, '') : Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Setup once, `iterations` passes of the body, teardown once. */
export function estimateRunSeconds(runtime: WorkflowRuntime, iterations = 1): number {
  return runtime.prep_s + Math.max(1, iterations) * runtime.iteration_s + runtime.cleanup_s;
}

/** "~8.5 min per run · 6 runs" -- the one line a workflow card carries. */
export function runtimeSummary(runtime: WorkflowRuntime | null | undefined): string {
  if (!runtime || !runtime.runs) return '';
  return `~${formatDuration(runtime.typical_s)} per run · ${runtime.runs} run${runtime.runs === 1 ? '' : 's'}`;
}
