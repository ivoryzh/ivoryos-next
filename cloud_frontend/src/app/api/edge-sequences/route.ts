import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

// edge_sequences is written by two producers: daemon.js (mirroring whatever each device's local
// Designer already saved, via MQTT) and this route (a sequence authored/edited directly in the
// Cloud edge-sequence page). Both write the same shape — {device_id, name, description, body} —
// so the Library page can list them together regardless of which side created them.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const deviceId = searchParams.get('device_id');
  try {
    return NextResponse.json(await getStore().listSequences(deviceId || undefined));
  } catch (error: any) {
    console.error('Failed to fetch edge sequences:', error.message);
    return NextResponse.json([]);
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const deviceId = body?.device_id;
  const name = body?.name;
  if (!deviceId || !name) {
    return NextResponse.json({ error: 'device_id and name are required.' }, { status: 400 });
  }

  try {
    const store = getStore();
    await store.upsertSequence({
      device_id: deviceId,
      name,
      description: body.description || '',
      body: body.body || {},
    });

    // Writing Cloud's own copy is not enough, and used to be all this did. The device resolves a
    // workflow against its local WORKFLOWS_DIR, so a sequence that existed only here could never
    // actually run — and worse, editing an existing one was silently reverted the next time the
    // device republished its own copy over the same {device_id, name} key.
    //
    // So queue it for the daemon to push down (this route holds no broker connection). The device
    // remains the owner: it applies the push through its normal save path and echoes the result
    // back, and only that echo marks the push acknowledged.
    await store.enqueueSequencePush({
      device_id: deviceId,
      name,
      body: body.body || {},
      body_hash: body.body?.body_hash || '',
    });

    return NextResponse.json({ status: 'success', push: 'queued' });
  } catch (error: any) {
    console.error('Failed to save edge sequence:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
