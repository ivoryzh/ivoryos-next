import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// Replaces the old tmpfile-based status route — nothing ever wrote ivoryos_tasks.json, so
// polling always returned []. run_tasks is the real, shared state now: daemon.js updates it as
// task-status messages arrive from each device (see daemon.js's handleTaskStatus), and this just
// reads it back out in the {runId, nodeId, status} shape the Orchestrator canvas already expects.
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('run_tasks')
    .select('run_id, node_id, status, updated_at')
    .order('updated_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error('Failed to fetch run tasks from Supabase:', error.message);
    return NextResponse.json([]);
  }
  return NextResponse.json(data.map(t => ({ runId: t.run_id, nodeId: t.node_id, status: t.status })));
}
