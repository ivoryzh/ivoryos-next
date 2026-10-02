import type { SequenceBlock } from './WorkflowEditor';
import {
  LIBRARY_INSTRUMENT, linkOutputBindings, scanDynamicParams, toSequenceBlocks, workflowOutputs,
  type SavedWorkflowBody,
} from './workflowBody';

const PY_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);

/**
 * Renders a designed sequence as a Python preview, split into prep()/main()/cleanup() rather
 * than one fused run_workflow(). This matches how the edge server actually executes an
 * Optimization run: prep() and cleanup() bookend the run once each, while main() is the part
 * that gets called repeatedly — once per trial, with a different suggested value each time —
 * so it can't honestly be shown as a single straight-line script.
 *
 * A step that links a saved workflow is a call to a function of the script's own: each linked
 * workflow becomes `def <its name>(<its open #variables>):` holding its steps and returning what
 * it saves, and the step reads `a, b = <its name>(x=...)` under the names the step saves them as.
 * It used to render as `Library Workflows.<name>(...)` with `from hardware import Library
 * Workflows` above it: a syntax error twice over, and no such module either way. `opts.workflows`
 * holds the saved bodies (the toolbox's), `opts.instruments` the deck's schema for their steps.
 */
export function generatePythonCode(
  prepSequence: SequenceBlock[],
  sequence: SequenceBlock[],
  cleanupSequence: SequenceBlock[],
  instrumentMeta: Record<string, any>,
  opts: { workflows?: Record<string, SavedWorkflowBody | undefined>; instruments?: any } = {},
): string {
  const isFlowControl = (b: { instrument: string }) => b.instrument === 'Flow_Control' || b.instrument === 'Flow Control';
  // Filled in while the bodies are written, since a linked workflow brings instruments (and maybe
  // a sleep) of its own that the sequence itself never names.
  const usedInstruments = new Set<string>();
  let usesSleep = false;

  // A workflow's name as a Python function name, unique within the script.
  const fnNames = new Map<string, string>();
  const fnName = (workflow: string): string => {
    const known = fnNames.get(workflow);
    if (known) return known;
    let id = workflow.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'workflow';
    if (/^\d/.test(id)) id = `workflow_${id}`;
    if (PY_KEYWORDS.has(id)) id = `${id}_workflow`;
    let unique = id;
    for (let n = 2; [...fnNames.values()].includes(unique); n++) unique = `${id}_${n}`;
    fnNames.set(workflow, unique);
    return unique;
  };
  const workflowDefs = new Map<string, string>();

  const formatValue = (v: any): string => {
    if (typeof v === 'string' && v.startsWith('#')) return v.substring(1).trim(); // bare reference to a variable set earlier in the script
    if (typeof v === 'string') return `"${v}"`;
    // Python's literals, not JavaScript's — a bool param was rendering as `true`/`false`, which
    // is a NameError when the generated script is actually run.
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    if (v === null || v === undefined) return 'None';
    if (typeof v === 'object' && v !== null) {
      const dictEntries = Object.entries(v).map(([subK, subV]) => `"${subK}": ${formatValue(subV)}`);
      return `{${dictEntries.join(', ')}}`;
    }
    return String(v);
  };

  // Turns free text like "The flow rate is #flow_rate today" into a Python f-string —
  // "f\"The flow rate is {flow_rate} today\"" — so referencing an earlier variable inside a
  // Comment or a User_Input prompt reads the same '#name' way as everywhere else in the app,
  // without the user needing to know Python's f-string syntax at all.
  const pyTextLiteral = (text: string): string => {
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (/#(\w+)/.test(escaped)) {
      const interpolated = escaped.replace(/#(\w+)/g, '{$1}');
      return `f"${interpolated}"`;
    }
    return `"${escaped}"`;
  };

  // `a, b = name(x=...)`: the names this step saves the workflow's outputs under.
  function linkCall(block: SequenceBlock): string {
    const name = String(block.method || '');
    const fn = defineWorkflow(name);
    const args = Object.entries(block.params || {})
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(', ');
    const outputs = Array.isArray((block.schema as any)?.return_paths)
      ? linkOutputBindings(block).map(b => b.var)
      : workflowOutputs(opts.workflows?.[name], () => []).map(o => o.path);
    return `${outputs.length ? `${outputs.join(', ')} = ` : ''}${fn}(${args})`;
  }

  // The function for one saved workflow: its open #variables as arguments, its prep, body and
  // cleanup in order, and what it saves as the return value. Defined once however many steps
  // call it; a workflow it links becomes a function of its own.
  function defineWorkflow(name: string): string {
    const fn = fnName(name);
    if (workflowDefs.has(name)) return fn;
    workflowDefs.set(name, '');
    const body = opts.workflows?.[name];
    if (!body) {
      workflowDefs.set(name,
        `def ${fn}(**kwargs):\n    # "${name}" is a saved workflow whose steps are not available here\n    raise NotImplementedError(${JSON.stringify(name)})\n`);
      return fn;
    }
    const steps = [
      ...toSequenceBlocks(body.prep, opts.instruments || {}),
      ...toSequenceBlocks(body.script || body.sequence, opts.instruments || {}),
      ...toSequenceBlocks(body.cleanup, opts.instruments || {}),
    ];
    const params = Object.keys(scanDynamicParams(body));
    const outputs = workflowOutputs(body, () => []).map(o => o.path);
    const doc = `${name}${body.version ? ` (v${body.version})` : ''}, from the Library.`.replace(/"/g, "'");
    let def = `def ${fn}(${params.join(', ')}):\n    """${doc}"""\n`;
    def += genFunctionBody(steps);
    if (outputs.length) def += `    return ${outputs.join(', ')}\n`;
    workflowDefs.set(name, def);
    return fn;
  }

  function genFunctionBody(blocks: SequenceBlock[]): string {
    if (blocks.length === 0) return '    pass\n';
    let body = '';
    let indent = 1;
    blocks.forEach((block, idx) => {
      const pad = '    '.repeat(indent);
      if (block.instrument === LIBRARY_INSTRUMENT) {
        body += `${pad}${linkCall(block)}\n`;
        return;
      }
      if (isFlowControl(block)) {
        if (block.method === 'If') {
          body += `${pad}if ${block.params.condition || 'True'}:\n`;
          indent++;
          const next = blocks[idx + 1];
          if (next && isFlowControl(next) && (next.method === 'Else' || next.method === 'End_If')) {
            body += `${'    '.repeat(indent)}pass\n`;
          }
        } else if (block.method === 'Else') {
          indent = Math.max(1, indent - 1);
          body += `${'    '.repeat(indent)}else:\n`;
          indent++;
          const next = blocks[idx + 1];
          if (next && isFlowControl(next) && next.method === 'End_If') {
            body += `${'    '.repeat(indent)}pass\n`;
          }
        } else if (block.method === 'End_If') {
          indent = Math.max(1, indent - 1);
        } else if (block.method === 'While') {
          body += `${pad}while ${block.params.condition || 'True'}:\n`;
          indent++;
          const next = blocks[idx + 1];
          if (next && isFlowControl(next) && next.method === 'End_While') {
            body += `${'    '.repeat(indent)}pass\n`;
          }
        } else if (block.method === 'End_While') {
          indent = Math.max(1, indent - 1);
        } else if (block.method === 'Sleep') {
          usesSleep = true;
          body += `${pad}time.sleep(${block.params.duration_seconds || 0})\n`;
        } else if (block.method === 'User_Input') {
          // No name to save under: a pause, so the value typed (Enter) is not kept.
          const varName = String(block.params.variable_name || '').trim();
          const promptText = String(block.params.prompt || '');
          body += varName
            ? `${pad}${varName} = input(${pyTextLiteral(promptText + ': ')})\n`
            : `${pad}input(${pyTextLiteral(promptText + ' (press Enter to continue)')})\n`;
        } else if (block.method === 'Comment') {
          const message = String(block.params.message || '');
          body += `${pad}print(${pyTextLiteral(message)})\n`;
        }
        return;
      }

      usedInstruments.add(block.instrument);

      // A property is an attribute in Python, not a call. Introspection surfaces a writable
      // property as two steps — `speed` and `speed_(setter)` — and rendering either of them as
      // `instrument.speed_(setter)(value=5)` would preview code that cannot run.
      const propertyName = block.schema?.property_name;
      if (propertyName && block.schema?.property_access === 'set') {
        body += `${pad}${block.instrument}.${propertyName} = ${formatValue(block.params.value)}\n`;
        return;
      }
      // A step's saved names are fields of one returned value, not a tuple to unpack — so write
      // the expression to a temp and pull each field out of it by the same path the run resolves
      // at execution time. `x, y = expr` would be a TypeError against a dataclass or Pydantic
      // result. Shared by the property getter and the method call below: a property typed as a
      // dataclass is as much a structured result as a method returning one.
      const emitAssignment = (expr: string) => {
        const bindings = (block.returnBindings || []).filter((b: any) => b && b.var);
        if (bindings.length === 1 && !bindings[0].path) {
          body += `${pad}${bindings[0].var} = ${expr}\n`;
        } else if (bindings.length > 0) {
          body += `${pad}_result = ${expr}\n`;
          bindings.forEach((b: any) => {
            const accessor = String(b.path).split('.')
              .map((seg: string) => (/^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`))
              .join('');
            body += `${pad}${b.var} = _result${accessor}\n`;
          });
        } else {
          const returnStr = block.returnVar ? `${block.returnVar} = ` : '';
          body += `${pad}${returnStr}${expr}\n`;
        }
      };

      if (propertyName && block.schema?.property_access === 'get') {
        emitAssignment(`${block.instrument}.${propertyName}`);
        return;
      }

      // A positional-only parameter cannot be written as a keyword — `read_channel(channel=2)`
      // on a `def read_channel(self, channel, /)` is a TypeError, so rendering it that way
      // previews code that does not run. Introspection marks those parameters; emit the leading
      // run of supplied ones by position, in the order the schema declares them, and the rest by
      // name. The run stops at the first one left empty, for the same reason execution does:
      // after a gap, position no longer identifies anything.
      const schemaParams: Record<string, any> = block.schema?.parameters || {};
      const positionalNames: string[] = [];
      for (const [name, info] of Object.entries(schemaParams)) {
        if (!(info as any)?.positional) continue;
        if (!(name in block.params)) break;
        positionalNames.push(name);
      }
      const params = [
        ...positionalNames.map(k => formatValue(block.params[k])),
        ...Object.entries(block.params)
          .filter(([k]) => !positionalNames.includes(k) && !k.startsWith('_'))
          .map(([k, v]) => `${k}=${formatValue(v)}`),
      ].join(', ');
      emitAssignment(`${block.instrument}.${block.method}(${params})`);
    });
    return body;
  }

  const bodies = {
    prep: genFunctionBody(prepSequence),
    main: genFunctionBody(sequence),
    cleanup: genFunctionBody(cleanupSequence),
  };

  // Imports last: only now is it known what the linked workflows use as well. Gathered across
  // every phase, not just Main — an instrument used only in Prep or Cleanup once had no import.
  let code = '';
  if (usesSleep) code += 'import time\n';
  const instruments = [...usedInstruments].filter(i => i && i !== LIBRARY_INSTRUMENT && !isFlowControl({ instrument: i }));
  if (instruments.length > 0) {
    const moduleGroups: Record<string, string[]> = {};
    instruments.forEach(inst => {
      const meta = instrumentMeta[inst];
      const mod = meta ? meta.module : 'hardware';
      if (!moduleGroups[mod]) moduleGroups[mod] = [];
      moduleGroups[mod].push(inst);
    });
    Object.entries(moduleGroups).forEach(([mod, insts]) => {
      code += `from ${mod} import ${insts.join(', ')}\n`;
    });
    code += '\n';
  }

  workflowDefs.forEach(def => { if (def) code += `${def}\n`; });

  code += `def prep():\n${bodies.prep}\n`;
  code += `def main():\n${bodies.main}\n`;
  code += `def cleanup():\n${bodies.cleanup}\n`;

  code += "\nif __name__ == '__main__':\n";
  code += '    prep()\n';
  code += '    main()  # in an Optimization run, this is called once per trial with a new suggested value\n';
  code += '    cleanup()\n';
  return code;
}
