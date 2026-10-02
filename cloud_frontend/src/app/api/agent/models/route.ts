import { NextResponse } from 'next/server';
import { authorize } from '@/lib/auth';
import { buildProvider, ProviderError } from '@/lib/agent/providers';
import { readAgentSettings } from '@/lib/agent/settingsStore';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const settings = await readAgentSettings();
  try {
    const provider = buildProvider(settings);
    const models = await provider.listModels();
    return NextResponse.json({ provider: provider.name, models, current: provider.model });
  } catch (e: any) {
    const status = e instanceof ProviderError ? 503 : 500;
    return NextResponse.json({ error: e.message, provider: settings.provider }, { status });
  }
}
