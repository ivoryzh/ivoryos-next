'use strict';
// What the model is told about the lab: deliberately lossy, like the edge's describe_deck. Keep
// what is needed to choose a device, a method or a saved workflow and call it; drop what is only
// needed to draw a form. The target narrows it to one device, one platform (a device group) or
// everything, which is also what keeps the prompt small once a lab has several decks.
const { CLOUD_LOGIC } = require('../dag.js');
const { scanDynamicParams, scanReturnVars } = require('./workflowScan.js');

const firstLine = (text) => String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

function describeMethod(entry) {
  const params = entry.parameters || {};
  const out = { summary: firstLine(entry.description) };
  const required = Object.entries(params).filter(([, p]) => p && p.required !== false).map(([k]) => k);
  const optional = Object.keys(params).filter((k) => !required.includes(k));
  if (required.length) out.required = required;
  if (optional.length) out.optional = optional;
  const numeric = (entry.return_paths || []).filter((r) => r && r.numeric).map((r) => r.path);
  if (numeric.length) out.numeric_results = numeric;
  if (entry.is_property) out.property = entry.property_access;
  return out;
}

/** Full detail for one method, for a follow-up question (types, options, defaults). */
function describeMethodFull(entry) {
  const parameters = {};
  for (const [name, p] of Object.entries(entry.parameters || {})) {
    const brief = { type: p.type || 'Any' };
    if (p.options) brief.options = p.options;
    if (p.required === false) { brief.optional = true; if (p.default !== undefined) brief.default = p.default; }
    if (p.is_object) brief.object_fields = Object.keys(p.fields || {}).sort();
    parameters[name] = brief;
  }
  const out = { description: entry.description || '', parameters };
  if ((entry.return_paths || []).length) out.returns = entry.return_paths.map((r) => ({ save_from: r.path, type: r.type, numeric: !!r.numeric }));
  else if (entry.return_type && !['None', 'NoneType'].includes(entry.return_type)) out.returns = [{ save_from: '', type: entry.return_type, numeric: false }];
  return out;
}

/**
 * @param {object[]} devices   store rows {id, name, status, busy, schema}
 * @param {object[]} sequences store rows {device_id, name, description, body}
 * @param {{kind:'all'|'platform'|'device', id?:string, deviceIds?:string[], name?:string}} target
 */
function describeTarget(devices, sequences, target = { kind: 'all' }) {
  let chosen = devices;
  if (target.kind === 'device') chosen = devices.filter((d) => String(d.id) === String(target.id));
  else if (target.kind === 'platform') {
    const ids = new Set((target.deviceIds || []).map(String));
    chosen = devices.filter((d) => ids.has(String(d.id)));
  }
  const out = { target: { kind: target.kind, name: target.name || null }, devices: {} };
  for (const d of chosen) {
    const instruments = {};
    for (const [inst, methods] of Object.entries(d.schema?.instruments || {}).sort()) {
      instruments[inst] = {};
      for (const [m, entry] of Object.entries(methods || {}).sort()) instruments[inst][m] = describeMethod(entry || {});
    }
    const workflows = {};
    for (const s of sequences.filter((x) => String(x.device_id) === String(d.id))) {
      const body = s.body || {};
      const wf = {
        description: firstLine(s.description || body.description),
        inputs: Object.keys(scanDynamicParams(body)),
        outputs: scanReturnVars(body),
        steps: ['prep', 'script', 'sequence', 'cleanup'].reduce((n, k) => n + (Array.isArray(body[k]) ? body[k].length : 0), 0),
      };
      if (body.compatibility && body.compatibility.status === 'broken') wf.broken = true;
      workflows[s.name] = wf;
    }
    out.devices[String(d.id)] = {
      name: d.name || String(d.id),
      status: d.status || 'offline',
      instruments,
      ...(Object.keys(workflows).length ? { workflows } : {}),
    };
  }
  out.cloud_logic = {
    device: 'cloud',
    methods: Object.fromEntries(Object.entries(CLOUD_LOGIC).map(([name, e]) => [name, {
      summary: firstLine(e.description),
      parameters: Object.fromEntries(Object.entries(e.parameters || {}).map(([k, p]) => [k, { type: p.type, ...(p.options ? { options: p.options } : {}), ...(p.required === false ? { optional: true } : {}) }])),
    }])),
  };
  out.conventions = {
    graph: 'A workflow is a set of steps with dependencies. A step runs when every step it is `after` has finished; steps with no `after` run first, in parallel. Steps on one device run one at a time whatever the graph says.',
    device_workflows: 'Prefer a device\'s saved workflow (device, instrument "Library Workflows", method = the workflow name) over spelling out its instrument methods: a long task on one device is one step here. Its `inputs` are the args it needs; its `outputs` are names later steps may read as "#name".',
    variable: 'An arg value of "#name" is filled at run time from an earlier step\'s output of that name (or by the operator before the run).',
    outputs: 'A step saves results with `outputs`: ["name", ...]. For an instrument method, names are bound in order to its numeric_results; for a saved workflow, use its listed outputs.',
    cloud_logic: 'Wait, User_Input and If run in Cloud, not on a device: device "cloud". An If reads one output name in `variable` and its two exits are branches "true" and "false": a step after an If names the branch with {"step": "<if id>", "branch": "true"}.',
  };
  return out;
}

module.exports = { describeTarget, describeMethod, describeMethodFull, firstLine };
