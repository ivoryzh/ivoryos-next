import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// Replaces orchestrator.ts's in-memory startRun — that Map never survived a dev-server reload and
// couldn't be read by daemon.js (a separate process) at all, which is exactly why dispatch never
// actually worked. This computes the same initial ready/blocked classification checkReadyNodes
// used to do, but persists it as rows daemon.js can watch (see daemon.js's dispatchChannel).
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const nodes: any[] = body.nodes || [];
    const edges: any[] = body.edges || [];
    const runId = `run_${Date.now()}`;

    const incoming = new Map<string, string[]>();
    for (const e of edges) {
      if (!incoming.has(e.target)) incoming.set(e.target, []);
      incoming.get(e.target)!.push(e.source);
    }

    const flowControlNodeIds = new Set(
      nodes.filter(n => n.data?.block?.instrument === 'Flow Control').map(n => n.id)
    );
    const dispatchableNodes = nodes.filter(n => !flowControlNodeIds.has(n.id));

    const missingDevice = dispatchableNodes.find(n => !n.data?.targetDeviceId);
    if (missingDevice) {
      return NextResponse.json({ error: 'Every instrument/sequence node needs a target device assigned before running.' }, { status: 400 });
    }

    const tasks = dispatchableNodes.map(n => {
      const deps = incoming.get(n.id) || [];
      const allDepsAreFlowControl = deps.every(d => flowControlNodeIds.has(d));
      return {
        run_id: runId,
        node_id: n.id,
        device_id: n.data.targetDeviceId,
        block: n.data.block,
        status: allDepsAreFlowControl ? 'pending' : 'blocked',
      };
    });

    const { error: runError } = await supabaseAdmin.from('runs').insert({
      id: runId,
      name: body.name || 'Distributed Run',
      status: 'running',
      nodes,
      edges,
    });
    if (runError) throw new Error(runError.message);

    if (tasks.length > 0) {
      const { error: tasksError } = await supabaseAdmin.from('run_tasks').insert(tasks);
      if (tasksError) throw new Error(tasksError.message);
    }

    return NextResponse.json({ runId });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
