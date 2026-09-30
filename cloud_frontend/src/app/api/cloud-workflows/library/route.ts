import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { authorize } from '@/lib/auth';
import { claimAllowed, workflowKey, workflowName } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

// The Library's distributed (multi-device) workflows, shared by everyone who opens this Cloud.
// They used to live in one browser's localStorage, so a workflow saved on one machine simply did
// not exist on another. The Orchestrator's own working canvas stays per browser: that is a draft.
//
//   GET                         -> every saved workflow, newest first
//   PUT {name, description, nodes, edges, created_at?, updated_at?}  -> save (replace by name)

// What the canvas attaches to each node at run time and re-attaches on load: the live device
// list and schemas (tens of KB per node), the last run's status, callbacks. None of it is the
// workflow, and saving it made each stored node carry a stale copy of every device's deck.
const TRANSIENT = ['cloudDevices', 'statusData', 'taskStatus', 'updateNodeData'];

const toMs = (v: any) => (typeof v === 'number' ? v : Date.parse(v || '') || 0);

export async function GET() {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const ws = auth.session.workspace.id;
  try {
    const all = await getStore().listCloudWorkflows() as any[];
    // Stored as `<workspace>/<name>`. One saved before sign-in has no prefix; on a lab's own Cloud
    // it is shown to everyone (and moves into a workspace when saved), never on the hosted one.
    const own = all.flatMap((r) => {
      const name = workflowName(ws, r.name);
      return name === null ? [] : [{ ...r, name }];
    });
    const ownNames = new Set(own.map((r) => r.name));
    const legacy = claimAllowed()
      ? all.filter((r) => !/^(user|org):[^/]+\//.test(r.name) && !ownNames.has(r.name))
      : [];
    const rows = [...own, ...legacy];
    return NextResponse.json(rows.map((r) => ({
      name: r.name,
      description: r.description || '',
      nodes: r.nodes || [],
      edges: r.edges || [],
      created_at: toMs(r.created_at),
      updated_at: toMs(r.updated_at),
    })));
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const ws = auth.session.workspace.id;
  try {
    const body = await req.json();
    const name = String(body.name || '').trim();
    if (!name) return NextResponse.json({ error: 'A workflow needs a name.' }, { status: 400 });
    if (!Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
      return NextResponse.json({ error: 'nodes and edges must be arrays.' }, { status: 400 });
    }
    const nodes = body.nodes.map((n: any) => {
      const data = { ...(n?.data || {}) };
      for (const key of TRANSIENT) delete data[key];
      return { ...n, data };
    });
    const iso = (v: any) => (v ? new Date(toMs(v) || Date.now()).toISOString() : undefined);
    await getStore().upsertCloudWorkflow({
      name: workflowKey(ws, name),
      description: String(body.description || ''),
      nodes,
      edges: body.edges,
      created_at: iso(body.created_at),
      updated_at: iso(body.updated_at) || new Date().toISOString(),
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
