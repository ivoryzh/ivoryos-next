/**
 * Reading one *named* output back out of a finished run.
 *
 * A step no longer produces "the" result: a driver method that returns a dataclass or Pydantic
 * model produces several named variables at once, each bound to one field of that object (see
 * `returnBindings` / `getReturnLeaves` in WorkflowEditor). Data History columns, CSV exports and
 * the Optimize page's "seed from an earlier run" all have to resolve a variable name back to the
 * *field* it pointed at — not to the whole recorded result object, and not to whatever step
 * happened to sit at the same position.
 */

export type ReturnBindingRef = { path: string; var: string };

export type OutputTemplateStep = {
  returnVar?: string | null;
  returnBindings?: ReturnBindingRef[] | null;
};

export type OutputStep = { outputs?: { result?: any } | null } | null | undefined;

/** Walk a dotted pointer ("metrics.purity", "0", "" for the whole value) into a recorded result. */
export const resolveResultPath = (result: any, path: string): any => {
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
};

/**
 * The value of one named output variable within a single iteration's steps.
 *
 * `steps` must be that iteration's steps in template order (every iteration repeats the same
 * block sequence, which is what makes the positional match valid). Returns '' when the run has
 * no record of that variable — an older run, a step that errored, a name that isn't bound.
 */
export function readNamedOutput(name: string, seqTemplate: OutputTemplateStep[], steps: OutputStep[]): any {
  for (let i = 0; i < seqTemplate.length; i++) {
    const tmpl = seqTemplate[i];
    if (!tmpl) continue;
    const result = steps[i]?.outputs?.result;

    const binding = tmpl.returnBindings?.find(b => b.var === name);
    if (binding) {
      if (result === undefined) return '';
      const value = resolveResultPath(result, binding.path);
      return value === undefined ? '' : value;
    }

    // Legacy: a flat comma-separated name list mapped onto the result positionally — one name
    // means "the whole result", several mean "the fields in the order they came out".
    const parts = String(tmpl.returnVar || '').split(',').map(v => v.trim()).filter(Boolean);
    const idx = parts.indexOf(name);
    if (idx === -1) continue;
    if (result === undefined) return '';
    if (parts.length === 1) return result;
    if (Array.isArray(result)) return result[idx] ?? '';
    if (result && typeof result === 'object') return Object.values(result)[idx] ?? '';
    return result;
  }
  return '';
}
