import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Pause, resume or delete one schedule.
 *
 * Resuming re-arms `next_fire_at` from *now* rather than restoring the time it was paused at: a
 * schedule paused for two days would otherwise come back already overdue and fire immediately,
 * which is the opposite of what pausing something is for.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const scheduleId = decodeURIComponent(id || '').trim();
    const body = await req.json();
    const store = getStore();

    const schedule: any = await store.getSchedule(scheduleId);
    if (!schedule) return NextResponse.json({ error: 'No such schedule.' }, { status: 404 });

    const enabled = !!body.enabled;
    const everyMs = Number(schedule.every_ms) || 0;
    const nextFireAt = enabled && everyMs > 0
      ? new Date(Date.now() + everyMs).toISOString()
      : (enabled ? schedule.next_fire_at : null);

    await store.setScheduleEnabled(scheduleId, enabled, nextFireAt);
    return NextResponse.json({ id: scheduleId, enabled, nextFireAt });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const removed = await getStore().deleteSchedule(decodeURIComponent(id || '').trim());
    if (!removed) return NextResponse.json({ error: 'No such schedule.' }, { status: 404 });
    // Runs this schedule already started are left alone — they are real runs with real history,
    // and deleting the trigger is not a request to erase what it did.
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
