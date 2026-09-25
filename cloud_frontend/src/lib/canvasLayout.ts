/**
 * Placement on the Orchestrator canvas: where a dropped step goes, what it connects to, and the
 * "Tidy up" layout. The graph flows top to bottom (handles are Top/Bottom), so a layer is a row.
 *
 * Only positions are touched here; nothing changes what a graph means.
 */

import type { Edge, Node } from '@xyflow/react';

export const GRID = 20;
const GAP_X = 60;
const GAP_Y = 70;
const FALLBACK = { w: 254, h: 140 };

const snap = (v: number) => Math.round(v / GRID) * GRID;

/**
 * A node's size before React Flow has measured it: a step dropped a moment ago, or a whole graph
 * in a tab the browser has not laid out yet (background tabs defer it). Estimated from what the
 * card will draw, because one fixed guess put the next step on top of any card with a few fields.
 */
function estimateSize(n: Node): { w: number; h: number } {
  const data = (n.data as any) || {};
  const block = data.block || {};
  const flow = ['Flow Control', 'Flow_Control'].includes(String(block.instrument || ''));
  if (flow && block.method === 'Start') return { w: 150, h: 57 };
  if (flow) {
    if (data.collapsed) return { w: 234, h: 80 };
    return { w: 234, h: block.method === 'Wait' ? 95 : block.method === 'If' ? 150 : 190 };
  }
  if (data.collapsed) return { w: 254, h: 120 };
  const params = Object.keys(block.schema?.parameters || {}).length;
  const returns = !['None', 'NoneType', undefined].includes(block.schema?.return_type);
  return { w: 261, h: 95 + (params ? 24 + params * 56 : 0) + (returns ? 60 : 0) };
}

export function sizeOf(n: Node): { w: number; h: number } {
  const est = n.measured?.width && n.measured?.height ? null : estimateSize(n);
  return {
    w: n.measured?.width ?? n.width ?? est?.w ?? FALLBACK.w,
    h: n.measured?.height ?? n.height ?? est?.h ?? FALLBACK.h,
  };
}

const methodOf = (n: Node) => String((n.data as any)?.block?.method || '');
const isFlow = (n: Node) => ['Flow Control', 'Flow_Control'].includes(String((n.data as any)?.block?.instrument || ''));
export const isIfNode = (n: Node | undefined) => !!n && isFlow(n) && methodOf(n) === 'If';
const isStart = (n: Node) => isFlow(n) && methodOf(n) === 'Start';

/** The branch a new edge out of `source` should use: the If's first unused one, or none. */
export function freeHandleOf(source: Node, edges: Edge[]): string | null {
  if (!isIfNode(source)) return null;
  const used = new Set(edges.filter(e => e.source === source.id).map(e => String(e.sourceHandle || '')));
  if (!used.has('true')) return 'true';
  if (!used.has('false')) return 'false';
  return 'true';
}

function hasFreeOutput(n: Node, edges: Edge[]): boolean {
  const out = edges.filter(e => e.source === n.id);
  if (isIfNode(n)) return !out.some(e => e.sourceHandle === 'true') || !out.some(e => e.sourceHandle === 'false');
  return out.length === 0;
}

/**
 * Which step a dropped step connects from, n8n-style: the selected step if exactly one is
 * selected, otherwise the nearest open end of the graph above the drop point (so the first step
 * dropped on a fresh canvas hangs off Start). Only steps already connected to Start count, so a
 * new step never extends a fragment that would not run anyway. Null means "leave it unconnected".
 */
export function pickAutoSource(nodes: Node[], edges: Edge[], drop: { x: number; y: number }): Node | null {
  const selected = nodes.filter(n => n.selected);
  if (selected.length === 1) return selected[0];

  const connected = new Set<string>(nodes.filter(isStart).map(n => n.id));
  const stack = [...connected];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of edges) {
      if (e.source === id && !connected.has(e.target)) { connected.add(e.target); stack.push(e.target); }
    }
  }
  const open = nodes.filter(n => connected.has(n.id) && hasFreeOutput(n, edges));
  if (!open.length) return null;

  const bottomCentre = (n: Node) => {
    const { w, h } = sizeOf(n);
    return { x: n.position.x + w / 2, y: n.position.y + h };
  };
  const dist = (n: Node) => {
    const p = bottomCentre(n);
    return Math.hypot(p.x - drop.x, p.y - drop.y);
  };
  const above = open.filter(n => bottomCentre(n).y <= drop.y);
  return (above.length ? above : open).sort((a, b) => dist(a) - dist(b))[0];
}

/** A slot for a new child of `source`: straight below it, or beside the children it already has. */
export function slotBelow(source: Node, nodes: Node[], edges: Edge[], newWidth = FALLBACK.w): { x: number; y: number } {
  const { w, h } = sizeOf(source);
  const children = edges
    .filter(e => e.source === source.id)
    .map(e => nodes.find(n => n.id === e.target))
    .filter((n): n is Node => !!n);
  if (!children.length) {
    return { x: snap(source.position.x + (w - newWidth) / 2), y: snap(source.position.y + h + GAP_Y) };
  }
  const rightmost = children.reduce((a, b) => (b.position.x + sizeOf(b).w > a.position.x + sizeOf(a).w ? b : a));
  return { x: snap(rightmost.position.x + sizeOf(rightmost).w + GAP_X), y: snap(rightmost.position.y) };
}

/**
 * Lay the whole graph out in rows: each step one row below the lowest step it waits on, rows
 * centred under Start, and siblings ordered by where their parents are (an If's true branch left
 * of its false one). Anchored on Start's current position so tidying does not move the view.
 */
export function tidyLayout(nodes: Node[], edges: Edge[]): Node[] {
  const ids = new Set(nodes.map(n => n.id));
  const live = edges.filter(e => ids.has(e.source) && ids.has(e.target));
  const incoming = new Map<string, Edge[]>();
  for (const e of live) incoming.set(e.target, [...(incoming.get(e.target) || []), e]);

  // Longest path from a root, by repeated relaxation (n is small; a cycle is capped, not looped).
  const layer = new Map<string, number>(nodes.map(n => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const e of live) {
      const want = (layer.get(e.source) || 0) + 1;
      if (want > (layer.get(e.target) || 0) && want < nodes.length) { layer.set(e.target, want); moved = true; }
    }
    if (!moved) break;
  }

  const rows: Node[][] = [];
  for (const n of nodes) (rows[layer.get(n.id)!] ||= []).push(n);

  const anchor = nodes.find(isStart) || nodes[0];
  if (!anchor) return nodes;
  const centreX = anchor.position.x + sizeOf(anchor).w / 2;
  let y = anchor.position.y;

  const placed = new Map<string, { x: number; y: number }>();
  const centreOf = (id: string) => {
    const p = placed.get(id);
    const n = nodes.find(m => m.id === id)!;
    return p ? p.x + sizeOf(n).w / 2 : n.position.x + sizeOf(n).w / 2;
  };
  for (const row of rows) {
    if (!row) continue;
    const key = (n: Node) => {
      const ins = incoming.get(n.id) || [];
      if (!ins.length) return n.position.x;
      const bias = (e: Edge) => (e.sourceHandle === 'true' ? -1 : e.sourceHandle === 'false' ? 1 : 0);
      return ins.reduce((s, e) => s + centreOf(e.source) + bias(e), 0) / ins.length;
    };
    const ordered = [...row].sort((a, b) => key(a) - key(b) || a.position.x - b.position.x);
    const total = ordered.reduce((s, n) => s + sizeOf(n).w, 0) + GAP_X * (ordered.length - 1);
    let x = centreX - total / 2;
    for (const n of ordered) {
      placed.set(n.id, { x: snap(x), y: snap(y) });
      x += sizeOf(n).w + GAP_X;
    }
    y += Math.max(...ordered.map(n => sizeOf(n).h)) + GAP_Y;
  }
  return nodes.map(n => ({ ...n, position: placed.get(n.id) || n.position }));
}
