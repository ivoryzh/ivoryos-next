import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { authorize } from '@/lib/auth';
import { claimAllowed, setOwner } from '@/lib/workspace';
import { rateLimiter } from '@/lib/rateLimit';
import { normalizeCode, formatCode, expiryFrom, cleanDeviceName, identityDecision, pollOutcome, CODE_LENGTH } from '@/lib/pairing';
import type { Session } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// A signed-in person typing codes. Generous for typos, far too slow to search ~1e12 codes.
const limited = rateLimiter(20);

// One message for "no such code", "expired" and "already answered": telling them apart would say
// which guesses exist.
const NOT_FOUND = 'No device is waiting with that code. Check it, or start pairing again on the device.';

/** A waiting request, as the approval screen shows it; null for anything else. */
async function waitingRequest(input: unknown) {
  const code = normalizeCode(input);
  if (code.length !== CODE_LENGTH) return null;
  const row = await getStore().getPairingRequest(code);
  return row && row.status === 'waiting' && pollOutcome(row) === 'waiting' ? row : null;
}

/**
 * Whether Cloud already knows the device asking (by its lasting id, pairing.js identityDecision):
 * new, the same device coming back to one of this person's workspaces, or someone else's.
 */
async function identityOf(row: any, session: Session) {
  const id: string | null = row.requested_id || null;
  if (!id) return { id, decision: 'new' as const, known: null };
  const store = getStore();
  const device = (await store.listDevices()).find((d: { id: string }) => d.id === id) || null;
  const owner = device ? await store.getOwner('device', id) : null;
  const decision = identityDecision({
    exists: !!device, owner, workspaces: session.workspaces.map((w) => w.id), claimable: claimAllowed(),
  });
  // Someone else's device: say only that it cannot be approved here, not its name or workspace.
  return { id, decision, known: device && decision !== 'foreign' ? { name: device.name || id, workspace: owner } : null };
}

const FOREIGN = 'This device is already in a workspace you are not in. Someone in that workspace has to remove it from Cloud first.';

/** GET ?code=XXXX-XXXX: what is asking to join, so the person can recognise it before approving. */
export async function GET(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  if (limited(`s:${auth.session.id}`)) return NextResponse.json({ error: 'Too many attempts. Wait a minute.' }, { status: 429 });

  const row = await waitingRequest(new URL(req.url).searchParams.get('code'));
  if (!row) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  const identity = await identityOf(row, auth.session);
  return NextResponse.json({
    code: formatCode(row.code),
    name: row.device_name,
    instruments: row.instruments || [],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deviceId: identity.id,
    // 'reattach': "this is <known.name>, paired before; approving reconnects it" (its workspace
    // preselected); 'foreign': it cannot be approved from here.
    identity: identity.decision,
    known: identity.known,
  });
}

/**
 * POST {code, decision: 'approve' | 'deny', name?, workspace?}
 *
 * Approving places the device in `workspace` (one of this session's; default the current one) and
 * lets the edge collect its credentials on its next poll. A device Cloud already knows is
 * reattached (same record, history and id). Denying ends the request; the edge is told.
 */
export async function POST(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  if (limited(`s:${auth.session.id}`)) return NextResponse.json({ error: 'Too many attempts. Wait a minute.' }, { status: 429 });

  const body = await req.json().catch(() => ({}));
  const row = await waitingRequest(body?.code);
  if (!row) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  const store = getStore();
  const now = new Date().toISOString();

  if (body.decision === 'deny') {
    await store.denyPairingRequest(row.code, now);
    return NextResponse.json({ status: 'denied' });
  }
  if (body.decision !== 'approve') {
    return NextResponse.json({ error: "decision must be 'approve' or 'deny'." }, { status: 400 });
  }

  const workspace = body.workspace ? String(body.workspace) : auth.session.workspace.id;
  if (!auth.session.workspaces.some((w) => w.id === workspace)) {
    return NextResponse.json({ error: 'That workspace is not one of yours.' }, { status: 403 });
  }
  const name = body.name === undefined ? row.device_name : cleanDeviceName(body.name);
  if (!name) {
    return NextResponse.json({ error: 'Give the device a name of up to 64 characters, without / + or #.' }, { status: 400 });
  }

  // Names are labels and may repeat; identity is the device's lasting id. Approving someone
  // else's device would hand over its connection and tasks, so that alone is refused.
  if ((await identityOf(row, auth.session)).decision === 'foreign') {
    return NextResponse.json({ error: FOREIGN, identity: 'foreign' }, { status: 409 });
  }

  await setOwner('pairing', row.code, workspace);
  if (!(await store.approvePairingRequest(row.code, name, now, expiryFrom()))) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  const ws = auth.session.workspaces.find((w) => w.id === workspace);
  return NextResponse.json({ status: 'approved', name, workspace: { id: workspace, name: ws?.name || workspace } });
}
