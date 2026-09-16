import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// Devices now come from Supabase (written by daemon.js as it consumes each device's retained
// MQTT status/schema topics) rather than orchestrator.ts's in-memory Map, which nothing writes to
// anymore now that the HTTP heartbeat polling endpoint is gone — see AGENTS.md's Cloud section.
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('devices')
    .select('id, name, status, last_seen, schema')
    .order('last_seen', { ascending: false });

  if (error) {
    // Every caller of this route (the orchestrator canvas especially) assumes the response is
    // always an array — that was true of the old in-memory getDevices() this replaced, which
    // could never fail. Keep that contract even on failure (e.g. Supabase not configured yet)
    // rather than returning an error object a `.map()` call downstream can't handle; log
    // server-side instead of changing the response shape.
    console.error('Failed to fetch devices from Supabase:', error.message);
    return NextResponse.json([]);
  }
  return NextResponse.json(data);
}
