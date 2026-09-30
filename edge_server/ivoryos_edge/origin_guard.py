"""Keep other websites from driving this edge.

The edge listens on this computer (and often the lab network) and moves real hardware. A browser
will happily let any website it has open send requests there: a page on example.com can POST to
http://127.0.0.1:8080/api/execute. CORS does not stop that, it only stops the page *reading* the
answer, and the damage (a pump moving, a run queued, the edge re-paired to someone else's Cloud)
is done by the request itself. So every request passes two checks here:

1. **Origin.** A browser labels each request with the page it came from. Requests that change
   something (anything but GET/HEAD/OPTIONS) and WebSocket connections must come from:
     - no Origin at all: the desktop app's main process, `ivoryos-edge pair`, curl, the MCP
       server, tests (a browser always sends one for these);
     - this edge's own pages (Origin matches the Host they were sent to);
     - the desktop launcher (`ivoryos-app://`);
     - a page served from this computer (`localhost`, `127.0.0.1`, `[::1]`): `next dev` on
       another port during development.
2. **Host.** DNS rebinding points an attacker's own domain at 127.0.0.1 after the page loads, so
   its requests look same-origin (Origin and Host are both evil.example). Such a request still
   names the attacker's domain in its Host header, which a real request never does. Allowed
   hosts: IP addresses, `localhost` (and `*.localhost`), `*.local` (mDNS on a lab network), this
   computer's own name, and whatever IVORYOS_ALLOWED_HOSTS lists (comma separated; `*` turns
   the check off, for an edge behind a reverse proxy that checks hosts itself).

Reading is covered by CORS (CORS_ORIGIN_REGEX): only the launcher and pages on this computer
may read cross-origin; the edge's own pages are same-origin and need no CORS at all.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
from typing import Optional
from urllib.parse import urlsplit

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

# Who may read the edge's answers from another origin (CORSMiddleware allow_origin_regex).
CORS_ORIGIN_REGEX = r"^(ivoryos-app://[^/]+|https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?)$"
_TRUSTED_ORIGIN = re.compile(CORS_ORIGIN_REGEX)

_MACHINE_NAMES: Optional[set] = None


def _machine_names() -> set:
    global _MACHINE_NAMES
    if _MACHINE_NAMES is None:
        names = set()
        for get in (socket.gethostname, socket.getfqdn):
            try:
                names.add(get().lower())
            except OSError:
                pass
        _MACHINE_NAMES = {n for n in names if n}
    return _MACHINE_NAMES


def _extra_hosts() -> set:
    # Read per request, not at import: a test or a launcher can set it after this module loads.
    return {h.strip().lower() for h in os.environ.get("IVORYOS_ALLOWED_HOSTS", "").split(",") if h.strip()}


def _hostname(host_header: str) -> str:
    """`[::1]:8080` -> `::1`, `Lab-PC:8080` -> `lab-pc`."""
    host = (host_header or "").strip().lower()
    if host.startswith("["):
        return host[1:host.find("]")] if "]" in host else host[1:]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def host_allowed(host_header: str) -> bool:
    extra = _extra_hosts()
    if "*" in extra:
        return True
    host = _hostname(host_header)
    if not host:
        return True  # HTTP/1.0 without Host: not something a browser sends
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local"):
        return True
    return host in _machine_names() or host in extra


def origin_allowed(origin: Optional[str], host_header: str) -> bool:
    if not origin:
        return True
    if _TRUSTED_ORIGIN.match(origin):
        return True
    # "null" (a sandboxed frame, a file:// page) has no host and never matches.
    return urlsplit(origin).netloc.lower() == (host_header or "").strip().lower()


class OriginGuard:
    """ASGI middleware applying both checks to every HTTP request and WebSocket connection."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        host = headers.get("host", "")
        origin = headers.get("origin")

        problem = None
        if not host_allowed(host):
            problem = (f"This edge does not answer to the name '{_hostname(host)}'. If that is a real name for it "
                       f"on your network, add it to IVORYOS_ALLOWED_HOSTS.")
        elif (scope["type"] == "websocket" or scope.get("method", "GET") not in SAFE_METHODS) \
                and not origin_allowed(origin, host):
            problem = "Requests from other websites cannot control this edge. Use its own pages or the IvoryOS app."

        if problem is None:
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            await receive()  # websocket.connect
            await send({"type": "websocket.close", "code": 1008, "reason": "refused"})
            return
        body = json.dumps({"error": problem}).encode()
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
