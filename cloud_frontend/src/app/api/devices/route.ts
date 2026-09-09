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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}
