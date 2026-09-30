import { NextResponse } from 'next/server';
import { AuthError, fetchUser, isSecure, startSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * POST {refresh_token} with `Authorization: Bearer <access token>`: start a Cloud session from an
 * IvoryOS sign-in the caller already has. This is how the desktop app signs its Cloud tab in: the
 * person is signed in to the app, the app's main process (never a page) sends its tokens here,
 * and puts the session cookie it gets back into the tab. The token is checked with the IvoryOS
 * account service like any sign-in; a forged one is refused there.
 *
 * Answers `{session}` (the cookie value) as well as setting the cookie, because the app sets the
 * cookie in the tab itself rather than receiving it in a browser.
 */
export async function POST(req: Request) {
  try {
    const access = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '')?.[1];
    if (!access) throw new AuthError('Send the IvoryOS access token as a bearer token.', 401);
    const { refresh_token } = await req.json().catch(() => ({}));
    const user = await fetchUser(access);
    const session = await startSession({ access_token: access, refresh_token: String(refresh_token || ''), user }, { secure: isSecure(req) });
    // `workspaces` lets the app ask which one a deck should join before approving its pairing.
    return NextResponse.json({ session: session.id, user: session.user, workspace: session.workspace, workspaces: session.workspaces });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e instanceof AuthError ? e.status : 500 });
  }
}
