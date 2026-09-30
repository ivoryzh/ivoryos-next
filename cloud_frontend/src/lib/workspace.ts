/**
 * What belongs to which workspace (store `ownership`), and the checks API routes make with it.
 *
 * Owned kinds: a device, a run, a library workflow, a schedule, a pairing code. Everything else
 * hangs off one of those -- a run's tasks off its run, a device's workflows and pushes off the
 * device -- so checking the root is enough. Ownership lives in its own table rather than a column
 * on each, so the dispatch daemon (which works on every workspace's tasks alike) is unchanged.
 */
import { getStore, resolveMode } from '@/lib/store';

export type OwnedKind = 'device' | 'run' | 'workflow' | 'schedule' | 'pairing';

export async function ownedKeys(kind: OwnedKind, workspaceId: string): Promise<Set<string>> {
  return new Set(await getStore().listOwned(kind, workspaceId));
}

export async function isOwned(kind: OwnedKind, key: string, workspaceId: string): Promise<boolean> {
  return (await getStore().getOwner(kind, key)) === workspaceId;
}

export async function setOwner(kind: OwnedKind, key: string, workspaceId: string) {
  await getStore().setOwner(kind, key, workspaceId);
}

/**
 * Devices paired before Cloud had sign-in belong to no workspace. On a lab's own Cloud (LAN mode)
 * the people signing in are the lab, so one of them may claim those devices into a workspace. On
 * the hosted Cloud that would let anyone take anyone's device, so it is refused unless the
 * operator opts in with IVORYOS_ALLOW_CLAIM=1 (e.g. once, while moving an existing deployment).
 */
export function claimAllowed(): boolean {
  return resolveMode() === 'local' || process.env.IVORYOS_ALLOW_CLAIM === '1';
}

export async function unclaimedDeviceIds(): Promise<string[]> {
  const store = getStore();
  const [devices, owned] = await Promise.all([store.listDevices(), store.listOwnedKeys('device')]);
  const taken = new Set(owned);
  return devices.map((d: { id: string }) => d.id).filter((id: string) => !taken.has(id));
}

/**
 * A library workflow's name is its key, and names are only unique within a workspace. Stored
 * under `<workspace>/<name>` so two labs can each have a "Screen"; the prefix never leaves the
 * library route.
 */
export const workflowKey = (workspaceId: string, name: string) => `${workspaceId}/${name}`;
export const workflowName = (workspaceId: string, key: string) =>
  key.startsWith(`${workspaceId}/`) ? key.slice(workspaceId.length + 1) : null;
