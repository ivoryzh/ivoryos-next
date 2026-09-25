/**
 * The Orchestrator's counterpart of shared-ui's `workflowSignature`: a fingerprint of what a
 * graph *is*, so the canvas can tell "edited since it was last saved" from "just reloaded".
 *
 * Kept to content, like the edge Designer's: which steps, on which device, with which values and
 * run settings, wired how. Everything the canvas writes onto a node while merely showing it is
 * left out -- position, selection, measured size, collapse, the last run's status, the device list
 * and schema snapshot -- or reopening a saved graph, or watching it run, would read as an edit.
 */

import type { Edge, Node } from '@xyflow/react';

export function graphSignature(nodes: Node[], edges: Edge[], name: string, description: string): string {
  const content = [...(nodes || [])]
    .map((n) => {
      const data = (n.data as any) || {};
      const block = data.block || {};
      return {
        id: String(n.id),
        instrument: block.instrument || '',
        method: block.method || '',
        params: block.params || {},
        returnVar: block.returnVar || '',
        refMode: block.ref?.mode || '',
        device: data.targetDeviceId || '',
        config: data.config || {},
        runConfig: data.runConfig || {},
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const wiring = (edges || [])
    .map((e) => `${e.source}>${e.target}:${e.sourceHandle || ''}`)
    .sort();
  return JSON.stringify({ name: name || '', description: description || '', content, wiring });
}

/** A canvas holding only the seeded Start node, which is what "New" produces. */
export const isEmptyGraph = (nodes: Node[], edges: Edge[]) =>
  (edges || []).length === 0 && (nodes || []).every((n) => (n.data as any)?.block?.method === 'Start');

/**
 * Whether the canvas as persisted in localStorage (`cloud_workflow`) has changes its last
 * save/load did not. Read by the Library before it replaces the canvas, so loading another graph
 * cannot silently discard work.
 */
export function storedCanvasIsUnsaved(): boolean {
  try {
    const raw = localStorage.getItem('cloud_workflow');
    if (!raw) return false;
    const w = JSON.parse(raw);
    const nodes = w.nodes || [];
    const edges = w.edges || [];
    const sig = graphSignature(nodes, edges, w.name || '', w.description || '');
    if (typeof w.savedSignature === 'string') return sig !== w.savedSignature;
    // Persisted before signatures existed: only a canvas with something on it can be losing work.
    return !isEmptyGraph(nodes, edges);
  } catch {
    return false;
  }
}
