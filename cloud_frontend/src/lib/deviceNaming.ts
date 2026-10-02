import { getStore } from '@/lib/store';
import { nameConflict, pollOutcome } from '@/lib/pairing';

/**
 * Every device name already claimed in a workspace (the rule is pairing.js nameConflict): its
 * devices, plus approvals the edge has not collected yet, so two approvals in quick succession
 * cannot both take one name before either device exists.
 */
async function namesTakenIn(workspace: string): Promise<{ id: string; name: string }[]> {
  const store = getStore();
  const [deviceIds, codes] = await Promise.all([store.listOwned('device', workspace), store.listOwned('pairing', workspace)]);
  const owned = new Set((deviceIds as string[]).map(String));
  const devices = ((await store.listDevices()) as any[])
    .filter((d) => owned.has(String(d.id)))
    .map((d) => ({ id: String(d.id), name: String(d.name || d.id) }));
  const requests = await Promise.all((codes as string[]).map((code) => store.getPairingRequest(code)));
  const pending = requests
    .filter((r: any) => r && (r.status === 'approved' || r.status === 'provisioning') && pollOutcome(r) !== 'expired')
    .map((r: any) => ({ id: String(r.requested_id || `pairing:${r.code}`), name: String(r.device_name || '') }));
  return [...devices, ...pending];
}

/** The device in `workspace` already called `name`, other than `selfId` itself; null if it is free. */
export async function deviceNameConflict(workspace: string, name: string, selfId?: string | null) {
  return nameConflict(name, await namesTakenIn(workspace), selfId || null) as { id: string; name: string } | null;
}

export const nameTakenMessage = (name: string) =>
  `A device in this workspace is already called "${name}". Device names are unique within a workspace; choose another.`;
