"""IvoryOS Schema Worker.

Extracts a JSON schema from an arbitrary, user-submitted Python package by running the
install+import step in a disposable, resource-limited container per request — never in this
process. This process only ever shells out to `docker run --rm ...`; it never pip-installs or
imports the target package itself. See DEPLOYMENT below for how that split has to be deployed
to actually mean something.

DEPLOYMENT — two independent ways to launch a sandbox job, pick based on where THIS process runs:

  /extract (synchronous, local Docker) needs a `docker` binary on PATH and a reachable Docker
  daemon — i.e. this process itself must run on a real host, NOT a serverless platform (Vercel
  and most PaaS/FaaS hosts give you no Docker daemon access at all). Two ways to satisfy that:
    (a) As a plain process on a host that has Docker installed (not itself containerized).
        Simplest — the daemon it talks to is the host's own.
    (b) Inside a container with /var/run/docker.sock mounted in (the "sibling containers"
        pattern; needs the `docker` CLI installed in this image too). Convenient for
        docker-compose-style deployment, but mounting the socket gives this container
        root-equivalent control of the *host's* Docker daemon — acceptable only because this
        process's own code is small, reviewed, and never executes attacker-controlled input
        directly.
  Either way, build the sandbox image once (`docker build -t ivoryos-schema-worker .` — same
  image serves both the API and the disposable sandbox) before the first request.

  /extract/async (Fly.io Machines) is what to use when THIS worker itself runs somewhere without
  Docker access — e.g. called from a Vercel API route, or run as a Vercel/Lambda function itself.
  No Docker daemon needed here at all: it makes a plain HTTPS call to Fly's API, which boots a
  disposable micro-VM from the same image and runs the job there. Returns immediately; the result
  is POSTed to the caller-supplied `callback_url` once the job finishes (see fly_launcher.py and
  sandbox_entrypoint.py's `report()`). Needs FLY_API_TOKEN and FLY_APP_NAME set — see
  fly_launcher.py's docstring for the one-time Fly app setup. NOT YET VERIFIED against the live
  Fly API (no account/token available while writing this) — test one real call before depending
  on it, and fix anything the real API rejects.
"""
import json
import os
import subprocess
import uuid
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from fly_launcher import launch_extraction_machine, FlyLaunchError

app = FastAPI(title="IvoryOS Schema Worker")

SANDBOX_IMAGE = os.environ.get("SANDBOX_IMAGE", "ivoryos-schema-worker:latest")
# Generous enough to cover pip install + import + inspection for a typical package; short enough
# that one hung/malicious submission can't tie up the worker indefinitely.
CONTAINER_TIMEOUT_S = 130


@app.get("/")
async def serve_ui():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    return FileResponse(os.path.join(base_dir, "static", "index.html"))


class ExtractRequest(BaseModel):
    install_url: Optional[str] = None
    module_name: str
    class_name: Optional[str] = None


@app.post("/extract")
async def extract_schema(req: ExtractRequest):
    # A unique, predictable container name lets us force-kill it by name if the client-side
    # subprocess.run() timeout fires — relying on the docker CLI's own process exit to also
    # stop the container is not guaranteed.
    job_id = f"ivoryos-extract-{uuid.uuid4().hex[:12]}"

    cmd = [
        "docker", "run", "--rm", "--name", job_id,
        # Hardening — all of this applies to the disposable sandbox container, never to this
        # worker process itself:
        "--memory", "256m", "--memory-swap", "256m",  # no swap headroom to escape the memory cap
        "--cpus", "1.0",
        "--pids-limit", "128",                         # fork-bomb guard
        "--read-only",                                  # root fs is immutable; only /tmp is writable
        "--tmpfs", "/tmp:rw,size=128m,exec",
        "--user", "1000:1000",                          # never runs as root
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        # TODO(v2): restrict --network to an egress allowlist (pypi.org, files.pythonhosted.org,
        # github.com) via a proxy container instead of the default bridge, which currently allows
        # unrestricted outbound access from inside the sandbox.
        SANDBOX_IMAGE,
        "python", "/app/sandbox_entrypoint.py", req.module_name,
    ]
    if req.install_url:
        cmd.extend(["--install_url", req.install_url])
    if req.class_name:
        cmd.extend(["--class_name", req.class_name])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=CONTAINER_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        subprocess.run(["docker", "kill", job_id], capture_output=True)
        raise HTTPException(status_code=504, detail="Schema extraction timed out")

    if result.returncode != 0:
        try:
            err_data = json.loads(result.stdout)
            raise HTTPException(status_code=400, detail=err_data.get("error", "Unknown extraction error"))
        except json.JSONDecodeError:
            detail = (result.stderr or result.stdout or "Sandbox container failed to start")[-2000:]
            raise HTTPException(status_code=500, detail=f"Sandbox failed: {detail}")

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail=f"Failed to parse extraction output: {result.stdout[-2000:]}")


class AsyncExtractRequest(ExtractRequest):
    # The caller (e.g. a Hub API route) owns persistence — this worker stores nothing and is
    # never told what a "module" is. It just launches the job and forgets about it; the sandbox
    # reports its own result straight back to whatever URL the caller gives it.
    callback_url: str
    job_id: Optional[str] = None


@app.post("/extract/async", status_code=202)
async def extract_schema_async(req: AsyncExtractRequest):
    """Fire-and-forget: launches a Fly Machine and returns immediately. The result (success or
    error) arrives later as a POST to `req.callback_url`, shaped like sandbox_entrypoint.py's
    `report()` output: {"job_id": ..., "module": ..., "schemas": {...}} or {"job_id": ..., "error": ...}.
    """
    job_id = req.job_id or f"ivoryos-extract-{uuid.uuid4().hex[:12]}"
    try:
        machine_id = launch_extraction_machine(
            module_name=req.module_name,
            job_id=job_id,
            callback_url=req.callback_url,
            install_url=req.install_url,
            class_name=req.class_name,
        )
    except FlyLaunchError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"job_id": job_id, "machine_id": machine_id, "status": "started"}
