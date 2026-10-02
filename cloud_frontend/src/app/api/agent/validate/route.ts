import { NextResponse } from 'next/server';
import { authorize } from '@/lib/auth';
import { checkProposal, summarise } from '@/lib/agent/graphSpec';
import { loadLabContext } from '@/lib/agent/context';

export const dynamic = 'force-dynamic';

/** Check a graph spec against this workspace's devices: {ok, summary, issues}. Files nothing. */
export async function POST(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const data = await req.json().catch(() => null);
  if (!data || typeof data !== 'object') return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  const spec = data.spec && typeof data.spec === 'object' ? data.spec : data;
  const ctx = await loadLabContext(auth.session.workspace.id, { kind: 'all' });
  const { issues, ok } = checkProposal(spec, ctx.devices, ctx.sequences);
  return NextResponse.json({ ok, summary: summarise(issues), issues });
}
