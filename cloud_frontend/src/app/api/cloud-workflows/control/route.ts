import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { authorize } from '@/lib/auth';
import { isOwned } from '@/lib/workspace';
import { commandProblem } from '@/lib/taskCommands';

// A decision about a task its device has stopped on: the answer to a User_Input step, or
// retry / skip / stop on a failed step -- what the bench's own prompt and error bar offer.
//
// Like the Cloud User_Input route this only records the decision; daemon.js is the one process
// with a broker connection, and it delivers it (see sendTaskCommands there). `pause` is the stop
// the person was looking at, echoed from the task's progress, so a click on a question that has
// since been answered at the bench changes nothing rather than answering whatever comes next.
export async function POST(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const ws = auth.session.workspace.id;

  try {
    const { runId, nodeId, pause, action, value } = await req.json();
    if (runId && !(await isOwned('run', String(runId), ws))) return NextResponse.json({ error: 'No such run.' }, { status: 404 });
    if (!runId || !nodeId || !pause || !action) {
      return NextResponse.json({ error: 'runId, nodeId, pause and action are required.' }, { status: 400 });
    }
    const store = getStore();
    const task = (await store.listRunTaskRecords(String(runId)) as any[])
      .find((t: any) => String(t.node_id) === String(nodeId));
    const problem = commandProblem(task, { action: String(action), pause: String(pause) });
    if (problem) return NextResponse.json({ error: problem }, { status: 409 });

    const command = {
      action: String(action),
      // Sent as typed: the device casts it to the step's declared input type, as it does for an
      // answer typed at the bench.
      ...(action === 'input' ? { value: value === undefined || value === null ? '' : value } : {}),
      pause: String(pause),
      state: 'pending',
      at: new Date().toISOString(),
    };
    if (!(await store.setTaskCommand(String(runId), String(nodeId), command))) {
      return NextResponse.json({ error: 'That step is no longer waiting for a decision.' }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
