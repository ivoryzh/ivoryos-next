import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// edge_sequences is written by two producers: daemon.js (mirroring whatever each device's local
// Designer already saved, via MQTT) and this route (a sequence authored/edited directly in the
// Cloud edge-sequence page). Both write the same shape — {device_id, name, description, body} —
// so the Library page can list them together regardless of which side created them.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const deviceId = searchParams.get('device_id');

  let query = supabaseAdmin.from('edge_sequences').select('device_id, name, description, body, updated_at, created_at');
  if (deviceId) query = query.eq('device_id', deviceId);

  const { data, error } = await query.order('updated_at', { ascending: false });
  if (error) {
    console.error('Failed to fetch edge sequences from Supabase:', error.message);
    return NextResponse.json([]);
  }
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const deviceId = body?.device_id;
  const name = body?.name;
  if (!deviceId || !name) {
    return NextResponse.json({ error: 'device_id and name are required.' }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from('edge_sequences').upsert({
    device_id: deviceId,
    name,
    description: body.description || '',
    body: body.body || {},
    updated_at: new Date().toISOString(),
  }, { onConflict: 'device_id,name' });

  if (error) {
    console.error('Failed to save edge sequence to Supabase:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ status: 'success' });
}
