'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSpec, materialize, checkProposal } = require('./agent/graphSpec.js');
const { describeTarget } = require('./agent/describe.js');
const { specFromGraph } = require('./agent/chat.js');
const { extractJsonObject } = require('./agent/providers.js');
const { validateGraph } = require('./dag.js');

const devices = [
  { id: 'bench-a', name: 'Bench A', status: 'online', schema: { instruments: {
    pump: { dispense: { description: 'Dispense a volume.', parameters: { volume_ml: { type: 'float', required: true }, rate: { type: 'float', required: false, default: 2 } }, return_type: 'None', return_paths: [] } },
    uv: { read: { description: 'Read absorbance.', parameters: {}, return_type: 'float', return_paths: [{ path: '', type: 'float', numeric: true }] } },
  } } },
  { id: 'bench-b', name: 'Bench B', status: 'online', schema: { instruments: { arm: { park: { description: 'Park.', parameters: {}, return_type: 'None' } } } } },
];
const sequences = [
  { device_id: 'bench-a', name: 'screen', description: 'A screen', body: { prep: [], script: [
    { instrument: 'pump', action: 'dispense', args: { volume_ml: '#volume' } },
    { instrument: 'uv', action: 'read', args: {}, return: 'absorbance' },
  ], cleanup: [] } },
];

test('the description keeps what is needed to call things and nothing else', () => {
  const d = describeTarget(devices, sequences, { kind: 'device', id: 'bench-a' });
  assert.deepEqual(Object.keys(d.devices), ['bench-a']);
  assert.deepEqual(d.devices['bench-a'].instruments.pump.dispense, { summary: 'Dispense a volume.', required: ['volume_ml'], optional: ['rate'] });
  assert.deepEqual(d.devices['bench-a'].instruments.uv.read.numeric_results, ['']);
  assert.deepEqual(d.devices['bench-a'].workflows.screen, { description: 'A screen', inputs: ['volume'], outputs: ['absorbance'], steps: 2 });
  assert.ok(d.cloud_logic.methods.If);
});

test('a good spec validates, materializes into canvas nodes, and passes the canvas rules', () => {
  const spec = { name: 'Two benches', steps: [
    { id: 's1', device: 'bench-a', instrument: 'Library Workflows', method: 'screen', args: { volume: 1.5 }, outputs: ['absorbance'], after: [] },
    { id: 'if', device: 'cloud', method: 'If', args: { variable: 'absorbance', operator: '>', value: 0.5 }, after: ['s1'] },
    { id: 's2', device: 'bench-b', instrument: 'arm', method: 'park', args: {}, after: [{ step: 'if', branch: 'true' }] },
  ] };
  const r = checkProposal(spec, devices, sequences);
  assert.deepEqual(r.issues, []);
  assert.ok(r.ok);
  const { nodes, edges } = r.graph;
  assert.equal(nodes[0].id, 'start_node');
  assert.equal(nodes.length, 4);
  const link = nodes.find((n) => n.data.block.instrument === 'Library Workflows');
  assert.deepEqual(link.data.block.params, { volume: 1.5 });
  assert.equal(link.data.block.returnVar, 'absorbance');
  assert.equal(link.data.block.ref.mode, 'latest');
  const ifNode = nodes.find((n) => n.data.block.method === 'If');
  assert.equal(ifNode.data.targetDeviceId, '');
  assert.deepEqual(ifNode.data.block.params, { variable: 'absorbance', operator: '>', value: 0.5 });
  assert.ok(edges.some((e) => e.source === 'start_node'));
  assert.ok(edges.some((e) => e.sourceHandle === 'true'));
  assert.deepEqual(validateGraph(nodes, edges), []);
  // And back: the canvas as a spec the model can edit.
  const back = specFromGraph(nodes, edges);
  assert.equal(back.length, 3);
  assert.deepEqual(back.find((s) => s.method === 'park').after, [{ step: ifNode.id, branch: 'true' }]);
});

test('every kind of mistake the model can make is named, with what to do instead', () => {
  const bad = { steps: [
    { id: 'a', device: 'nope', instrument: 'pump', method: 'dispense', args: {} },
    { id: 'b', device: 'bench-a', instrument: 'laser', method: 'fire', args: {} },
    { id: 'c', device: 'bench-a', instrument: 'pump', method: 'dispense', args: { volume_ml: '65 C', speed: 1 } },
    { id: 'd', device: 'bench-a', instrument: 'pump', method: 'dispense', args: {} },
    { id: 'e', device: 'bench-a', instrument: 'Library Workflows', method: 'wash', args: {} },
    { id: 'f', device: 'bench-a', instrument: 'pump', method: 'dispense', args: { volume_ml: '#nothing' } },
    { id: 'g', device: 'cloud', method: 'If', args: { variable: 'ghost', operator: '~', value: '' }, after: ['zzz'] },
    { id: 'h', device: 'bench-b', instrument: 'arm', method: 'park', args: {}, after: ['g'] },
    { id: 'h', device: 'bench-b', instrument: 'arm', method: 'park', args: {}, after: ['h'] },
  ] };
  const { issues, ok } = validateSpec(bad, devices, sequences);
  assert.equal(ok, false);
  const text = issues.map((i) => i.message).join('\n');
  for (const needle of ["no device 'nope'", "no instrument called 'laser'", 'expects a number', "no parameter 'speed'", "needs a value for 'volume_ml'", "no saved workflow called 'wash'", 'reads #nothing', "If reads 'ghost'", 'operator from', "'zzz', which is not a step", 'say which branch', "share the id 'h'", 'cycle']) {
    assert.ok(text.includes(needle), `expected an issue mentioning ${needle}\n${text}`);
  }
});

test('a dependency-less spec hangs every root off Start, and nothing else is reachable-less', () => {
  const { nodes, edges } = materialize({ steps: [{ id: 'x', device: 'bench-b', instrument: 'arm', method: 'park', args: {} }] }, devices, sequences);
  assert.deepEqual(edges.map((e) => [e.source, e.target]), [['start_node', nodes[1].id]]);
});

test('Claude is offered as a provider of its own, with Anthropic defaults', () => {
  const { buildProvider, providerCatalogue } = require('./agent/providers.js');
  assert.ok(providerCatalogue().some((p) => p.name === 'anthropic' && p.needs_api_key === false));
  const p = buildProvider({ provider: 'anthropic', model: '' });
  assert.equal(p.name, 'anthropic');
  assert.equal(p.model, process.env.ANTHROPIC_MODEL || 'claude-opus-5-5');
});

test('a reply wrapped in prose or a code fence still yields its JSON object', () => {
  assert.deepEqual(extractJsonObject('Sure! ```json\n{"a": {"b": "}"}}\n```'), { a: { b: '}' } });
  assert.throws(() => extractJsonObject('no json here'), /no JSON object/);
});

test('the loop feeds the exact errors back and stops at the first valid draft', async () => {
  const { translate } = require('./agent/chat.js');
  const replies = [
    'Here you go: {"summary": "first try", "name": "x", "steps": [{"id": "a", "device": "bench-a", "instrument": "pump", "method": "dispense", "args": {"volume_ml": "1 mL"}}]}',
    '{"summary": "fixed", "name": "x", "steps": [{"id": "a", "device": "bench-a", "instrument": "pump", "method": "dispense", "args": {"volume_ml": 1}}]}',
  ];
  const seen = [];
  const provider = { name: 'stub', model: 'm', async complete(system, messages) { seen.push(messages[messages.length - 1].content); return replies.shift(); } };
  const phases = [];
  const { result } = await translate(provider, 'dispense a millilitre', { devices, sequences, target: { kind: 'all' } }, (ev) => phases.push(ev.phase));
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.ok(seen[1].includes("expects a number"), seen[1]);
  assert.deepEqual(phases, ['reading_deck', 'drafting', 'validating', 'found_problems', 'drafting', 'validating', 'valid']);
  assert.equal(result.graph.nodes.length, 2);
});

test('three unusable drafts hand the last one over rather than throwing', async () => {
  const { translate } = require('./agent/chat.js');
  const provider = { name: 'stub', model: 'm', async complete() { return '{"summary": "no", "steps": [{"id": "a", "device": "mars", "method": "land"}]}'; } };
  const { result } = await translate(provider, 'go', { devices, sequences, target: { kind: 'all' } });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.graph, null);
  assert.ok(result.issues.some((i) => i.message.includes("no device 'mars'")));
});
