import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { authorize } from '@/lib/auth';
import { isOwned } from '@/lib/workspace';
import { ACTIVE_TASK_STATUSES } from '@/lib/dag';
import { removeDevice } from '@/lib/deviceRemoval';

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
    const { removed, aws } = await removeDevice(store, deviceId);
    return NextResponse.json({ ok: true, id: deviceId, removed, aws });
  } catch (error: any) {
    console.error('Failed to delete device:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
