"""An MCP server that puts a running IvoryOS deck in front of Claude Desktop (or any MCP client).

This process holds no logic of its own. It is stdio in front of the same /api/agent endpoints
the Designer's chat panel calls, so "which model is driving" and "what a tool does" stay
independent — that separation is what makes swapping in another model later a configuration
change rather than a rewrite.

Run it from a Claude Desktop config entry:

    {
      "mcpServers": {
        "ivoryos": {
          "command": "uv",
          "args": ["run", "--extra", "mcp", "--project", "/path/to/ivoryos-nextgen/edge_server",
                   "python", "-m", "ivoryos_edge.agent.mcp_server"],
          "env": {"IVORYOS_URL": "http://localhost:8080"}
        }
      }
    }

The edge server must already be running; this talks to it over HTTP like any other client.
"""

import os
import sys

import httpx

# MCP 2.x renamed FastMCP to MCPServer; both names are handled so this runs against either
# SDK generation rather than pinning the lab to one.
try:
    from mcp.server.mcpserver import MCPServer
except ImportError:  # pragma: no cover - SDK v1, or the extra isn't installed
    try:
        from mcp.server.fastmcp import FastMCP as MCPServer
    except ImportError:
        print(
            "The MCP server needs the 'mcp' package:\n"
            "    uv sync --extra mcp --project edge_server\n"
            "or:  pip install mcp",
            file=sys.stderr,
        )
        raise SystemExit(1)

IVORYOS_URL = os.environ.get("IVORYOS_URL", "http://localhost:8080").rstrip("/")
SOURCE = os.environ.get("IVORYOS_AGENT_SOURCE", "mcp:claude-desktop")
TIMEOUT = float(os.environ.get("IVORYOS_TIMEOUT", "30"))

server = MCPServer("ivoryos")


def _get(path, **params):
    try:
        response = httpx.get(f"{IVORYOS_URL}{path}", params=params or None, timeout=TIMEOUT)
    except httpx.RequestError as e:
        return {"error": f"Cannot reach IvoryOS at {IVORYOS_URL}: {e}. Is the edge server running?"}
    return _unwrap(response)


def _post(path, payload):
    try:
        response = httpx.post(f"{IVORYOS_URL}{path}", json=payload, timeout=TIMEOUT)
    except httpx.RequestError as e:
        return {"error": f"Cannot reach IvoryOS at {IVORYOS_URL}: {e}. Is the edge server running?"}
    return _unwrap(response)


def _unwrap(response):
    try:
        body = response.json()
    except ValueError:
        return {"error": f"IvoryOS returned {response.status_code} with a non-JSON body."}
    if response.status_code >= 400 and isinstance(body, dict):
        body.setdefault("error", f"IvoryOS returned {response.status_code}.")
    return body


@server.tool()
def list_deck() -> dict:
    """List every instrument on this lab's deck with a one-line summary of each method.

    Start here. The summary names each method's required and optional arguments and which of
    its results are numbers, which is enough to choose what to call. Use describe_instrument
    for the full argument detail of the one you settle on.
    """
    return _get("/api/agent/deck")


@server.tool()
def describe_instrument(instrument: str) -> dict:
    """Full argument detail for every method on one instrument: types, defaults, allowed values
    for enums, and the individual result fields each method exposes."""
    return _get("/api/agent/deck", instrument=instrument)


@server.tool()
def describe_method(instrument: str, method: str) -> dict:
    """The exact call shape of one method, including which result fields are numeric and can
    therefore be used as an optimization objective."""
    return _get(f"/api/agent/deck/{instrument}/{method}")


@server.tool()
def list_workflows() -> dict:
    """The protocols already saved in this lab's library, with their step counts."""
    return _get("/api/agent/workflows")


@server.tool()
def get_workflow(name: str) -> dict:
    """Read one saved workflow's full body — the starting point for modifying an existing
    protocol rather than writing a new one."""
    return _get(f"/api/agent/workflows/{name}")


@server.tool()
def validate_workflow(body: dict) -> dict:
    """Check a workflow body against the live deck without saving anything.

    Call this on every draft before proposing it. It catches invented methods, missing or
    mistyped arguments (including numbers written with their units), variables nothing
    produces, unclosed If/While blocks, and results bound to fields that do not exist. Fix
    what it reports and validate again — a proposal with errors wastes the scientist's review.
    """
    return _post("/api/agent/validate", {"body": body})


@server.tool()
def propose_workflow(name: str, body: dict, summary: str) -> dict:
    """Put a workflow in front of the scientist for review. This does not save it.

    It appears in IvoryOS as a pending proposal, shown as a diff against whatever is currently
    saved under that name, and takes effect only if a person accepts it. Use `summary` to say
    in plain language what the protocol does and, when modifying an existing one, what you
    changed and why — that text is what they read before the diff.

    A workflow body is {name, description, prep: [], script: [], cleanup: []}. Each step is
    {instrument, action, args: {...}}; prep runs once at the start, script is the part repeated
    per sample or per optimization trial, cleanup runs once at the end. To save a result, add
    "return": "var_name" and "return_bindings": [{"path": "<a save_from value>", "var": "var_name"}].
    """
    return _post("/api/agent/propose", {
        "name": name, "body": body, "summary": summary, "source": SOURCE,
    })


@server.tool()
def request_run(name: str, summary: str, variables: dict | None = None) -> dict:
    """Ask for a saved workflow to be queued on the real hardware.

    This does not start anything. It files a request that a person has to accept in IvoryOS —
    deliberately, because this moves liquid and applies heat. Say in `summary` why you believe
    it is ready to run, and tell the scientist you have asked rather than implying it started.

    A workflow that leaves values open (#variables) cannot run without them: pass them in
    `variables` as {"name": value}. If you do not know what they should be, ask the scientist
    rather than choosing for them — these are reagent volumes and temperatures.
    """
    payload = {"name": name, "summary": summary, "source": SOURCE}
    if variables:
        payload["variables"] = variables
    return _post("/api/agent/request-run", payload)


@server.tool()
def list_proposals(status: str = "pending") -> dict:
    """Check what you have already put forward and whether it was accepted or rejected.

    A rejection usually carries a note saying why; read it before proposing a replacement.
    """
    return _get("/api/agent/proposals", status=status)


def main():
    server.run("stdio")


if __name__ == "__main__":
    main()
