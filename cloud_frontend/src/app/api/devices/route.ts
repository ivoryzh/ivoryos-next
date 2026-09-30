import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { authorize } from '@/lib/auth';
import { ownedKeys } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

// Devices come from the store (written by daemon.js as it consumes each device's retained MQTT
// status/schema topics) — SQLite on a LAN, Supabase in the hosted product.
export async function GET() {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const ws = auth.session.workspace.id;
  try {
    // This workspace's devices only (lib/workspace.ts).
    const mine = await ownedKeys('device', ws);
    const devices = (await getStore().listDevices() as any[]).filter((d) => mine.has(String(d.id)));
    return NextResponse.json(devices);
  } catch (error: any) {
    // Every caller of this route (the orchestrator canvas especially) assumes the response is
    // always an array, so keep that contract even on failure rather than returning an error
    // object a `.map()` downstream can't handle. The reason a failure happened is not lost: it
    // is reported properly by /api/health, which is what the header badge reads. Returning []
    // here *and* having no health check was what made a broken backend look like an empty lab.
    console.error('Failed to fetch devices:', error.message);
    return NextResponse.json([]);
  }
}
