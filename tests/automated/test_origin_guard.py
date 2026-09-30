"""Other websites must not drive the edge (ivoryos_edge/origin_guard.py).

A page open in the person's browser can send requests to the edge on their machine. CORS only
hides the answer; the request itself still moves hardware. So changes and WebSockets are refused
from other sites, a Host that is not this machine's (DNS rebinding) is refused outright, and only
trusted origins may read cross-origin.
"""
import socket

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from ivoryos_edge import origin_guard
from ivoryos_edge.origin_guard import host_allowed, origin_allowed
from ivoryos_edge.server import app

EDGE = "http://127.0.0.1:8080"
EVIL = "https://evil.example"

asyncio_test = pytest.mark.asyncio


@pytest.mark.parametrize("host", [
    "127.0.0.1:8080", "10.0.0.42:8080", "[::1]:8080", "localhost:8080", "edge.localhost",
    "lab-pc.local:8080", socket.gethostname() + ":8080",
])
def test_names_of_this_machine_are_answered(host):
    assert host_allowed(host)


@pytest.mark.parametrize("host", ["evil.example", "evil.example:8080", "127.0.0.1.evil.example"])
def test_other_names_are_refused(host, monkeypatch):
    monkeypatch.setenv("IVORYOS_ALLOWED_HOSTS", "")
    assert not host_allowed(host)


def test_a_deployment_can_add_its_own_names(monkeypatch):
    monkeypatch.setenv("IVORYOS_ALLOWED_HOSTS", "edge.lab.example, other.example")
    assert host_allowed("Edge.Lab.Example:443") and host_allowed("other.example")
    monkeypatch.setenv("IVORYOS_ALLOWED_HOSTS", "*")
    assert host_allowed("anything.example")


@pytest.mark.parametrize("origin,allowed", [
    (None, True),                          # the app's main process, curl, the CLI
    ("http://127.0.0.1:8080", True),       # the edge's own pages
    ("ivoryos-app://ui", True),            # the desktop launcher
    ("http://localhost:3001", True),       # next dev on this computer
    ("http://[::1]:3001", True),
    (EVIL, False),
    ("null", False),                       # sandboxed frame, file:// page
    ("http://127.0.0.1.evil.example", False),
    ("http://127.0.0.1:9999", True),       # another port on this computer is still this computer
])
def test_origins(origin, allowed):
    assert origin_allowed(origin, "127.0.0.1:8080") is allowed


def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url=EDGE)


@pytest.mark.parametrize("method,path,body", [
    ("POST", "/api/execute", {"module": "pump", "method": "dispense", "args": {}}),
    ("POST", "/api/queue/runs", {"name": "x", "sequence": []}),
    ("POST", "/api/system/restart", None),
    ("POST", "/api/cloud-settings", {"token": ""}),
    ("DELETE", "/api/workflows/anything", None),
])
@asyncio_test
async def test_another_site_cannot_change_anything(method, path, body):
    async with client() as ac:
        res = await ac.request(method, path, json=body, headers={"Origin": EVIL})
    assert res.status_code == 403
    assert "other websites" in res.json()["error"]


@pytest.mark.parametrize("origin", [None, EDGE, "ivoryos-app://ui", "http://localhost:3001"])
@asyncio_test
async def test_trusted_callers_reach_the_routes(origin):
    # An instrument that does not exist: the route answers (404), so the guard let it through,
    # and nothing moves.
    async with client() as ac:
        res = await ac.post("/api/execute", json={"module": "no_such_instrument", "method": "x", "args": {}},
                            headers={"Origin": origin} if origin else {})
    assert res.status_code != 403, res.text


@asyncio_test
async def test_dns_rebinding_is_refused_even_for_reading(monkeypatch):
    monkeypatch.setenv("IVORYOS_ALLOWED_HOSTS", "")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://evil.example:8080") as ac:
        res = await ac.get("/api/status", headers={"Origin": "http://evil.example:8080"})
    assert res.status_code == 403
    assert "IVORYOS_ALLOWED_HOSTS" in res.json()["error"]


@asyncio_test
async def test_only_trusted_origins_may_read_cross_origin():
    async with client() as ac:
        theirs = await ac.get("/api/plugins", headers={"Origin": EVIL})
        launcher = await ac.get("/api/plugins", headers={"Origin": "ivoryos-app://ui"})
        preflight = await ac.options("/api/execute", headers={"Origin": EVIL, "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in theirs.headers
    assert launcher.headers["access-control-allow-origin"] == "ivoryos-app://ui"
    assert preflight.headers.get("access-control-allow-origin") != EVIL


def test_websockets_from_another_site_are_closed():
    # Refused before any handler runs, so the real app is fine here.
    tc = TestClient(app, base_url=EDGE)
    with pytest.raises(WebSocketDisconnect) as refused:
        with tc.websocket_connect("/api/ws/queue", headers={"Origin": EVIL}):
            pass
    assert refused.value.code == 1008

    # Let through: shown on a bare app behind the same guard. The real /api/ws/queue reads the
    # database as it opens, and in one test process that shared engine does not survive the
    # event loops of earlier tests (it hangs after any asyncio.run); an edge has one loop.
    from fastapi import FastAPI, WebSocket
    bare = FastAPI()

    @bare.websocket("/ws")
    async def echo(websocket: WebSocket):
        await websocket.accept()
        await websocket.send_text("hello")
        await websocket.close()

    bare.add_middleware(origin_guard.OriginGuard)
    with TestClient(bare, base_url=EDGE).websocket_connect("/ws", headers={"Origin": EDGE}) as ws:
        assert ws.receive_text() == "hello"


def test_machine_names_are_looked_up_once(monkeypatch):
    monkeypatch.setattr(origin_guard, "_MACHINE_NAMES", None)
    calls = []
    monkeypatch.setattr(origin_guard.socket, "gethostname", lambda: calls.append(1) or "Bench-PC")
    monkeypatch.setattr(origin_guard.socket, "getfqdn", lambda: "bench-pc.lab.internal")
    assert host_allowed("bench-pc:8080") and host_allowed("BENCH-PC.lab.internal")
    host_allowed("bench-pc")
    assert len(calls) == 1
