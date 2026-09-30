import { NextResponse } from 'next/server';
import { AuthError, authorize, switchWorkspace } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** POST {id}: work in another of this person's workspaces (their own, or one of their orgs). */
export async function POST(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await req.json();
    await switchWorkspace(auth.session, String(id || ''));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e instanceof AuthError ? e.status : 500 });
  }
}
