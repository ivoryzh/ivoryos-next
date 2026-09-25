import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

// run_tasks is the shared state the Orchestrator canvas polls: daemon.js updates it as
// task-status messages arrive from each device (see daemon.js's handleTaskStatus), and this just
// reads it back out in the {runId, nodeId, status} shape the canvas already expects.
//
// One task can now cover several canvas nodes — a linear chain merged into a single run — so each
// row is fanned out over its members. Without this, a merged chain lit up only its head node and
// the rest of the chain sat visibly blank while it was demonstrably running.
export async function GET() {
  try {
    const tasks = await getStore().listRecentTasks(500);
    const out: any[] = [];
    for (const t of tasks as any[]) {
      const members: string[] = t.members?.length ? t.members : [t.node_id];
      for (const nodeId of members) {
        out.push({
          runId: t.run_id,
          nodeId,
          status: t.status,
          // The device's latest "how far along" summary while the task runs (edge queue.py's
          // run_progress_summary): steps done/total, current step, row.
          ...(t.progress ? { progress: t.progress } : {}),
          // The device synced this task's run record back (edge queue.build_cloud_result); the
          // canvas links to it on the Results page.
          ...(t.edge_run_id !== null && t.edge_run_id !== undefined ? { hasResult: true } : {}),
          // Names the task actually carrying this node, so the canvas can say "running as part of
          // <head>" rather than implying the node was dispatched on its own.
          ...(members.length > 1 ? { mergedInto: t.node_id } : {}),
        });
      }
    }
    return NextResponse.json(out);
  } catch (error: any) {
    console.error('Failed to fetch run tasks:', error.message);
    return NextResponse.json([]);
  }
}
