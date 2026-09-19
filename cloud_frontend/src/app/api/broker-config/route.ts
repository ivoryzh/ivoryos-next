import { NextResponse } from 'next/server';
import { getStore, resolveBrokerUrl } from '@/lib/store';

export const dynamic = 'force-dynamic';

// The broker the daemon should dial, chosen in /settings instead of an env var.
//
// This route only writes the intent; it never touches MQTT. The daemon is a separate process and
// is the only thing holding a broker connection, so it polls this row and reconnects when it
// changes (see daemon.js's watchBrokerConfig). What actually happened shows up in /api/health,
// which reports the URL the daemon is really connected to — so the UI can tell "saved" apart
// from "connected", which are not the same thing when the host is wrong.
export async function GET() {
  try {
    const stored = await getStore().getBrokerConfig();
    return NextResponse.json({
      host: stored?.host || '',
      port: stored?.port || 1883,
      // What the daemon falls back to with no row set — env vars, then the LAN default.
      fallbackUrl: resolveBrokerUrl(),
      configured: !!stored?.host,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const host = typeof body?.host === 'string' ? body.host.trim() : '';
  const port = Number(body?.port ?? 1883);

  if (!host) {
    return NextResponse.json({ error: 'A broker host is required.' }, { status: 400 });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return NextResponse.json({ error: 'Port must be an integer between 1 and 65535.' }, { status: 400 });
  }

  try {
    await getStore().setBrokerConfig({ host, port });
    // Saved, not connected. The daemon picks this up within ~3s; the caller should watch
    // /api/health to see whether the new host actually accepted the connection.
    return NextResponse.json({ status: 'saved', host, port });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
