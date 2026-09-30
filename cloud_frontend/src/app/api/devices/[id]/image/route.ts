import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { authorize } from '@/lib/auth';
import { isOwned } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

// A picture of a device's bench, so a lab with several look-alike names can tell them apart at a
// glance. Stored as a small data: URL on the device row (the browser scales it to a thumbnail
// before upload), which works the same in LAN and hosted mode with no file storage to set up. It
// is kept out of the device list, which is polled every few seconds; this route serves it alone,
// and the list carries `image_version` to key the URL so a changed picture is fetched once.

const MAX_BYTES = 400_000;
const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

const idOf = async (params: Promise<{ id: string }>) => decodeURIComponent((await params).id || '').trim();

/** The device's id when it is the signed-in workspace's; otherwise the response to return. */
async function ownDevice(params: Promise<{ id: string }>): Promise<{ id: string } | { response: NextResponse }> {
  const auth = await authorize();
  if ('response' in auth) return auth;
  const id = await idOf(params);
  if (!(await isOwned('device', id, auth.session.workspace.id))) return { response: NextResponse.json({ error: 'No such device.' }, { status: 404 }) };
  return { id };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const device = await ownDevice(params);
  if ('response' in device) return device.response;
  try {
    const found = await getStore().getDeviceImage(device.id);
    if (!found) return new NextResponse(null, { status: 404 });
    const [, mime, b64] = /^data:([^;]+);base64,(.*)$/.exec(found.image) || [];
    if (!mime) return new NextResponse(null, { status: 404 });
    return new NextResponse(Buffer.from(b64, 'base64'), {
      headers: {
        'Content-Type': mime,
        // Safe to cache hard: callers put `image_version` in the URL, so a new picture is a new URL.
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const device = await ownDevice(params);
  if ('response' in device) return device.response;
  try {
    const { image } = await req.json();
    if (typeof image !== 'string' || !DATA_URL.test(image)) {
      return NextResponse.json({ error: 'Expected a PNG, JPEG, WebP or GIF image.' }, { status: 400 });
    }
    if (image.length > MAX_BYTES) {
      return NextResponse.json({ error: 'That image is too large; pick a smaller one.' }, { status: 413 });
    }
    const deviceId = device.id;
    if (!(await getStore().setDeviceImage(deviceId, image))) {
      return NextResponse.json({ error: `No device named "${deviceId}" is registered.` }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const device = await ownDevice(params);
  if ('response' in device) return device.response;
  try {
    const deviceId = device.id;
    if (!(await getStore().setDeviceImage(deviceId, null))) {
      return NextResponse.json({ error: `No device named "${deviceId}" is registered.` }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
