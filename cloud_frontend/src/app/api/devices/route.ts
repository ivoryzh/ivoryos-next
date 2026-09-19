import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

// Devices come from the store (written by daemon.js as it consumes each device's retained MQTT
// status/schema topics) — SQLite on a LAN, Supabase in the hosted product.
export async function GET() {
  try {
    const devices = await getStore().listDevices();
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
