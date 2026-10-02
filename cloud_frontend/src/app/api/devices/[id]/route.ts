import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { authorize } from '@/lib/auth';
import { isOwned } from '@/lib/workspace';
import { ACTIVE_TASK_STATUSES } from '@/lib/dag';
import { removeDevice } from '@/lib/deviceRemoval';
import { cleanDeviceName } from '@/lib/pairing';
import { deviceNameConflict, nameTakenMessage } from '@/lib/deviceNaming';

export const dynamic = 'force-dynamic';

// Remove a registered device.
//
// Pairing could create a device but nothing could ever remove one, which bit hardest in exactly
// the case pairing is most likely to half-fail: a device that collects its credentials over HTTP
// and then never reaches the broker leaves a permanent row that never goes online. Because a device
// name IS its MQTT client id, approving another pairing under that name is refused (409), so a
// failed attempt made its own name unusable with no supported way to reclaim it.
//
// Only a device of the signed-in workspace (lib/workspace.ts).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const ws = auth.session.workspace.id;
  try {
    const { id } = await params;
    const deviceId = decodeURIComponent(id || '').trim();
    if (!deviceId) {
      return NextResponse.json({ error: 'A device id is required.' }, { status: 400 });
    }

    if (!(await isOwned('device', deviceId, ws))) {
      return NextResponse.json({ error: `No device named "${deviceId}" is registered.` }, { status: 404 });
    }
    const store = getStore();

    // Removing a device mid-run would strand the run: its tasks stay queued against a device that
    // no longer exists, and nothing would ever advance the graph past them. Refuse instead, the
    // same way pairing refuses a name collision rather than leaving it to be discovered
    // later as mysteriously stuck hardware.
    const active = await store.countActiveDeviceTasks(deviceId, ACTIVE_TASK_STATUSES);
    if (active > 0) {
      return NextResponse.json({
        error: `"${deviceId}" has ${active} task${active === 1 ? '' : 's'} still running or queued. `
          + 'Let the run finish or cancel it before removing the device.',
      }, { status: 409 });
    }

    // Remembered as removed, its records deleted, and on AWS its certificates revoked and Thing
    // deleted (deviceRemoval.js). A device still running is told by the daemon to forget its
    // pairing, and is never re-registered from its heartbeat; pairing it again brings it back.
    // Its workflows are kept as a record in this workspace's Library (see deviceRemoval.js).
    const { removed, aws, archived, workflows } = await removeDevice(store, deviceId);
    return NextResponse.json({ ok: true, id: deviceId, removed, aws, archived, workflows });
  } catch (error: any) {
    console.error('Failed to delete device:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * PATCH {name}: rename a device of the signed-in workspace. Only the label changes: the id stays
 * its MQTT identity, so nothing on the device or the broker is touched, and runs, schedules and
 * canvases that name it by id keep working. Names are unique within the workspace
 * (pairing.js nameConflict).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const ws = auth.session.workspace.id;
  const { id } = await params;
  const deviceId = decodeURIComponent(id || '').trim();
  if (!deviceId || !(await isOwned('device', deviceId, ws))) {
    return NextResponse.json({ error: `No device "${deviceId}" is registered.` }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const name = cleanDeviceName(body?.name);
  if (!name) {
    return NextResponse.json({ error: 'Give the device a name of up to 64 characters, without / + or #.' }, { status: 400 });
  }
  if (await deviceNameConflict(ws, name, deviceId)) {
    return NextResponse.json({ error: nameTakenMessage(name), field: 'name' }, { status: 409 });
  }
  if (!(await getStore().renameDevice(deviceId, name))) {
    return NextResponse.json({ error: `No device "${deviceId}" is registered.` }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id: deviceId, name });
}
