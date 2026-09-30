import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { rateLimiter, callerOf } from '@/lib/rateLimit';
import { hashSecret, pollOutcome, generateDeviceId } from '@/lib/pairing';
import { issueDeviceCredentials } from '@/lib/provision';

export const dynamic = 'force-dynamic';

// An edge polls every few seconds (pairing.js POLL_INTERVAL_S); this leaves room for several
// edges behind one address while still refusing a loop.
const limited = rateLimiter(60);

const MESSAGES: Record<string, string> = {
  unknown: 'This pairing request is not known to Cloud. Start pairing again.',
  denied: 'Pairing was declined on Cloud.',
  expired: 'The pairing code expired before it was approved. Start pairing again.',
  used: 'This pairing request was already completed.',
};

/**
 * Called by the edge that started the request, with the secret only it holds (open: the secret is
 * the proof). Answers `{status: 'waiting'}` until a person approves, then the device's credentials
 * exactly once. Every other outcome is final and says why.
 */
export async function POST(req: Request) {
  if (limited(callerOf(req))) {
    return NextResponse.json({ status: 'waiting', error: 'Polling too fast.' }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  if (typeof body?.secret !== 'string' || body.secret.length < 20) {
    return NextResponse.json({ status: 'unknown', error: MESSAGES.unknown }, { status: 400 });
  }
  const secretHash = hashSecret(body.secret);
  const store = getStore();
  const now = new Date().toISOString();

  const row = await store.getPairingRequestBySecret(secretHash);
  const outcome = pollOutcome(row);
  if (outcome === 'waiting') return NextResponse.json({ status: 'waiting', expiresAt: row.expires_at });
  if (outcome !== 'approved') {
    return NextResponse.json({ status: outcome, error: MESSAGES[outcome] }, { status: outcome === 'unknown' ? 404 : 410 });
  }

  // One conditional update: of two polls arriving together, one mints the identity and the other
  // is told to keep waiting (and then finds it used).
  if (!(await store.claimPairingRequest(secretHash, now))) {
    return NextResponse.json({ status: 'waiting' });
  }
  try {
    // The device's own lasting id (a request from before ids existed gets one now), so a device
    // paired again is the same record, not a second one.
    const deviceId = row.requested_id || generateDeviceId(row.device_name);
    const issued = await issueDeviceCredentials(req, deviceId, row.device_name || deviceId);
    // Paired again after being removed: it may register itself once more.
    await store.clearDeviceRemoved(issued.deviceId);
    // The workspace the person approved it into (pair/request) becomes the device's.
    const workspace = await store.getOwner('pairing', row.code);
    if (workspace) await store.setOwner('device', issued.deviceId, workspace);
    await store.finishPairingRequest(row.code, issued.deviceId, 'redeemed');
    return NextResponse.json({ status: 'approved', ...issued });
  } catch (error: any) {
    // Put it back, so the edge's next poll retries instead of the person having to start over.
    try { await store.finishPairingRequest(row.code, null, 'approved'); } catch { /* best effort */ }
    return NextResponse.json({ status: 'waiting', error: error.message || 'Could not issue credentials.' }, { status: 500 });
  }
}
