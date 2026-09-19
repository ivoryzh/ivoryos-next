import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { generateCode, formatCode, expiryFrom, TTL_MS } from '@/lib/pairing';

export const dynamic = 'force-dynamic';

// Mint a pairing code for a new device. The code is shown in /settings and typed into the edge
// server's Cloud Connect page; nothing is provisioned until it is redeemed.
//
// NOTE: like /api/devices/provision before it, this endpoint has no auth — Cloud has no user
// accounts yet (see AGENTS.md). Pairing narrows the exposure rather than closing it: minting a
// code is now a separate, harmless step, and the expensive part (an AWS IoT Thing plus
// certificate) requires possessing an unexpired, unredeemed code. Real auth is still needed
// before any public deployment.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const deviceName = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : 'edge-device';

    const store = getStore();

    // A device name IS the MQTT client id. Two clients connecting with the same id do not
    // coexist — the broker kicks the older one off, it reconnects, kicks the newer one off, and
    // the pair sit in a disconnect loop that looks like flaky hardware. So a collision is refused
    // here rather than being left to discover in the field. `force` exists for deliberately
    // re-pairing the same physical device (certificate rotation, reinstall); nothing in the UI
    // sets it yet.
    if (!body.force) {
      const existing = await store.listDevices();
      if (existing.some((d: any) => String(d.id) === deviceName)) {
        return NextResponse.json({
          error: `A device named "${deviceName}" is already registered. Device names are MQTT client ids and must be unique — two devices sharing one id disconnect each other in a loop.`,
        }, { status: 409 });
      }
    }
    // Opportunistic cleanup — codes are short-lived and there is no scheduler here, so the
    // cheapest place to sweep them is the only route that creates them.
    await store.purgeExpiredPairingCodes(new Date().toISOString());

    const code = generateCode();
    const expiresAt = expiryFrom();
    await store.createPairingCode({ code, deviceName, expiresAt });

    return NextResponse.json({
      code: formatCode(code),
      deviceName,
      expiresAt,
      expiresInMs: TTL_MS,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
