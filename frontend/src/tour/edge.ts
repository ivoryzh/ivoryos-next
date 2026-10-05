// One deck's edge, in the page: the HTTP API the deck pages call (edge_server/ivoryos_edge/server.py)
// and the queue that runs workflows (queue.py), over the simulated instruments in sim.ts. It mirrors
// what the pages read -- run and step shapes (models.py as_dict), the queue broadcast, #name
// substitution, return bindings, If/While/User input/Sleep, failed-step decisions, pause, stop and
// graceful stop -- so the pages behave as they do against a real edge. What the tour cannot do
// (optimizers, Cloud, plugins, the agent) answers with an error that says so.
//
// When queue.py or server.py change what a page reads, change this too.
import type { LabDeck } from './lab';
import { SimulatedDeck } from './sim';

/* eslint-disable @typescript-eslint/no-explicit-any -- JSON in, JSON out, like the edge itself */
type Json = any;
export type EdgeResponse = { status: number; body: Json };

type Step = {
  id: number; run_id: number; sequence_index: number; instrument: string; method: string;
  parameters: Record<string, Json>; outputs: Json; status: string; error: string | null;
  start_time: string | null; end_time: string | null;
};
type Run = {
  id: number; name: string; status: string; start_time: string | null; end_time: string | null;
  parameters: Record<string, Json>; steps: Step[];
};
type Version = Record<string, Json> & { version: number; body_hash: string; updated_at: number; note: string; author: string };
type SavedWorkflow = { created_at: number; versions: Version[]; tags: string[] };

const FLOW_CONTROL = new Set(['Flow Control', 'Flow_Control']);
const TERMINAL = new Set(['completed', 'error', 'cancelled']);
const MAX_CONDITION_HISTORY = 50;
const MISSING = Symbol('missing');

/** A naive UTC ISO time, as Python's datetime.utcnow().isoformat() writes it. */
const utcnow = () => new Date().toISOString().replace('Z', '');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const isObject = (v: Json): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
const ok = (body: Json): EdgeResponse => ({ status: 200, body });
const err = (status: number, error: string, extra: Json = {}): EdgeResponse => ({ status, body: { error, ...extra } });

const phaseOf = (s: Step) => (s.parameters?._phase as string) || 'main';
const rowOf = (s: Step): number | null => (Number.isInteger(s.parameters?._row) ? s.parameters._row : null);

function hashOf(body: Json): string {
  const text = JSON.stringify({ prep: body.prep, script: body.script, cleanup: body.cleanup, description: body.description });
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

function resolvePath(value: Json, path: string): Json {
  if (!path) return value;
  let current = value;
  for (const segment of String(path).split('.')) {
    if (isObject(current)) {
      if (!(segment in current)) return MISSING;
      current = current[segment];
    } else if (Array.isArray(current) && /^-?\d+$/.test(segment)) {
      const i = Number(segment);
      if (i >= current.length || i < -current.length) return MISSING;
      current = current[i < 0 ? current.length + i : i];
    } else {
      return MISSING;
    }
  }
  return current;
}

/** queue.py extract_return_values. */
function extractReturnValues(bindings: Json, returnVar: Json, result: Json): Record<string, Json> {
  const values: Record<string, Json> = {};
  if (bindings) {
    const pairs: [string, string][] = Array.isArray(bindings)
      ? bindings.filter(isObject).map(b => [b.path || '', b.var])
      : Object.entries(bindings) as [string, string][];
    for (const [path, name] of pairs) {
      if (!name) continue;
      const v = resolvePath(result, path);
      if (v !== MISSING) values[name] = v;
    }
    if (Object.keys(values).length) return values;
  }
  if (!returnVar) return values;
  const names = String(returnVar).split(',').map(s => s.trim()).filter(Boolean);
  if (names.length > 1 && isObject(result)) Object.values(result).forEach((v, i) => { if (names[i]) values[names[i]] = v; });
  else if (names.length > 1 && Array.isArray(result)) result.forEach((v, i) => { if (names[i]) values[names[i]] = v; });
  else if (names.length) values[names[0]] = isObject(result) && names[0] in result ? result[names[0]] : result;
  return values;
}

function withAliases(values: Record<string, Json>, aliases: Json): Record<string, Json> {
  if (!Array.isArray(aliases)) return values;
  const out = { ...values };
  for (const pair of aliases) if (Array.isArray(pair) && pair.length === 2 && pair[0] in out && pair[1]) out[pair[1]] = out[pair[0]];
  return out;
}

/** queue.py substitute_workflow_vars: a whole-value '#name' is replaced, or the step fails. */
function substitute(obj: Json, context: Record<string, Json>): Json {
  if (typeof obj === 'string' && obj.startsWith('#')) {
    const name = obj.slice(1).trim();
    if (!name) return obj;
    if (!(name in context)) throw new Error(`Variable '#${name}' is not available yet — no earlier step has set it.`);
    return context[name];
  }
  if (Array.isArray(obj)) return obj.map(v => substitute(v, context));
  if (isObject(obj)) return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, substitute(v, context)]));
  return obj;
}

const interpolate = (text: string, context: Record<string, Json>) =>
  text.replace(/#(\w+)/g, (m, name) => (name in context ? String(context[name]) : m));

function coerceInput(value: Json, type: string): Json {
  if (value === null || value === undefined) return value;
  if (type === 'int') { const n = Math.trunc(Number(value)); return Number.isNaN(n) ? value : n; }
  if (type === 'float') { const n = Number(value); return Number.isNaN(n) ? value : n; }
  if (type === 'bool') return typeof value === 'string' ? ['true', '1', 'yes', 'y', 'on'].includes(value.trim().toLowerCase()) : !!value;
  return value;
}

/**
 * A condition as the edge evaluates it (Python `eval` over the workflow's values): the Python words
 * a lab condition uses are translated, and only the run's own values are in scope.
 */
function evaluate(condition: string, scope: Record<string, Json>): Json {
  const expr = String(condition)
    .replace(/\band\b/g, '&&').replace(/\bor\b/g, '||').replace(/\bnot\b/g, '!')
    .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
  const names = Object.keys(scope).filter(n => /^[A-Za-z_$][\w$]*$/.test(n));
  // The edge evaluates the condition too, over the same values.
  return new Function(...names, `"use strict"; return (${expr});`)(...names.map(n => scope[n]));
}

function conditionRecord(condition: string, result: Json, scope: Record<string, Json>, previous: Json) {
  const variables: Record<string, Json> = {};
  for (const name of [...new Set(String(condition).match(/[A-Za-z_][A-Za-z0-9_]*/g) || [])].sort()) {
    if (name in scope) {
      const v = scope[name];
      variables[name] = v === null || ['number', 'string', 'boolean'].includes(typeof v) ? v : JSON.stringify(v);
    }
  }
  const history = [...(isObject(previous) && Array.isArray(previous.history) ? previous.history : []), !!result].slice(-MAX_CONDITION_HISTORY);
  return { result: !!result, condition: String(condition), variables, history };
}

function savedNames(params: Json, instrument: string, method: string): string[] {
  const names: string[] = [];
  const p = params || {};
  if (p._return_var) names.push(...String(p._return_var).split(',').map((s: string) => s.trim()).filter(Boolean));
  if (Array.isArray(p._return_bindings)) names.push(...p._return_bindings.filter(isObject).map((b: Json) => b.var).filter(Boolean));
  if (Array.isArray(p._return_aliases)) names.push(...p._return_aliases.map((a: Json) => a?.[1]).filter(Boolean));
  if (FLOW_CONTROL.has(instrument) && method === 'User_Input' && p.variable_name) names.push(String(p.variable_name).trim());
  return names;
}

/** queue.py unproduced_references: a '#name' nothing before it saves stops the run before it starts. */
function unproducedReferences(steps: Json[]): string[] {
  const produced = new Set<string>();
  const problems: string[] = [];
  const reads = (value: Json, out: string[]) => {
    if (typeof value === 'string') { const n = value.startsWith('#') ? value.slice(1).trim() : ''; if (n) out.push(n); }
    else if (Array.isArray(value)) value.forEach(v => reads(v, out));
    else if (isObject(value)) Object.entries(value).forEach(([k, v]) => { if (!k.startsWith('_')) reads(v, out); });
  };
  steps.forEach((step, i) => {
    if (!FLOW_CONTROL.has(step.instrument)) {
      const names: string[] = [];
      reads(step.params || {}, names);
      for (const name of [...new Set(names)]) {
        if (!produced.has(name)) problems.push(`Step ${i + 1} (${step.instrument}.${step.method}) reads #${name}, but no step before it saves '${name}'.`);
      }
    }
    savedNames(step.params, step.instrument, step.method).forEach(n => produced.add(n));
  });
  return problems;
}

export class TourEdge {
  private runs: Run[] = [];
  private nextRunId = 1;
  private nextStepId = 1;
  private workflows = new Map<string, SavedWorkflow>();
  private activeRunId: number | null = null;
  private paused = false;
  private cancelled = false;
  private awaitingDecision: number | null = null;
  private errorAction: string | null = null;
  private graceful: { cleanup: boolean; continue_queue: boolean } | null = null;
  private pendingInput = new Map<number, (value: Json) => void>();
  private looping = false;
  private executions = new Map<string, Json>();
  private nextTask = 1;
  private subscribers = new Set<(payload: Json) => void>();
  private sim: SimulatedDeck;
  private simFor = '';

  constructor(private readonly deck: LabDeck, workflows: Json[] = []) {
    const created = Date.now() - 6 * 24 * 3600 * 1000;
    for (const body of workflows) {
      this.workflows.set(body.name, {
        created_at: created, tags: [],
        versions: [{ ...body, version: 1, body_hash: hashOf(body), updated_at: created / 1000, note: '', author: '' }],
      });
    }
    this.sim = new SimulatedDeck();
    this.simulated();
  }

  /** The simulated instruments for the deck as it is now: rebuilt when its instruments change. */
  private simulated(): SimulatedDeck {
    const instruments = (this.deck.deck.instruments || []).filter(i => i.enabled !== false);
    const key = JSON.stringify(instruments.map(i => [i.name, i.class, i.args]));
    if (key !== this.simFor) {
      this.sim = new SimulatedDeck();
      for (const inst of instruments) this.sim.add(inst.name, inst.class, inst.args || {}, this.deck.schemas[inst.name] || {});
      this.simFor = key;
    }
    return this.sim;
  }

  private schemas(): Record<string, Json> {
    const out: Record<string, Json> = {};
    for (const inst of this.deck.deck.instruments || []) if (inst.enabled !== false) out[inst.name] = this.deck.schemas[inst.name] || {};
    return out;
  }

  // --- the live queue (WebSocket /api/ws/queue) ------------------------------------------------

  subscribe(send: (payload: Json) => void): () => void {
    this.subscribers.add(send);
    // queue.py: every subscribe broadcasts to everyone.
    this.broadcast();
    return () => { this.subscribers.delete(send); };
  }

  private broadcast() {
    if (!this.subscribers.size) return;
    const payload: Json = {
      runs: this.liveRuns(10),
      status: {
        status: 'running', active_workflow_id: this.activeRunId, queue_paused: this.paused,
        awaiting_decision: this.awaitingDecision, graceful_stop: this.graceful, cloud_queue: null,
      },
    };
    if (this.activeRunId) {
      payload.active_run = this.runStatus(this.activeRunId);
      payload.status.attention = this.attention(payload.active_run);
    } else {
      const recent = this.runs.filter(r => TERMINAL.has(r.status) && r.end_time).sort((a, b) => (b.end_time! > a.end_time! ? 1 : -1))[0];
      if (recent && Date.now() - Date.parse(`${recent.end_time}Z`) < 10_000) payload.recent_run = this.runStatus(recent.id);
    }
    const text = JSON.parse(JSON.stringify(payload));
    for (const send of [...this.subscribers]) send(text);
  }

  private attention(run: Json): Json[] {
    if (!run) return [];
    const name = run.name || `Run ${run.id}`;
    const items: Json[] = [];
    if (run.status === 'waiting_input') {
      const step = run.steps.find((s: Step) => s.status === 'waiting_input');
      if (step) {
        const paused = step.outputs?.input_type === 'none';
        items.push({ key: `input:${run.id}:${step.id}`, kind: 'input', run_id: run.id, run_name: name, title: paused ? 'Paused for you' : 'Input needed', body: String(step.outputs?.prompt || (paused ? 'The run waits for you to continue.' : 'A step is waiting for your answer.')) });
      }
    }
    if (this.awaitingDecision === run.id) {
      const step = run.steps.find((s: Step) => s.status === 'error');
      if (step) {
        const failures = (step.outputs?.attempts || []).length || 1;
        items.push({ key: `error:${run.id}:${step.id}:${failures}`, kind: 'error', run_id: run.id, run_name: name, title: 'A step failed', body: `${step.instrument}.${step.method}: ${String(step.error || '').split('\n')[0]}` });
      }
    }
    return items;
  }

  private copy(run: Run): Json {
    return JSON.parse(JSON.stringify(run));
  }

  private liveRuns(recent: number): Json[] {
    const newest = new Set([...this.runs].sort((a, b) => b.id - a.id).slice(0, recent).map(r => r.id));
    return [...this.runs].sort((a, b) => b.id - a.id).filter(r => !TERMINAL.has(r.status) || newest.has(r.id)).map(r => this.copy(r));
  }

  private runStatus(id: number): Json {
    const run = this.runs.find(r => r.id === id);
    if (!run) return null;
    const out = this.copy(run);
    if (this.activeRunId === id) {
      if (this.cancelled) out.status = 'cancelling';
      else if (run.steps.some(s => s.status === 'error')) out.status = 'error';
      else if (this.paused && run.status === 'running') out.status = 'paused';
    }
    return out;
  }

  // --- running ---------------------------------------------------------------------------------

  private submit(name: string, parameters: Json, prep: Json[], sequence: Json[], cleanup: Json[]): number {
    if (parameters?.type === 'Optimization') {
      throw new Error('The tour does not run optimizers: they are Python libraries (Ax, BayBE, NIMO) that run in the desktop app.');
    }
    const steps = [...prep, ...sequence, ...cleanup];
    const missing = unproducedReferences(steps);
    if (missing.length) throw new Error(`${missing.join(' ')} Nothing was run.`);
    const run: Run = { id: this.nextRunId++, name, status: 'pending', start_time: utcnow(), end_time: null, parameters: { ...(parameters || {}) }, steps: [] };
    run.steps = steps.map((s, i) => ({
      id: this.nextStepId++, run_id: run.id, sequence_index: i, instrument: s.instrument, method: s.method,
      parameters: s.params || {}, outputs: null, status: 'pending', error: null, start_time: null, end_time: null,
    }));
    this.runs.push(run);
    // queue.py: held after a stop or an error; a run submitted with nothing else waiting goes.
    if (this.paused && this.activeRunId === null && !this.runs.some(r => r.status === 'pending' && r.id !== run.id)) this.paused = false;
    this.broadcast();
    void this.loop();
    return run.id;
  }

  private async waitWhilePaused() {
    while (this.paused && !this.cancelled) await sleep(120);
  }

  private nextPending(): Run | undefined {
    const position = (r: Run) => (typeof r.parameters?.queue_position === 'number' ? r.parameters.queue_position : r.id);
    return this.runs.filter(r => r.status === 'pending').sort((a, b) => position(a) - position(b) || a.id - b.id)[0];
  }

  private async loop() {
    if (this.looping) return;
    this.looping = true;
    try {
      for (;;) {
        await this.waitWhilePaused();
        const run = this.nextPending();
        if (!run) break;
        this.activeRunId = run.id;
        this.cancelled = false;
        this.graceful = null;
        await this.execute(run);
      }
    } finally {
      this.activeRunId = null;
      this.looping = false;
      this.broadcast();
    }
  }

  private async execute(run: Run) {
    const steps = run.steps;
    const context: Record<string, Json> = {};
    const rowContexts = new Map<number, Record<string, Json>>();
    const scope = (s: Step) => { const row = rowOf(s); return row !== null && rowContexts.has(row) ? { ...context, ...rowContexts.get(row) } : context; };
    const bind = (s: Step, values: Record<string, Json>) => {
      Object.assign(context, values);
      const row = rowOf(s);
      if (row !== null) rowContexts.set(row, { ...(rowContexts.get(row) || {}), ...values });
    };
    const batch = Math.max(1, Number(run.parameters?.batch_size) || 1);
    let stoppedEarly = false;
    let gracefulApplied = false;
    let index = 0;
    while (index < steps.length) {
      const step = steps[index];
      if (step.status !== 'pending' && step.status !== 'error') { index++; continue; }
      await this.waitWhilePaused();
      if (this.cancelled) break;
      if (this.graceful && !gracefulApplied && (this.gracefulStopHere(steps, index, batch) || phaseOf(step) === 'cleanup')) {
        gracefulApplied = true;
        stoppedEarly = this.skipAfterGraceful(steps, index, this.graceful.cleanup) > 0;
        this.broadcast();
        continue;
      }
      step.status = 'running';
      step.error = null;
      step.start_time = utcnow();
      run.status = 'running';
      this.broadcast();
      try {
        if (FLOW_CONTROL.has(step.instrument)) {
          const next = await this.flowControl(run, steps, index, scope, bind);
          if (next === null) break;
          index = next;
          continue;
        }
        const args = Object.fromEntries(Object.entries(step.parameters || {}).filter(([k]) => !k.startsWith('_')));
        const { result, ms } = this.simulated().call(step.instrument, step.method, substitute(args, scope(step)));
        await this.wait(Math.min(Math.max(ms, 0) + 280, 4000));
        if (this.cancelled) {
          step.status = 'error'; step.error = 'Step execution cancelled'; step.end_time = utcnow();
          break;
        }
        step.status = 'completed';
        const attempts = step.outputs?.attempts;
        step.outputs = attempts ? { result, attempts } : { result };
        const p = step.parameters || {};
        if (p._return_bindings || p._return_var) bind(step, withAliases(extractReturnValues(p._return_bindings, p._return_var, result), p._return_aliases));
        step.end_time = utcnow();
        this.broadcast();
        index++;
      } catch (e) {
        const action = await this.errorDecision(run, step, e as Error);
        if (action === 'retry') continue;
        if (action === 'skip') { index++; continue; }
        break;
      }
    }
    if (this.cancelled) run.status = 'cancelled';
    else if (steps.some(s => s.status === 'error')) run.status = 'error';
    else run.status = 'completed';
    const attempts = steps.flatMap(s => s.outputs?.attempts || []);
    const issues: Record<string, number> = {};
    const retried = attempts.filter((a: Json) => a.resolution === 'retry').length;
    const skipped = steps.filter(s => s.status === 'skipped' && s.error).length;
    if (retried) issues.retried = retried;
    if (skipped) issues.skipped = skipped;
    if (stoppedEarly) issues.stopped_early = 1;
    if (Object.keys(issues).length) run.parameters = { ...run.parameters, _issues: issues };
    run.end_time = utcnow();
    // queue.py _hold_queue_after: Stop, an error, or a graceful stop told not to go on holds the queue.
    const graceful = this.graceful;
    this.graceful = null;
    if (this.cancelled || run.status === 'error' || (graceful && !graceful.continue_queue)) this.paused = true;
    this.activeRunId = null;
    this.broadcast();
  }

  /** A step's simulated duration, cut short by Stop. */
  private async wait(ms: number) {
    const until = Date.now() + ms;
    while (!this.cancelled && Date.now() < until) await sleep(Math.min(100, until - Date.now()));
  }

  private gracefulStopHere(steps: Step[], index: number, batch: number): boolean {
    const step = steps[index];
    if (phaseOf(step) !== 'main') return false;
    const row = rowOf(step);
    if (row === null) return true;
    const started = new Set(steps.slice(0, index).filter(s => phaseOf(s) === 'main' && s.status !== 'pending' && rowOf(s) !== null).map(s => Math.floor(rowOf(s)! / batch)));
    return !started.has(Math.floor(row / batch));
  }

  private skipAfterGraceful(steps: Step[], index: number, cleanup: boolean): number {
    let leftOut = 0;
    for (const s of steps.slice(index)) {
      if (s.status !== 'pending') continue;
      const phase = phaseOf(s);
      if (phase === 'main' || (phase === 'cleanup' && !cleanup)) { s.status = 'skipped'; if (phase === 'main') leftOut++; }
    }
    return leftOut;
  }

  private async errorDecision(run: Run, step: Step, error: Error): Promise<string> {
    const message = error?.message || String(error);
    step.status = 'error';
    step.error = `${message}\n(simulated in the tour)`;
    step.end_time = utcnow();
    step.outputs = { ...(step.outputs || {}), attempts: [...(step.outputs?.attempts || []), { error: message.slice(0, 300), start_time: step.start_time, end_time: step.end_time }] };
    run.status = 'error';
    this.paused = true;
    this.errorAction = null;
    this.awaitingDecision = run.id;
    this.broadcast();
    while (this.errorAction === null && !this.cancelled) await sleep(150);
    this.awaitingDecision = null;
    let action = this.cancelled ? 'stop' : this.errorAction!;
    this.errorAction = null;
    if (action === 'retry') { step.status = 'pending'; step.error = null; }
    else if (action === 'skip') step.status = 'skipped';
    else action = 'stop';
    const attempts = [...(step.outputs?.attempts || [])];
    if (attempts.length) attempts[attempts.length - 1] = { ...attempts[attempts.length - 1], resolution: action };
    step.outputs = { ...(step.outputs || {}), attempts };
    if (action !== 'stop') { run.status = 'running'; this.paused = false; }
    this.broadcast();
    return action;
  }

  /** queue.py _flow_control_step: the index to go on from, or null when the run was stopped. */
  private async flowControl(run: Run, steps: Step[], index: number, scope: (s: Step) => Record<string, Json>, bind: (s: Step, v: Record<string, Json>) => void): Promise<number | null> {
    const step = steps[index];
    const args = step.parameters || {};
    const done = (outputs?: Json) => {
      step.status = 'completed';
      if (outputs !== undefined) step.outputs = outputs;
      step.end_time = utcnow();
      this.broadcast();
    };
    const findForward = (opener: string, closer: string, stopAtElse = false): number | null => {
      let depth = 0;
      for (let i = index + 1; i < steps.length; i++) {
        const s = steps[i];
        s.status = 'skipped';
        if (FLOW_CONTROL.has(s.instrument)) {
          if (s.method === opener) depth++;
          else if (s.method === closer) { if (depth === 0) return i; depth--; }
          else if (stopAtElse && s.method === 'Else' && depth === 0) return i;
        }
      }
      return null;
    };

    switch (step.method) {
      case 'Sleep': {
        await this.wait(Math.min(Number(args.duration_seconds || 0) * 1000, 5000));
        if (this.cancelled) { step.status = 'error'; step.error = 'Stopped during the wait'; step.end_time = utcnow(); return null; }
        done();
        return index + 1;
      }
      case 'Comment':
        done({ message: interpolate(String(args.message ?? ''), scope(step)) });
        return index + 1;
      case 'User_Input': {
        const name = String(args.variable_name || '').trim();
        const prompt = interpolate(String(args.prompt || 'Input required'), scope(step));
        let type = String(args.input_type || 'str').trim().toLowerCase();
        if (!['str', 'int', 'float', 'bool'].includes(type)) type = 'str';
        if (!name) type = 'none';
        step.status = 'waiting_input';
        step.outputs = { prompt, input_type: type };
        run.status = 'waiting_input';
        this.broadcast();
        const value = await new Promise<Json>(resolve => {
          const watch = setInterval(() => { if (this.cancelled) { clearInterval(watch); resolve(undefined); } }, 150);
          this.pendingInput.set(run.id, v => { clearInterval(watch); resolve(v); });
        });
        this.pendingInput.delete(run.id);
        if (this.cancelled) { step.status = 'error'; step.error = 'Cancelled while waiting for input'; step.end_time = utcnow(); return null; }
        run.status = 'running';
        if (!name) { done({ prompt, input_type: type, acknowledged: true }); return index + 1; }
        const coerced = coerceInput(value, type);
        bind(step, { [name]: coerced });
        done({ result: coerced, input_type: type });
        return index + 1;
      }
      case 'If':
      case 'While': {
        const condition = String(args.condition ?? 'False');
        const values = scope(step);
        let result: Json;
        try { result = evaluate(condition, values); } catch (e) { throw new Error(`Failed to evaluate ${step.method} condition: ${(e as Error).message}`); }
        step.outputs = conditionRecord(condition, result, values, step.method === 'While' ? step.outputs : null);
        if (result) { done(); return index + 1; }
        if (step.method === 'If') {
          const target = findForward('If', 'End_If', true);
          if (target === null) throw new Error('Matching Else or End_If not found for If statement');
          steps[target].status = 'pending';
          done();
          return target;
        }
        const target = findForward('While', 'End_While');
        if (target === null) throw new Error('Matching End_While not found for While statement');
        done();
        return target + 1;
      }
      case 'Else': {
        const target = findForward('If', 'End_If');
        if (target === null) throw new Error('Matching End_If not found for Else statement');
        steps[target].status = 'pending';
        done();
        return target;
      }
      case 'End_While': {
        let depth = 0;
        let start: number | null = null;
        for (let i = index - 1; i >= 0; i--) {
          const s = steps[i];
          if (!FLOW_CONTROL.has(s.instrument)) continue;
          if (s.method === 'End_While') depth++;
          else if (s.method === 'While') { if (depth === 0) { start = i; break; } depth--; }
        }
        if (start === null) throw new Error('Matching While not found for End_While statement');
        step.status = 'completed';
        step.end_time = utcnow();
        for (let i = start; i <= index; i++) steps[i].status = 'pending';
        this.broadcast();
        return start;
      }
      default:
        done();
        return index + 1;
    }
  }

  // --- the HTTP API ----------------------------------------------------------------------------

  async handle(method: string, path: string, query: URLSearchParams, body: Json): Promise<EdgeResponse> {
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const route = `${method} /${parts.join('/')}`;
    const id = (i: number) => Number(parts[i]);

    if (route === 'GET /status') return ok(this.status());
    if (route === 'GET /plugins') return ok({ plugins: [], errors: [] });
    if (route === 'GET /deck') return ok({ version: null, versions: [] });
    if (route === 'GET /optimizers') return ok({});
    if (route === 'POST /system/restart') return ok({ status: 'restarting' });
    if (parts[0] === 'cloud-settings') return method === 'GET' ? ok(this.cloudSettings()) : err(400, 'Cloud is not part of the tour.');
    if (parts[0] === 'agent') return method === 'GET' && parts[1] === 'proposals' ? ok({ proposals: [] }) : err(404, 'The agent is not part of the tour.');

    if (parts[0] === 'execute') {
      if (method === 'POST' && parts.length === 1) return this.executeOne(body);
      if (method === 'GET' && parts.length === 2) return ok(this.executions.get(parts[1]) || { status: 'error', error: 'Unknown task' });
    }

    if (parts[0] === 'workflows') return this.workflowRoute(method, parts, query, body);

    if (parts[0] === 'steps' && method === 'PUT') {
      const step = this.runs.flatMap(r => r.steps).find(s => s.id === id(1));
      if (!step) return err(404, 'Step not found');
      if (step.status !== 'pending') return err(400, 'Cannot edit step that has already started');
      step.parameters = body?.parameters ?? body;
      this.broadcast();
      return ok({ status: 'success' });
    }

    if (parts[0] === 'queue') return this.queueRoute(method, parts, query, body);

    return err(404, 'That part of IvoryOS is not in the tour.');
  }

  private status(): Json {
    const meta: Record<string, Json> = {};
    for (const inst of this.deck.deck.instruments || []) if (inst.enabled !== false) meta[inst.name] = { module: inst.import, class: inst.class };
    return {
      status: 'running', cloud_connected: false, instruments: this.schemas(), instrument_meta: meta,
      active_tasks: [], active_workflow_id: this.activeRunId, queue_paused: this.paused,
      cloud_coming_soon: true, cloud_queue: null, instrument_errors: [],
    };
  }

  private cloudSettings(): Json {
    return { paired: false, client_id: null, broker: null, connection_state: null, connection_error: null, pairing_file: null, pairing: null, paused: false, device_id: null, sync_workflows: 'always', last_workflow_sync: null, workflow_count: this.workflows.size };
  }

  private executeOne(body: Json): EdgeResponse {
    const taskId = `task-${this.nextTask++}`;
    const { module: instrument, method, args } = body || {};
    this.executions.set(taskId, { status: 'running' });
    try {
      const { result, ms } = this.simulated().call(String(instrument), String(method), args || {});
      setTimeout(() => this.executions.set(taskId, { status: 'completed', result }), Math.min(ms + 250, 3000));
    } catch (e) {
      const message = (e as Error).message;
      setTimeout(() => this.executions.set(taskId, { status: 'error', error: message, traceback: `${message}\n(simulated in the tour)` }), 250);
    }
    return ok({ status: 'started', task_id: taskId });
  }

  // --- workflows -------------------------------------------------------------------------------

  private head(name: string): Version | null {
    const w = this.workflows.get(name);
    return w ? w.versions[w.versions.length - 1] : null;
  }

  private links(body: Json): string[] {
    const out = new Set<string>();
    for (const key of ['prep', 'script', 'cleanup']) {
      for (const b of body?.[key] || []) if (b?.instrument === 'Library Workflows' || b?.instrument === 'Library_Workflows') out.add(String(b.action));
    }
    return [...out];
  }

  private compatibility(body: Json): Json {
    const schemas = this.schemas();
    const errors: Json[] = [];
    for (const key of ['prep', 'script', 'cleanup']) {
      for (const b of body?.[key] || []) {
        if (!b || FLOW_CONTROL.has(b.instrument) || b.instrument === 'Library Workflows' || b.instrument === 'Library_Workflows') continue;
        if (!schemas[b.instrument]) errors.push({ where: key, message: `Uses ${b.instrument}, which is not on this deck.`, hint: 'Add it to the deck, or point the step at an instrument the deck has.' });
        else if (!schemas[b.instrument][b.action]) errors.push({ where: key, message: `${b.instrument} has no ${b.action}.`, hint: 'Pick one of its methods in the Designer.' });
      }
    }
    return { status: errors.length ? 'broken' : 'ok', error_count: errors.length, errors: errors.slice(0, 20) };
  }

  private summary(name: string): Json {
    const w = this.workflows.get(name)!;
    const head = this.head(name)!;
    return {
      name, description: head.description || '', created_at: w.created_at, updated_at: head.updated_at * 1000,
      version: head.version, body_hash: head.body_hash, note: head.note || '', author: head.author || '',
      links: this.links(head), tags: w.tags,
      linked_by: [...this.workflows.keys()].filter(other => other !== name && this.links(this.head(other)).includes(name)),
      runtime: null, compatibility: this.compatibility(head),
    };
  }

  private workflowRoute(method: string, parts: string[], query: URLSearchParams, body: Json): EdgeResponse {
    if (parts.length === 1 && method === 'GET') {
      const names = [...this.workflows.keys()].sort((a, b) => a.localeCompare(b));
      return ok({ workflows: names.map(n => this.summary(n)), tags: [...new Set(names.flatMap(n => this.workflows.get(n)!.tags))].sort() });
    }
    if (parts[1] === 'expand' && method === 'POST') {
      const prep = body?.prep || [], sequence = body?.sequence || [], cleanup = body?.cleanup || [];
      return ok({ prep, sequence, cleanup, resolved_links: [], counts: { prep: prep.length, sequence: sequence.length, cleanup: cleanup.length, total: prep.length + sequence.length + cleanup.length } });
    }
    const name = parts[1];
    const record = this.workflows.get(name);
    if (parts[2] === 'versions' && method === 'GET') {
      if (!record) return err(404, `Workflow '${name}' not found`);
      return ok({ name, versions: [...record.versions].reverse().map(v => ({ version: v.version, body_hash: v.body_hash, updated_at: v.updated_at * 1000, note: v.note, author: v.author, steps: ['prep', 'script', 'cleanup'].reduce((n, k) => n + (v[k]?.length || 0), 0) })) });
    }
    if (parts[2] === 'dependents' && method === 'GET') {
      return ok({ name, dependents: [...this.workflows.keys()].filter(o => o !== name && this.links(this.head(o)).includes(name)) });
    }
    if (parts[2] === 'tags' && method === 'PUT') {
      if (!record) return err(404, `Workflow '${name}' not found`);
      record.tags = [...new Set<string>((body?.tags || []).map((t: Json) => String(t).trim()).filter(Boolean))];
      return ok({ name, tags: record.tags });
    }
    if (parts.length === 2 && method === 'GET') {
      if (!record) return err(404, `Workflow '${name}' not found`);
      const wanted = query.get('version');
      const v = wanted ? record.versions.find(x => x.version === Number(wanted)) : this.head(name);
      return v ? ok({ ...v, name }) : err(404, `Workflow '${name}' has no version ${wanted}`);
    }
    if (parts.length === 2 && method === 'POST') {
      const { force: _force, ...data } = body || {};
      void _force;
      if (!name.trim() || /[\\/]/.test(name)) return err(400, 'A workflow name cannot be empty or contain a slash.');
      const hash = hashOf(data);
      const now = Date.now() / 1000;
      const w = record || { created_at: Date.now(), versions: [], tags: [] };
      const last = w.versions[w.versions.length - 1];
      const created = !last || last.body_hash !== hash;
      const version = created ? { ...data, name, version: (last?.version || 0) + 1, body_hash: hash, updated_at: now, note: data.note || '', author: data.author || '' } : last;
      if (created) w.versions.push(version);
      this.workflows.set(name, w);
      return ok({ status: 'success', name, version: version.version, created_version: created, body_hash: hash, dependents: [] });
    }
    if (parts.length === 2 && method === 'DELETE') {
      const linkedBy = [...this.workflows.keys()].filter(o => o !== name && this.links(this.head(o)).includes(name));
      if (linkedBy.length && query.get('force') !== 'true') return err(409, `'${name}' is linked by: ${linkedBy.join(', ')}. Detach those steps first, or delete with force=true.`);
      this.workflows.delete(name);
      return ok({ status: 'deleted', name });
    }
    return err(404, 'That part of IvoryOS is not in the tour.');
  }

  // --- queue -----------------------------------------------------------------------------------

  private queueRoute(method: string, parts: string[], query: URLSearchParams, body: Json): EdgeResponse {
    const runId = Number(parts[2]);
    const run = this.runs.find(r => r.id === runId);
    const action = parts[3];

    if (parts[1] === 'history' && method === 'GET') return ok(this.history(query));
    if (parts[1] === 'pause' && method === 'POST') { this.paused = true; this.broadcast(); return ok({ status: 'paused' }); }
    if (parts[1] === 'resume' && method === 'POST') { this.paused = false; this.broadcast(); void this.loop(); return ok({ status: 'running' }); }
    if (parts[1] !== 'runs') return err(404, 'That part of IvoryOS is not in the tour.');

    if (parts.length === 2 && method === 'GET') {
      const recent = query.get('recent');
      return ok({ runs: recent !== null ? this.liveRuns(Number(recent) || 10) : [...this.runs].sort((a, b) => b.id - a.id).map(r => this.copy(r)) });
    }
    if (parts.length === 2 && method === 'POST') {
      try {
        return ok({ status: 'started', run_id: this.submit(body?.name || 'Unnamed Workflow', body?.parameters || {}, body?.prep || [], body?.sequence || [], body?.cleanup || []) });
      } catch (e) {
        return err(400, (e as Error).message);
      }
    }
    if (!run) return err(404, 'Run not found');

    if (parts.length === 3) {
      if (method === 'GET') return ok(this.runStatus(runId));
      if (method === 'PATCH') {
        const name = String(body?.name || '').trim();
        if (!name) return err(400, 'Name cannot be empty');
        run.name = name.slice(0, 128);
        this.broadcast();
        return ok({ status: 'success', name: run.name });
      }
      if (method === 'DELETE') {
        if (!['pending', 'cancelled', 'completed', 'error'].includes(run.status)) return err(400, `Cannot delete a run that is ${run.status}`);
        if (this.activeRunId === runId) return err(400, 'Cannot delete the active run');
        this.runs = this.runs.filter(r => r.id !== runId);
        this.broadcast();
        return ok({ status: 'deleted', run_id: runId });
      }
      if (method === 'PUT') {
        if (run.status !== 'pending') return err(400, 'Only a run that has not started can be changed.');
        const steps = [...(body?.prep || []), ...(body?.sequence || []), ...(body?.cleanup || [])];
        run.name = body?.name || run.name;
        run.parameters = { ...(body?.parameters || {}), ...(run.parameters?.queue_position !== undefined ? { queue_position: run.parameters.queue_position } : {}) };
        run.steps = steps.map((s: Json, i: number) => ({ id: this.nextStepId++, run_id: run.id, sequence_index: i, instrument: s.instrument, method: s.method, parameters: s.params || {}, outputs: null, status: 'pending', error: null, start_time: null, end_time: null }));
        this.broadcast();
        return ok({ status: 'success', run_id: runId });
      }
    }

    if (method === 'POST') {
      const active = this.activeRunId === runId;
      switch (action) {
        case 'pause':
          if (!active) return err(400, 'Workflow not active');
          this.paused = true;
          return ok({ status: 'paused' });
        case 'resume':
          if (!active) return err(400, 'Workflow not active');
          this.paused = false;
          return ok({ status: 'running' });
        case 'cancel':
          if (active) { this.cancelled = true; this.paused = false; return ok({ status: 'cancelling' }); }
          if (run.status === 'pending') { run.status = 'cancelled'; run.end_time = utcnow(); this.broadcast(); return ok({ status: 'cancelled' }); }
          return err(400, 'Workflow not active');
        case 'resolve':
          if (active) this.errorAction = String(body?.action || 'stop');
          return ok({ status: 'success' });
        case 'input': {
          const deliver = this.pendingInput.get(runId);
          if (!active || !deliver) return err(400, 'This run is not waiting for input');
          deliver(body?.value ?? '');
          return ok({ status: 'success' });
        }
        case 'graceful-stop':
          if (!active) return err(400, 'Workflow not active');
          if (this.awaitingDecision === runId) return err(409, 'A failed step is waiting for retry, skip or stop.');
          this.graceful = { cleanup: body?.cleanup ?? true, continue_queue: body?.continue_queue ?? true };
          this.paused = false;
          this.broadcast();
          return ok({ status: 'stopping' });
        case 'move': {
          const direction = body?.direction;
          if (direction !== 'up' && direction !== 'down') return err(400, "direction must be 'up' or 'down'");
          const position = (r: Run) => (typeof r.parameters?.queue_position === 'number' ? r.parameters.queue_position : r.id);
          const pending = this.runs.filter(r => r.status === 'pending').sort((a, b) => position(a) - position(b) || a.id - b.id);
          const at = pending.findIndex(r => r.id === runId);
          if (at === -1) return err(400, 'Run is not pending');
          const target = direction === 'up' ? at - 1 : at + 1;
          if (target < 0 || target >= pending.length) return err(400, `Run is already at the ${direction === 'up' ? 'front' : 'back'} of the queue`);
          [pending[at], pending[target]] = [pending[target], pending[at]];
          pending.forEach((r, i) => { r.parameters = { ...r.parameters, queue_position: i }; });
          this.broadcast();
          return ok({ status: 'success' });
        }
        case 'plots':
          return err(400, 'Plots are drawn by the optimizer, which the tour does not run.');
      }
    }
    if (method === 'GET' && action === 'plots') return err(400, 'Plots are drawn by the optimizer, which the tour does not run.');
    return err(404, 'That part of IvoryOS is not in the tour.');
  }

  private history(query: URLSearchParams): Json {
    const limit = Math.max(1, Math.min(Number(query.get('limit')) || 50, 500));
    const offset = Math.max(0, Number(query.get('offset')) || 0);
    const terms = (query.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const status = query.get('status') || 'all';
    let runs = this.runs.filter(r => terms.every(t =>
      r.name.toLowerCase().includes(t) || JSON.stringify(r.parameters).toLowerCase().includes(t)
      || r.steps.some(s => s.instrument.toLowerCase().includes(t) || s.method.toLowerCase().includes(t))));
    if (status === 'active') runs = runs.filter(r => !TERMINAL.has(r.status));
    else if (status !== 'all') runs = runs.filter(r => r.status === status);
    const duration = (r: Run) => (r.end_time && r.start_time ? Date.parse(r.end_time) - Date.parse(r.start_time) : -1);
    const sorted = [...runs].sort(({
      oldest: (a: Run, b: Run) => a.id - b.id,
      name: (a: Run, b: Run) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || b.id - a.id,
      duration: (a: Run, b: Run) => duration(b) - duration(a) || b.id - a.id,
    } as Record<string, (a: Run, b: Run) => number>)[query.get('sort') || 'newest'] || ((a: Run, b: Run) => b.id - a.id));
    return {
      total: runs.length,
      runs: sorted.slice(offset, offset + limit).map(r => {
        const variables = r.parameters?.variables || [];
        return {
          id: r.id, name: r.name, status: r.status, start_time: r.start_time, end_time: r.end_time, type: r.parameters?.type,
          variable_count: variables.length, row_count: variables.length ? (r.parameters?.rows || []).length : null,
          instruments: [...new Set(r.steps.map(s => s.instrument).filter(i => !FLOW_CONTROL.has(i)))].sort(),
          issues: r.parameters?._issues || null,
        };
      }),
    };
  }
}
