import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { authorize } from '@/lib/auth';
import { ownedKeys } from '@/lib/workspace';
import { CLOUD_DEVICE_ID } from '@/lib/dag';
import { pauseKind } from '@/lib/taskCommands';

export const dynamic = 'force-dynamic';

// Everything currently stopped for a person, across every run and device: a device's User_Input
// step or failed step (reported in its progress, see taskCommands.js), and Cloud's own User_Input
// steps. Polled by the attention panel on every page -- the run is somewhere else entirely when
// it stops, and nothing used to say so anywhere but a paused bar on one canvas card.
export async function GET() {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const ws = auth.session.workspace.id;
  try {
    const store = getStore();
    const runs = await ownedKeys('run', ws);
    const [allTasks, devices] = await Promise.all([store.listRecentTasks(500), store.listDevices()]) as [any[], any[]];
    const tasks = allTasks.filter((t) => runs.has(String(t.run_id)));
    const imageOf = new Map(devices.map((d: any) => [String(d.id), d.image_version || null]));
    const runNames = new Map<string, string>();
    const nameOf = async (runId: string) => {
      if (!runNames.has(runId)) runNames.set(runId, (await store.getRun(runId))?.name || runId);
      return runNames.get(runId)!;
    };

    const items: any[] = [];
    for (const t of tasks) {
      if (t.status !== 'running' || !t.progress) continue;
      const pr = t.progress;
      const onCloud = String(t.device_id) === CLOUD_DEVICE_ID;
      const kind = onCloud ? (pr.state === 'waiting_input' ? 'input' : null) : pauseKind(t);
      if (!kind) continue;
      items.push({
        key: onCloud ? `cloud:${t.run_id}:${t.node_id}` : `${t.run_id}:${t.node_id}:${pr.pause}`,
        runId: t.run_id,
        nodeId: t.node_id,
        members: t.members,
        deviceId: onCloud ? null : t.device_id,
        deviceImage: onCloud ? null : imageOf.get(String(t.device_id)) || null,
        runName: await nameOf(t.run_id),
        kind,
        prompt: pr.prompt || '',
        inputType: onCloud ? 'str' : (pr.input_type || 'str'),
        error: pr.error || '',
        step: pr.step || '',
        row: pr.row || null,
        pause: pr.pause || null,
        // A decision already on its way: the card shows it rather than offering the choice again.
        sent: !!(t.command && t.command.pause === pr.pause) ? t.command.action : null,
        since: t.updated_at,
      });
    }
    return NextResponse.json(items);
  } catch (error: any) {
    console.error('Failed to list what needs attention:', error.message);
    return NextResponse.json([]);
  }
}
