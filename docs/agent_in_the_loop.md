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

## Watching it work

`POST /api/agent/chat/stream` is the same translation reported as it happens, as SSE. The panel
uses it; `/api/agent/chat` stays for anything that just wants the result. A real exchange, with
a model that got the first draft wrong:

```
  0.0s  reading_deck   {'instruments': 7}
  0.0s  drafting       {'attempt': 1, 'max_attempts': 3}
  3.0s  validating     {'attempt': 1, 'steps': 9, 'name': 'Suzuki coupling, 65 C'}
  3.0s  found_problems - script[3]: 'setpoint_c' expects a number (float) but got '65 C'.
                       - script[4]: 'reactor' has no method 'warm_up'.
  3.0s  drafting       {'attempt': 2, 'max_attempts': 3}
  6.0s  validating     {'attempt': 2, 'steps': 8}
  6.0s  valid          {'attempt': 2, 'steps': 8}
  6.0s  filed          proposal #10, ok=True, attempts=2
```

What is streamed is the loop, not the tokens. The interesting part of a translation is the
check-and-correct cycle — "wrote 9 steps, two were wrong, fixing" tells a waiting scientist both
that it is working and roughly how well, which a token stream does not. Token streaming remains
possible (the provider interface would need a streaming `complete`) but buys much less.

### Trying it without a model

There is no fake provider in the codebase. To exercise the panel on a machine with no Ollama,
run something that speaks `/api/tags` and `/api/chat` on port 11434 and point the settings at
it; returning a deliberately wrong first draft and a corrected second is what makes the retry
cycle visible.

## Known limits

- **No token streaming.** Phase progress is streamed (above), but not partial text.
- **No tool calling from the panel.** The loop asks for one JSON object and validates it, which
  is more reliable across small local models than a tool-calling protocol they support poorly.
  A provider that does support tools can be added without changing the contract.
- **The panel is Designer-only.** `cloud_frontend`'s editor has no equivalent yet.
- **Proposals are polled** every 5 seconds, not pushed over the existing websocket.


## The same assistant in Cloud

The Orchestrator has an **Assistant** button in its header. It is the design above ported to
Node (`cloud_frontend/src/lib/agent/`), not a call to an edge's `/api/agent`: Cloud has no HTTP
path to a device, and a Cloud workflow spans several.

What differs:

- **Target first.** The panel asks what you are designing for: all devices, one platform (a
  device group from the Devices page), or one device. The model is told only about those
  devices' instruments and saved workflows, which is also what keeps the prompt small.
- **Workflows are the unit.** A device's saved workflow is offered as one step (`Library
  Workflows`, its inputs as args, its outputs readable by later steps), and the prompt says to
  prefer it over spelling out instrument methods. A long task on one device is one node.
- **The model writes a graph spec, not nodes.** A flat list of steps with `after` dependencies
  (and a branch name after an `If`). `graphSpec.js` validates every step against the real device
  schemas, then materializes the spec into the exact node and edge objects a drag-drop makes,
  laid out by depth, and runs `validateGraph` on the result. Errors go back to the model, three
  attempts at most, then the draft is handed over with its problems listed.
- **Settings** (provider, endpoint, key, model) are one row for the whole Cloud in
  `cloud_settings` (Supabase migration `0013_cloud_settings.sql`; in LAN mode the SQLite table is
  created on start). Env vars `IVORYOS_LLM_PROVIDER`, `OLLAMA_URL`, `OLLAMA_MODEL`,
  `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY` are the fallback.

What is the same: one JSON object back, the validate-and-retry loop, the progress log, and the
human gate. "Put on canvas" is the only way a proposal reaches the canvas, and Run is a person's
click as before.

### Cloud's MCP server and proposals

Cloud has the same two surfaces as the edge. Proposals are stored (`agent_proposals`, migration
0014), whether they came from the panel's own loop or from outside, and the panel shows the
outside ones under "Waiting for you". `POST /api/agent/propose` files one (422 with the errors if
it does not validate, unless `allow_invalid`); `/accept` saves it to the Cloud library (or, with
`save: false`, records that it was taken onto the canvas); `/reject` dismisses it.

An outside agent authenticates with an **agent token**: Settings -> Agent access mints one
(`ivc_...`, shown once, hash stored, standing for one workspace). Sent as
`Authorization: Bearer`, it may read the workspace and file proposals; it cannot accept, run or
switch workspace. `npm run mcp` in `cloud_frontend` (`scripts/mcp-server.js`) is the stdio MCP
server, a thin proxy over those routes with `list_lab`, `validate_workflow`, `propose_workflow`
and `list_proposals`, configured by `IVORYOS_CLOUD_URL` and `IVORYOS_CLOUD_TOKEN`. For Claude
Desktop:

```json
{ "mcpServers": { "ivoryos-cloud": { "command": "node", "args": ["<repo>/cloud_frontend/scripts/mcp-server.js"],
  "env": { "IVORYOS_CLOUD_URL": "https://cloud.ivoryos.app", "IVORYOS_CLOUD_TOKEN": "ivc_..." } } } }
```


## Using Claude

Two different things, easy to confuse:

- **Claude as the panel's model.** Pick the `anthropic` provider in the panel's settings (edge
  or Cloud). The edge needs `pip install 'ivoryos-edge[claude]'`; Cloud ships the SDK. A key is
  optional: Anthropic's SDK also reads `ANTHROPIC_API_KEY` or an `ant auth login` profile on the
  machine the edge runs on. The default model is `claude-opus-5-5`, with the server-side refusal
  fallback turned on so a declined request is re-run on a fallback model inside the same call.
- **Claude as the agent, through MCP.** Claude Desktop or Claude Code connects to
  `python -m ivoryos_edge.agent.mcp_server` (env `IVORYOS_URL`), gets the nine tools, and drives
  them itself: read the deck, validate, propose, request a run. The proposals land in the same
  inbox the panel shows, behind the same human gate. This needs no provider setting at all.
