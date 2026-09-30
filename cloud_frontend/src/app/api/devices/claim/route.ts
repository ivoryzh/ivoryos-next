import { NextResponse } from 'next/server';
import { authorize } from '@/lib/auth';
import { claimAllowed, setOwner, unclaimedDeviceIds } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * Devices paired before Cloud had sign-in belong to no workspace, and so appear in none.
 *   GET            -> {allowed, devices: [ids]}
 *   POST {ids}     -> move those into the signed-in workspace
 * Allowed on a lab's own Cloud only (lib/workspace.ts claimAllowed): on the hosted one it would let
 * anyone take anyone's device.
 */
export async function GET() {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  if (!claimAllowed()) return NextResponse.json({ allowed: false, devices: [] });
  return NextResponse.json({ allowed: true, devices: await unclaimedDeviceIds() });
}

export async function POST(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  if (!claimAllowed()) return NextResponse.json({ error: 'Claiming devices is not available on this Cloud.' }, { status: 403 });
  const { ids } = await req.json().catch(() => ({ ids: [] }));
  const unclaimed = new Set(await unclaimedDeviceIds());
  const claimed: string[] = [];
  for (const id of Array.isArray(ids) ? ids.map(String) : []) {
    if (!unclaimed.has(id)) continue; // already someone's: never taken over
    await setOwner('device', id, auth.session.workspace.id);
    claimed.push(id);
  }
  return NextResponse.json({ claimed });
}
