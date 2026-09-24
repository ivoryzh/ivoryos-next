import { NextResponse } from 'next/server';
import { experimentName, workflowSourcesFor } from '@/lib/runSources';
import { getStore } from '@/lib/store';
import { planRun } from '@/lib/dag';
import { buildRunTasks, resolveGraphForDispatch } from '@/lib/planTasks';

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
//
// It is also where each node's run payload is built (`buildRunTasks`), rather than at dispatch
// time: `daemon.js` has no build step and cannot import the TypeScript that produces one, and a
// payload that is going to reach real hardware should be validated while someone is still looking
// at the screen that produced it.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const nodes: any[] = body.nodes || [];
    const edges: any[] = body.edges || [];
    const runId = `run_${Date.now()}`;

    // Values first, then plan: `planRun` rejects a single-step node still holding a `#name`,
    // so the graph has to arrive at it already resolved. See resolveGraphForDispatch.
    const resolved = resolveGraphForDispatch(nodes);
    const { errors, tasks } = planRun(runId, resolved, edges);
    if (errors.length > 0) {
      // `error` is the single string the Orchestrator canvas already surfaces; `errors` keeps the
      // per-problem codes for a caller that wants to do something better than an alert().
      return NextResponse.json(
        { error: errors.map(e => e.message).join('\n'), errors },
        { status: 400 },
      );
    }

    const name = await experimentName(body.name, body.base);
    const built = buildRunTasks(tasks, resolved, name, await workflowSourcesFor(resolved));
    if (built.problems.length > 0) {
      return NextResponse.json({ error: built.problems.join('\n') }, { status: 400 });
    }

    const store = getStore();
    await store.insertRun({
      id: runId,
      name,
      status: 'running',
      // The resolved graph, so the stored run records what ran rather than what was drawn.
      nodes: resolved,
      edges,
    });

    if (built.rows.length > 0) await store.insertTasks(built.rows);

    return NextResponse.json({ runId });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
