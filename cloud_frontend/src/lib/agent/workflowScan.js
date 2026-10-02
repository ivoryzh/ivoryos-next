'use strict';
// A saved workflow's open inputs and its outputs, from its body, for Node code that cannot import
// the TypeScript originals in packages/shared-ui/src/workflowBody.ts (scanDynamicParams,
// scanReturnVars). Same rules: an arg whose value is "#name" is an input, a `return` (or
// `returnVar`) is a comma list of outputs, and `return_bindings` name outputs too.
const stepsOf = (body) => ['prep', 'script', 'sequence', 'cleanup'].flatMap((k) => (Array.isArray(body?.[k]) ? body[k] : []));

function walk(value, found) {
  if (typeof value === 'string') {
    const m = /^#\s*([A-Za-z_]\w*)\s*$/.exec(value);
    if (m) found.add(m[1]);
  } else if (Array.isArray(value)) value.forEach((v) => walk(v, found));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => walk(v, found));
}

function scanDynamicParams(body) {
  const found = new Set();
  for (const step of stepsOf(body)) walk(step.args || step.params || {}, found);
  const out = {};
  for (const name of found) out[name] = { type: 'str', required: true };
  return out;
}

function scanReturnVars(body) {
  const out = [];
  for (const step of stepsOf(body)) {
    const names = String(step.return || step.returnVar || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const b of step.return_bindings || step.returnBindings || []) if (b && b.var) names.push(String(b.var));
    for (const n of names) if (!out.includes(n)) out.push(n);
  }
  return out;
}

module.exports = { scanDynamicParams, scanReturnVars };
