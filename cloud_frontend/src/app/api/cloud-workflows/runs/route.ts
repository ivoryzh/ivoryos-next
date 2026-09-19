import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { planRun } from '@/lib/dag';

// Replaces orchestrator.ts's in-memory startRun — that Map never survived a dev-server reload and
// couldn't be read by daemon.js (a separate process) at all, which is exactly why dispatch never
// actually worked. This persists the plan as rows daemon.js can watch (see daemon.js's
// dispatchChannel).
//
// The ready/blocked classification and the structural checks both live in `@/lib/dag`, shared
// verbatim with daemon.js, which advances the same plan as tasks report back. They used to be two
// hand-written copies that disagreed about what a dependency is; see that module's header.
//
// This route is the enforcement point, not the canvas. The editor refuses to draw a cycle, but a
// graph can arrive here having never been drawn in this session at all — restored from
// localStorage, loaded from the Library, or POSTed directly — and an invalid graph used to be
// accepted and then hang partway through with no terminal state and no explanation.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const nodes: any[] = body.nodes || [];
    const edges: any[] = body.edges || [];
    const runId = `run_${Date.now()}`;

    const { errors, tasks } = planRun(runId, nodes, edges);
    if (errors.length > 0) {
      // `error` is the single string the Orchestrator canvas already surfaces; `errors` keeps the
      // per-problem codes for a caller that wants to do something better than an alert().
      return NextResponse.json(
        { error: errors.map(e => e.message).join('\n'), errors },
        { status: 400 },
      );
    }

    const store = getStore();
    await store.insertRun({
      id: runId,
      name: body.name || 'Distributed Run',
      status: 'running',
      nodes,
      edges,
    });

    if (tasks.length > 0) {
      // `deps` is derived state, recomputed from runs.edges on every advance — it travels with
      // the plan for logging but is deliberately not a column, so there is only ever one copy of
      // the graph.
      const rows = tasks.map(t => ({
        run_id: t.run_id,
        node_id: t.node_id,
        device_id: t.device_id,
        block: t.block,
        status: t.status,
      }));
      await store.insertTasks(rows);
    }

    return NextResponse.json({ runId });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
