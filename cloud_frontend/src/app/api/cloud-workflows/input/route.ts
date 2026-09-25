import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { CLOUD_DEVICE_ID } from '@/lib/dag';

// Answers a Cloud User_Input step -- the human in the loop of a distributed run. This only records
// the answer; daemon.js completes the step on its next sweep (about a second), so the daemon stays
// the one process that advances a run and nothing here needs to know the graph.
export async function POST(req: Request) {
  try {
    const { runId, nodeId, value } = await req.json();
    if (!runId || !nodeId) {
      return NextResponse.json({ error: 'runId and nodeId are required.' }, { status: 400 });
    }
    const store = getStore();
    const task = (await store.listRunTasks(String(runId)) as any[])
      .find((t: any) => String(t.node_id) === String(nodeId));
    const current = task?.progress && typeof task.progress === 'object' ? task.progress : {};
    const answered = await store.answerTaskInput(String(runId), String(nodeId), CLOUD_DEVICE_ID, {
      ...current,
      state: 'answered',
      answer: value === undefined || value === null ? '' : String(value),
      answered_at: new Date().toISOString(),
    });
    if (!answered) {
      // Already answered, never asked, or the run has moved on: the same reply for all three.
      return NextResponse.json({ error: 'That step is not waiting for an answer.' }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
