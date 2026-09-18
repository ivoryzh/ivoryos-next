import type { SequenceBlock } from './WorkflowEditor';

/**
 * Renders a designed sequence as a Python preview, split into prep()/main()/cleanup() rather
 * than one fused run_workflow(). This matches how the edge server actually executes an
 * Optimization run: prep() and cleanup() bookend the run once each, while main() is the part
 * that gets called repeatedly — once per trial, with a different suggested value each time —
 * so it can't honestly be shown as a single straight-line script.
 */
export function generatePythonCode(
  prepSequence: SequenceBlock[],
  sequence: SequenceBlock[],
  cleanupSequence: SequenceBlock[],
  instrumentMeta: Record<string, any>
): string {
  const allBlocks = [...prepSequence, ...sequence, ...cleanupSequence];
  const isFlowControl = (b: SequenceBlock) => b.instrument === 'Flow_Control' || b.instrument === 'Flow Control';
  const hasSleep = allBlocks.some(b => isFlowControl(b) && b.method === 'Sleep');

  let code = '';
  if (hasSleep) code += 'import time\n';

  // Imports are gathered across every phase, not just Main — an instrument used only in
  // Prep or Cleanup previously had no import line generated for it at all.
  const instruments = Array.from(new Set(allBlocks.map(s => s.instrument))).filter(i => i !== 'Flow_Control' && i !== 'Flow Control');
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

  const genFunctionBody = (blocks: SequenceBlock[]): string => {
    if (blocks.length === 0) return '    pass\n';
    let body = '';
    let indent = 1;
    blocks.forEach((block, idx) => {
      const pad = '    '.repeat(indent);
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
          body += `${pad}time.sleep(${block.params.duration_seconds || 0})\n`;
        } else if (block.method === 'User_Input') {
          const varName = (block.params.variable_name || 'user_value').trim();
          const promptText = String(block.params.prompt || '');
          body += `${pad}${varName} = input(${pyTextLiteral(promptText + ': ')})\n`;
        } else if (block.method === 'Comment') {
          const message = String(block.params.message || '');
          body += `${pad}print(${pyTextLiteral(message)})\n`;
        }
        return;
      }

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

      const params = Object.entries(block.params).map(([k, v]) => `${k}=${formatValue(v)}`).join(', ');
      emitAssignment(`${block.instrument}.${block.method}(${params})`);
    });
    return body;
  };

  code += `def prep():\n${genFunctionBody(prepSequence)}\n`;
  code += `def main():\n${genFunctionBody(sequence)}\n`;
  code += `def cleanup():\n${genFunctionBody(cleanupSequence)}\n`;

  code += "\nif __name__ == '__main__':\n";
  code += '    prep()\n';
  code += '    main()  # in an Optimization run, this is called once per trial with a new suggested value\n';
  code += '    cleanup()\n';
  return code;
}
