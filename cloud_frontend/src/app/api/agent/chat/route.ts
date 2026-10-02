import { authorize } from '@/lib/auth';
import { buildProvider, ProviderError } from '@/lib/agent/providers';
import { readAgentSettings } from '@/lib/agent/settingsStore';
import { translate, specFromGraph } from '@/lib/agent/chat';
import { loadLabContext, type AgentTarget } from '@/lib/agent/context';
import { getStore } from '@/lib/store';
import { randomBytes } from 'node:crypto';

export const dynamic = 'force-dynamic';

/**
 * Prose in, proposal out, as server-sent events: the loop's phases as they happen (reading the
 * lab, drafting, validating, fixing), then one `filed` event with the result, or `error`.
 * Body: {message, target: {kind, id?}, history?: [{role, content}], existing?: {name, nodes, edges}}.
 * Nothing is saved or dispatched here: the result is shown to a person, who puts it on the canvas.
 */
export async function POST(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const data = await req.json().catch(() => null);
  if (!data || typeof data !== 'object') return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  const message = String(data.message || '').trim();
  if (!message) return Response.json({ error: 'Say what the workflow should do.' }, { status: 400 });
  const target: AgentTarget = data.target && typeof data.target === 'object' ? { kind: data.target.kind || 'all', id: data.target.id } : { kind: 'all' };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        const settings = await readAgentSettings();
        const provider = buildProvider(settings);
        const ctx = await loadLabContext(auth.session.workspace.id, target);
        const existing = data.existing && Array.isArray(data.existing.nodes) && data.existing.nodes.some((n: any) => n?.data?.block?.method !== 'Start')
          ? { name: data.existing.name, spec: specFromGraph(data.existing.nodes, data.existing.edges || []) }
          : null;
        const { result, transcript } = await translate(provider, message, { ...ctx, history: Array.isArray(data.history) ? data.history : [], existing }, send);
        // Filed like any other proposal, so the inbox, accept and reject paths are the same whether
        // the model sat in this panel or behind an MCP client.
        const proposalId = `prop_${randomBytes(6).toString('hex')}`;
        await (getStore() as any).insertAgentProposal({
          id: proposalId, workspace_id: auth.session.workspace.id, user_id: auth.session.user.id, name: result.spec.name, summary: result.summary,
          source: `panel:${provider.name}/${provider.model}`, spec: result.spec, graph: result.graph, issues: result.issues, questions: result.questions,
        }).catch(() => {});
        send({
          phase: 'filed',
          ...result,
          proposal_id: proposalId,
          model: `${provider.name}/${provider.model}`,
          raw: result.ok ? null : String(transcript[transcript.length - 1]?.raw || '').slice(0, 4000),
        });
      } catch (e: any) {
        send({ phase: 'error', error: e instanceof ProviderError ? e.message : `The model call failed: ${e.message}` });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
}
