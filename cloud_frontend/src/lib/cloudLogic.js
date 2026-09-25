'use strict';

/**
 * The values a Cloud `If` step can test: every named output the run has produced so far.
 *
 * Built from what Cloud already holds -- each finished device task's run record (edge
 * `queue.build_cloud_result`) and each answered Cloud `User_Input` -- so an If needs no extra
 * round trip to any device. Plain CommonJS for the same reason as dag.js: daemon.js requires it.
 *
 * A step's record carries its raw result (`outputs.result`) and the names it was told to bind
 * (`parameters._return_bindings` / `_return_var`), which is the same pair the edge's
 * `extract_return_values` and shared-ui's `readNamedOutput` resolve. This is a third reader of
 * that pair, kept to the same two rules: explicit pointers win, and the legacy comma list maps
 * one name onto the whole result and several names onto its values in order.
 */

/** Walk a dotted pointer ("metrics.purity", "0", "" for the whole value) into a result. */
function resolveResultPath(result, path) {
  if (!path) return result;
  let current = result;
  for (const segment of String(path).split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === 'object') {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** `{name: value}` for the variables one recorded step bound. */
function namedOutputsOfStep(step) {
  const out = {};
  if (!step || step.status === 'error') return out;
  const params = step.parameters || {};
  const result = step.outputs && typeof step.outputs === 'object' ? step.outputs.result : undefined;
  if (result === undefined) return out;

  const bindings = params._return_bindings;
  if (bindings) {
    const pairs = Array.isArray(bindings)
      ? bindings.filter(b => b && typeof b === 'object').map(b => [b.path || '', b.var])
      : Object.entries(bindings);
    for (const [path, name] of pairs) {
      if (!name) continue;
      const value = resolveResultPath(result, path);
      if (value !== undefined) out[name] = value;
    }
    if (Object.keys(out).length) return out;
  }

  const names = String(params._return_var || '').split(',').map(s => s.trim()).filter(Boolean);
  if (names.length === 1) {
    out[names[0]] = result;
  } else if (names.length > 1) {
    const values = Array.isArray(result) ? result
      : result && typeof result === 'object' ? Object.values(result) : [result];
    names.forEach((name, i) => { if (values[i] !== undefined) out[name] = values[i]; });
  }
  return out;
}

/**
 * Every named value available to a run, from its task records (`store.listRunTaskRecords`).
 * Later values win: records are applied in the order their tasks finished, and steps within a
 * record in the order they ran, so a spreadsheet's last row is what an If sees.
 */
function runContext(records) {
  const ctx = {};
  const finished = (records || [])
    .filter(r => r && r.status === 'completed')
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
  for (const record of finished) {
    for (const step of (record.result && record.result.steps) || []) {
      Object.assign(ctx, namedOutputsOfStep(step));
    }
    const p = record.progress;
    if (p && p.save_as && p.answer !== undefined) ctx[String(p.save_as).replace(/^#/, '')] = p.answer;
  }
  return ctx;
}

module.exports = { resolveResultPath, namedOutputsOfStep, runContext };
