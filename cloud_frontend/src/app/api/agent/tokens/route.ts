import { NextResponse } from 'next/server';
import { authorize } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { hashAgentToken, mintAgentToken } from '@/lib/agent/tokens';

export const dynamic = 'force-dynamic';

const person = (auth: any) => !auth.session.agent;

/** The workspace's agent tokens, by label; the token itself is never shown again after minting. */
export async function GET() {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const rows = await (getStore() as any).listAgentTokens(auth.session.workspace.id);
  return NextResponse.json({ tokens: rows.map((r: any) => ({ id: r.token_hash.slice(0, 12), label: r.label, created_at: r.created_at, last_used_at: r.last_used_at })) });
}

/** {label} -> {token}: shown once. A token stands for this workspace only. */
export async function POST(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  if (!person(auth)) return NextResponse.json({ error: 'Only a signed-in person can mint tokens.' }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) || {};
  const token = mintAgentToken();
  await (getStore() as any).createAgentToken({ token_hash: hashAgentToken(token), workspace_id: auth.session.workspace.id, user_id: auth.session.user.id, label: String(body.label || 'MCP client').slice(0, 80) });
  return NextResponse.json({ token, id: hashAgentToken(token).slice(0, 12) });
}

/** ?id=<first 12 of the hash> */
export async function DELETE(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  if (!person(auth)) return NextResponse.json({ error: 'Only a signed-in person can revoke tokens.' }, { status: 403 });
  const id = new URL(req.url).searchParams.get('id') || '';
  const store = getStore() as any;
  const row = (await store.listAgentTokens(auth.session.workspace.id)).find((r: any) => r.token_hash.startsWith(id) && id.length >= 8);
  if (!row) return NextResponse.json({ error: 'No such token.' }, { status: 404 });
  await store.deleteAgentToken(row.token_hash, auth.session.workspace.id);
  return NextResponse.json({ ok: true });
}
