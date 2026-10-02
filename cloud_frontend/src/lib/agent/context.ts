import { getStore } from '@/lib/store';
import { ownedKeys } from '@/lib/workspace';

export type AgentTarget = { kind: 'all' | 'platform' | 'device'; id?: string; name?: string; deviceIds?: string[] };

/**
 * This workspace's devices and their saved workflows, plus the target resolved to device ids.
 * A platform is a device group (/api/platforms); its id resolves here so the client only sends
 * {kind, id}.
 */
export async function loadLabContext(workspaceId: string, target: AgentTarget) {
  const store = getStore() as any;
  const mine = await ownedKeys('device', workspaceId);
  const devices = ((await store.listDevices()) as any[]).filter((d) => mine.has(String(d.id)));
  const sequences = ((await store.listSequences()) as any[]).filter((s) => mine.has(String(s.device_id)));
  const resolved: AgentTarget = { ...target };
  if (target.kind === 'platform' && target.id) {
    const platforms = (await store.listPlatforms(workspaceId).catch(() => [])) as any[];
    const p = platforms.find((x) => String(x.id) === String(target.id));
    resolved.deviceIds = (p?.device_ids || []).map(String);
    resolved.name = p?.name || target.name;
  } else if (target.kind === 'device' && target.id) {
    resolved.name = devices.find((d) => String(d.id) === String(target.id))?.name || target.name;
  }
  return { devices, sequences, target: resolved };
}
