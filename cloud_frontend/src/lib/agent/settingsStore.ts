import { getStore } from '@/lib/store';

export type AgentSettings = { provider?: string; base_url?: string; model?: string; api_key?: string };

const KEY = 'agent';

/** The assistant's provider settings, from the store, with env vars as the fallback when nothing is saved. */
export async function readAgentSettings(): Promise<AgentSettings> {
  const stored = (await (getStore() as any).getSetting(KEY).catch(() => null)) as AgentSettings | null;
  return { provider: process.env.IVORYOS_LLM_PROVIDER || 'ollama', ...(stored || {}) };
}

export async function writeAgentSettings(patch: Record<string, unknown>): Promise<AgentSettings> {
  const current = (await (getStore() as any).getSetting(KEY).catch(() => null)) || {};
  const next: AgentSettings = { ...current };
  for (const k of ['provider', 'base_url', 'model'] as const) {
    if (k in patch) next[k] = String(patch[k] ?? '').slice(0, 500);
  }
  if ('api_key' in patch) {
    if (patch.api_key) next.api_key = String(patch.api_key).slice(0, 500);
    else delete next.api_key;
  }
  await (getStore() as any).setSetting(KEY, next);
  return next;
}

/** What the page may see: never the key itself. */
export function publicSettings(s: AgentSettings) {
  const { api_key, ...rest } = s;
  return { ...rest, api_key_set: !!api_key };
}
