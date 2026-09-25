'use strict';

/**
 * The one description of what a distributed Orchestrator graph *means* as an execution plan.
 *
 * Two processes need to agree about this and they cannot share a TypeScript module: the Next.js
 * route that plans a run (`api/cloud-workflows/runs`) and `daemon.js`, a plain `node daemon.js`
 * with no build step. They previously each carried their own copy of the dependency rules and had
 * already drifted — the route classified a node by "are all its direct deps Flow Control", the
 * daemon by "is each dep Flow Control or completed". Both were wrong in the same way (below), but
 * independently wrong, which is the failure mode AGENTS.md section 3 warns about. Hence: plain
 * CommonJS, `require`-able from the daemon and importable from the app.
 *
 * Four rules define the semantics:
 *
 * 1. **Edges are the only ordering.** A task runs when every task it depends on has completed —
 *    never before. Nodes with no dependencies start together; independent branches run in
 *    parallel. That is the whole point of authoring on a canvas instead of a list.
 *
 * 2. **Structural Flow Control nodes are transparent, not satisfied.** They get no `run_tasks` row (they
 *    are not dispatched to any device), so it is tempting to treat them as an already-met
 *    dependency — which is exactly what both copies of the old logic did. That silently deleted
 *    ordering: in `A -> Sleep -> B`, B's only dependency is the Sleep node, "already satisfied",
 *    so B was dispatched at the same instant as A. On real hardware that is two instruments
 *    moving at once in a graph that says they must not. Instead a Flow Control node is contracted
 *    out of the graph and its dependents inherit *its* dependencies, so B waits for A.
 *    The seeded `Start` node is the degenerate case of this and keeps working: it has no
 *    predecessors, so everything hanging off it inherits an empty dependency set and runs first.
 *
 * 3. **Cloud Logic nodes are real steps that Cloud runs itself** (`CLOUD_LOGIC`: Wait, User_Input,
 *    If). They get a `run_tasks` row on the pseudo-device `CLOUD_DEVICE_ID`, and daemon.js carries
 *    them out instead of publishing them: a Wait holds its branch, a User_Input holds it until
 *    someone answers on the canvas, and an If picks a branch. Rule 2 still covers every other Flow
 *    Control method (Start, and whatever a legacy graph carries), so old graphs mean what they did.
 *
 * 4. **An If's untaken branch is skipped, not failed.** An edge leaving an If carries the branch it
 *    belongs to (`sourceHandle`: 'true' | 'false'). A step whose dependencies all finished without
 *    one of them leading to it live ends `skipped`, and that propagates down the branch. A join
 *    fed by both branches runs once the taken one reaches it, so "if ... else ... then continue"
 *    draws the obvious way.
 */

// The shapes below are annotated in JSDoc rather than a parallel dag.d.ts: `allowJs` means the
// TypeScript side of the app (the run route, the Orchestrator canvas) gets real types straight
// from this file, with no second copy of the signatures to drift out of step with it.
/**
 * @typedef {{ code: string, message: string }} GraphProblem
 * @typedef {{ run_id: string, node_id: string, device_id: string, block: any, status: string, deps: string[] }} PlannedTask
 * @typedef {{ node_id: string, status: string, progress?: any }} TaskRow
 * @typedef {{ unblock: string[], cancel: {nodeId: string, reason: string}[], skip: string[], runStatus: string, stalled: boolean }} AdvanceDecision
 */

// Both spellings are live across this stack (`packages/shared-ui/src/flowControl.ts`, `queue.py`
// and `agent/validate.py` all accept either). The cloud side used to check only 'Flow Control',
// which meant a graph carrying the underscored spelling had its Flow Control nodes treated as
// ordinary instrument nodes and rejected for having no target device.
const FLOW_CONTROL_INSTRUMENTS = ['Flow_Control', 'Flow Control'];
const START_METHOD = 'Start';

// The pseudo-device a Cloud Logic task is assigned to. daemon.js checks for it before any broker
// traffic, so it never reaches an MQTT topic.
const CLOUD_DEVICE_ID = '@cloud';

// Steps Cloud executes itself rather than sending to a device. Same schema shape as a device
// method, so the canvas renders these with the code it already has.
const IF_OPERATORS = ['==', '!=', '>', '>=', '<', '<=', 'contains'];
const CLOUD_LOGIC = {
  Wait: {
    description: 'Hold this branch for a while, doing nothing, then continue.',
    parameters: { seconds: { type: 'float', required: true, default: 60 } },
    return_type: 'None',
  },
  User_Input: {
    description: 'Hold this branch until someone answers on the canvas. The answer can be saved for an If to test.',
    parameters: {
      prompt: { type: 'str', required: true, default: 'Continue?' },
      save_as: { type: 'str', required: false, default: '' },
    },
    return_type: 'None',
  },
  If: {
    description: 'Continue down the true or the false branch, depending on a value an earlier step saved.',
    parameters: {
      variable: { type: 'str', required: true, default: '' },
      operator: { type: 'str', required: true, default: '>', options: IF_OPERATORS },
      value: { type: 'str', required: true, default: '' },
    },
    return_type: 'None',
  },
};
// The branch handles on an If node. An edge from any other node has no handle: unconditional.
const IF_BRANCHES = ['true', 'false'];

// A task that will never change again on its own. Shared with daemon.js's out-of-order-message
// guard so "what counts as finished" has one definition.
// 'skipped' is an If's untaken branch: finished, never run, and not a failure.
const TERMINAL_TASK_STATUSES = ['completed', 'error', 'cancelled', 'skipped'];
// A task the run is still actively waiting on. 'blocked' is deliberately NOT here: a run where
// every remaining task is blocked is making no progress, which is a stall, not activity.
const ACTIVE_TASK_STATUSES = ['pending', 'queued', 'running'];

function blockOf(node) {
  if (!node) return {};
  return (node.data && node.data.block) || node.block || {};
}

function isFlowControlNode(node) {
  return FLOW_CONTROL_INSTRUMENTS.indexOf(String(blockOf(node).instrument || '')) !== -1;
}

/** A Flow Control step Cloud carries out itself (Wait, User_Input, If). Gets a task. */
function isCloudLogicNode(node) {
  return isFlowControlNode(node)
    && Object.prototype.hasOwnProperty.call(CLOUD_LOGIC, String(blockOf(node).method || ''));
}

/** A Flow Control node that only shapes the graph (Start, legacy methods). Contracted away. */
function isTransparentNode(node) {
  return isFlowControlNode(node) && !isCloudLogicNode(node);
}

/** A step sent to a real device: needs a target device and complete params. */
function isDeviceNode(node) {
  return !isFlowControlNode(node);
}

const stripHash = (v) => String(v === undefined || v === null ? '' : v).trim().replace(/^#/, '');

/**
 * What is wrong with one Cloud Logic node's settings, as short phrases. Its own check rather than
 * `blankParamsOf`: `save_as` is legitimately empty, and a Wait of "abc" seconds is not a value.
 */
function logicProblemsOf(node) {
  const block = blockOf(node);
  const method = String(block.method || '');
  const value = (k) => effectiveParamValue(block, k);
  const problems = [];
  if (method === 'Wait') {
    const seconds = Number(value('seconds'));
    if (!Number.isFinite(seconds) || seconds <= 0) problems.push('needs a number of seconds greater than 0');
  } else if (method === 'User_Input') {
    if (!String(value('prompt') ?? '').trim()) problems.push('needs a prompt');
  } else if (method === 'If') {
    if (!stripHash(value('variable'))) problems.push('needs a variable to test');
    if (IF_OPERATORS.indexOf(String(value('operator') || '')) === -1) problems.push('needs a comparison');
    else if (!String(value('value') ?? '').trim()) problems.push('needs a value to compare with');
  }
  return problems;
}

/**
 * An If's comparison. Numbers compare as numbers when both sides are numeric, otherwise as
 * case-insensitive text. Pure, so the daemon and the tests share one definition.
 * @returns {boolean}
 */
function evaluateCondition(actual, operator, expected) {
  const a = typeof actual === 'string' ? actual.trim() : actual;
  const b = typeof expected === 'string' ? expected.trim() : expected;
  const numeric = a !== '' && b !== '' && a !== null && typeof a !== 'boolean'
    && Number.isFinite(Number(a)) && Number.isFinite(Number(b));
  const [x, y] = numeric ? [Number(a), Number(b)] : [String(a).toLowerCase(), String(b).toLowerCase()];
  switch (operator) {
    case '==': return x === y;
    case '!=': return x !== y;
    case '>': return x > y;
    case '>=': return x >= y;
    case '<': return x < y;
    case '<=': return x <= y;
    case 'contains': return String(a).toLowerCase().includes(String(b).toLowerCase());
    default: throw new Error(`Unknown comparison '${operator}'.`);
  }
}

// `#name` means "supply this when the run starts" — the same convention the edge Designer uses
// (AGENTS.md section 4). Anywhere a value is expected, a bare '#' is not one.
const DYNAMIC_PREFIX = '#';
const isDynamicValue = (v) => typeof v === 'string' && v.trim().startsWith(DYNAMIC_PREFIX);

/**
 * The value a field actually shows, which is what "is this box empty" has to mean: the node
 * renders `params[k]`, falling back to the schema default. A param left untouched where the
 * schema supplies a default is NOT empty — the default is a real value and the edge applies it.
 */
function effectiveParamValue(block, key) {
  const params = block.params || {};
  if (params[key] !== undefined) return params[key];
  const declared = (block.schema && block.schema.parameters && block.schema.parameters[key]) || {};
  return declared.default;
}

/** Declared params whose effective value is blank — the boxes a person sees as empty. */
function blankParamsOf(node) {
  const block = blockOf(node);
  const declared = Object.keys((block.schema && block.schema.parameters) || {});
  return declared.filter((key) => {
    const v = effectiveParamValue(block, key);
    if (v === undefined || v === null) return true;
    if (typeof v === 'string') return v.trim() === '';
    return false;
  });
}

/** Declared params still holding a `#name` placeholder (including a bare '#', which names nothing). */
function placeholderParamsOf(node) {
  const block = blockOf(node);
  const declared = Object.keys((block.schema && block.schema.parameters) || {});
  return declared.filter((key) => isDynamicValue(effectiveParamValue(block, key)));
}

/**
 * How a node turns into work. `single` dispatches the bare block, exactly as this canvas always
 * did; `spreadsheet` and `optimization` wrap it in a whole run (see src/lib/runPayload.ts).
 *
 * Defined here rather than beside the payload builder because both sides need it and only this
 * file can be required by `daemon.js` — the TypeScript module re-exports these instead of keeping
 * its own copy of the rule.
 */
function runConfigOf(node) {
  return (node && node.data && node.data.runConfig) || {};
}

function runModeOf(node) {
  const mode = runConfigOf(node).mode;
  return mode === 'spreadsheet' || mode === 'optimization' ? mode : 'single';
}

/** A node that iterates carries its own `#name`s down to the device, unresolved on purpose. */
function isIteratingNode(node) {
  return runModeOf(node) !== 'single';
}

function isStartNode(node) {
  return isFlowControlNode(node) && String(blockOf(node).method || '') === START_METHOD;
}

function deviceIdOf(node) {
  if (!node) return '';
  const id = (node.data && node.data.targetDeviceId) || node.targetDeviceId || '';
  return typeof id === 'string' ? id.trim() : '';
}

/** Adjacency built once and reused by every function below. */
function buildGraph(nodes, edges) {
  const nodeById = new Map();
  for (const n of nodes) nodeById.set(String(n && n.id), n);

  const incoming = new Map();
  const outgoing = new Map();
  // The same edges as `incoming`, with the If branch each leaves its source by (null = none).
  const incomingEdges = new Map();
  for (const e of edges) {
    const source = String(e && e.source);
    const target = String(e && e.target);
    if (!nodeById.has(source) || !nodeById.has(target)) continue; // reported by validateGraph
    if (!incoming.has(target)) incoming.set(target, []);
    if (!outgoing.has(source)) outgoing.set(source, []);
    if (!incomingEdges.has(target)) incomingEdges.set(target, []);
    incoming.get(target).push(source);
    outgoing.get(source).push(target);
    incomingEdges.get(target).push({ source, handle: e && e.sourceHandle ? String(e.sourceHandle) : null });
  }
  return { nodeById, incoming, outgoing, incomingEdges };
}

/**
 * Which task carries each node's work: its own, for every run planned today.
 *
 * Runs planned while "merge chains" existed stored one task for a whole straight line of steps,
 * listing the nodes it covered in `members`. Such a run can still be in flight or be advanced
 * after an upgrade, so the mapping is read back from those rows rather than recomputed -- there is
 * no chain-finding left to recompute it with. Every task planned now covers exactly its own node.
 */
function representativesFromTasks(nodes, tasks) {
  const reps = new Map();
  for (const n of (nodes || [])) reps.set(String(n.id), String(n.id));
  for (const t of (tasks || [])) {
    for (const member of (Array.isArray(t.members) ? t.members : [])) {
      reps.set(String(member), String(t.node_id));
    }
  }
  return reps;
}

/**
 * The tasks `nodeId` genuinely waits on: its ancestors with the Flow Control nodes contracted
 * away. Walking upward rather than looking at direct predecessors is what makes rule 2 hold
 * through a chain of several Flow Control nodes (`A -> If -> Sleep -> B` still yields `{A}`).
 * `seen` keeps this terminating even on a graph that has not been validated yet.
 */
function effectiveDependencies(nodeId, incoming, isFlowControlId, reps) {
  return new Set(dependencyBranches(nodeId, incoming, isFlowControlId, reps).keys());
}

/**
 * `effectiveDependencies`, keeping the branch each dependency is reached through: a map of
 * dependency -> set of If handles, `null` meaning an unconditional edge. A dependency reached
 * more than one way carries every way it is reached.
 *
 * Takes either `incoming` (plain source ids) or `incomingEdges` (`{source, handle}`), so callers
 * that do not care about branches keep passing what they always passed.
 */
function dependencyBranches(nodeId, incoming, isFlowControlId, reps) {
  const repOf = (id) => (reps && reps.get(String(id))) || String(id);
  const self = repOf(nodeId);
  const deps = new Map();
  const edgesInto = (id) => (incoming.get(String(id)) || [])
    .map((x) => (x !== null && typeof x === 'object' ? x : { source: String(x), handle: null }));
  // Keyed on node and branch together: one transparent node reached through both branches of an
  // If has to be explored both ways, or one branch would silently vanish.
  const seen = new Set();
  const stack = edgesInto(nodeId);
  while (stack.length) {
    const { source, handle } = stack.pop();
    const parent = String(source);
    const key = `${parent}\u0000${handle}`;
    if (parent === String(nodeId) || seen.has(key)) continue;
    seen.add(key);
    if (isFlowControlId(parent)) {
      // A path through a transparent node stays on whichever branch it arrived by.
      for (const up of edgesInto(parent)) stack.push({ source: up.source, handle: up.handle || handle });
      continue;
    }
    // Only reachable for a run planned when chains could be merged: a step in the same task as
    // this one is part of the run it dispatches, not something to wait for. Without this such a
    // task would depend on itself and stay blocked forever.
    const rep = repOf(parent);
    if (rep === self) {
      for (const up of edgesInto(parent)) stack.push(up);
      continue;
    }
    if (!deps.has(rep)) deps.set(rep, new Set());
    deps.get(rep).add(handle);
  }
  return deps;
}

/**
 * Every structural reason this graph cannot be executed, as `{code, message}` — all of them, not
 * just the first, so one Run click tells you everything to fix.
 *
 * This runs server-side on purpose. The canvas already refuses to *draw* a cycle
 * (`CloudWorkflowEditor`'s `isValidConnection`), but a graph can reach the run route without ever
 * having passed through that: restored from `localStorage`, loaded from the Library, or posted
 * directly. An unvalidated cycle did not fail — it hung. Every node in it stayed `blocked`
 * forever, the run sat at `running` forever, and nothing in the UI said why.
 *
 * @param {any[]} nodes
 * @param {any[]} edges
 * @param {{ requireResolvedParams?: boolean }} [opts] `requireResolvedParams` additionally rejects
 *   params still holding a `#name`. The canvas validates *before* substituting, where `#name` is
 *   the normal authored state, so only a caller holding already-substituted nodes (the run route)
 *   passes it.
 * @returns {GraphProblem[]}
 */
function validateGraph(nodes, edges, opts) {
  const errors = [];
  if (!Array.isArray(nodes)) return [{ code: 'bad_payload', message: 'nodes must be an array.' }];
  if (!Array.isArray(edges)) return [{ code: 'bad_payload', message: 'edges must be an array.' }];
  if (nodes.length === 0) return [{ code: 'empty', message: 'This workflow has no steps.' }];

  const seenIds = new Set();
  const duplicates = new Set();
  for (const n of nodes) {
    const id = n && n.id;
    if (typeof id !== 'string' || !id) {
      errors.push({ code: 'invalid_node', message: 'Every step needs a non-empty string id.' });
      continue;
    }
    if (seenIds.has(id)) duplicates.add(id);
    seenIds.add(id);
  }
  if (duplicates.size) {
    // `run_tasks` has `unique (run_id, node_id)`, so this used to surface as a raw Postgres
    // constraint message in an alert() — and it is reachable by importing the same saved
    // workflow onto a canvas twice.
    errors.push({
      code: 'duplicate_node_id',
      message: 'Duplicate step ids: ' + Array.from(duplicates).join(', ') + '.',
    });
  }
  if (errors.length) return errors;

  const dangling = [];
  const selfLoops = [];
  for (const e of edges) {
    const source = e && typeof e.source === 'string' ? e.source : '';
    const target = e && typeof e.target === 'string' ? e.target : '';
    if (!seenIds.has(source) || !seenIds.has(target)) {
      dangling.push((source || '?') + ' -> ' + (target || '?'));
    } else if (source === target) {
      selfLoops.push(source);
    }
  }
  if (dangling.length) {
    // A dangling edge is not cosmetic: the old code took the missing endpoint as a dependency
    // that could never complete, so the step downstream of it stayed blocked for good.
    errors.push({
      code: 'dangling_edge',
      message: 'Connection(s) referencing steps that are not on the canvas: ' + dangling.join(', ') + '.',
    });
  }
  if (selfLoops.length) {
    errors.push({
      code: 'self_loop',
      message: 'Step(s) connected to themselves: ' + selfLoops.join(', ') + '.',
    });
  }

  const { nodeById, incoming, outgoing } = buildGraph(nodes, edges);

  // Kahn's algorithm: peel off nodes with no unprocessed predecessors. Whatever will not peel is
  // in (or downstream of) a cycle, and naming those nodes is the whole value over a bare
  // "invalid graph" — on a large canvas the offending loop is not obvious by eye.
  const indegree = new Map();
  for (const id of nodeById.keys()) indegree.set(id, (incoming.get(id) || []).length);
  const queue = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  let settled = 0;
  while (queue.length) {
    const id = queue.pop();
    settled++;
    for (const next of (outgoing.get(id) || [])) {
      const deg = indegree.get(next) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  const hasCycle = settled !== nodeById.size;
  if (hasCycle) {
    const inCycle = Array.from(indegree.entries()).filter(([, deg]) => deg > 0).map(([id]) => id);
    errors.push({
      code: 'cycle',
      message: 'This workflow is not a DAG — these steps form a loop (or sit downstream of one): '
        + inCycle.join(', ') + '. Execution order is undefined, so nothing was started.',
    });
  }

  // Reachability from Start. Without this a node that was dragged out and never wired up has an
  // empty dependency set, which reads as "ready" — so it fires the instant the run starts,
  // concurrently with everything else, in a graph whose edges say nothing about it. Silently
  // actuating unwired hardware is the worst available reading of an ambiguous canvas, so this is
  // an error rather than a warning. (If it proves too strict for real graphs, it is this block
  // and nothing else — downgrading it does not touch the scheduler.)
  const startIds = nodes.filter(isStartNode).map(n => String(n.id));
  // Sent to a device: needs a device and complete params.
  const dispatchable = nodes.filter(isDeviceNode);
  // Everything that becomes a task, Cloud Logic included: an unwired Wait or User_Input would
  // start the instant the run does, exactly like an unwired instrument step.
  const executable = nodes.filter(n => !isTransparentNode(n));
  if (executable.length > 0) {
    if (startIds.length === 0) {
      errors.push({
        code: 'no_start',
        message: 'This workflow has no Start step, so there is nothing to begin from.',
      });
    } else if (!hasCycle) {
      const reachable = new Set(startIds);
      const stack = startIds.slice();
      while (stack.length) {
        const id = stack.pop();
        for (const next of (outgoing.get(id) || [])) {
          if (reachable.has(next)) continue;
          reachable.add(next);
          stack.push(next);
        }
      }
      const orphans = executable.filter(n => !reachable.has(String(n.id))).map(n => String(n.id));
      if (orphans.length) {
        errors.push({
          code: 'unreachable',
          message: 'Step(s) not connected to Start: ' + orphans.join(', ')
            + '. Connect them or remove them — an unconnected step would otherwise run immediately, in parallel with everything else.',
        });
      }
    }
  }

  // Checked last so a structurally broken graph reports its structure problems first.
  const noDevice = dispatchable.filter(n => !deviceIdOf(n)).map(n => String(n.id));
  if (noDevice.length) {
    errors.push({
      code: 'no_device',
      message: 'Every instrument/sequence step needs a target device assigned before running. Missing: '
        + noDevice.join(', ') + '.',
    });
  }

  // Parameter completeness. Only `dispatchable` nodes: a Flow Control node is contracted out of
  // the graph and never reaches an instrument, so an empty field on one cannot actuate anything.
  // An empty field on a step that IS dispatched sends "" to real hardware as if it were a value.
  const blanks = [];
  const unresolved = [];
  for (const node of dispatchable) {
    const blank = blankParamsOf(node);
    if (blank.length) blanks.push(`${node.id} (${blank.join(', ')})`);
    // An iterating node keeps its `#name`s on purpose: a spreadsheet supplies them per row and an
    // optimization per trial, so they are resolved by the run rather than before it. Only a node
    // that dispatches once has to arrive with every placeholder already filled in.
    if (opts && opts.requireResolvedParams && !isIteratingNode(node)) {
      const left = placeholderParamsOf(node);
      if (left.length) unresolved.push(`${node.id} (${left.join(', ')})`);
    }
  }
  if (blanks.length) {
    errors.push({
      code: 'empty_param',
      message: 'Step(s) with empty parameters: ' + blanks.join('; ')
        + '. Fill them in, or write #name to supply the value when the run starts.',
    });
  }
  const logic = [];
  for (const node of nodes.filter(isCloudLogicNode)) {
    const p = logicProblemsOf(node);
    if (p.length) logic.push(`${String(blockOf(node).method).replace(/_/g, ' ')} ${node.id} ${p.join(', ')}`);
  }
  if (logic.length) {
    errors.push({ code: 'logic_config', message: 'Cloud Logic step(s) not set up: ' + logic.join('; ') + '.' });
  }
  if (unresolved.length) {
    // Only checked for callers that have already substituted (the run route). Reaching dispatch
    // with a literal "#temperature" would hand an instrument that string as if it were a number.
    errors.push({
      code: 'unresolved_placeholder',
      message: 'Step(s) still carrying unfilled placeholders: ' + unresolved.join('; ')
        + '. These must be given values before the run is dispatched.',
    });
  }

  return errors;
}

/**
 * Turn a graph into the `run_tasks` rows to insert. A task starts `pending` only when its
 * effective dependency set is empty; everything else starts `blocked` and is released by
 * `computeAdvance` as its dependencies finish.
 *
 * `deps` comes back alongside each row but is not a column — it is recomputed from `runs.edges`
 * on every advance, so there is no second copy of the graph to keep in sync.
 *
 * @param {string} runId
 * @param {any[]} nodes
 * @param {any[]} edges
 * @returns {{ errors: GraphProblem[], tasks: PlannedTask[] }}
 */
function planRun(runId, nodes, edges) {
  // Always `requireResolvedParams`: these nodes are the ones about to be written as run_tasks and
  // dispatched, so a `#name` surviving to here is a value that will never arrive. Enforced inside
  // planRun rather than left to the caller precisely so there is no flag anyone can forget — the
  // canvas is not the only route in (Library, localStorage, a direct POST).
  const errors = validateGraph(nodes, edges, { requireResolvedParams: true });
  if (errors.length) return { errors, tasks: [] };

  const { incoming } = buildGraph(nodes, edges);
  const flowControlIds = new Set(nodes.filter(isTransparentNode).map(n => String(n.id)));
  const isFlowControlId = (id) => flowControlIds.has(id);
  // One task per step, each dispatched on its own. Cloud owns the ordering between them: a join
  // (C after both A and B) is C staying blocked here until both report, not C being handed to a
  // device queue early to wait there. That keeps every task standalone -- it can be retried,
  // cancelled or reported on by itself -- and is why straight lines are no longer merged into
  // one run.
  const tasks = nodes.filter((n) => !isTransparentNode(n)).map((node) => {
    const id = String(node.id);
    const deps = effectiveDependencies(id, incoming, isFlowControlId);
    return {
      run_id: runId,
      node_id: id,
      device_id: isCloudLogicNode(node) ? CLOUD_DEVICE_ID : deviceIdOf(node),
      // The bare block, for the single-step wire shape. A node that iterates carries its real
      // content in `run` instead, attached by the caller -- see src/lib/runPayload.ts.
      block: blockOf(node),
      members: [id],
      status: deps.size === 0 ? 'pending' : 'blocked',
      deps: Array.from(deps),
    };
  });

  return { errors: [], tasks };
}

/**
 * Given the stored graph and the current `run_tasks` rows, decide what changes: which blocked
 * tasks are now released, which are dead because something upstream failed, and whether the run
 * itself has reached a terminal state. Pure — the caller does the writes — so the scheduling
 * rules can be reasoned about (and tested) without a broker or a database.
 *
 * @param {any[]} nodes
 * @param {any[]} edges
 * @param {TaskRow[]} tasks
 * @returns {AdvanceDecision}
 */
function computeAdvance(nodes, edges, tasks) {
  const { incomingEdges } = buildGraph(nodes || [], edges || []);
  const flowControlIds = new Set((nodes || []).filter(isTransparentNode).map(n => String(n.id)));
  const isFlowControlId = (id) => flowControlIds.has(id);

  const reps = representativesFromTasks(nodes, tasks);

  const statusByNode = new Map((tasks || []).map(t => [String(t.node_id), t.status]));
  // The branch each finished If took; the daemon records it in the task's progress.
  const branchByNode = new Map((tasks || [])
    .filter(t => t.progress && typeof t.progress === 'object' && t.progress.branch)
    .map(t => [String(t.node_id), String(t.progress.branch)]));

  const unblock = [];
  const cancel = [];
  const skip = [];
  // Decisions are projected as they are made and the pass repeats until nothing moves: skipping
  // one step can settle the next one, and a whole untaken branch should resolve at once rather
  // than one step per incoming message. Projecting also means a run that finishes on this very
  // pass is recognised now rather than waiting for a message that will never arrive.
  const projected = new Map(statusByNode);
  let moved = true;
  while (moved) {
    moved = false;
    for (const task of (tasks || [])) {
      const nodeId = String(task.node_id);
      if (projected.get(nodeId) !== 'blocked') continue;
      const deps = dependencyBranches(nodeId, incomingEdges, isFlowControlId, reps);
      const depIds = Array.from(deps.keys());
      // A dependency that errored or was itself cancelled can never complete, so this task can
      // never legally run. Leaving it 'blocked' was safe (it does stay unrun) but left the run
      // parked at 'running' with no terminal state and nothing in the UI explaining the stall.
      const deadDep = depIds.find(d => projected.get(d) === 'error' || projected.get(d) === 'cancelled');
      if (deadDep) {
        cancel.push({ nodeId, reason: 'upstream ' + deadDep + ' did not complete' });
        projected.set(nodeId, 'cancelled');
        moved = true;
        continue;
      }
      if (depIds.some(d => TERMINAL_TASK_STATUSES.indexOf(projected.get(d)) === -1)) continue;
      // Everything it waits on has finished. It runs when at least one of those leads here live:
      // completed, and either unconditionally or through the branch its If actually took.
      const live = depIds.length === 0 || depIds.some((d) => {
        if (projected.get(d) !== 'completed') return false;
        const taken = branchByNode.get(d);
        const handles = deps.get(d);
        return !taken || handles.has(null) || handles.has(taken);
      });
      if (live) {
        unblock.push(nodeId);
        projected.set(nodeId, 'pending');
      } else {
        skip.push(nodeId);
        projected.set(nodeId, 'skipped');
      }
      moved = true;
    }
  }
  const statuses = Array.from(projected.values());

  let runStatus = 'running';
  let stalled = false;
  if (statuses.length === 0 || statuses.every(s => TERMINAL_TASK_STATUSES.indexOf(s) !== -1)) {
    runStatus = statuses.some(s => s === 'error' || s === 'cancelled') ? 'error' : 'completed';
  } else if (!statuses.some(s => ACTIVE_TASK_STATUSES.indexOf(s) !== -1)) {
    // Nothing running, nothing queued, nothing ready — yet tasks remain blocked. Validation
    // should make this unreachable (a cycle is the only way to build it deliberately); treat it
    // as a bug surfacing rather than a run to leave hanging forever.
    runStatus = 'error';
    stalled = true;
  }

  return { unblock, cancel, skip, runStatus, stalled };
}

module.exports = {
  FLOW_CONTROL_INSTRUMENTS,
  CLOUD_DEVICE_ID,
  CLOUD_LOGIC,
  IF_OPERATORS,
  IF_BRANCHES,
  isCloudLogicNode,
  isTransparentNode,
  isDeviceNode,
  logicProblemsOf,
  evaluateCondition,
  dependencyBranches,
  TERMINAL_TASK_STATUSES,
  ACTIVE_TASK_STATUSES,
  isFlowControlNode,
  isStartNode,
  deviceIdOf,
  blockOf,
  isDynamicValue,
  effectiveParamValue,
  blankParamsOf,
  placeholderParamsOf,
  buildGraph,
  runConfigOf,
  runModeOf,
  isIteratingNode,
  representativesFromTasks,
  effectiveDependencies,
  validateGraph,
  planRun,
  computeAdvance,
};
