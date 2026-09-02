import { NextResponse } from 'next/server';
import { completeNode } from '@/lib/orchestrator';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { runId, nodeId, status } = body;
    
    if (!runId || !nodeId || !status) {
      return NextResponse.json({ error: 'runId, nodeId, and status are required' }, { status: 400 });
    }
    
    // Mark the node as complete in the graph to trigger next steps
    completeNode(runId, nodeId, status);
    
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
