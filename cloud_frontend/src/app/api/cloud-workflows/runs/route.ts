import { NextResponse } from 'next/server';
import { experimentName, workflowSourcesFor } from '@/lib/runSources';
import { getStore } from '@/lib/store';
import { authorize } from '@/lib/auth';
import { ownedKeys, setOwner } from '@/lib/workspace';
import { planRun, CLOUD_DEVICE_ID } from '@/lib/dag';
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
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const ws = auth.session.workspace.id;

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

    // Refused while a target device is offline. Accepted, the run would be recorded as started and
    // its steps for that device held in Cloud until it came back -- which could be never -- with
    // nothing on the canvas saying why. (Schedules are deliberately not checked: a device being
    // down when a schedule is created says nothing about when it next fires.)
    const store = getStore();
    const targets = new Set(tasks.map((t: any) => String(t.device_id)).filter((d: string) => d && d !== CLOUD_DEVICE_ID));
    // A run may only move this workspace's devices.
    const mine = await ownedKeys('device', ws);
    const foreign = Array.from(targets).filter((id) => !mine.has(id));
    if (foreign.length) {
      return NextResponse.json({ error: `${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not in this workspace.` }, { status: 403 });
    }
    if (targets.size) {
      const devices = await store.listDevices() as any[];
      const offline = Array.from(targets).filter(id =>
        !String(devices.find((d: any) => String(d.id) === id)?.status || '').includes('online'));
      if (offline.length) {
        return NextResponse.json(
          { error: `${offline.join(', ')} ${offline.length === 1 ? 'is' : 'are'} offline, so this run cannot start.`, offline },
          { status: 409 },
        );
      }
    }

    const name = await experimentName(body.name, body.base);
    const built = buildRunTasks(tasks, resolved, name, await workflowSourcesFor(resolved));
    if (built.problems.length > 0) {
      return NextResponse.json({ error: built.problems.join('\n') }, { status: 400 });
    }

    // "After current work": wait for every run that has work open on these devices now, rather
    // than slotting into their gaps (a repeat's 5-minute wait leaves the device idle, and a run
    // started now would use it). Everything starts blocked and the run 'queued'; daemon.js
    // starts it -- releasing its first steps through the ordinary advanceRun -- once those runs
    // have nothing open. Asked for with nothing ahead, it is simply a run that starts now.
    const ahead = body.after ? await store.listOpenRunsOnDevices(Array.from(targets)) as any[] : [];
    const queued = ahead.length > 0;

    await store.insertRun({
      id: runId,
      name,
      status: queued ? 'queued' : 'running',
      // The resolved graph, so the stored run records what ran rather than what was drawn.
      nodes: resolved,
      edges,
      after_runs: ahead.map((r) => r.id),
    });

    await setOwner('run', runId, ws);
    const rows = queued ? built.rows.map((r: any) => ({ ...r, status: 'blocked' })) : built.rows;
    if (rows.length > 0) await store.insertTasks(rows);

    return NextResponse.json({ runId, queuedAfter: ahead.map((r) => r.name || r.id) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// What is already open on these devices: the runs a new one would wait for if queued "after
// current work". The canvas asks before dispatching, and only offers the choice when this is
// not empty. GET /api/cloud-workflows/runs?devices=a,b
export async function GET(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const ws = auth.session.workspace.id;
  try {
    const runs = await ownedKeys('run', ws);
    const devices = (new URL(req.url).searchParams.get('devices') || '')
      .split(',').map((d) => d.trim()).filter((d) => d && d !== CLOUD_DEVICE_ID);
    const ahead = (await getStore().listOpenRunsOnDevices(devices) as any[]).filter((r) => runs.has(String(r.id)));
    return NextResponse.json({ ahead: ahead.map((r) => ({ id: r.id, name: r.name || r.id, openTasks: r.open_tasks })) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
