import { NextResponse } from 'next/server';
import { AuthError, isSecure, passwordSignIn, startSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** POST {email, password}: sign in with an IvoryOS account and start a Cloud session. */
export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();
    const tokens = await passwordSignIn(String(email || ''), String(password || ''));
    const session = await startSession(tokens, { secure: isSecure(req) });
    return NextResponse.json({ user: session.user, workspace: session.workspace, workspaces: session.workspaces });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e instanceof AuthError ? e.status : 500 });
  }
}
