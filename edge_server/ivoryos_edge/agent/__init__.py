"""The agent tool layer: what an assistant is allowed to know and to ask for.

One layer, two surfaces. `routes.py` publishes it over HTTP under /api/agent; the MCP server
(`ivoryos_edge.agent.mcp_server`) is a thin stdio process that calls those same endpoints, and
the Designer's chat panel calls them from the browser. Adding a third surface, or swapping which
model is driving, should never mean reimplementing what a tool *does* — which is the whole
reason this is a module and not a pile of route handlers.
"""

from ivoryos_edge.agent.deck import describe_deck, describe_method
from ivoryos_edge.agent.validate import validate_body, summarise

__all__ = ["describe_deck", "describe_method", "validate_body", "summarise"]
