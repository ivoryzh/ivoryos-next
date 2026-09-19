import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

// run_tasks is the shared state the Orchestrator canvas polls: daemon.js updates it as
// task-status messages arrive from each device (see daemon.js's handleTaskStatus), and this just
// reads it back out in the {runId, nodeId, status} shape the canvas already expects.
export async function GET() {
  try {
    const tasks = await getStore().listRecentTasks(500);
    return NextResponse.json(
      tasks.map((t: any) => ({ runId: t.run_id, nodeId: t.node_id, status: t.status })),
    );
  } catch (error: any) {
    console.error('Failed to fetch run tasks:', error.message);
    return NextResponse.json([]);
  }
}
