import { NextResponse } from 'next/server';
import { authorize } from '@/lib/auth';
import { providerCatalogue } from '@/lib/agent/providers';
import { publicSettings, readAgentSettings, writeAgentSettings } from '@/lib/agent/settingsStore';

export const dynamic = 'force-dynamic';

// The assistant's model provider, shared by everyone on this Cloud (one setting, not per user:
// the model is part of the deployment, like the broker). The API key is stored, never returned.
export async function GET() {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  return NextResponse.json({ settings: publicSettings(await readAgentSettings()), providers: providerCatalogue() });
}

export async function POST(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  try {
    const next = await writeAgentSettings(body);
    return NextResponse.json({ settings: publicSettings(next) });
  } catch (e: any) {
    return NextResponse.json({ error: `Could not save settings: ${e.message}` }, { status: 500 });
  }
}
