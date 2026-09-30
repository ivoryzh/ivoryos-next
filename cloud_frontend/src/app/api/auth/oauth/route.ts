import { NextResponse } from 'next/server';
import { oauthUrl, pkcePair } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const VERIFIER_COOKIE = 'ivoryos_pkce';

/**
 * GET ?provider=github|google[&next=/path]: "Continue with GitHub/Google". PKCE: the verifier stays
 * in a short-lived http-only cookie on this Cloud, so a code intercepted on the way back is useless
 * without it. The IvoryOS account service must allow this Cloud's `/api/auth/callback` as a
 * redirect URL (Supabase Auth -> URL Configuration); without it the browser lands on the Hub
 * instead of coming back here.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider');
  if (provider !== 'github' && provider !== 'google') return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
  const next = url.searchParams.get('next') || '/';
  const { verifier, challenge } = pkcePair();
  const redirectTo = `${url.origin}/api/auth/callback?next=${encodeURIComponent(next.startsWith('/') ? next : '/')}`;
  const res = NextResponse.redirect(oauthUrl(provider, redirectTo, challenge));
  res.cookies.set(VERIFIER_COOKIE, verifier, { httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', path: '/api/auth', maxAge: 600 });
  return res;
}
