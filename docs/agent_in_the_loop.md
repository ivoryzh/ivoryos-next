# Agent in the loop

Describe a protocol in prose; get a workflow the scientist reviews, edits and saves. Works
from the Designer's own panel or from Claude Desktop, against the same tools either way.

## The shape of it

```
                      ┌─────────────────────────────┐
  Claude Desktop ────▶│  MCP server (stdio)         │──┐
  (or any MCP client) │  agent/mcp_server.py        │  │
                      └─────────────────────────────┘  │   ┌──────────────────────┐
                                                       ├──▶│  /api/agent/*        │
                      ┌─────────────────────────────┐  │   │  agent/routes.py     │
  Designer panel ────▶│  chat loop + provider       │──┘   └──────────┬───────────┘
  (AgentPanel.tsx)    │  agent/chat.py, providers.py│                 │
                      └─────────────────────────────┘                 ▼
                                                          ┌──────────────────────┐
                                                          │ deck.py   describe   │
                                                          │ validate.py  check   │
                                                          │ AgentProposal  queue │
                                                          └──────────┬───────────┘
                                                                     ▼
                                                        a person accepts or rejects
```

Two surfaces, one tool layer. Which model is driving and what a tool *does* are independent,
which is what makes swapping models a configuration change. The SaaS build is expected to run
hosted models through the same `providers.py`; the local build is expected to stop shipping an
LLM at all and keep only the MCP surface.

## Nothing an agent does takes effect on its own

Every write path files an `AgentProposal` and stops. There is exactly one route from "the model
suggested it" to "it happened", and a person stands in it.

| The agent can | The agent cannot |
| --- | --- |
| Read the deck, read saved workflows | Save a workflow |
| Validate a draft against the live deck | Queue or start a run |
| File a proposed workflow (reviewed as a diff) | Edit the canvas |
| Ask for a run (reviewed as "start this?") | Change settings, delete anything |

A `run` request is refused outright when the workflow leaves values open (`#variables`) and
none are supplied — otherwise a person would be approving a run guaranteed to stop partway
through, with reagent already in the vial. Accepting a workflow proposal re-validates it first,
because the deck can change between a model writing it and a person reading it.

## Why the validator carries the weight

`agent/validate.py` checks a body against the live schema before a scientist sees it, and the
translate loop feeds its errors straight back to the model, up to three attempts. Every mistake
a model plausibly makes here is mechanically detectable:

| It writes | Caught as |
| --- | --- |
| `centrifuge.spin(...)` on a deck with no centrifuge | unknown instrument, with the real list |
| `pump.aspirate(...)` | unknown method, with that instrument's real methods |
| `setpoint_c: "65 C"` | expects a number, no unit |
| `mode: "turbo"` | must be one of `["fast", "slow", "eco"]` |
| `#yield` before anything sets it | warning: nothing produces it |
| an `If` with no `End_If` | never closed |
| an objective bound to a `str` field | info: cannot be an optimization objective |

That last one is the quiet one — it is legal, and it is what silently leaves an optimization run
without the objective its author thought they configured.

The retry matters more than it sounds: an 8B local model gets an argument name or a unit wrong
often enough to be annoying, and gets it right when told exactly what was wrong, because these
messages name the field and list the legal alternatives.

## Setting up Claude Desktop (no API key, no cost)

1. Install the extra once:
   ```bash
   uv sync --extra mcp --project edge_server
   ```
2. Start the edge server as usual (`python example/demo.py`).
3. Add to `claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "ivoryos": {
         "command": "uv",
         "args": ["run", "--extra", "mcp", "--project",
                  "/absolute/path/to/ivoryos-nextgen/edge_server",
                  "python", "-m", "ivoryos_edge.agent.mcp_server"],
         "env": { "IVORYOS_URL": "http://localhost:8080" }
       }
     }
   }
   ```
4. Restart Claude Desktop. Ask it to read the deck and draft a protocol; its proposal appears in
   the Designer's assistant panel under "waiting for you".

Tools exposed: `list_deck`, `describe_instrument`, `describe_method`, `list_workflows`,
`get_workflow`, `validate_workflow`, `propose_workflow`, `request_run`, `list_proposals`.

## Setting up the in-app panel (Ollama)

```bash
ollama serve
ollama pull llama3.1
```

Open the Designer, click **Assistant**. With nothing configured it assumes Ollama on
`localhost:11434`; the gear picks the provider, endpoint and model, and the model list comes
from the provider itself rather than a hardcoded set. Settings live in `agent_settings.json`
beside the workflows directory; an API key is stored there and never sent back to the browser.

`providers.py` ships Ollama and an OpenAI-compatible provider — one entry covering Groq,
Together, OpenRouter, a local vLLM and OpenAI itself, since most hosted options differ only by
base URL and model name.

Ollama is the default deliberately: no key, no account, and an unpublished protocol never
leaves the building, which is usually what decides whether a lab may use this at all.

## Prompt size

`/api/status` is the wrong shape for a prompt — a modest deck is tens of thousands of tokens
once every widget-level detail is spelled out. `describe_deck` is lossy in one direction: keep
what is needed to choose a method and call it correctly, drop what is only needed to draw a
form. The summary view gives one line plus argument names per method; `describe_method` gives
the full shape for the one method the model settled on.

## Known limits

- **No streaming.** A reply arrives when the loop finishes, which on a local model is tens of
  seconds. The panel says what it is doing but shows no partial output.
- **No tool calling from the panel.** The loop asks for one JSON object and validates it, which
  is more reliable across small local models than a tool-calling protocol they support poorly.
  A provider that does support tools can be added without changing the contract.
- **The panel is Designer-only.** `cloud_frontend`'s editor has no equivalent yet.
- **Proposals are polled** every 5 seconds, not pushed over the existing websocket.
