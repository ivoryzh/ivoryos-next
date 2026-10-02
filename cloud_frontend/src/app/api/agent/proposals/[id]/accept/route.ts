import { NextResponse } from 'next/server';
import { authorize } from '@/lib/auth';
import { acceptProposal } from '@/lib/agent/proposals';

export const dynamic = 'force-dynamic';

/** {save?: boolean, note?} — save (default) writes the graph to the Cloud library; the canvas apply sends save:false. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  // A token (an outside agent) may file and read; accepting is a person's click.
  if (auth.session.agent) return NextResponse.json({ error: 'Only a signed-in person can accept a proposal.' }, { status: 403 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) || {};
  const r = await acceptProposal(id, auth.session.workspace.id, auth.session.user.id, { save: body.save !== false, note: body.note });
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
