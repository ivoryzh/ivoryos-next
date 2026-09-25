import { NextResponse } from 'next/server';
import { workflowSourcesFor } from '@/lib/runSources';
import { getStore } from '@/lib/store';
import { planRun } from '@/lib/dag';
import { buildRunTasks, resolveGraphForDispatch } from '@/lib/planTasks';

export const dynamic = 'force-dynamic';

/**
 * Recurring triggers for a whole distributed run.
 *
 * A schedule is planned once, here, and stored with its tasks already built — including each
 * node's run payload. `daemon.js` fires it by copying those rows under a new run id, which is
 * what lets the clock live in a process that has no build step and cannot construct a payload.
 * It also means an unattended firing at 3am replays something that was validated while a person
 * was looking at it, rather than re-deriving it from a canvas that may since have been edited.
 *
 * NOTE: unauthenticated, like the rest of this API — Cloud has no user accounts yet (see
 * AGENTS.md). A schedule starts real runs on real hardware, so this is worth stating plainly
 * rather than leaving implied: it is the same pre-existing gap, on a route that repeats itself.
 */

const MIN_INTERVAL_MS = 60_000; // a minute; anything finer is a per-node cadence, not a schedule

export async function GET() {
  try {
    const schedules = await getStore().listSchedules();
    return NextResponse.json(
      (schedules as any[]).map((s) => ({
        id: s.id,
        name: s.name,
        enabled: !!s.enabled,
        triggerType: s.trigger_type,
        everyMs: Number(s.every_ms) || 0,
        maxRuns: Number(s.max_runs) || 0,
        runsFired: Number(s.runs_fired) || 0,
        nextFireAt: s.next_fire_at,
        lastFireAt: s.last_fire_at,
        lastRunId: s.last_run_id,
        stepCount: (s.tasks || []).length,
      })),
    );
  } catch (error: any) {
    console.error('Failed to list schedules:', error.message);
    return NextResponse.json([]);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const nodes: any[] = body.nodes || [];
    const edges: any[] = body.edges || [];
    const name: string = String(body.name || '').trim();
    if (!name) {
      return NextResponse.json({ error: 'Give the schedule a name.' }, { status: 400 });
    }

    const triggerType = body.triggerType === 'once' ? 'once' : 'interval';
    const everyMs = Math.round(Number(body.everyMinutes || 0) * 60_000);
    if (triggerType === 'interval' && (!Number.isFinite(everyMs) || everyMs < MIN_INTERVAL_MS)) {
      return NextResponse.json(
        { error: 'An interval schedule repeats at least once a minute apart. For anything finer, give the step itself a cadence instead.' },
        { status: 400 },
      );
    }

    // The first firing. A schedule with no explicit start begins one interval from now rather
    // than immediately: creating a schedule should not itself actuate hardware, which is exactly
    // the surprise someone gets if "every 30 minutes" starts by running right now.
    const startAt = body.startAt ? Date.parse(body.startAt) : Date.now() + (everyMs || 0);
    if (!Number.isFinite(startAt)) {
      return NextResponse.json({ error: 'Could not read the start time.' }, { status: 400 });
    }

    // Planned exactly as `POST /api/cloud-workflows/runs` plans it, so a schedule cannot accept a
    // graph that a manual run would have refused.
    const scheduleId = `sch_${Date.now()}`;
    const resolved = resolveGraphForDispatch(nodes);
    const { errors, tasks } = planRun('__template__', resolved, edges);
    if (errors.length > 0) {
      return NextResponse.json({ error: errors.map(e => e.message).join('\n'), errors }, { status: 400 });
    }
    const built = buildRunTasks(tasks, resolved, name, await workflowSourcesFor(resolved));
    if (built.problems.length > 0) {
      return NextResponse.json({ error: built.problems.join('\n') }, { status: 400 });
    }

    await getStore().insertSchedule({
      id: scheduleId,
      name,
      enabled: body.enabled !== false,
      trigger_type: triggerType,
      every_ms: triggerType === 'interval' ? everyMs : 0,
      nodes: resolved,
      edges,
      // `run_id` is stamped per firing; the stored template carries everything else verbatim.
      tasks: built.rows.map(({ run_id: _ignored, ...rest }) => rest),
      max_runs: Math.max(0, Math.floor(Number(body.maxRuns) || 0)),
      next_fire_at: new Date(startAt).toISOString(),
    });

    return NextResponse.json({ id: scheduleId, nextFireAt: new Date(startAt).toISOString() });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
