import { NextResponse } from 'next/server';
import { getStore, resolveMode } from '@/lib/store';
import { normalizeCode, CODE_LENGTH } from '@/lib/pairing';
import { provisionDevice } from '@/lib/aws-iot';

export const dynamic = 'force-dynamic';

// Called by the *edge server* (server-to-server, not from a browser — so no CORS, and the token
// never passes through anyone's clipboard or page). Exchanges a valid pairing code for the
// device's full connection config, then marks the code used.
//
// This is the only place a device identity is minted. On AWS that means a Thing plus a
// certificate, and the private key is returned here, once, over TLS, straight to the device that
// will use it — replacing a flow that asked a person to carry that key between machines by hand.

// Guessing an 8-character code (~8.5e11 possibilities) inside its 10-minute life needs an
// enormous number of attempts, which is only true if attempts are actually limited. In-memory and
// therefore per-instance: adequate for a single-process LAN deployment and for a single Next
// server, NOT a substitute for a shared rate limiter once Cloud runs more than one instance.
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS_PER_WINDOW;
}

/**
 * The broker address to hand the device, which is not necessarily the one this Cloud uses itself.
 *
 * In cloud mode it is fixed — AWS_IOT_ENDPOINT, the same for every device, nothing to infer.
 *
 * In LAN mode the daemon may well be talking to 127.0.0.1, which is meaningless on another
 * machine. But the device just told us a working address for free: whatever host it used to reach
 * this route is, by construction, an address that resolves from where the device is. So derive it
 * from the request rather than asking anyone to configure it.
 */
function brokerForDevice(req: Request, storedHost: string | undefined, storedPort: number) {
  if (process.env.AWS_IOT_ENDPOINT) {
    return { protocol: 'aws_iot' as const, endpoint: process.env.AWS_IOT_ENDPOINT, port: 8883 };
  }

  const configured = (storedHost || '').trim();
  const isLoopback = !configured
    || configured === '127.0.0.1'
    || configured === 'localhost'
    || configured === '::1';

  let endpoint = configured;
  if (isLoopback) {
    // Host header minus the port; it is the address the device successfully connected to.
    const host = (req.headers.get('host') || '').split(':')[0];
    endpoint = host && host !== 'localhost' && host !== '127.0.0.1' ? host : '127.0.0.1';
  }
  return { protocol: 'mqtt' as const, endpoint, port: storedPort || 1883 };
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const code = normalizeCode(body?.code);

  // Rate limit on the caller, before touching the store, so a guessing loop is cheap to refuse.
  const caller = req.headers.get('x-forwarded-for') || 'local';
  if (rateLimited(caller)) {
    return NextResponse.json(
      { error: 'Too many pairing attempts. Wait a minute and try again.' },
      { status: 429 },
    );
  }

  if (code.length !== CODE_LENGTH) {
    return NextResponse.json({ error: 'That pairing code is not valid.' }, { status: 400 });
  }

  try {
    const store = getStore();

    // One conditional update does the existence, expiry and single-use checks together. Doing it
    // as read-then-write would let two devices redeem the same code concurrently and mint two
    // identities from one credential.
    const claimed = await store.claimPairingCode(code, new Date().toISOString());
    if (!claimed) {
      // Deliberately one message for "wrong", "already used" and "expired": distinguishing them
      // tells someone guessing codes which of their guesses exist.
      return NextResponse.json(
        { error: 'That pairing code is not valid, has expired, or has already been used.' },
        { status: 400 },
      );
    }

    const record = await store.getPairingCode(code);
    const deviceName = record?.device_name || 'edge-device';
    const topicPrefix = process.env.MQTT_TOPIC_PREFIX || 'ivoryos/edge';
    const brokerCfg = await store.getBrokerConfig();
    const broker = brokerForDevice(req, brokerCfg?.host, brokerCfg?.port || 1883);

    let token: any;
    let deviceId: string;

    if (broker.protocol === 'aws_iot') {
      // Mints a real Thing + certificate. Only reachable with a valid code now, which is the
      // point: this is the expensive, billable half of pairing.
      const provisioned = await provisionDevice(deviceName);
      deviceId = provisioned.thingName;
      // provisionDevice already returns a ready-to-use base64 token containing the certs.
      token = provisioned.token;
    } else {
      deviceId = deviceName;
      await store.upsertDevicePlaceholder(deviceId, deviceName);
      token = Buffer.from(JSON.stringify({
        protocol: 'mqtt',
        endpoint: broker.endpoint,
        port: broker.port,
        client_id: deviceId,
        topic_prefix: topicPrefix,
      })).toString('base64');
    }

    await store.finishPairingCode(code, deviceId, 'redeemed');

    return NextResponse.json({
      token,
      deviceId,
      mode: resolveMode(),
      broker: `${broker.protocol === 'aws_iot' ? 'mqtts' : 'mqtt'}://${broker.endpoint}:${broker.port}`,
    });
  } catch (error: any) {
    // Release the claim so a failed provision does not burn the person's code — they can retry
    // with the same one rather than going back to Cloud for a new one.
    try { await getStore().finishPairingCode(code, null, 'pending'); } catch { /* best effort */ }
    return NextResponse.json({ error: error.message || 'Pairing failed.' }, { status: 500 });
  }
}
