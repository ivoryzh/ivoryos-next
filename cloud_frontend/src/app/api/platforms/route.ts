import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { authorize } from '@/lib/auth';
import { ownedKeys } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * Platforms: named groups of this workspace's edges, e.g. "Flow rig" = the pump edge and the
 * collector edge. Organization only -- a platform changes nothing about how a device runs -- and
 * a device is in at most one, so the Devices page can list each once.
 *
 *   GET                              -> [{id, name, device_ids}]
 *   POST   {name, device_ids?}        -> create
 *   PATCH  {id, name?, device_ids?}   -> rename or change members
 *   DELETE ?id=                       -> remove (its devices stay; they are just ungrouped)
 */
async function context() {
  const auth = await authorize();
  if ('response' in auth) return auth;
  const ws = auth.session.workspace.id;
  return { ws, store: getStore(), devices: await ownedKeys('device', ws) };
}

/** Keep each device in one platform: moving one here takes it out of any other. */
async function place(store: any, ws: string, id: string, deviceIds: string[]) {
  for (const p of await store.listPlatforms(ws)) {
    if (p.id === id) continue;
    const kept = (p.device_ids || []).filter((d: string) => !deviceIds.includes(d));
    if (kept.length !== (p.device_ids || []).length) await store.upsertPlatform({ ...p, device_ids: kept });
  }
}

export async function GET() {
  const c = await context();
  if ('response' in c) return c.response;
  const rows = await c.store.listPlatforms(c.ws);
  return NextResponse.json(rows.map((p: any) => ({ id: p.id, name: p.name, device_ids: (p.device_ids || []).filter((d: string) => c.devices.has(d)) })));
}

export async function POST(req: Request) {
  const c = await context();
  if ('response' in c) return c.response;
  const body = await req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) return NextResponse.json({ error: 'Give the platform a name.' }, { status: 400 });
  const deviceIds = (Array.isArray(body.device_ids) ? body.device_ids.map(String) : []).filter((d: string) => c.devices.has(d));
  const id = `plat_${crypto.randomBytes(6).toString('hex')}`;
  await place(c.store, c.ws, id, deviceIds);
  await c.store.upsertPlatform({ id, workspace_id: c.ws, name, device_ids: deviceIds });
  return NextResponse.json({ id, name, device_ids: deviceIds });
}

export async function PATCH(req: Request) {
  const c = await context();
  if ('response' in c) return c.response;
  const body = await req.json().catch(() => ({}));
  const current = (await c.store.listPlatforms(c.ws)).find((p: any) => p.id === body.id);
  if (!current) return NextResponse.json({ error: 'No such platform.' }, { status: 404 });
  const name = body.name !== undefined ? String(body.name).trim() : current.name;
  if (!name) return NextResponse.json({ error: 'Give the platform a name.' }, { status: 400 });
  const deviceIds = Array.isArray(body.device_ids)
    ? body.device_ids.map(String).filter((d: string) => c.devices.has(d))
    : current.device_ids || [];
  await place(c.store, c.ws, current.id, deviceIds);
  await c.store.upsertPlatform({ id: current.id, workspace_id: c.ws, name, device_ids: deviceIds });
  return NextResponse.json({ id: current.id, name, device_ids: deviceIds });
}

export async function DELETE(req: Request) {
  const c = await context();
  if ('response' in c) return c.response;
  const id = new URL(req.url).searchParams.get('id') || '';
  await c.store.deletePlatform(id, c.ws);
  return NextResponse.json({ ok: true });
}
