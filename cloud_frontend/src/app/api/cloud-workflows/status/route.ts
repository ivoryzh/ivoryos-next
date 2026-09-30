import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { authorize } from '@/lib/auth';
import { ownedKeys } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

// run_tasks is the shared state the Orchestrator canvas polls: daemon.js updates it as
// task-status messages arrive from each device (see daemon.js's handleTaskStatus), and this just
// reads it back out in the {runId, nodeId, status} shape the canvas already expects.
//
// One task can now cover several canvas nodes — a linear chain merged into a single run — so each
// row is fanned out over its members. Without this, a merged chain lit up only its head node and
// the rest of the chain sat visibly blank while it was demonstrably running.
export async function GET() {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const ws = auth.session.workspace.id;
  try {
    const runs = await ownedKeys('run', ws);
    const tasks = (await getStore().listRecentTasks(500) as any[]).filter((t) => runs.has(String(t.run_id)));
    const out: any[] = [];
    for (const t of tasks) {
      const members: string[] = t.members?.length ? t.members : [t.node_id];
      for (const nodeId of members) {
        out.push({
          runId: t.run_id,
          nodeId,
          status: t.status,
          // The device's latest "how far along" summary while the task runs (edge queue.py's
          // run_progress_summary): steps done/total, current step, row.
          ...(t.progress ? { progress: t.progress } : {}),
          // A repeating or paced node: how many firings are done and when the next is due, so
          // the canvas can say "row 3 of 6 · next in 4 min" between firings.
          ...(Number(t.repeat_total) > 1 ? {
            repeat: { done: Number(t.repeat_done) || 0, total: Number(t.repeat_total), nextAt: t.not_before || null },
          } : {}),
          // Its run was queued "after current work" and has not started yet.
          ...(t.run_status === 'queued' ? { runQueued: true } : {}),
          // A decision about the pause the device is on, already on its way (see taskCommands.js),
          // so the node shows it rather than offering the choice a second time.
          ...(t.command && t.progress && t.command.pause === t.progress.pause ? { sent: t.command.action } : {}),
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
