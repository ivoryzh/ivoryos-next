"""Where the words come from.

Deliberately the only module that knows a model exists. Everything else in `agent/` works on
decks, workflow bodies and proposals, so switching provider — or running the same panel against
a hosted model in the SaaS build and a local one in the lab — is a change here and nowhere else.

A provider does two things: say which models it can offer, and turn a conversation into text.
No streaming and no tool-calling protocol, on purpose: small local models are unreliable at
tool calling but broadly fine at emitting one JSON object, and `chat.py` gets the same
reliability from a validate-and-retry loop without depending on a capability the model may not
have. A provider that *does* support tools can still be added without changing that contract.
"""

import json
import os

import httpx

DEFAULT_TIMEOUT = float(os.environ.get("IVORYOS_LLM_TIMEOUT", "180"))


class ProviderError(RuntimeError):
    """Something went wrong talking to the model, phrased for the scientist rather than the log."""


class Provider:
    name = "base"
    #: False for providers that cannot be reached without a key, so the UI can say so up front.
    needs_api_key = False

    def __init__(self, base_url=None, api_key=None, model=None, timeout=DEFAULT_TIMEOUT):
        self.base_url = (base_url or self.default_base_url).rstrip("/")
        self.api_key = api_key
        self.model = model or self.default_model
        self.timeout = timeout

    default_base_url = ""
    default_model = ""

    async def list_models(self):
        raise NotImplementedError

    async def complete(self, system, messages, json_mode=False):
        raise NotImplementedError


class OllamaProvider(Provider):
    """A model running on the lab's own machine.

    The default because it needs no key and no account, and because an unpublished protocol
    never leaves the building — which is the part that actually decides whether a lab is
    allowed to use this at all.
    """

    name = "ollama"
    default_base_url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    default_model = os.environ.get("OLLAMA_MODEL", "llama3.1")

    async def list_models(self):
        async with httpx.AsyncClient(timeout=10) as client:
            try:
                response = await client.get(f"{self.base_url}/api/tags")
            except httpx.RequestError as e:
                raise ProviderError(
                    f"No Ollama at {self.base_url}. Start it with `ollama serve`, "
                    f"then pull a model with `ollama pull {self.default_model}`. ({e})"
                )
        if response.status_code != 200:
            raise ProviderError(f"Ollama returned {response.status_code} listing models.")
        return [m["name"] for m in response.json().get("models", [])]

    async def complete(self, system, messages, json_mode=False):
        payload = {
            "model": self.model,
            "messages": ([{"role": "system", "content": system}] if system else []) + messages,
            "stream": False,
            # Near-deterministic: this is translation, and a protocol that comes out different
            # every time it is asked for is not reviewable.
            "options": {"temperature": 0.1},
        }
        if json_mode:
            payload["format"] = "json"
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                response = await client.post(f"{self.base_url}/api/chat", json=payload)
            except httpx.RequestError as e:
                raise ProviderError(f"Could not reach Ollama at {self.base_url}: {e}")
        if response.status_code == 404:
            raise ProviderError(
                f"Ollama has no model called '{self.model}'. Pull it with `ollama pull {self.model}`."
            )
        if response.status_code != 200:
            raise ProviderError(f"Ollama returned {response.status_code}: {response.text[:200]}")
        return (response.json().get("message") or {}).get("content", "")


class OpenAICompatibleProvider(Provider):
    """Anything speaking the OpenAI chat-completions shape.

    One entry covers Groq, Together, OpenRouter, a local vLLM and OpenAI itself, which is what
    "model agnostic" means in practice — most hosted options are reachable by changing a URL
    and a model name rather than by writing another provider.
    """

    name = "openai-compatible"
    needs_api_key = True
    default_base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    default_model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

    def _headers(self):
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def list_models(self):
        async with httpx.AsyncClient(timeout=15) as client:
            try:
                response = await client.get(f"{self.base_url}/models", headers=self._headers())
            except httpx.RequestError as e:
                raise ProviderError(f"Could not reach {self.base_url}: {e}")
        if response.status_code == 401:
            raise ProviderError("The endpoint rejected the API key.")
        if response.status_code != 200:
            raise ProviderError(f"Listing models returned {response.status_code}.")
        return [m["id"] for m in response.json().get("data", [])]

    async def complete(self, system, messages, json_mode=False):
        payload = {
            "model": self.model,
            "messages": ([{"role": "system", "content": system}] if system else []) + messages,
            "temperature": 0.1,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                response = await client.post(
                    f"{self.base_url}/chat/completions", json=payload, headers=self._headers()
                )
            except httpx.RequestError as e:
                raise ProviderError(f"Could not reach {self.base_url}: {e}")
        if response.status_code == 401:
            raise ProviderError("The endpoint rejected the API key.")
        if response.status_code != 200:
            raise ProviderError(f"The model endpoint returned {response.status_code}: {response.text[:200]}")
        choices = response.json().get("choices") or [{}]
        return (choices[0].get("message") or {}).get("content", "")


PROVIDERS = {
    OllamaProvider.name: OllamaProvider,
    OpenAICompatibleProvider.name: OpenAICompatibleProvider,
}


def build_provider(settings):
    """Instantiate whichever provider the settings name, defaulting to a local Ollama."""
    name = (settings or {}).get("provider") or OllamaProvider.name
    cls = PROVIDERS.get(name)
    if cls is None:
        raise ProviderError(f"No provider called '{name}'. Available: {', '.join(sorted(PROVIDERS))}.")
    return cls(
        base_url=(settings or {}).get("base_url") or None,
        api_key=(settings or {}).get("api_key") or None,
        model=(settings or {}).get("model") or None,
    )


def provider_catalogue():
    """What the settings UI offers, without instantiating or contacting anything."""
    return [
        {
            "name": cls.name,
            "default_base_url": cls.default_base_url,
            "default_model": cls.default_model,
            "needs_api_key": cls.needs_api_key,
        }
        for cls in PROVIDERS.values()
    ]


def extract_json_object(text):
    """Pull the one JSON object out of a model's reply.

    Even in JSON mode a local model will wrap its answer in ```json fences or add a sentence of
    preamble. Failing the whole turn over that would be a bad trade, so the object is recovered
    by brace matching when a plain parse fails; a genuinely malformed reply still raises and is
    handled as a retry.
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("The model returned nothing.")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    if start == -1:
        raise ValueError("The model's reply contained no JSON object.")
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start:index + 1])
    raise ValueError("The model's reply contained an unterminated JSON object.")
