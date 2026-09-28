"""One edge per data folder (ivoryos_edge/instance_lock.py): a second copy refuses to start and
says who has the folder; the lock goes away with its holder, however it ends."""
import os
import subprocess
import sys
import time

from ivoryos_edge import instance_lock

EDGE_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "edge_server")


def _holder(folder, ready_file):
    """A process that takes the folder, says so, and waits to be killed."""
    code = (
        "import sys, time; from ivoryos_edge.instance_lock import acquire; "
        f"acquire(r'{folder}'); open(r'{ready_file}', 'w').write('ok'); time.sleep(60)"
    )
    return subprocess.Popen([sys.executable, "-c", code], env={**os.environ, "PYTHONPATH": EDGE_DIR})


def _wait(path, timeout=20):
    deadline = time.time() + timeout
    while not os.path.exists(path) and time.time() < deadline:
        time.sleep(0.05)
    assert os.path.exists(path), "holder never took the lock"


def _second(folder):
    code = f"from ivoryos_edge.instance_lock import acquire_or_exit; acquire_or_exit(r'{folder}'); print('got it')"
    return subprocess.run([sys.executable, "-c", code], env={**os.environ, "PYTHONPATH": EDGE_DIR},
                          capture_output=True, text=True, timeout=60)


def _kill(proc):
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.kill()
    proc.wait()


def test_a_second_copy_on_the_same_folder_is_refused_and_told_who_has_it(tmp_path):
    folder, ready = tmp_path / "edge", tmp_path / "ready"
    first = _holder(folder, ready)
    try:
        _wait(ready)
        second = _second(folder)
        assert second.returncode == 1
        assert second.stderr.startswith("Cannot start: Another IvoryOS edge is already running")
        assert str(folder) in second.stderr
        # The holder's own details, read past the lock (Windows locks a byte range far from them).
        details = open(folder / instance_lock.LOCK_NAME, "rb").read()
        assert b'"pid"' in details
    finally:
        _kill(first)
    # Gone with its holder, even killed: no stale lock to clear by hand.
    assert _second(folder).stdout.strip() == "got it"


def test_different_folders_do_not_interfere(tmp_path):
    ready = tmp_path / "ready"
    first = _holder(tmp_path / "a", ready)
    try:
        _wait(ready)
        assert _second(tmp_path / "b").stdout.strip() == "got it"
    finally:
        _kill(first)


def test_taking_it_twice_in_one_process_is_fine(tmp_path):
    folder = str(tmp_path / "same")
    try:
        assert instance_lock.acquire(folder) == instance_lock.acquire(folder)
    finally:
        instance_lock._held.pop(os.path.abspath(folder)).close()
