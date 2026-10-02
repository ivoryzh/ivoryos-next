'use strict';
// The model proposes a *graph spec*, a flat list of steps with dependencies, which is far easier
// for a model to get right than React Flow nodes with positions and handles. This module is the
// load-bearing piece, as agent/validate.py is on the edge: it checks every step against the real
// device schemas (unknown device, instrument, method or workflow; missing, unknown or mistyped
// args; outputs nothing produces), then materializes the spec into the exact node and edge
// objects a person's drag-drop would have made, and runs validateGraph on the result. Errors are
// fed back to the model (chat.js); only a spec with none is shown as "validates".
//
// A spec:
//   { name, description, steps: [ { id, device: "<device id>" | "cloud", instrument, method,
//       args: {}, outputs: ["name"], after: ["<id>" | {step: "<id>", branch: "true"|"false"}] } ] }

const { CLOUD_LOGIC, IF_OPERATORS, validateGraph } = require('../dag.js');
const { scanDynamicParams, scanReturnVars } = require('./workflowScan.js');

const LIBRARY_INSTRUMENT = 'Library Workflows';
const FLOW_CONTROL = 'Flow Control';
const CLOUD = 'cloud';

const issue = (severity, where, message, hint) => ({ severity, where, message, ...(hint ? { hint } : {}) });
const isRef = (v) => typeof v === 'string' && v.trim().startsWith('#');
const numericOk = (v) => {
  if (typeof v === 'boolean') return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.trim() !== '' && Number.isFinite(Number(v));
  return false;
};

function stepsOf(spec) { return Array.isArray(spec?.steps) ? spec.steps : []; }

function afterOf(step) {
  return (Array.isArray(step.after) ? step.after : []).map((a) => (typeof a === 'string' ? { step: a, branch: null } : { step: String(a?.step || ''), branch: a?.branch ? String(a.branch) : null }));
}

/** The method schema a step resolves to on its device, or null. */
function schemaFor(step, device, sequencesOfDevice) {
  if (step.device === CLOUD) return CLOUD_LOGIC[step.method] || null;
  if (step.instrument === LIBRARY_INSTRUMENT) {
    const s = sequencesOfDevice.find((x) => x.name === step.method);
    if (!s) return null;
    const body = s.body || {};
    return {
      description: s.description || body.description || '',
      parameters: scanDynamicParams(body),
      return_type: 'None',
      outputs: scanReturnVars(body),
      version: body.version, body_hash: body.body_hash,
      runtime: body.runtime || null, compatibility: body.compatibility || null,
    };
  }
  return device?.schema?.instruments?.[step.instrument]?.[step.method] || null;
}

function checkArgs(where, step, schema, known, issues) {
  const params = schema.parameters || {};
  const args = step.args && typeof step.args === 'object' ? step.args : {};
  for (const [name, info] of Object.entries(params)) {
    if (info.required === false || 'default' in info) continue;
    const v = args[name];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      issues.push(issue('error', where, `${step.instrument}.${step.method} needs a value for '${name}' (${info.type || 'Any'}).`, "Give it a literal value, or '#name' to take it from an earlier step's outputs."));
    }
  }
  for (const [name, v] of Object.entries(args)) {
    if (name.startsWith('_')) continue;
    const info = params[name];
    if (!info) {
      if (schema.accepts_kwargs) continue;
      issues.push(issue('error', where, `${step.instrument}.${step.method} has no parameter '${name}'.`, Object.keys(params).length ? `Parameters are: ${Object.keys(params).sort().join(', ')}` : 'This method takes no parameters.'));
      continue;
    }
    if (isRef(v)) {
      const ref = v.trim().slice(1).trim();
      if (!ref) issues.push(issue('error', where, `'${name}' is a bare '#' with no name.`));
      else if (!known.has(ref)) issues.push(issue('error', where, `'${name}' reads #${ref}, which no step produces.`, 'Name it in an earlier step\'s `outputs`, or give a literal value.'));
      continue;
    }
    if (v === null || v === undefined || v === '') continue;
    const type = String(info.type || '').toLowerCase();
    if ((type.includes('int') || type.includes('float')) && !numericOk(v)) {
      issues.push(issue('error', where, `'${name}' expects a number (${info.type}) but got ${JSON.stringify(v)}.`, 'Write the bare number, with no unit: 65, not "65 C".'));
    }
    if (Array.isArray(info.options) && info.options.length && !info.options.map(String).includes(String(v))) {
      issues.push(issue('error', where, `'${name}' must be one of ${JSON.stringify(info.options)}, not ${JSON.stringify(v)}.`));
    }
  }
}

/**
 * @returns {{issues: object[], ok: boolean}} issues sorted errors first
 */
function validateSpec(spec, devices, sequences) {
  const issues = [];
  const steps = stepsOf(spec);
  if (!spec || typeof spec !== 'object') return { issues: [issue('error', 'spec', 'The reply had no workflow object.')], ok: false };
  if (!steps.length) return { issues: [issue('error', 'spec', 'The workflow has no steps.')], ok: false };
  const byId = new Map();
  const deviceOf = (id) => devices.find((d) => String(d.id) === String(id));

  // Outputs any step declares: later steps may read them. (Order is a graph property, checked
  // by the dependency walk below; here every declared name counts.)
  const known = new Set();
  for (const s of steps) for (const o of s.outputs || []) if (typeof o === 'string' && o.trim()) known.add(o.trim());

  steps.forEach((step, i) => {
    const where = `steps[${i}]${step && step.id ? ` (${step.id})` : ''}`;
    if (!step || typeof step !== 'object') { issues.push(issue('error', where, 'A step must be an object.')); return; }
    if (!step.id || typeof step.id !== 'string') issues.push(issue('error', where, 'Every step needs a string `id`.'));
    else if (byId.has(step.id)) issues.push(issue('error', where, `Two steps share the id '${step.id}'.`));
    else byId.set(step.id, step);
    if (!step.method) { issues.push(issue('error', where, 'A step needs a `method`.')); return; }

    if (step.device === CLOUD) {
      if (!CLOUD_LOGIC[step.method]) { issues.push(issue('error', where, `Cloud has no step called '${step.method}'.`, `Cloud steps are: ${Object.keys(CLOUD_LOGIC).join(', ')}`)); return; }
      step.instrument = FLOW_CONTROL;
      const args = step.args || {};
      if (step.method === 'If') {
        if (!args.variable || !known.has(String(args.variable).replace(/^#/, ''))) issues.push(issue('error', where, `If reads '${args.variable || ''}', which no step produces.`, 'Set `variable` to an output name from an earlier step.'));
        if (!IF_OPERATORS.includes(String(args.operator || ''))) issues.push(issue('error', where, `If needs an operator from ${JSON.stringify(IF_OPERATORS)}.`));
        if (args.value === undefined || args.value === '') issues.push(issue('error', where, 'If needs a `value` to compare with.'));
      } else if (step.method === 'Wait') {
        if (!(Number(args.seconds) > 0)) issues.push(issue('error', where, 'Wait needs `seconds` greater than 0.'));
      } else if (step.method === 'User_Input') {
        if (!args.prompt) issues.push(issue('error', where, 'User_Input needs a `prompt`.'));
      }
      return;
    }

    const device = deviceOf(step.device);
    if (!device) { issues.push(issue('error', where, `There is no device '${step.device}'.`, `Devices are: ${devices.map((d) => d.id).join(', ')}`)); return; }
    if (!step.instrument) { issues.push(issue('error', where, 'A device step needs an `instrument`.')); return; }
    const mine = sequences.filter((s) => String(s.device_id) === String(device.id));
    const schema = schemaFor(step, device, mine);
    if (!schema) {
      if (step.instrument === LIBRARY_INSTRUMENT) issues.push(issue('error', where, `'${device.id}' has no saved workflow called '${step.method}'.`, mine.length ? `Its workflows are: ${mine.map((s) => s.name).join(', ')}` : 'It has no saved workflows; use its instrument methods.'));
      else if (!device.schema?.instruments?.[step.instrument]) issues.push(issue('error', where, `'${device.id}' has no instrument called '${step.instrument}'.`, `Its instruments are: ${Object.keys(device.schema?.instruments || {}).sort().join(', ')}`));
      else issues.push(issue('error', where, `'${step.instrument}' on '${device.id}' has no method '${step.method}'.`, `Its methods are: ${Object.keys(device.schema.instruments[step.instrument]).sort().join(', ')}`));
      return;
    }
    if (schema.compatibility && schema.compatibility.status === 'broken') issues.push(issue('error', where, `'${step.method}' does not currently run on '${device.id}' (its Library marks it broken).`));
    checkArgs(where, step, schema, known, issues);
    const outputs = (step.outputs || []).filter(Boolean);
    if (outputs.length) {
      if (step.instrument === LIBRARY_INSTRUMENT) {
        for (const o of outputs) if (!(schema.outputs || []).includes(o)) issues.push(issue('error', where, `'${step.method}' produces no output called '${o}'.`, (schema.outputs || []).length ? `Its outputs are: ${schema.outputs.join(', ')}` : 'It produces no outputs.'));
      } else {
        const numeric = (schema.return_paths || []).filter((r) => r.numeric);
        const any = schema.return_type && !['None', 'NoneType'].includes(schema.return_type);
        if (!any) issues.push(issue('error', where, `${step.instrument}.${step.method} returns nothing to save.`));
        else if (numeric.length && outputs.length > numeric.length) issues.push(issue('warning', where, `${step.instrument}.${step.method} has ${numeric.length} numeric result(s); ${outputs.length} names were given.`));
      }
    }
  });

  // Dependencies: known ids, If branches named, no cycles (Kahn).
  const ids = new Set(byId.keys());
  const indeg = new Map([...ids].map((id) => [id, 0]));
  const out = new Map([...ids].map((id) => [id, []]));
  steps.forEach((step, i) => {
    if (!step || !byId.has(step.id)) return;
    const where = `steps[${i}] (${step.id})`;
    for (const a of afterOf(step)) {
      if (!ids.has(a.step)) { issues.push(issue('error', where, `'after' names '${a.step}', which is not a step.`)); continue; }
      const dep = byId.get(a.step);
      const depIsIf = dep.device === CLOUD && dep.method === 'If';
      if (depIsIf && !['true', 'false'].includes(a.branch || '')) issues.push(issue('error', where, `'${a.step}' is an If: say which branch, {"step": "${a.step}", "branch": "true"} or "false".`));
      if (!depIsIf && a.branch) issues.push(issue('warning', where, `'${a.step}' is not an If; its branch '${a.branch}' is ignored.`));
      indeg.set(step.id, indeg.get(step.id) + 1);
      out.get(a.step).push(step.id);
    }
  });
  const queue = [...ids].filter((id) => indeg.get(id) === 0);
  let seen = 0;
  while (queue.length) { const id = queue.shift(); seen += 1; for (const n of out.get(id)) { indeg.set(n, indeg.get(n) - 1); if (indeg.get(n) === 0) queue.push(n); } }
  if (seen < ids.size) issues.push(issue('error', 'spec', 'The steps depend on each other in a cycle.', 'Every step must come after steps that do not come after it.'));

  const rank = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { issues, ok: !issues.some((x) => x.severity === 'error') };
}

/** Longest-path depth from the roots, for layout. */
function depths(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const memo = new Map();
  const depth = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    const d = Math.max(0, ...afterOf(byId.get(id)).filter((a) => byId.has(a.step)).map((a) => depth(a.step, stack) + 1));
    memo.set(id, d);
    return d;
  };
  for (const s of steps) depth(s.id);
  return memo;
}

/**
 * The spec as the canvas's own nodes and edges: one `customCloudNode` per step with the method's
 * schema copied in (what onDrop does), the fixed Start node, and an edge per dependency, with
 * Start feeding every root. Positions are layered by depth and snapped to the canvas grid.
 */
function materialize(spec, devices, sequences) {
  const steps = stepsOf(spec).filter((s) => s && s.id);
  const stamp = Date.now();
  const nodes = [{
    id: 'start_node', type: 'customCloudNode', position: { x: 250, y: 100 },
    data: { targetDeviceId: '', block: { id: 'start_block', instrument: FLOW_CONTROL, method: 'Start', schema: { parameters: {} }, params: {} } },
  }];
  const edges = [];
  const d = depths(steps);
  const perLayer = new Map();
  for (const s of steps) { const k = d.get(s.id) || 0; perLayer.set(k, (perLayer.get(k) || 0) + 1); }
  const placed = new Map();
  const idOf = (sid) => `node_${stamp}_${sid.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  steps.forEach((step, i) => {
    const device = devices.find((x) => String(x.id) === String(step.device));
    const mine = sequences.filter((x) => String(x.device_id) === String(step.device));
    const isCloud = step.device === CLOUD;
    const schema = (isCloud ? CLOUD_LOGIC[step.method] : schemaFor(step, device, mine)) || { parameters: {} };
    const params = {};
    for (const [k, p] of Object.entries(schema.parameters || {})) if (p && p.default !== undefined) params[k] = p.default;
    Object.assign(params, step.args && typeof step.args === 'object' ? step.args : {});
    if (isCloud && step.method === 'If' && typeof params.variable === 'string') params.variable = params.variable.replace(/^#/, '');
    if (isCloud && step.method === 'User_Input' && Array.isArray(step.outputs) && step.outputs[0] && !params.save_as) params.save_as = step.outputs[0];
    const layer = d.get(step.id) || 0;
    const col = placed.get(layer) || 0; placed.set(layer, col + 1);
    const width = 300; const total = perLayer.get(layer) || 1;
    const x = Math.round((250 + (col - (total - 1) / 2) * width) / 20) * 20;
    const y = 100 + (layer + 1) * 180;
    nodes.push({
      id: idOf(step.id), type: 'customCloudNode', position: { x, y },
      data: {
        targetDeviceId: isCloud ? '' : String(step.device),
        block: {
          id: `block-${stamp}-${i}`,
          instrument: isCloud ? FLOW_CONTROL : step.instrument,
          method: step.method,
          schema,
          params,
          returnVar: isCloud ? '' : (step.outputs || []).filter(Boolean).join(', '),
          ...(step.instrument === LIBRARY_INSTRUMENT && !isCloud ? { ref: { name: step.method, version: schema.version, body_hash: schema.body_hash, mode: 'latest' } } : {}),
        },
      },
    });
  });
  for (const step of steps) {
    const after = afterOf(step).filter((a) => steps.some((s) => s.id === a.step));
    if (!after.length) {
      edges.push({ id: `xy-edge__start_node-${idOf(step.id)}`, source: 'start_node', target: idOf(step.id), sourceHandle: null, targetHandle: null });
      continue;
    }
    for (const a of after) {
      const handle = a.branch === 'true' || a.branch === 'false' ? a.branch : null;
      edges.push({ id: `xy-edge__${idOf(a.step)}${handle || ''}-${idOf(step.id)}`, source: idOf(a.step), target: idOf(step.id), sourceHandle: handle, targetHandle: null });
    }
  }
  return { nodes, edges };
}

/** Validate the spec, materialize it, and run the canvas's own graph rules on the result. */
function checkProposal(spec, devices, sequences) {
  const { issues } = validateSpec(spec, devices, sequences);
  let graph = null;
  if (!issues.some((x) => x.severity === 'error')) {
    graph = materialize(spec, devices, sequences);
    for (const p of validateGraph(graph.nodes, graph.edges)) issues.push(issue('error', 'graph', p.message));
  }
  return { issues, ok: !issues.some((x) => x.severity === 'error'), graph };
}

function summarise(issues) {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  if (errors) return `${errors} error${errors === 1 ? '' : 's'} must be fixed before this can run.`;
  if (warnings) return `No errors. ${warnings} warning${warnings === 1 ? '' : 's'}.`;
  return 'Valid against the current devices.';
}

module.exports = { validateSpec, materialize, checkProposal, summarise, LIBRARY_INSTRUMENT, CLOUD };
