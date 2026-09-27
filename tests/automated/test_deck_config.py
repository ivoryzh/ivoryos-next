"""Decks described as data (deck_config.py), the one data directory (paths.py), and the process
control the desktop app relies on (`python -m ivoryos_edge`, /api/system/restart)."""
import json
import os
import socket
import subprocess
import sys
import textwrap
import time

import httpx
import pytest

from ivoryos_edge.deck_config import load_deck

EDGE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "edge_server"))
EXAMPLE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "example"))


def _write_driver(folder, name="bench_drivers"):
    (folder / f"{name}.py").write_text(textwrap.dedent("""
        class Settings:
            def __init__(self, max_rate=1):
                self.max_rate = max_rate

        class Pump:
            def __init__(self, port="COM1", settings=None):
                self.port = port
                self.settings = settings
                self.connected = False
            def connect(self, retries=1):
                self.connected = retries
            def dispense(self, volume_ml: float) -> float:
                return volume_ml

        class Unplugged:
            def __init__(self, port):
                raise OSError(f"could not open {port}")

        class AsyncSetup:
            def __init__(self):
                self.ready = False
            async def connect(self):
                self.ready = True
    """))


def _deck(tmp_path, instruments, **extra):
    path = tmp_path / "deck.json"
    path.write_text(json.dumps({"format": "ivoryos-deck/1", "paths": ["."], "instruments": instruments, **extra}))
    return str(path)


def test_builds_instruments_with_nested_objects_and_setup_calls(tmp_path):
    _write_driver(tmp_path)
    loaded = load_deck(_deck(tmp_path, [
        {"name": "pump", "import": "bench_drivers", "class": "Pump",
         "args": {"port": "COM3", "settings": {"$object": {"import": "bench_drivers", "class": "Settings", "args": {"max_rate": 20}}}},
         "calls": [{"method": "connect", "args": {"retries": 3}}]},
        {"name": "async_thing", "import": "bench_drivers", "class": "AsyncSetup", "calls": [{"method": "connect"}]},
        {"name": "spare", "import": "bench_drivers", "class": "Unplugged", "enabled": False},
    ]))
    assert loaded.errors == []
    pump = loaded.instruments["pump"]
    assert (pump.port, pump.settings.max_rate, pump.connected) == ("COM3", 20, 3)
    assert loaded.instruments["async_thing"].ready is True
    assert "spare" not in loaded.instruments


def test_one_bad_instrument_does_not_stop_the_rest(tmp_path):
    _write_driver(tmp_path)
    loaded = load_deck(_deck(tmp_path, [
        {"name": "pump", "import": "bench_drivers", "class": "Pump"},
        {"name": "hplc", "import": "bench_drivers", "class": "Unplugged", "args": {"port": "COM9"}},
        {"name": "ghost", "import": "not_installed_anywhere", "class": "Thing"},
        {"name": "typo", "import": "bench_drivers", "class": "Pmup"},
        {"name": "flaky", "import": "bench_drivers", "class": "Pump", "calls": [{"method": "calibrate"}]},
        {"name": "pump", "import": "bench_drivers", "class": "Pump"},
        {"name": "2nd_pump", "import": "bench_drivers", "class": "Pump"},
    ]))
    assert list(loaded.instruments) == ["pump"]
    by_name = {(e["name"], e["stage"]): e for e in loaded.errors}
    assert "could not open COM9" in by_name[("hplc", "init")]["error"]
    assert ("ghost", "import") in by_name
    assert "has no class 'Pmup'" in by_name[("typo", "import")]["error"]
    assert ("flaky", "setup") in by_name
    assert "Two instruments are named 'pump'" in by_name[("pump", "config")]["error"]
    assert ("2nd_pump", "config") in by_name


def test_an_unreadable_deck_file_is_reported_not_raised(tmp_path):
    path = tmp_path / "deck.json"
    path.write_text("{ not json")
    loaded = load_deck(str(path))
    assert loaded.instruments == {}
    assert loaded.errors[0]["stage"] == "deck" and "not valid JSON" in loaded.errors[0]["error"]


def test_example_deck_matches_the_demo_script():
    loaded = load_deck(os.path.join(EXAMPLE_DIR, "deck.json"))
    assert loaded.errors == []
    assert set(loaded.instruments) == {"pump_1", "pump_2", "pump_3", "reactor", "balance", "uv_vis", "hplc"}


def test_data_dir_moves_every_path(tmp_path):
    code = "from ivoryos_edge import paths; import json; print(json.dumps({k: getattr(paths, k) for k in ('DB_PATH','WORKFLOWS_DIR','ENV_PATH','CERTS_DIR','OPTIMIZER_DATA_DIR','SCHEMA_DUMP_PATH')}))"
    out = subprocess.run([sys.executable, "-c", code], cwd=EDGE_DIR, capture_output=True, text=True,
                         env={**os.environ, "IVORYOS_DATA_DIR": str(tmp_path / "data")}, check=True)
    for value in json.loads(out.stdout).values():
        assert value.startswith(str(tmp_path / "data")), value


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_status(port, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return httpx.get(f"http://127.0.0.1:{port}/api/status", timeout=1).json()
        except Exception:
            time.sleep(0.2)
    raise AssertionError("edge server did not come up")


def _start(tmp_path, port, supervised):
    _write_driver(tmp_path)
    deck = _deck(tmp_path, [
        {"name": "pump", "import": "bench_drivers", "class": "Pump"},
        {"name": "hplc", "import": "bench_drivers", "class": "Unplugged", "args": {"port": "COM9"}},
    ])
    env = {**os.environ, "PYTHONPATH": EDGE_DIR}
    env.pop("CLOUD_TOKEN", None)
    if supervised:
        env["IVORYOS_SUPERVISED"] = "1"
    return subprocess.Popen(
        [sys.executable, "-m", "ivoryos_edge", "--deck", deck, "--data-dir", str(tmp_path / "data"),
         "--port", str(port), "--host", "127.0.0.1"],
        cwd=str(tmp_path), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def test_cli_runs_a_deck_and_restarts_itself_in_place(tmp_path):
    port = _free_port()
    proc = _start(tmp_path, port, supervised=False)
    try:
        status = _wait_for_status(port)
        assert list(status["instruments"]) == ["pump"]
        assert status["instrument_errors"][0]["name"] == "hplc"
        info = httpx.get(f"http://127.0.0.1:{port}/api/system").json()
        assert info["data_dir"] == str(tmp_path / "data") and info["supervised"] is False
        assert os.path.exists(tmp_path / "data" / "ivoryos_edge.db")

        restart = httpx.post(f"http://127.0.0.1:{port}/api/system/restart").json()
        assert restart["mode"] == "exec"
        time.sleep(1)
        assert list(_wait_for_status(port)["instruments"]) == ["pump"]
        # exec keeps the pid on POSIX: the same process, running a fresh interpreter.
        assert proc.poll() is None
    finally:
        proc.kill()
        proc.wait()


def test_supervised_restart_exits_with_the_restart_code(tmp_path):
    port = _free_port()
    proc = _start(tmp_path, port, supervised=True)
    try:
        _wait_for_status(port)
        assert httpx.post(f"http://127.0.0.1:{port}/api/system/restart").json()["mode"] == "supervisor"
        assert proc.wait(timeout=10) == 75
    finally:
        if proc.poll() is None:
            proc.kill()
