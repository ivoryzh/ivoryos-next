import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { exchangeCode, isSecure, startSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Where "Continue with GitHub/Google" comes back: trade the code for a session. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') || '/';
  const jar = await cookies();
  const verifier = jar.get('ivoryos_pkce')?.value;
  const back = (error: string) => NextResponse.redirect(`${url.origin}/login?error=${encodeURIComponent(error)}`);
  if (!code || !verifier) return back(url.searchParams.get('error_description') || 'The sign-in did not come back complete. Try again.');
  try {
    const tokens = await exchangeCode(code, verifier);
    await startSession(tokens, { secure: isSecure(req) });
    jar.delete('ivoryos_pkce');
    return NextResponse.redirect(`${url.origin}${next.startsWith('/') ? next : '/'}`);
  } catch (e: any) {
    return back(e.message);
  }
}
