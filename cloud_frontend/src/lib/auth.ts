/**
 * Signing in to Cloud with an IvoryOS account.
 *
 * Cloud keeps no users of its own: an account is an IvoryOS account (the Hub's Supabase Auth),
 * registering one here registers it there, and the same account signs in to the Hub, the desktop
 * app and every Cloud, hosted or self-hosted. What Cloud keeps is a *session* (store `sessions`):
 * the IvoryOS tokens, the workspace this browser is working in, and the workspaces it may switch
 * to. The browser holds only the session's random id, in an http-only cookie, so no page script
 * can read a token.
 *
 * Signing in needs the IvoryOS service; staying signed in does not. A self-hosted Cloud on a lab
 * network that loses its internet keeps every session until the session's own expiry -- the
 * tokens are only used to re-read which organizations the person belongs to, and that is skipped
 * (and retried later) while the service cannot be reached.
 *
 * Workspaces: `user:<id>` is the person's own; `org:<id>` is each organization they belong to on
 * the Hub (organization_members). A Hub without organizations yet simply yields the personal one.
 */
import crypto from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';

export const SESSION_COOKIE = 'ivoryos_session';
const SESSION_DAYS = 30;
const WORKSPACES_RECHECK_MS = 10 * 60 * 1000;

// The IvoryOS account service: the Hub's Supabase project. The anon key is public by design (it
// ships in the Hub's own pages). A private deployment of the whole product line would point both
// at its own project.
export const IVORYOS_AUTH = {
  url: (process.env.IVORYOS_AUTH_URL || 'https://eaarfpxmxyhxndlsvgkd.supabase.co').replace(/\/+$/, ''),
  key: process.env.IVORYOS_AUTH_ANON_KEY
    || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhYXJmcHhteHloeG5kbHN2Z2tkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM0MzcwMDEsImV4cCI6MjA3OTAxMzAwMX0.eSD7GpJ5boAxj5z0KaKoehILMUPbzuJBq7ZosJnfMsI',
};

export type Workspace = { id: string; kind: 'personal' | 'org'; name: string; role?: string };
export type SessionUser = { id: string; email: string | null; name: string | null };
export type Session = {
  id: string;
  user: SessionUser;
  workspace: Workspace;
  workspaces: Workspace[];
  /** True for an agent token (src/lib/agent/tokens.ts): read and propose, never accept or run. */
  agent?: boolean;
};

type Tokens = { access_token: string; refresh_token: string; expires_in?: number; expires_at?: number; user?: any };

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function message(body: any, status: number): string {
  const raw = body && (body.msg || body.error_description || body.message || body.error);
  if (/invalid login credentials/i.test(raw || '')) return 'That email and password do not match an IvoryOS account.';
  if (/email not confirmed/i.test(raw || '')) return 'Confirm your email first: open the link we sent you, then sign in.';
  if (/user already registered/i.test(raw || '')) return 'There is already an IvoryOS account with this email. Sign in instead.';
  return raw || `The IvoryOS account service answered ${status}.`;
}

async function authRequest(path: string, { method = 'GET', body, token }: { method?: string; body?: unknown; token?: string } = {}) {
  let res: Response;
  try {
    res = await fetch(`${IVORYOS_AUTH.url}${path}`, {
      method,
      headers: {
        apikey: IVORYOS_AUTH.key,
        Authorization: `Bearer ${token || IVORYOS_AUTH.key}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e: any) {
    throw new AuthError(`Could not reach the IvoryOS account service (${e.message}). Signing in needs it once; staying signed in does not.`, 503);
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new AuthError(message(json, res.status), res.status === 400 ? 401 : res.status);
  return json;
}

export async function passwordSignIn(email: string, password: string): Promise<Tokens> {
  if (!email || !password) throw new AuthError('Enter your email and password.');
  return authRequest('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: email.trim(), password } });
}

/** Registers an IvoryOS account. With email confirmation on, no tokens come back yet. */
export async function signUp(email: string, password: string, name: string, redirectTo: string): Promise<Tokens | null> {
  if (!email || !password) throw new AuthError('Enter an email and a password.');
  if (password.length < 6) throw new AuthError('Use a password of at least 6 characters.');
  const body = await authRequest(`/auth/v1/signup?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: 'POST', body: { email: email.trim(), password, data: name ? { full_name: name.trim() } : {} },
  });
  return body && body.access_token ? body : null;
}

export async function exchangeCode(code: string, verifier: string): Promise<Tokens> {
  return authRequest('/auth/v1/token?grant_type=pkce', { method: 'POST', body: { auth_code: code, code_verifier: verifier } });
}

export async function refreshTokens(refreshToken: string): Promise<Tokens> {
  return authRequest('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken } });
}

export async function fetchUser(accessToken: string) {
  try {
    return await authRequest('/auth/v1/user', { token: accessToken });
  } catch (e) {
    if (e instanceof AuthError && e.status < 500) throw new AuthError('That IvoryOS sign-in is not valid, or has expired. Sign in again.', 401);
    throw e;
  }
}

export function oauthUrl(provider: 'github' | 'google', redirectTo: string, challenge: string) {
  const q = new URLSearchParams({ provider, redirect_to: redirectTo, code_challenge: challenge, code_challenge_method: 's256' });
  return `${IVORYOS_AUTH.url}/auth/v1/authorize?${q}`;
}

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function userOf(raw: any): SessionUser {
  const meta = (raw && raw.user_metadata) || {};
  return { id: raw.id, email: raw.email || null, name: meta.full_name || meta.name || meta.user_name || null };
}

/**
 * The workspaces this account may use: its own, and each organization it belongs to on the Hub.
 * A Hub whose database has no organizations yet (or cannot be reached) yields the personal one.
 */
export async function workspacesFor(user: SessionUser, accessToken: string): Promise<Workspace[]> {
  const personal: Workspace = { id: `user:${user.id}`, kind: 'personal', name: 'Personal' };
  try {
    const rows = await authRequest(
      `/rest/v1/organization_members?select=role,org_id,organizations(name)&user_id=eq.${encodeURIComponent(user.id)}`,
      { token: accessToken },
    );
    const orgs: Workspace[] = (Array.isArray(rows) ? rows : []).map((r: any) => ({
      id: `org:${r.org_id}`, kind: 'org', name: (r.organizations && r.organizations.name) || 'Organization', role: r.role,
    }));
    return [personal, ...orgs];
  } catch {
    return [personal];
  }
}

function expiresAtOf(tokens: Tokens) {
  return tokens.expires_at || Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600);
}

/** Record a signed-in session and give this browser its cookie. */
export async function startSession(tokens: Tokens, { secure }: { secure: boolean }): Promise<Session> {
  const raw = tokens.user || (await fetchUser(tokens.access_token));
  const user = userOf(raw);
  const workspaces = await workspacesFor(user, tokens.access_token);
  const id = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  const store = getStore();
  await store.createSession({
    id, user_id: user.id, email: user.email, name: user.name,
    access_token: tokens.access_token, refresh_token: tokens.refresh_token, token_expires_at: expiresAtOf(tokens),
    workspace_id: workspaces[0].id, workspaces, workspaces_checked_at: new Date().toISOString(), expires_at: expires.toISOString(),
  });
  (await cookies()).set(SESSION_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure, path: '/', expires });
  store.purgeExpiredSessions(new Date().toISOString()).catch(() => {});
  return { id, user, workspace: workspaces[0], workspaces };
}

/** The signed-in session of this request, or null. */
export async function currentSession(): Promise<Session | null> {
  const id = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!id) return null;
  const store = getStore();
  const row = await store.getSession(id);
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;

  let workspaces: Workspace[] = Array.isArray(row.workspaces) ? row.workspaces : [];
  // Organizations change on the Hub; re-read them now and then, never letting an offline account
  // service end or slow down a session for long.
  const checked = row.workspaces_checked_at ? new Date(row.workspaces_checked_at).getTime() : 0;
  if (Date.now() - checked > WORKSPACES_RECHECK_MS && row.refresh_token) {
    try {
      let access = row.access_token;
      const patch: Record<string, unknown> = { workspaces_checked_at: new Date().toISOString() };
      if (!access || Number(row.token_expires_at) - 60 < Date.now() / 1000) {
        const tokens = await refreshTokens(row.refresh_token);
        access = tokens.access_token;
        Object.assign(patch, { access_token: tokens.access_token, refresh_token: tokens.refresh_token, token_expires_at: expiresAtOf(tokens) });
      }
      workspaces = await workspacesFor({ id: row.user_id, email: row.email, name: row.name }, access);
      patch.workspaces = workspaces;
      await store.updateSession(id, patch);
    } catch (e) {
      // Refused (revoked, signed out everywhere): end this session too. Unreachable: keep it.
      if (e instanceof AuthError && e.status >= 400 && e.status < 500) { await store.deleteSession(id); return null; }
    }
  }
  if (!workspaces.length) workspaces = [{ id: `user:${row.user_id}`, kind: 'personal', name: 'Personal' }];
  const workspace = workspaces.find((w) => w.id === row.workspace_id) || workspaces[0];
  return { id, user: { id: row.user_id, email: row.email, name: row.name }, workspace, workspaces };
}

/**
 * For an API route: the session, or the 401 to return. Use as
 *   const auth = await authorize(); if ('response' in auth) return auth.response;
 */
/**
 * An outside agent (an MCP client, a script) has no browser cookie; it sends
 * `Authorization: Bearer ivc_...`, a token minted in Settings that stands for one workspace
 * (src/lib/agent/tokens.ts). The session it yields can read that workspace and file proposals;
 * it cannot switch workspace, and nothing it files runs without a person's click.
 */
async function tokenSession(): Promise<Session | null> {
  const header = (await headers()).get('authorization') || '';
  const m = /^Bearer\s+(ivc_[A-Za-z0-9_-]+)$/.exec(header.trim());
  if (!m) return null;
  const { hashAgentToken } = await import('./agent/tokens');
  const row = await getStore().resolveAgentToken(hashAgentToken(m[1])).catch(() => null);
  if (!row) return null;
  const workspace: Workspace = { id: row.workspace_id, kind: row.workspace_id.startsWith('org:') ? 'org' : 'personal', name: row.label || 'agent' };
  // The agent acts for the person who minted the token: what it files is theirs to accept.
  return { id: `token:${row.token_hash.slice(0, 12)}`, user: { id: row.user_id || 'agent', email: null, name: row.label || 'agent' }, workspace, workspaces: [workspace], agent: true };
}

export async function authorize(): Promise<{ session: Session } | { response: NextResponse }> {
  const session = (await currentSession()) || (await tokenSession());
  if (!session) return { response: NextResponse.json({ error: 'Sign in to Cloud first, or send an agent token as `Authorization: Bearer ivc_...`.' }, { status: 401 }) };
  return { session };
}

export async function switchWorkspace(session: Session, workspaceId: string) {
  if (!session.workspaces.some((w) => w.id === workspaceId)) throw new AuthError('That workspace is not one of yours.', 403);
  await getStore().updateSession(session.id, { workspace_id: workspaceId });
}

export async function endSession() {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (id) await getStore().deleteSession(id).catch(() => {});
  jar.delete(SESSION_COOKIE);
}

export function isSecure(req: Request) {
  return new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
}
