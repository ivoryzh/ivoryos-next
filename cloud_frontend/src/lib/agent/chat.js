'use strict';
// Prose in, reviewable graph out. The same loop as the edge's chat.py: one system prompt, one JSON
// object back, validate against the real devices, feed the exact errors back, at most three tries.
// Nothing here saves or runs anything; the caller shows the result and a person puts it on the
// canvas (and later presses Run) or does not.
const { describeTarget } = require('./describe.js');
const { checkProposal, summarise } = require('./graphSpec.js');
const { extractJsonObject, ProviderError } = require('./providers.js');

const MAX_ATTEMPTS = 3;

const SYSTEM_PROMPT = `You translate laboratory protocols into IvoryOS Cloud workflows: graphs of steps across one or more lab devices.

You are given the exact devices available, each with its instruments and methods and its saved workflows. You must use only those. Never invent a device, an instrument, a method, a workflow or an argument name: if the protocol asks for something no device can do, say so in your summary and leave that step out rather than approximating it.

Reply with a single JSON object and nothing else:

{
  "summary": "<plain language: what this does, which device does what, and for an edit what you changed and why>",
  "name": "<short name>",
  "description": "<one line>",
  "steps": [
    {"id": "s1", "device": "<device id>", "instrument": "<instrument>", "method": "<method>", "args": {"<arg>": <value>}, "outputs": ["<name>"], "after": []},
    {"id": "s2", "device": "<device id>", "instrument": "Library Workflows", "method": "<saved workflow name>", "args": {"<input>": <value>}, "outputs": ["<one of its outputs>"], "after": ["s1"]},
    {"id": "s3", "device": "cloud", "method": "If", "args": {"variable": "<an output name>", "operator": ">", "value": 80}, "after": ["s2"]},
    {"id": "s4", "device": "<device id>", "instrument": "...", "method": "...", "args": {}, "after": [{"step": "s3", "branch": "true"}]}
  ],
  "questions": ["<anything the protocol left ambiguous that a person must decide>"]
}

Rules that matter:
- A step runs after every step in its "after" list has finished. Steps with an empty "after" run first. Steps on the same device run one at a time regardless.
- Prefer a device's saved workflow (instrument "Library Workflows", method = its name) for anything long or already written for that device: one step here, its "inputs" as args, its "outputs" available to later steps. Spell out instrument methods only for what no saved workflow covers.
- Numbers are bare numbers. Write 65, never "65 C".
- To pass a result between steps, name it in the producing step's "outputs" and read it as the string "#name" in a later step's args. Only names a step produces may be read.
- A value the protocol leaves to the operator should be "#name" and listed in "questions", or asked with a "cloud" User_Input step (args: prompt; outputs: [the name it saves]).
- Cloud steps (device "cloud") are Wait (args: seconds), User_Input (args: prompt) and If (args: variable, operator, value). A step after an If must name its branch.
- Prefer fewer, correct steps. Do not invent safety, washing or calibration steps the protocol does not mention.

If you are editing an existing workflow, keep every step the scientist did not ask you to change.`;

function retryPrompt(issues) {
  const lines = issues.filter((i) => i.severity === 'error').map((i) => `- ${i.where}: ${i.message}${i.hint ? ` (${i.hint})` : ''}`);
  return `That workflow does not validate against the devices. Fix exactly these problems and return the corrected JSON object:\n\n${lines.join('\n')}`;
}

/**
 * @param {object} provider        from buildProvider
 * @param {string} message         what the scientist typed
 * @param {object} ctx             {devices, sequences, target, history?, existing?: {name, spec}}
 * @param {(event: object) => void} [report]  progress events, the panel's live log
 */
async function translate(provider, message, ctx, report = () => {}) {
  const { devices, sequences, target } = ctx;
  const described = describeTarget(devices, sequences, target);
  report({ phase: 'reading_deck', devices: Object.keys(described.devices).length, target: described.target });

  const parts = [`The lab, as JSON. These are the only devices, instruments, methods and saved workflows that exist:\n\n${JSON.stringify(described, null, 1)}`];
  if (ctx.existing && ctx.existing.spec) {
    parts.push(`You are editing the workflow '${ctx.existing.name || 'untitled'}'. Its current steps are:\n\n${JSON.stringify(ctx.existing.spec, null, 1)}\n\nReturn the complete new object, not a patch.`);
  }
  const messages = [
    { role: 'user', content: parts.join('\n\n') },
    { role: 'assistant', content: 'Understood. I will use only those devices, instruments, methods and workflows, and reply with a single JSON object.' },
  ];
  for (const turn of ctx.history || []) {
    if ((turn.role === 'user' || turn.role === 'assistant') && turn.content) messages.push({ role: turn.role, content: String(turn.content).slice(0, 20000) });
  }
  messages.push({ role: 'user', content: message });

  const transcript = [];
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    report({ phase: 'drafting', attempt, max_attempts: MAX_ATTEMPTS });
    const raw = await provider.complete(SYSTEM_PROMPT, messages, { jsonMode: true });
    transcript.push({ attempt, raw });
    let parsed;
    try { parsed = extractJsonObject(raw); } catch (e) {
      lastError = e.message;
      report({ phase: 'unreadable', attempt, detail: e.message });
      messages.push({ role: 'assistant', content: String(raw).slice(0, 4000) });
      messages.push({ role: 'user', content: 'That was not valid JSON. Reply with a single JSON object and nothing else.' });
      continue;
    }
    if (!Array.isArray(parsed.steps)) {
      lastError = "The reply had no 'steps' array.";
      report({ phase: 'unreadable', attempt, detail: lastError });
      messages.push({ role: 'assistant', content: String(raw).slice(0, 4000) });
      messages.push({ role: 'user', content: "The JSON object must contain a 'steps' array." });
      continue;
    }
    const spec = {
      name: parsed.name || (ctx.existing && ctx.existing.name) || 'Untitled workflow',
      description: parsed.description || '',
      steps: parsed.steps,
    };
    report({ phase: 'validating', attempt, steps: spec.steps.length, name: spec.name });
    const checked = checkProposal(spec, devices, sequences);
    const result = {
      summary: String(parsed.summary || '').trim(),
      spec,
      graph: checked.graph,
      questions: (Array.isArray(parsed.questions) ? parsed.questions : []).map(String).slice(0, 10),
      issues: checked.issues,
      validation_summary: summarise(checked.issues),
      ok: checked.ok,
      attempts: attempt,
    };
    if (checked.ok) { report({ phase: 'valid', attempt, steps: spec.steps.length }); return { result, transcript }; }
    const errors = checked.issues.filter((i) => i.severity === 'error');
    report({ phase: 'found_problems', attempt, errors: errors.map((i) => `${i.where}: ${i.message}`) });
    if (attempt === MAX_ATTEMPTS) { report({ phase: 'gave_up', attempt, remaining: errors.length }); return { result, transcript }; }
    messages.push({ role: 'assistant', content: JSON.stringify(parsed).slice(0, 8000) });
    messages.push({ role: 'user', content: retryPrompt(checked.issues) });
  }
  throw new ProviderError(lastError || 'The model did not return a usable workflow.');
}

/** The canvas's current graph as a spec the model can edit: the inverse of materialize. */
function specFromGraph(nodes, edges) {
  const steps = [];
  const byId = new Map((nodes || []).map((n) => [n.id, n]));
  for (const n of nodes || []) {
    const block = n.data?.block || {};
    if (block.method === 'Start') continue;
    const isCloud = ['Flow Control', 'Flow_Control'].includes(block.instrument);
    const after = (edges || []).filter((e) => e.target === n.id && byId.has(e.source) && byId.get(e.source).data?.block?.method !== 'Start')
      .map((e) => (e.sourceHandle === 'true' || e.sourceHandle === 'false' ? { step: e.source, branch: e.sourceHandle } : e.source));
    steps.push({
      id: n.id,
      device: isCloud ? 'cloud' : String(n.data?.targetDeviceId || ''),
      ...(isCloud ? {} : { instrument: block.instrument }),
      method: block.method,
      args: block.params || {},
      outputs: String(block.returnVar || '').split(',').map((s) => s.trim()).filter(Boolean),
      after,
    });
  }
  return steps;
}

module.exports = { translate, specFromGraph, SYSTEM_PROMPT, MAX_ATTEMPTS };
