import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { authorize } from '@/lib/auth';
import { ownedKeys } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

// Run records devices synced back after finishing Cloud tasks (edge queue.build_cloud_result,
// stored by daemon.js). Only runs Cloud dispatched: a device's own bench history stays there.
//
// A Cloud run is one experiment, however many devices it spans, so that is the unit here:
//   GET /api/results               -> recent experiments (Cloud runs with at least one result)
//   GET /api/results?runId=        -> one experiment: every task, its device, and its record
//   GET /api/results?runId=&nodeId -> one task's record (kept for older links)

const SEVERITY = ['error', 'cancelled', 'running', 'queued', 'waiting_input', 'pending', 'blocked', 'completed with issues', 'completed', 'skipped'];
const worst = (statuses: string[]) =>
  SEVERITY.find((s) => statuses.includes(s)) || statuses[0] || 'unknown';

const nodeLabel = (node: any) => {
  const block = node?.data?.block || {};
  if (block.instrument === 'Library Workflows') return String(block.method || node?.id);
  return [block.instrument, block.method].filter(Boolean).join('.') || String(node?.id || '');
};

export async function GET(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const ws = auth.session.workspace.id;

  const url = new URL(req.url);
  const runId = url.searchParams.get('runId');
  const nodeId = url.searchParams.get('nodeId');
  try {
    const store = getStore();
    const runs = await ownedKeys('run', ws);
    if (runId && !runs.has(runId)) return NextResponse.json({ error: 'No such run.' }, { status: 404 });

    if (runId && nodeId) {
      const record = await store.getTaskResult(runId, nodeId);
      if (!record || !record.result) {
        return NextResponse.json({ error: 'No results synced for this task yet.' }, { status: 404 });
      }
      return NextResponse.json(record);
    }

    if (runId) {
      const [run, tasks] = await Promise.all([store.getRun(runId), store.listRunTaskRecords(runId)]);
      if (!run) return NextResponse.json({ error: 'No such run.' }, { status: 404 });
      const nodes = new Map<string, any>((run.nodes || []).map((n: any) => [String(n.id), n]));
      // Canvas order: nodes in the order they were laid out, so the record reads like the graph.
      const order = (run.nodes || []).map((n: any) => String(n.id));
      return NextResponse.json({
        run: { id: run.id, name: run.name, status: run.status },
        tasks: (tasks as any[])
          .map((t) => ({
            nodeId: t.node_id,
            label: nodeLabel(nodes.get(String(t.node_id))),
            deviceId: t.device_id,
            status: t.status,
            dispatchedAt: t.dispatched_at,
            updatedAt: t.updated_at,
            result: t.result || null,
            // Every occurrence of a repeating step, oldest first; one entry for a step that ran once.
            // Records stored before occurrences were kept have only `result`.
            results: t.results?.length ? t.results : t.result ? [t.result] : [],
          }))
          .sort((a, b) => order.indexOf(String(a.nodeId)) - order.indexOf(String(b.nodeId))),
      });
    }

    const rows = (await store.listTaskResults(300) as any[]).filter((r) => runs.has(String(r.run_id)));
    const byRun = new Map<string, any>();
    for (const r of rows) {
      const e = byRun.get(r.run_id) || {
        runId: r.run_id, name: r.run_name || r.name || r.run_id, devices: [] as string[],
        statuses: [] as string[], tasks: 0, updatedAt: r.updated_at,
      };
      e.tasks += 1;
      if (!e.devices.includes(r.device_id)) e.devices.push(r.device_id);
      // A step that completed only through retries or a skipped failure (edge run_issues).
      const issues = typeof r.issues === 'string' ? JSON.parse(r.issues) : r.issues;
      const s = r.result_status || r.status;
      e.statuses.push(s === 'completed' && issues && Object.keys(issues).length ? 'completed with issues' : s);
      if (r.updated_at > e.updatedAt) e.updatedAt = r.updated_at;
      byRun.set(r.run_id, e);
    }
    return NextResponse.json(
      [...byRun.values()]
        .map(({ statuses, ...e }) => ({ ...e, status: worst(statuses) }))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    );
  } catch (error: any) {
    console.error('Failed to read results:', error.message);
    return NextResponse.json(runId ? { error: error.message } : [], { status: runId ? 500 : 200 });
  }
}
