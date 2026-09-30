import { NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** GET: who is signed in, the workspace they are working in, and the ones they can switch to. */
export async function GET() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ signedIn: false }, { status: 401 });
  return NextResponse.json({ signedIn: true, user: session.user, workspace: session.workspace, workspaces: session.workspaces });
}
