import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { ACTIVE_TASK_STATUSES } from '@/lib/dag';

export const dynamic = 'force-dynamic';

// Remove a registered device.
//
// Pairing could create a device but nothing could ever remove one, which bit hardest in exactly
// the case pairing is most likely to half-fail: a device that redeems its code over HTTP and then
// never reaches the broker leaves a permanent row that never goes online. Because a device name
// IS its MQTT client id, /api/pair/new then refuses to re-pair under that name (409), so a failed
// attempt made its own name unusable with no supported way to reclaim it.
//
// NOTE: unauthenticated, like the rest of this API — Cloud has no user accounts yet (see
// AGENTS.md). That is a pre-existing gap this route joins rather than widens, but it is worth
// stating plainly that this one deletes.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const deviceId = decodeURIComponent(id || '').trim();
    if (!deviceId) {
      return NextResponse.json({ error: 'A device id is required.' }, { status: 400 });
    }

    const store = getStore();

    // Removing a device mid-run would strand the run: its tasks stay queued against a device that
    // no longer exists, and nothing would ever advance the graph past them. Refuse instead, the
    // same way /api/pair/new refuses a name collision rather than leaving it to be discovered
    // later as mysteriously stuck hardware.
    const active = await store.countActiveDeviceTasks(deviceId, ACTIVE_TASK_STATUSES);
    if (active > 0) {
      return NextResponse.json({
        error: `"${deviceId}" has ${active} task${active === 1 ? '' : 's'} still running or queued. `
          + 'Let the run finish or cancel it before removing the device.',
      }, { status: 409 });
    }

    const removed = await store.deleteDevice(deviceId);
    if (!removed) {
      return NextResponse.json({ error: `No device named "${deviceId}" is registered.` }, { status: 404 });
    }

    // The device itself is not told anything: there is no cloud->edge "you are unpaired" message,
    // and inventing one here would be a protocol change, not a delete. A device that is still
    // alive will simply re-register itself on its next retained status publish — removing it is
    // how you clear a stale row, not how you revoke a working device. Say so rather than letting
    // a reappearing row look like the delete failed.
    return NextResponse.json({ ok: true, id: deviceId, removed });
  } catch (error: any) {
    console.error('Failed to delete device:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
