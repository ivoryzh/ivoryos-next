import { NextResponse } from 'next/server';
import { AuthError, isSecure, signUp, startSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * POST {email, password, name}: register an IvoryOS account -- the same account the Hub and the
 * desktop app use, not one local to this Cloud. With email confirmation on (the IvoryOS default)
 * the answer is `confirmEmail`: the person opens the link, then signs in.
 */
export async function POST(req: Request) {
  try {
    const { email, password, name } = await req.json();
    const origin = new URL(req.url).origin;
    const tokens = await signUp(String(email || ''), String(password || ''), String(name || ''), `${origin}/login`);
    if (!tokens) return NextResponse.json({ confirmEmail: true, email });
    const session = await startSession(tokens, { secure: isSecure(req) });
    return NextResponse.json({ user: session.user, workspace: session.workspace, workspaces: session.workspaces });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e instanceof AuthError ? e.status : 500 });
  }
}
