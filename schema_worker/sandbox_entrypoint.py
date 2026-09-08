"""Runs *inside* the disposable sandbox container — never in the long-lived worker process.

Installs the target package into a scratch directory (not system site-packages, since the
container's root filesystem is mounted read-only) and runs extract_cli.py against it. This file
is the only thing that ever touches attacker-controlled code (pip's install hooks, the package's
own import-time side effects); the worker process that launches this container never does.

Two ways the result gets back to whoever asked for it:
  - Local docker path (main.py's /extract): the caller captures this process's stdout directly.
  - Fly Machines path (fly_launcher.py's /extract/async): nobody is attached to this process's
    stdout once it's running as a detached cloud VM, so when --callback_url is given, the result
    is POSTed there instead (in addition to still printing, which is harmless and useful in logs).
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

PKG_DIR = "/tmp/pkgs"
INSTALL_TIMEOUT_S = 90
EXTRACT_TIMEOUT_S = 30
CALLBACK_TIMEOUT_S = 10


def report(payload: dict, callback_url: str, job_id: str, exit_code: int) -> None:
    if job_id:
        payload = {"job_id": job_id, **payload}
    print(json.dumps(payload))
    if callback_url:
        req = urllib.request.Request(
            callback_url,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=CALLBACK_TIMEOUT_S)
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            # Nothing useful to do here — stdout already has the real result for log-based
            # recovery — but don't let a flaky callback endpoint mask a successful extraction
            # with a non-zero exit code.
            print(json.dumps({"warning": f"callback POST failed: {e}"}))
    sys.exit(exit_code)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("module_name")
    parser.add_argument("--install_url", default=None)
    parser.add_argument("--class_name", default=None)
    parser.add_argument("--callback_url", default=None)
    parser.add_argument("--job_id", default=None)
    args = parser.parse_args()

    def fail(message: str) -> None:
        report({"error": message}, args.callback_url, args.job_id, exit_code=1)

    env = dict(os.environ)

    if args.install_url:
        os.makedirs(PKG_DIR, exist_ok=True)
        try:
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "--no-cache-dir", "--target", PKG_DIR, args.install_url],
                check=True, capture_output=True, text=True, timeout=INSTALL_TIMEOUT_S,
            )
        except subprocess.CalledProcessError as e:
            fail(f"Failed to install {args.install_url}: {e.stderr[-2000:]}")
            return
        except subprocess.TimeoutExpired:
            fail(f"Installing {args.install_url} timed out after {INSTALL_TIMEOUT_S}s")
            return
        env["PYTHONPATH"] = PKG_DIR + os.pathsep + env.get("PYTHONPATH", "")

    cmd = [sys.executable, "/app/extract_cli.py", args.module_name]
    if args.class_name:
        cmd.extend(["--class_name", args.class_name])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=EXTRACT_TIMEOUT_S, env=env)
    except subprocess.TimeoutExpired:
        fail(f"Extraction timed out after {EXTRACT_TIMEOUT_S}s — the module likely has a blocking import-time side effect")
        return

    if not result.stdout.strip():
        fail(result.stderr[-2000:] or "Extraction failed with no output")
        return

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        fail(f"extract_cli.py produced non-JSON output: {result.stdout[-2000:]}")
        return

    report(payload, args.callback_url, args.job_id, exit_code=result.returncode)


if __name__ == "__main__":
    main()
