'use strict';

/**
 * Advice about a graph that is valid but may not do what it looks like it does. Unlike
 * `validateGraph`, nothing here blocks a run; the canvas shows it as a warning while drawing.
 *
 * The one case today: two steps on the **same device** that the graph puts on parallel branches.
 * The canvas reads as "these run at the same time", but daemon.js sends a device one Cloud task at
 * a time (see `dispatchTask`), so they run one after the other, in whichever order they become
 * ready. That is usually what a single instrument needs anyway -- the warning is there so the
 * drawing is not mistaken for a promise of parallelism, and so an order that matters gets drawn
 * as an edge instead of being left to timing.
 *
 * Plain CommonJS so `node --test` runs it directly, like dag.js.
 */

const { buildGraph, isDeviceNode, isStartNode, deviceIdOf, IF_BRANCHES } = require('./dag');

function descendantsOf(outgoing, id) {
  const seen = new Set();
  const stack = (outgoing.get(String(id)) || []).slice();
  while (stack.length) {
    const next = String(stack.pop());
    if (seen.has(next)) continue;
    seen.add(next);
    for (const n of (outgoing.get(next) || [])) stack.push(n);
  }
  return seen;
}

/** For each If: everything below its true edge and everything below its false edge. */
function branchReach(edges, outgoing) {
  const reach = new Map();
  for (const e of edges || []) {
    const handle = e && e.sourceHandle ? String(e.sourceHandle) : '';
    if (IF_BRANCHES.indexOf(handle) === -1) continue;
    const source = String(e.source);
    if (!reach.has(source)) reach.set(source, { true: new Set(), false: new Set() });
    const side = reach.get(source)[handle];
    side.add(String(e.target));
    for (const d of descendantsOf(outgoing, e.target)) side.add(d);
  }
  return reach;
}

/** True when some If sends `a` and `b` down opposite branches only, so at most one of them runs. */
function exclusive(reach, a, b) {
  for (const { true: t, false: f } of reach.values()) {
    const onlyTrue = (x) => t.has(x) && !f.has(x);
    const onlyFalse = (x) => f.has(x) && !t.has(x);
    if ((onlyTrue(a) && onlyFalse(b)) || (onlyFalse(a) && onlyTrue(b))) return true;
  }
  return false;
}

/**
 * Per device, the steps that the graph puts in parallel with at least one other step there.
 * Only steps reachable from Start count: an unwired one is already reported as an error.
 *
 * @returns {{ deviceId: string, nodeIds: string[] }[]}
 */
function parallelOnSameDevice(nodes, edges) {
  const { outgoing } = buildGraph(nodes || [], edges || []);
  const reachable = new Set();
  for (const s of (nodes || []).filter(isStartNode)) {
    reachable.add(String(s.id));
    for (const d of descendantsOf(outgoing, s.id)) reachable.add(d);
  }
  const reach = branchReach(edges, outgoing);

  const byDevice = new Map();
  for (const n of nodes || []) {
    if (!isDeviceNode(n) || !reachable.has(String(n.id))) continue;
    const device = deviceIdOf(n);
    if (!device) continue;
    if (!byDevice.has(device)) byDevice.set(device, []);
    byDevice.get(device).push(String(n.id));
  }

  const out = [];
  for (const [deviceId, ids] of byDevice) {
    if (ids.length < 2) continue;
    const desc = new Map(ids.map((id) => [id, descendantsOf(outgoing, id)]));
    const involved = new Set();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = [ids[i], ids[j]];
        if (desc.get(a).has(b) || desc.get(b).has(a)) continue; // one is drawn after the other
        if (exclusive(reach, a, b)) continue;
        involved.add(a);
        involved.add(b);
      }
    }
    if (involved.size) out.push({ deviceId, nodeIds: ids.filter((id) => involved.has(id)) });
  }
  return out;
}

module.exports = { parallelOnSameDevice, descendantsOf };
