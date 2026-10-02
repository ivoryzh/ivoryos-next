import { NextResponse } from 'next/server';
import { authorize } from '@/lib/auth';
import { describeTarget } from '@/lib/agent/describe';
import { loadLabContext, type AgentTarget } from '@/lib/agent/context';

export const dynamic = 'force-dynamic';

// What the model would be told, for the person to see: ?kind=all|platform|device&id=...
export async function GET(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const url = new URL(req.url);
  const kind = (url.searchParams.get('kind') || 'all') as AgentTarget['kind'];
  const target: AgentTarget = { kind, id: url.searchParams.get('id') || undefined };
  const ctx = await loadLabContext(auth.session.workspace.id, target);
  return NextResponse.json(describeTarget(ctx.devices, ctx.sequences, ctx.target));
}
