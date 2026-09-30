import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Cloud needs a signed-in session for everything but signing in. This is only the optimistic
 * check Next recommends for a proxy -- is there a session cookie at all -- so a signed-out browser
 * lands on /login instead of on pages that then fail request by request. Whether the session is
 * real, and which workspace's data it may see, is decided by each API route (lib/auth.ts
 * `authorize`, lib/workspace.ts), which read the store; this file never does.
 *
 * Open without a session:
 *   /login, /api/auth/*          signing in
 *   /api/health                  the desktop app checks a Cloud address answers before offering it
 *   /api/pair/start, /api/pair/poll
 *                                called by an edge server: it starts a pairing request, then
 *                                proves itself with the secret it kept (src/lib/pairing.js)
 */
const OPEN = [/^\/login(\/|$)/, /^\/api\/auth\//, /^\/api\/health(\/|$)/, /^\/api\/pair\/(start|poll)(\/|$)/];

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (OPEN.some((re) => re.test(pathname)) || req.cookies.get('ivoryos_session')) return NextResponse.next();
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Sign in to Cloud first.' }, { status: 401 });
  }
  const login = req.nextUrl.clone();
  login.pathname = '/login';
  login.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next's own assets and files with an extension (icons, images).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)'],
};
