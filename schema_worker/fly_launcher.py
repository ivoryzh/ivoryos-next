"""Launches one ephemeral Fly.io Machine to run a single schema-extraction job.

This exists because the local `docker run` path in main.py needs a Docker daemon reachable from
wherever this process runs — true on a VM you control, false on Vercel/any serverless host. Fly
Machines are the same idea (a disposable, resource-capped sandbox running the same image built
from this directory's Dockerfile) launched over a plain HTTPS API call instead, so the caller
(e.g. a Vercel API route) never needs Docker access at all — it only needs an HTTPS client.

NOT YET VERIFIED AGAINST THE LIVE FLY API — written from documented Machines API shape, but there
is no Fly account/token available in this environment to actually call it. Before relying on this,
run one real launch by hand (see the one-time setup below) and fix anything the real API rejects.

One-time setup (do this once, not per job):
    fly apps create <your-app-name>
    fly auth docker && docker build -t registry.fly.io/<your-app-name>:latest ./schema_worker \
        && docker push registry.fly.io/<your-app-name>:latest
    export FLY_API_TOKEN=$(fly auth token)
    export FLY_APP_NAME=<your-app-name>
"""
import json
import os
import urllib.error
import urllib.request
from typing import Optional

FLY_API_BASE = "https://api.machines.dev/v1"


class FlyLaunchError(Exception):
    pass


def launch_extraction_machine(
    module_name: str,
    job_id: str,
    callback_url: str,
    install_url: Optional[str] = None,
    class_name: Optional[str] = None,
    region: Optional[str] = None,
) -> str:
    """Starts a Machine that runs sandbox_entrypoint.py and POSTs its result to `callback_url`
    when done — this function does not wait for that; it returns as soon as the Machine is
    accepted for creation. Returns the Fly machine id (useful for logs/manual cleanup).
    """
    token = os.environ.get("FLY_API_TOKEN")
    app_name = os.environ.get("FLY_APP_NAME")
    if not token or not app_name:
        raise FlyLaunchError("FLY_API_TOKEN and FLY_APP_NAME must be set to launch a Fly Machine")
    image = os.environ.get("FLY_SANDBOX_IMAGE", f"registry.fly.io/{app_name}:latest")

    cmd = ["python", "/app/sandbox_entrypoint.py", module_name, "--job_id", job_id, "--callback_url", callback_url]
    if install_url:
        cmd.extend(["--install_url", install_url])
    if class_name:
        cmd.extend(["--class_name", class_name])

    body = {
        "config": {
            "image": image,
            "guest": {"cpu_kind": "shared", "cpus": 1, "memory_mb": 256},
            "init": {"cmd": cmd},
            # Mirrors the local docker path's intent: the Machine tears itself down once the
            # command exits (success or failure) instead of sitting around billable and idle.
            "auto_destroy": True,
            "restart": {"policy": "no"},
        },
    }
    if region:
        body["region"] = region

    req = urllib.request.Request(
        f"{FLY_API_BASE}/apps/{app_name}/machines",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise FlyLaunchError(f"Fly API rejected the machine ({e.code}): {e.read().decode()[:500]}") from e
    return data["id"]
