import { NextResponse } from 'next/server';
import { startRun } from '@/lib/orchestrator';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const runId = `run_${Date.now()}`;
    startRun(runId, body.name, body.nodes || [], body.edges || []);
    return NextResponse.json({ runId });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
