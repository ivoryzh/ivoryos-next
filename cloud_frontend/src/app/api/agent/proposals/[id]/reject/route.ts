import { NextResponse } from 'next/server';
import { authorize } from '@/lib/auth';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  if (auth.session.agent) return NextResponse.json({ error: 'Only a signed-in person can reject a proposal.' }, { status: 403 });
  const { id } = await params;
  const store = getStore() as any;
  const p = await store.getAgentProposal(id);
  if (!p || p.workspace_id !== auth.session.workspace.id || p.user_id !== auth.session.user.id) return NextResponse.json({ error: 'No such proposal.' }, { status: 404 });
  if (p.status !== 'pending') return NextResponse.json({ error: `This proposal was already ${p.status}.` }, { status: 409 });
  const body = (await req.json().catch(() => ({}))) || {};
  await store.decideAgentProposal(id, { status: 'rejected', result: String(body.note || '').slice(0, 4000) });
  return NextResponse.json({ ok: true, status: 'rejected' });
}
