/**
 * The `#variable` resolution rules, shared by every page that turns an authored sequence into a
 * dispatchable one.
 *
 * Three call sites used to carry three hand-written copies of the same tree walk — Configure's
 * `resolveArgs`, Optimize's `resolveFixedVarsInBlock`, and Optimize's `resolveGlobalBlock` — and
 * they already disagreed about numeric casting: Configure rejects a non-numeric value for an
 * int/float param, the other two silently pass the string through. That is the drift AGENTS.md
 * section 3 warns about, and it now matters twice over, because the Cloud orchestrator has to
 * resolve `#name`s exactly the way the edge does or a distributed run means something different
 * from the same sequence run at the bench.
 *
 * So: one walker, three policies, expressed as options rather than as three functions.
 */

/** Thrown for a value that is missing or of the wrong shape. Message is user-facing verbatim. */
export class RunConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunConfigError';
  }
}

export interface ResolveOptions {
  /**
   * Supplies the value for a `#name`. Returning `undefined` means "no value here" and is handled
   * per `onMissing` below.
   */
  lookup: (varName: string) => any;
  /** How a `#name` is described in an error message, e.g. `'temperature' in row 3`. */
  describe: (varName: string) => string;
  /**
   * `throw` — a missing value aborts (Configure rows, Prep/Cleanup fixed values): the step is
   * about to run and an unresolved param would reach an instrument as the literal string.
   * `leave` — an unresolved `#name` stays in place (Optimize's search-space vars, which the
   * backend substitutes per trial).
   */
  onMissing: 'throw' | 'leave';
  /**
   * `strict` rejects a non-numeric value for an int/float param up front, which is the only
   * point where a typo is still cheap to fix. `lenient` casts when it can and passes the string
   * through otherwise, leaving the backend's own `cast_arguments` to have the last word.
   */
  numeric?: 'strict' | 'lenient';
  /** Names resolved elsewhere (e.g. live `User_Input` vars) — left as `#name` and never looked up. */
  skip?: (varName: string) => boolean;
}

const isNumericType = (type: unknown) => {
  const hint = String(type || '').toLowerCase();
  return hint.includes('int') || hint.includes('float');
};

/**
 * Resolve every `#name` inside one block's params, returning a new params object.
 *
 * Walks nested objects against the matching slice of the schema (`parameters` at the top level,
 * `fields` inside a structured argument) so a `#name` buried in a dataclass argument gets the same
 * type checking as a top-level one.
 */
export function resolveBlockParams(block: any, opts: ResolveOptions): Record<string, any> {
  const args = JSON.parse(JSON.stringify(block?.params || {}));

  const walk = (obj: any, schemaObj: any) => {
    Object.keys(obj).forEach((key) => {
      const val = obj[key];
      const declared = schemaObj?.parameters?.[key] ?? schemaObj?.fields?.[key] ?? null;

      if (typeof val === 'string' && val.trim().startsWith('#')) {
        const varName = val.trim().slice(1).trim();
        if (varName === '') {
          throw new RunConfigError(
            "A parameter uses '#' with no variable name — fix it in the Designer before running.",
          );
        }
        if (opts.skip?.(varName)) return;

        let subVal = opts.lookup(varName);
        if (subVal === undefined || subVal === null || subVal === '') {
          if (opts.onMissing === 'leave') return;
          throw new RunConfigError(`Missing value for ${opts.describe(varName)}`);
        }

        if (isNumericType(declared?.type)) {
          if (isNaN(Number(subVal))) {
            if (opts.numeric === 'strict') {
              throw new RunConfigError(
                `${opts.describe(varName)} expects a number (${declared?.type}), got '${subVal}'`,
              );
            }
          } else {
            subVal = Number(subVal);
          }
        }
        obj[key] = subVal;
      } else if (typeof val === 'object' && val !== null) {
        walk(val, declared);
      }
    });
  };

  walk(args, block?.schema);
  return args;
}

/** The wire shape `/api/queue/runs` and `/api/workflows/expand` both accept. */
export function toWireBlock(b: any) {
  return {
    instrument: b.instrument,
    method: b.method,
    params: b.params,
    returnVar: b.returnVar,
    ...(b.returnBindings?.length ? { returnBindings: b.returnBindings } : {}),
    batch_action: !!b.isBatchAction,
    ...(b.ref ? { ref: b.ref } : {}),
  };
}

/** One resolved step, ready to be posted as part of a run's `prep`/`sequence`/`cleanup`. */
export interface ResolvedStep {
  instrument: string;
  method: string;
  params: Record<string, any>;
  returnVar?: string;
  returnBindings?: any;
}

/**
 * Which of a block's arguments are `#name` references, as `{argument: name}`.
 *
 * A step is recorded with its values already substituted, so without this a finished run cannot
 * say which of its arguments came from a spreadsheet column, a fixed value or the optimizer and
 * which were typed into the step itself. Carried on the submitted step as `_vars` — metadata the
 * edge never forwards to a driver (`cast_arguments` drops `_`-prefixed keys) — and read by Data
 * History to mark those arguments.
 */
export function dynamicArgumentsOf(block: any, skip?: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(block?.params || {})) {
    const m = typeof value === 'string' ? /^#(\w+)$/.exec(value.trim()) : null;
    if (m && !key.startsWith('_') && !skip?.(m[1])) out[key] = m[1];
  }
  return out;
}

/**
 * Resolve a Prep/Cleanup block against the run's fixed values. These run once for the whole run,
 * so every `#name` in them must have a value before dispatch.
 */
export function resolveFixedBlock(
  block: any,
  values: Record<string, any>,
  opts: { numeric?: 'strict' | 'lenient'; describe?: (v: string) => string } = {},
): ResolvedStep {
  const params = resolveBlockParams(block, {
    lookup: (v) => values[v],
    describe: opts.describe ?? ((v) => `'${v}' in Fixed Values`),
    onMissing: 'throw',
    numeric: opts.numeric ?? 'strict',
  });
  const vars = dynamicArgumentsOf(block);
  return {
    instrument: block.instrument,
    method: block.method,
    params: Object.keys(vars).length ? { ...params, _vars: vars } : params,
    returnVar: block.returnVar,
    ...(block.returnBindings ? { returnBindings: block.returnBindings } : {}),
  };
}
