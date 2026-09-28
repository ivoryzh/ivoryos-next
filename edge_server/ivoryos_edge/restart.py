"""Restarting an edge that no supervisor watches, on Windows.

A restart must be a new process: Python cannot reliably unload a driver or let go of a serial
port it holds. With the desktop app that is easy (the edge exits with RESTART_EXIT_CODE and the
app starts it again). From a terminal, on macOS and Linux, the edge execs itself: same pid, fresh
interpreter, and the terminal keeps it.

Windows has no exec. os.execv there starts the new program and ends the calling process, so the
terminal sees its program finish, prints its prompt, and the edge carries on detached from it.
So on Windows `python -m ivoryos_edge` runs as a small loop that never loads a driver, with the
edge as its child: a restart is the child exiting with RESTART_EXIT_CODE (which frees its port
and every instrument handle), and the loop starting a fresh one. The terminal owns the loop
throughout, and Ctrl+C reaches both (every process on a console gets it).

The loop has to start before any instrument is created, which the CLI can guarantee: it runs
first thing, before the deck is read. A script calling ivoryos_edge.run() at its end has already
built its instruments by then, and a loop at that point would hold their ports while its child
tried to open them, so scripts keep exec (see server._relaunch).

Kept free of imports from the rest of the package: the loop process must not open the database
or fix the data paths (paths.py), since it is not the edge.
"""
import os
import subprocess
import sys

# Asks whatever started this process to start it again. 75 is EX_TEMPFAIL in sysexits.h:
# "try again", which is what a restart is. The desktop app uses the same code.
RESTART_EXIT_CODE = 75

# Set by the loop on its child: "restart by exiting with RESTART_EXIT_CODE; I will start you
# again". Internal; the desktop app's IVORYOS_SUPERVISED means the same to the edge, but also
# that the desktop app is in charge, which /api/system reports.
LOOP_ENV = "IVORYOS_RESTART_LOOP_CHILD"


def restart_by_exit() -> bool:
    """Whether a restart should just exit with RESTART_EXIT_CODE (someone will start us again)."""
    return os.environ.get("IVORYOS_SUPERVISED") == "1" or os.environ.get(LOOP_ENV) == "1"


def needs_loop() -> bool:
    """On Windows, from a terminal: run the edge as a child of a restart loop."""
    return sys.platform == "win32" and not restart_by_exit()


def _kill_with_parent():
    """A Windows job object whose processes end when this process does, however it ends.

    Windows does not take children down with their parent: a loop killed from Task Manager (or by
    a test's proc.kill()) would leave the edge running, holding its port and serial ports, with
    nothing left to stop it. A job with KILL_ON_JOB_CLOSE is closed by the OS when the loop dies,
    and that ends the edge too. The loop puts *itself* in the job, so every process it starts
    afterwards is in it from its first instant (in a venv the child is a launcher that starts the
    real interpreter as a grandchild, which assigning the child afterwards could miss).
    Best effort: without it the loop still works. Returns whether it took effect.
    """
    try:
        import ctypes
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class BASIC_LIMITS(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD),
            ]

        class EXTENDED_LIMITS(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BASIC_LIMITS), ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # Declared, not left to ctypes' int default: handles are pointer-sized, and the current
        # process's pseudo-handle (-1) overflows a C int.
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.GetCurrentProcess.argtypes = []
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return False
        limits = EXTENDED_LIMITS()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):  # 9: ExtendedLimitInformation
            return False
        # The handle is deliberately never closed: it closes when this process ends, which is
        # the moment the job should take its processes down.
        return bool(kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess()))
    except Exception:
        return False


def run_loop(command: list, *, popen=subprocess.Popen) -> int:
    """Run `command` until it exits with anything but RESTART_EXIT_CODE; return that exit code."""
    env = {**os.environ, LOOP_ENV: "1"}
    if sys.platform == "win32" and popen is subprocess.Popen:
        _kill_with_parent()
    while True:
        child = popen(command, env=env)
        try:
            code = child.wait()
        except KeyboardInterrupt:
            # Ctrl+C went to the child as well; let it shut down (close ports, the database)
            # rather than killing it, unless it will not.
            try:
                code = child.wait(timeout=15)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                child.kill()
                code = child.wait()
            return code
        if code != RESTART_EXIT_CODE:
            return code
        print("Restarting the edge...", flush=True)
