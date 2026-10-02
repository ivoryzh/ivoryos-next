'use strict';
// The one module that knows a model exists: Ollama (default; nothing leaves the building) and any
// OpenAI-compatible chat endpoint. Mirrors edge_server/ivoryos_edge/agent/providers.py so the
// two assistants are configured the same way and fail with the same messages. No streaming and
// no tool-calling protocol: the loop asks for one JSON object and validates it (chat.js).

const DEFAULT_TIMEOUT_MS = Number(process.env.IVORYOS_LLM_TIMEOUT || 180) * 1000;

class ProviderError extends Error {}

async function fetchJson(url, init, timeoutMs, unreachable) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderError(`${unreachable} (${e.name === 'TimeoutError' ? 'no answer in time' : e.message})`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* reported by status below */ }
  return { res, text, json };
}

const CATALOGUE = [
  { name: 'ollama', default_base_url: process.env.OLLAMA_URL || 'http://localhost:11434', default_model: process.env.OLLAMA_MODEL || 'llama3.1', needs_api_key: false },
  { name: 'openai-compatible', default_base_url: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', default_model: process.env.OPENAI_MODEL || 'gpt-4o-mini', needs_api_key: true },
  // Claude through Anthropic's own SDK, not the OpenAI-compatible entry: the Messages API has its
  // own shape, and the SDK resolves credentials itself (ANTHROPIC_API_KEY or an `ant auth login`
  // profile), so a key is optional here.
  { name: 'anthropic', default_base_url: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', default_model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5', needs_api_key: false },
];

function providerCatalogue() { return CATALOGUE.map((p) => ({ ...p })); }

/** `settings` is {provider, base_url, model, api_key}; blanks fall back to the provider's defaults. */
function buildProvider(settings = {}) {
  const name = settings.provider || 'ollama';
  const spec = CATALOGUE.find((p) => p.name === name);
  if (!spec) throw new ProviderError(`No provider called '${name}'. Available: ${CATALOGUE.map((p) => p.name).join(', ')}`);
  const base = String(settings.base_url || spec.default_base_url).replace(/\/+$/, '');
  const model = settings.model || spec.default_model;
  const apiKey = settings.api_key || (name === 'openai-compatible' ? process.env.OPENAI_API_KEY : name === 'anthropic' ? process.env.ANTHROPIC_API_KEY : '') || '';
  const timeout = DEFAULT_TIMEOUT_MS;

  if (name === 'ollama') {
    return {
      name, model, base_url: base,
      async listModels() {
        const { res, json } = await fetchJson(`${base}/api/tags`, {}, 10000, `No Ollama at ${base}. Start it with \`ollama serve\`, then pull a model with \`ollama pull ${spec.default_model}\`.`);
        if (res.status !== 200) throw new ProviderError(`Ollama returned ${res.status} listing models.`);
        return (json?.models || []).map((m) => m.name);
      },
      async complete(system, messages, { jsonMode = true } = {}) {
        const body = { model, messages: [{ role: 'system', content: system }, ...messages], stream: false, options: { temperature: 0.1 } };
        if (jsonMode) body.format = 'json';
        const { res, text, json } = await fetchJson(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeout, `Could not reach Ollama at ${base}`);
        if (res.status === 404) throw new ProviderError(`Ollama has no model called '${model}'. Pull it with \`ollama pull ${model}\`.`);
        if (res.status !== 200) throw new ProviderError(`Ollama returned ${res.status}: ${text.slice(0, 200)}`);
        return json?.message?.content || '';
      },
    };
  }
  if (name === 'anthropic') {
    const client = () => {
      let Anthropic;
      try { Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk'); } catch {
        throw new ProviderError("The Claude provider needs Anthropic's SDK: run `npm install @anthropic-ai/sdk` in cloud_frontend.");
      }
      const opts = { timeout, maxRetries: 2 };
      if (apiKey) opts.apiKey = apiKey;
      if (base && base !== 'https://api.anthropic.com') opts.baseURL = base;
      return { Anthropic, client: new Anthropic(opts) };
    };
    const explain = (Anthropic, e) => {
      if (e instanceof ProviderError) return e;
      if (Anthropic.AuthenticationError && e instanceof Anthropic.AuthenticationError) return new ProviderError("Anthropic rejected the API key. Save one in the assistant's settings, or set ANTHROPIC_API_KEY.");
      if (Anthropic.NotFoundError && e instanceof Anthropic.NotFoundError) return new ProviderError(`Anthropic has no model called '${model}'.`);
      if (Anthropic.RateLimitError && e instanceof Anthropic.RateLimitError) return new ProviderError('Anthropic rate-limited the request. Try again in a moment.');
      if (Anthropic.APIConnectionError && e instanceof Anthropic.APIConnectionError) return new ProviderError(`Could not reach Anthropic: ${e.message}`);
      if (Anthropic.APIError && e instanceof Anthropic.APIError) return new ProviderError(`Anthropic returned ${e.status}: ${String(e.message).slice(0, 200)}`);
      return new ProviderError(`The model call failed: ${e.message}`);
    };
    return {
      name, model, base_url: base,
      async listModels() {
        const { Anthropic, client: c } = client();
        try { const ids = []; for await (const m of c.models.list()) ids.push(m.id); return ids; } catch (e) { throw explain(Anthropic, e); }
      },
      async complete(system, messages) {
        // No JSON mode on this API: the system prompt asks for one JSON object and chat.js
        // recovers it from any wrapping. The server-side refusal fallback is on, so a declined
        // request is re-run on a fallback model inside the same call.
        const { Anthropic, client: c } = client();
        let response;
        try {
          response = await c.beta.messages.create({
            model, max_tokens: 16000, system, messages,
            betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
          });
        } catch (e) { throw explain(Anthropic, e); }
        if (response.stop_reason === 'refusal') throw new ProviderError(`The model declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : '.'}`);
        return (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      },
    };
  }
  const headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  return {
    name, model, base_url: base,
    async listModels() {
      const { res, json } = await fetchJson(`${base}/models`, { headers }, 15000, `Could not reach ${base}`);
      if (res.status === 401) throw new ProviderError('The endpoint rejected the API key.');
      if (res.status !== 200) throw new ProviderError(`Listing models returned ${res.status}.`);
      return (json?.data || []).map((m) => m.id);
    },
    async complete(system, messages, { jsonMode = true } = {}) {
      const body = { model, messages: [{ role: 'system', content: system }, ...messages], temperature: 0.1 };
      if (jsonMode) body.response_format = { type: 'json_object' };
      const { res, text, json } = await fetchJson(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, timeout, `Could not reach ${base}`);
      if (res.status === 401) throw new ProviderError('The endpoint rejected the API key.');
      if (res.status !== 200) throw new ProviderError(`The model endpoint returned ${res.status}: ${text.slice(0, 200)}`);
      return json?.choices?.[0]?.message?.content || '';
    },
  };
}

/** The first JSON object in a reply, even when the model wrapped it in prose or a code fence. */
function extractJsonObject(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('The model returned nothing.');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const start = s.indexOf('{');
  if (start < 0) throw new Error("The model's reply contained no JSON object.");
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error("The model's reply contained an unterminated JSON object.");
}

module.exports = { ProviderError, buildProvider, providerCatalogue, extractJsonObject, SETTINGS_KEY: 'agent' };
