"""Python plugins (ivoryos_edge/plugins.py): a plugin must work with the deck's own instrument
objects, never construct a second copy -- a second copy reopens the serial port the first one
holds. These tests count constructions in a file, so a copy made in *any* module or process shows.
"""

import asyncio
import json
import os
import socket
import subprocess
import sys
import textwrap
import threading
import time

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ivoryos_edge.introspection import inspect_device_module, resolve_callable
from ivoryos_edge.plugins import Plugin, load_plugin_refs, start_plugin

EDGE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) + "/edge_server"

DRIVER = '''
import os

def _log(what):
    with open(os.environ["CONSTRUCTION_LOG"], "a") as f:
        f.write(what + "\\n")

class Shaker:
    """Stands in for a serial instrument: constructing it "opens the port"."""
    def __init__(self, port="COM3"):
        _log(f"Shaker({port})")
        self.port = port
        self.rpm = 0

    def shake(self, rpm: int, seconds: float = 1.0) -> int:
        self.rpm = rpm
        return rpm

    async def stop(self) -> None:
        self.rpm = 0
'''

PLUGIN = '''
from ivoryos_edge.plugins import Plugin

plugin = Plugin("Shaker view", page="page", placement="panel-right")
seen = []

@plugin.on_start
def setup(instruments):
    plugin.observe("shaker", lambda event: seen.append(event["method"]), methods=["shake"])

@plugin.router.get("/api/state")
def state():
    shaker = plugin.instrument("shaker")
    return {"rpm": shaker.rpm, "object": id(shaker), "seen": seen}
'''


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait(port, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return httpx.get(f"http://127.0.0.1:{port}/api/status", timeout=1).json()
        except Exception:
            time.sleep(0.2)
    raise AssertionError("edge server did not come up")


def _execute(port, module, method, args):
    task = httpx.post(f"http://127.0.0.1:{port}/api/execute", json={"module": module, "method": method, "args": args}).json()
    for _ in range(50):
        result = httpx.get(f"http://127.0.0.1:{port}/api/execute/{task['task_id']}").json()
        if result["status"] != "running":
            return result
        time.sleep(0.1)
    raise AssertionError("step did not finish")


def _plugin_files(folder):
    (folder / "bench.py").write_text(DRIVER)
    (folder / "shaker_view.py").write_text(PLUGIN)
    (folder / "page").mkdir()
    (folder / "page" / "index.html").write_text("<h1>Shaker view</h1>")


def _spawn(args, cwd, log):
    env = {**os.environ, "PYTHONPATH": EDGE_DIR, "CONSTRUCTION_LOG": str(log)}
    env.pop("CLOUD_TOKEN", None)
    return subprocess.Popen([sys.executable, *args], cwd=str(cwd), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def test_a_deck_file_plugin_gets_the_objects_the_deck_built(tmp_path):
    """Through the real CLI: the plugin reads the object the edge executes steps on."""
    _plugin_files(tmp_path)
    deck = tmp_path / "deck.json"
    deck.write_text(json.dumps({
        "format": "ivoryos-deck/1", "paths": ["."], "plugins": ["shaker_view:plugin", "missing_module:plugin"],
        "instruments": [{"name": "shaker", "import": "bench", "class": "Shaker", "args": {"port": "COM7"}}],
    }))
    log, port = tmp_path / "constructed.log", _free_port()
    proc = _spawn(["-m", "ivoryos_edge", "--deck", str(deck), "--data-dir", str(tmp_path / "data"),
                   "--port", str(port), "--host", "127.0.0.1"], tmp_path, log)
    try:
        status = _wait(port)
        # observe() kept the method's real signature, so the Designer still offers `rpm`.
        assert set(status["instruments"]["shaker"]["shake"]["parameters"]) == {"rpm", "seconds"}

        assert _execute(port, "shaker", "shake", {"rpm": "900"})["result"] == 900
        state = httpx.get(f"http://127.0.0.1:{port}/plugins/shaker_view/api/state").json()
        assert state["rpm"] == 900          # the step changed the very object the plugin reads
        assert state["seen"] == ["shake"]   # and the plugin observed it happen
        assert log.read_text().splitlines() == ["Shaker(COM7)"]  # constructed once, by the deck

        listing = httpx.get(f"http://127.0.0.1:{port}/api/plugins").json()
        mine = next(p for p in listing["plugins"] if p["id"] == "shaker_view")
        assert (mine["url"], mine["placement"], mine["kind"]) == ("/plugins/shaker_view/", "panel-right", "python")
        assert listing["errors"][0]["plugin"] == "missing_module:plugin"   # reported, not fatal
        page = httpx.get(f"http://127.0.0.1:{port}/plugins/shaker_view/")
        assert "Shaker view" in page.text
        # Rechecked on every load, or an edited plugin keeps running its old JavaScript.
        assert page.headers["cache-control"] == "no-cache"
        again = httpx.get(f"http://127.0.0.1:{port}/plugins/shaker_view/", headers={"If-None-Match": page.headers["etag"]})
        assert again.status_code == 304
    finally:
        proc.kill()
        proc.wait()


def test_a_script_plugin_that_imports_the_script_does_not_rebuild_it(tmp_path):
    """The legacy habit: a plugin does `import demo` to reach the instruments. Run as
    `python demo.py`, the script is `__main__`, and without the alias that import executes the
    file again -- constructing every instrument a second time."""
    _plugin_files(tmp_path)
    (tmp_path / "legacy_view.py").write_text(textwrap.dedent('''
        from ivoryos_edge.plugins import Plugin
        plugin = Plugin("Legacy view")

        @plugin.router.get("/api/same")
        def same():
            import my_deck                      # imported lazily, inside the route
            return {"same": my_deck.shaker is plugin.instrument("shaker")}
    '''))
    port = _free_port()
    (tmp_path / "my_deck.py").write_text(textwrap.dedent(f'''
        import ivoryos_edge
        from bench import Shaker
        from legacy_view import plugin

        shaker = Shaker("COM9")

        if __name__ == "__main__":
            ivoryos_edge.run(__name__, port={port}, host="127.0.0.1", plugins=[plugin])
    '''))
    log = tmp_path / "constructed.log"
    proc = _spawn(["my_deck.py"], tmp_path, log)
    try:
        status = _wait(port)
        assert list(status["instruments"]) == ["shaker"]      # the Plugin object is not an instrument
        assert httpx.get(f"http://127.0.0.1:{port}/plugins/legacy_view/api/same").json() == {"same": True}
        assert log.read_text().splitlines() == ["Shaker(COM9)"]
    finally:
        proc.kill()
        proc.wait()


# --- in-process: the pieces on their own -----------------------------------------------------------


def _load_bench(tmp_path, monkeypatch):
    (tmp_path / "bench_mod.py").write_text(DRIVER)
    monkeypatch.setenv("CONSTRUCTION_LOG", str(tmp_path / "log"))
    monkeypatch.syspath_prepend(str(tmp_path))
    import importlib
    return importlib.import_module("bench_mod")


def test_observe_keeps_signatures_and_async_methods_async(tmp_path, monkeypatch):
    bench = _load_bench(tmp_path, monkeypatch)
    shaker, other = bench.Shaker(), bench.Shaker()
    before = inspect_device_module(shaker)
    events = []
    plugin = Plugin("p")
    plugin.instruments = {"shaker": shaker}
    plugin.observe("shaker", events.append)

    assert inspect_device_module(shaker) == before
    assert asyncio.iscoroutinefunction(resolve_callable(shaker, "stop"))
    shaker.shake(rpm=300)
    asyncio.run(shaker.stop())
    assert [(e["instrument"], e["method"]) for e in events] == [("shaker", "shake"), ("shaker", "stop")]
    assert events[0]["args"] == {"rpm": 300} and events[0]["result"] == 300
    other.shake(rpm=5)                       # only the observed instance is wrapped
    assert len(events) == 2


def test_observe_can_report_the_start_of_each_call(tmp_path, monkeypatch):
    bench = _load_bench(tmp_path, monkeypatch)
    events = []
    plugin = Plugin("p")
    plugin.instruments = {"shaker": bench.Shaker()}
    plugin.observe("shaker", events.append, methods=["shake", "stop"], starts=True)
    plugin.instrument("shaker").shake(rpm=5)
    asyncio.run(plugin.instrument("shaker").stop())
    assert [(e["phase"], e["method"]) for e in events] == [("start", "shake"), ("end", "shake"), ("start", "stop"), ("end", "stop")]
    assert events[0]["args"] == {"rpm": 5} and "result" not in events[0]


def test_a_failing_callback_never_fails_the_step(tmp_path, monkeypatch):
    bench = _load_bench(tmp_path, monkeypatch)
    plugin = Plugin("p")
    plugin.instruments = {"shaker": bench.Shaker()}
    plugin.observe("shaker", lambda e: 1 / 0, methods=["shake"])
    assert plugin.instrument("shaker").shake(rpm=10) == 10


def test_publish_reaches_open_pages_from_any_thread():
    app = FastAPI()
    plugin = Plugin("Live")
    start_plugin(app, plugin, {})
    plugin.publish({"n": 0})
    with TestClient(app).websocket_connect("/plugins/live/events") as ws:
        assert ws.receive_json() == {"n": 0}          # the latest state, on connect
        worker = threading.Thread(target=plugin.publish, args=({"n": 1},))
        worker.start()
        worker.join()
        assert ws.receive_json() == {"n": 1}


def test_unknown_instrument_names_what_is_loaded():
    plugin = Plugin("p")
    plugin.instruments = {"pump": object()}
    with pytest.raises(KeyError, match=r"'balance'.*loaded: pump"):
        plugin.instrument("balance")


def test_load_plugin_refs_reports_bad_entries():
    plugins, errors = load_plugin_refs(["json:dumps", "no_such_module_xyz"])
    assert plugins == []
    assert [e["plugin"] for e in errors] == ["json:dumps", "no_such_module_xyz"]
    assert "not an ivoryos_edge.plugins.Plugin" in errors[0]["error"]


def test_a_failing_on_start_is_reported_and_the_plugin_still_served():
    app = FastAPI()
    plugin = Plugin("Broken")

    @plugin.on_start
    def boom(instruments):
        raise RuntimeError("no calibration file")

    @plugin.router.get("/api/ping")
    def ping():
        return {"ok": True}

    error = start_plugin(app, plugin, {})
    assert error["stage"] == "on_start" and "no calibration file" in error["error"]
    assert TestClient(app).get("/plugins/broken/api/ping").json() == {"ok": True}
