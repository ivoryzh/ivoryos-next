import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { authorize } from '@/lib/auth';
import { isOwned, ownedKeys } from '@/lib/workspace';
import { isArchivedId } from '@/lib/deviceRemoval';

export const dynamic = 'force-dynamic';

// edge_sequences is written by two producers: daemon.js (mirroring whatever each device's local
// Designer already saved, via MQTT) and this route (a sequence authored/edited directly in the
// Cloud edge-sequence page). Both write the same shape — {device_id, name, description, body} —
// so the Library page can list them together regardless of which side created them.
export async function GET(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const ws = auth.session.workspace.id;
  const { searchParams } = new URL(req.url);
  const deviceId = searchParams.get('device_id');
  try {
    // The workflows of this workspace's devices only.
    const mine = await ownedKeys('device', ws);
    if (deviceId && !mine.has(deviceId)) return NextResponse.json([]);
    const rows = await getStore().listSequences(deviceId || undefined) as any[];
    return NextResponse.json(rows.filter((r) => mine.has(String(r.device_id))));
  } catch (error: any) {
    console.error('Failed to fetch edge sequences:', error.message);
    return NextResponse.json([]);
  }
}

export async function POST(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const ws = auth.session.workspace.id;
  const body = await req.json().catch(() => null);
  const deviceId = body?.device_id;
  const name = body?.name;
  if (!deviceId || !name) {
    return NextResponse.json({ error: 'device_id and name are required.' }, { status: 400 });
  }

  if (!(await isOwned('device', String(deviceId), ws))) {
    return NextResponse.json({ error: 'No such device.' }, { status: 404 });
  }
  if (isArchivedId(deviceId)) {
    return NextResponse.json(
      { error: 'This device was removed from Cloud. Its workflows are kept as a record and cannot be changed.' },
      { status: 409 },
    );
  }
  // Sending the workflow to its device is a choice (`push`, default yes). Kept in Cloud only, it
  // is marked so: the device's version of the same name does not replace it (daemon.js), and a
  // run cannot use it until it is sent, since the device would run its own version.
  const push = body.push !== false;
  const content = { ...(body.body || {}) } as Record<string, any>;
  delete content.cloud_only;

  try {
    const store = getStore();
    await store.upsertSequence({
      device_id: deviceId,
      name,
      description: body.description || '',
      body: push ? content : { ...content, cloud_only: true },
    });
    if (!push) return NextResponse.json({ status: 'success', push: 'not sent' });

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
      body: content,
      body_hash: content.body_hash || '',
    });

    return NextResponse.json({ status: 'success', push: 'queued' });
  } catch (error: any) {
    console.error('Failed to save edge sequence:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
