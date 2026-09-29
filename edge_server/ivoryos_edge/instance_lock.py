"""One edge per data folder.

A data folder is one edge's identity: its database, its saved workflows, and the `.env` holding
its Cloud pairing. Two processes on the same folder are two copies of one edge (the same script
started from a terminal and from the desktop app, say): they open the same instruments, write
the same database, and use the same Cloud client id, so they evict each other from Cloud once a
second. None of that fails cleanly on its own. So the second one refuses to start, and says who
already has the folder.

An OS file lock, not a pid file: the OS releases it when the holder exits, however it exits, so a
crashed edge never leaves a stale lock behind. It is held for the life of the process. Python
opens files non-inheritable, so an edge that restarts by exec releases it and the new image takes
it again; the Windows restart loop never takes it (it is not the edge; restart.py).
"""
import json
import os
import sys
import time

LOCK_NAME = ".ivoryos_edge.lock"
# Windows locks byte ranges, and a locked range cannot be read by anyone else; lock one byte far
# past the details so a refused process can still read who holds the folder.
_LOCK_OFFSET = 1 << 20

_held = {}  # folder -> open file, kept for the life of the process


class AlreadyRunning(RuntimeError):
    def __init__(self, folder, holder):
        self.folder, self.holder = folder, holder or {}
        who = []
        if self.holder.get("pid"):
            who.append(f"process {self.holder['pid']}")
        if self.holder.get("command"):
            who.append(f"`{self.holder['command']}`")
        if self.holder.get("started"):
            who.append(f"started {self.holder['started']}")
        super().__init__(
            f"Another IvoryOS edge is already running with this data folder ({folder})"
            + (f": {', '.join(who)}" if who else "")
            + ". Two copies would fight over its instruments, its database and its Cloud identity. "
              "Stop that one first, or give this one its own folder (--data-dir, or IVORYOS_DATA_DIR)."
        )


def _try_lock(handle) -> bool:
    try:
        if sys.platform == "win32":
            import msvcrt
            handle.seek(_LOCK_OFFSET)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _read_holder(path):
    try:
        with open(path, "rb") as f:
            return json.loads(f.read(4096).split(b"\n", 1)[0] or b"{}")
    except (OSError, ValueError):
        return None


def acquire(folder: str) -> str:
    """Hold the folder for this process, or raise AlreadyRunning. Idempotent within a process."""
    folder = os.path.abspath(folder)
    if folder in _held:
        return folder
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, LOCK_NAME)
    # Binary and never truncated before the lock is ours: text-mode seeks and Windows byte-range
    # locks do not mix, and truncating first would wipe the holder's details a refused process
    # reads back.
    handle = open(path, "r+b" if os.path.exists(path) else "w+b")
    if not _try_lock(handle):
        handle.close()
        raise AlreadyRunning(folder, _read_holder(path))
    details = {
        "pid": os.getpid(),
        "command": " ".join(os.path.basename(a) if i == 0 else a for i, a in enumerate(getattr(sys, "orig_argv", sys.argv))),
        "started": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    handle.seek(0)
    handle.truncate()
    handle.write((json.dumps(details) + "\n").encode("utf-8"))
    handle.flush()
    _held[folder] = handle
    return folder


def acquire_or_exit(folder: str):
    """For entry points: refuse to start with one readable line, instead of a traceback.

    The line starts with "Cannot start:", which the desktop app shows as the reason."""
    try:
        return acquire(folder)
    except AlreadyRunning as e:
        print(f"Cannot start: {e}", file=sys.stderr, flush=True)
        sys.exit(1)
