import { NextResponse } from 'next/server';
import { authorize } from '@/lib/auth';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** ?status=pending|accepted|rejected|all (default pending), ?limit= (default 50). */
export async function GET(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const url = new URL(req.url);
  const status = url.searchParams.get('status') || 'pending';
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
  const proposals = await (getStore() as any).listAgentProposals(auth.session.workspace.id, auth.session.user.id, status, limit);
  return NextResponse.json({ proposals });
}
