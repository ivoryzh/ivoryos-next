import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

const ACTIVE = ['queued', 'running', 'waiting_input'];

// One row per device for the Devices page: is it up, is it busy, what is it running for Cloud
// and how far along, what is waiting for it, and what it last finished. Everything here is what
// devices already report (heartbeat, schema, sequences, task status/progress/results); nothing
// is asked of a device to build it.
export async function GET() {
  try {
    const store = getStore();
    const [devices, sequences, recent, waiting, results, schedules] = await Promise.all([
      store.listDevices(),
      store.listSequences(),
      store.listRecentTasks(500),
      store.listWaitingTasks(),
      store.listTaskResults(200),
      store.listSchedules(),
    ]);

    const runNames = new Map<string, string>();
    const nameOf = async (runId: string) => {
      if (!runNames.has(runId)) runNames.set(runId, (await store.getRun(runId))?.name || runId);
      return runNames.get(runId)!;
    };

    const out = [];
    for (const d of devices as any[]) {
      const mySequences = (sequences as any[]).filter((s) => s.device_id === d.id);
      const current = (recent as any[]).find((t) => t.device_id === d.id && ACTIVE.includes(t.status));
      const last = (results as any[]).find((r) => r.device_id === d.id);
      const nextSchedule = (schedules as any[])
        .filter((s) => s.enabled && s.next_fire_at && (s.tasks || []).some((t: any) => t.device_id === d.id))
        .map((s) => ({ name: s.name, at: s.next_fire_at }))
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] || null;
      out.push({
        id: d.id,
        name: d.name || d.id,
        status: d.status,
        busy: !!d.busy,
        lastSeen: d.last_seen,
        deckVersion: d.schema?.deck_version ?? null,
        instruments: Object.keys(d.schema?.instruments || {}).length,
        optimizers: Object.keys(d.schema?.optimizers || {}).length,
        workflows: mySequences.length,
        brokenWorkflows: mySequences.filter((s) => s.body?.compatibility?.status === 'broken').length,
        current: current ? {
          runId: current.run_id,
          nodeId: current.node_id,
          runName: await nameOf(current.run_id),
          status: current.status,
          progress: current.progress || null,
        } : null,
        waiting: (waiting as any[]).filter((t) => t.device_id === d.id).length,
        lastResult: last ? {
          runId: last.run_id,
          nodeId: last.node_id,
          name: last.name || last.run_name,
          status: last.result_status || last.status,
          at: last.end_time || last.updated_at,
        } : null,
        nextSchedule,
      });
    }
    return NextResponse.json(out);
  } catch (error: any) {
    console.error('Failed to build device overview:', error.message);
    return NextResponse.json([]);
  }
}
