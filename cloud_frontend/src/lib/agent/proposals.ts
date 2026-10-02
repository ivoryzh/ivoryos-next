import { randomBytes } from 'node:crypto';
import { getStore } from '@/lib/store';
import { checkProposal, summarise } from '@/lib/agent/graphSpec';
import { workflowKey } from '@/lib/workspace';

export type Spec = { name?: string; description?: string; steps: unknown[] };

/** Check a spec against this workspace's devices and file it. Returns the stored row. */
export async function fileProposal(opts: { workspaceId: string; userId: string; spec: Spec; summary?: string; source?: string; questions?: string[]; devices: any[]; sequences: any[] }) {
  const { workspaceId, userId, spec, devices, sequences } = opts;
  const checked = checkProposal(spec, devices, sequences);
  const row = {
    id: `prop_${randomBytes(6).toString('hex')}`,
    workspace_id: workspaceId,
    user_id: userId,
    name: String(spec.name || 'Untitled workflow').slice(0, 255),
    summary: String(opts.summary || '').slice(0, 4000),
    source: String(opts.source || 'agent').slice(0, 128),
    spec: { name: spec.name || 'Untitled workflow', description: spec.description || '', steps: spec.steps },
    graph: checked.graph,
    issues: checked.issues,
    questions: (opts.questions || []).map(String).slice(0, 10),
  };
  await (getStore() as any).insertAgentProposal(row);
  return { ...row, status: 'pending', ok: checked.ok, validation_summary: summarise(checked.issues) };
}

/** Accepting saves the graph to the Cloud library (unless `save` is false: taken onto the canvas only). */
export async function acceptProposal(id: string, workspaceId: string, userId: string, { save = true, note = '' }: { save?: boolean; note?: string }) {
  const store = getStore() as any;
  const p = await store.getAgentProposal(id);
  // Someone else's proposal reads as absent: accepting is personal, and an id reveals nothing.
  if (!p || p.workspace_id !== workspaceId || p.user_id !== userId) return { error: 'No such proposal.', status: 404 as const };
  if (p.status !== 'pending') return { error: `This proposal was already ${p.status}.`, status: 409 as const };
  if (!p.graph) return { error: 'This proposal has problems and could not be turned into a graph; fix them and propose again.', status: 400 as const };
  if (save) {
    await store.upsertCloudWorkflow({ name: workflowKey(workspaceId, p.name), description: p.spec?.description || p.summary || '', nodes: p.graph.nodes, edges: p.graph.edges });
  }
  await store.decideAgentProposal(id, { status: 'accepted', result: note || (save ? `Saved to the library as "${p.name}"` : 'Taken onto the canvas') });
  return { ok: true, name: p.name, saved: save, graph: p.graph };
}
