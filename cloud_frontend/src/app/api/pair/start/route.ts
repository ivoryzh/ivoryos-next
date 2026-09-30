import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { rateLimiter, callerOf } from '@/lib/rateLimit';
import {
  generateCode, generateSecret, hashSecret, formatCode, expiryFrom, cleanDeviceName, cleanInstruments,
  cleanDeviceId, generateDeviceId, POLL_INTERVAL_S, TTL_MS,
} from '@/lib/pairing';

export const dynamic = 'force-dynamic';

// Starting a request costs nothing and grants nothing (it waits for a signed-in person), but each
// one is a row, so a caller cannot start them without limit.
const limited = rateLimiter(10);

/** This Cloud's address as the edge reached it, for the link it shows beside the code. */
function publicOrigin(req: Request) {
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  const host = req.headers.get('x-forwarded-host')?.split(',')[0].trim() || req.headers.get('host');
  if (host) return `${proto || new URL(req.url).protocol.replace(':', '')}://${host}`;
  return new URL(req.url).origin;
}

/**
 * Called by an edge server (open: the edge has no account). Answers the code the edge shows, and
 * the secret it keeps and polls with. See src/lib/pairing.js for the whole flow.
 */
export async function POST(req: Request) {
  if (limited(callerOf(req))) {
    return NextResponse.json({ error: 'Too many pairing requests. Wait a minute and try again.' }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const deviceName = cleanDeviceName(body?.name) || 'edge-device';
  const instruments = cleanInstruments(body?.instruments);
  // The device's own lasting id, so pairing it again reattaches it. An edge too old to send one
  // gets one here (it then keeps whatever its token names, see the edge's ensure_device_id).
  const requestedId = cleanDeviceId(body?.device_id) || generateDeviceId(deviceName);

  try {
    const store = getStore();
    // No scheduler here, so the cheapest place to sweep old requests is where they are made.
    await store.purgeExpiredPairingRequests(new Date().toISOString());

    const secret = generateSecret();
    const expiresAt = expiryFrom();
    let code = '';
    for (let attempt = 0; attempt < 3 && !code; attempt++) {
      const candidate = generateCode();
      try {
        await store.createPairingRequest({ code: candidate, secretHash: hashSecret(secret), requestedId, deviceName, instruments, expiresAt });
        code = candidate;
      } catch (e) {
        if (attempt === 2) throw e; // a live code collided three times: something else is wrong
      }
    }
    const shown = formatCode(code);
    return NextResponse.json({
      code: shown,
      secret,
      expiresAt,
      expiresInMs: TTL_MS,
      interval: POLL_INTERVAL_S,
      approveUrl: `${publicOrigin(req)}/pair?code=${encodeURIComponent(shown)}`,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Could not start pairing.' }, { status: 500 });
  }
}
