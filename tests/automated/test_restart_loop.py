"""The Windows restart loop (ivoryos_edge/restart.py): `python -m ivoryos_edge` from a terminal runs
the edge as a child, restarts it when it exits with RESTART_EXIT_CODE, and stays the process the
terminal owns, because Windows has no exec."""
import os
import subprocess
import sys
import time

import pytest

from ivoryos_edge import restart
from ivoryos_edge.restart import LOOP_ENV, RESTART_EXIT_CODE, needs_loop, run_loop


class FakeChild:
    def __init__(self, codes, interrupt=False, stubborn=False):
        self.codes, self.interrupt, self.stubborn, self.killed = codes, interrupt, stubborn, False

    def wait(self, timeout=None):
        if self.interrupt:
            self.interrupt = False
            raise KeyboardInterrupt
        if self.stubborn and timeout is not None and not self.killed:
            raise subprocess.TimeoutExpired("edge", timeout)
        return self.codes.pop(0) if not self.killed else 1

    def kill(self):
        self.killed = True


def fake_popen(children):
    started = []

    def popen(command, env):
        started.append(env)
        return children.pop(0)
    return popen, started


def test_restarts_on_the_restart_code_and_returns_any_other():
    popen, started = fake_popen([FakeChild([RESTART_EXIT_CODE]), FakeChild([RESTART_EXIT_CODE]), FakeChild([3])])
    assert run_loop(["edge"], popen=popen) == 3
    assert len(started) == 3
    assert all(env[LOOP_ENV] == "1" for env in started), "the child restarts by exiting"


def test_ctrl_c_lets_the_edge_stop_and_ends_the_loop():
    popen, started = fake_popen([FakeChild([0], interrupt=True)])
    assert run_loop(["edge"], popen=popen) == 0
    assert len(started) == 1, "no restart after Ctrl+C"


def test_an_edge_that_ignores_ctrl_c_is_killed():
    child = FakeChild([], interrupt=True, stubborn=True)
    popen, _ = fake_popen([child])
    run_loop(["edge"], popen=popen)
    assert child.killed


def test_the_loop_is_only_for_an_unsupervised_edge_on_windows(monkeypatch):
    monkeypatch.delenv("IVORYOS_SUPERVISED", raising=False)
    monkeypatch.delenv(LOOP_ENV, raising=False)
    monkeypatch.setattr(restart.sys, "platform", "win32")
    assert needs_loop()
    monkeypatch.setenv("IVORYOS_SUPERVISED", "1")  # the desktop app restarts it itself
    assert not needs_loop()
    monkeypatch.delenv("IVORYOS_SUPERVISED")
    monkeypatch.setenv(LOOP_ENV, "1")  # already the loop's child
    assert not needs_loop()
    monkeypatch.delenv(LOOP_ENV)
    monkeypatch.setattr(restart.sys, "platform", "darwin")  # exec works there
    assert not needs_loop()


def _alive(pid):
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
    return str(pid) in out


@pytest.mark.skipif(sys.platform != "win32", reason="Windows does not end children with their parent; this is the fix for that")
def test_killing_the_loop_ends_the_edge_too(tmp_path):
    # The base interpreter, not a venv launcher, so the process killed below is the loop itself.
    python = getattr(sys, "_base_executable", sys.executable)
    pid_file = tmp_path / "edge.pid"
    edge = f"import os, time; open(r'{pid_file}', 'w').write(str(os.getpid())); time.sleep(120)"
    loop = subprocess.Popen(
        [python, "-c", f"import sys; from ivoryos_edge.restart import run_loop; sys.exit(run_loop([sys.executable, '-c', {edge!r}]))"],
        env={**os.environ, "PYTHONPATH": os.path.join(os.path.dirname(__file__), "..", "..", "edge_server")},
    )
    try:
        deadline = time.time() + 20
        while not pid_file.exists() and time.time() < deadline:
            time.sleep(0.1)
        edge_pid = int(pid_file.read_text())
        assert _alive(edge_pid)
        loop.kill()
        loop.wait()
        deadline = time.time() + 5
        while _alive(edge_pid) and time.time() < deadline:
            time.sleep(0.1)
        assert not _alive(edge_pid), "the edge outlived its loop and would keep holding its ports"
    finally:
        if loop.poll() is None:
            loop.kill()
