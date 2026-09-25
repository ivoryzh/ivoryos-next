import os
import asyncio
import inspect
import sys
import time
import uuid
import httpx
import base64
import json
from typing import Dict, Any, Optional
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from dotenv import load_dotenv

from .introspection import inspect_device_module
from .models import init_db, async_session, WorkflowRun
from sqlalchemy import func, select
from .queue import WorkflowQueueManager
from . import deck
from . import runtime
from . import workflows as wf
from .workflows import WorkflowError, expand_workflow_blocks

ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
load_dotenv(ENV_PATH)

app = FastAPI(title="IvoryOS Edge Server")
queue_manager = WorkflowQueueManager(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CLOUD_TOKEN = os.getenv("CLOUD_TOKEN", "")
global_broker = None
global_topic_prefix = None
global_client_id = None
# Surfaces *why* a connection attempt failed (bad cert, wrong endpoint, refused, timed out) so the
# Cloud Connect page can show an actionable message instead of just a red X — previously a failure
# in setup_broker() only ever reached a server-side print(), invisible to the frontend entirely.
cloud_connection_state = "disconnected"  # "disconnected" | "connecting" | "connected" | "error"
cloud_connection_error = None
# Where we are paired, for the Cloud Connect page. Derived from the token at connect time so the
# UI can say something useful without ever being handed the token itself.
cloud_broker_url = None

class CloudSettingsRequest(BaseModel):
    token: str

# The Cloud URL only has to be supplied on a LAN, where Cloud lives at some arbitrary local
# address. A hosted deployment is at a fixed, known URL, so the device ships with it and the
# person types only the pairing code. IVORYOS_CLOUD_URL overrides it for staging or self-hosting.
DEFAULT_CLOUD_URL = os.getenv("IVORYOS_CLOUD_URL", "https://cloud.ivoryos.app")

class CloudPairRequest(BaseModel):
    code: str
    cloud_url: str = ""

@app.get("/api/cloud-settings")
def get_cloud_settings():
    """Deliberately does NOT return CLOUD_TOKEN.

    It used to, and the Cloud Connect page rendered it in a textarea — which on AWS meant this
    device's **private key** was displayed to anyone who opened that page, and sat in the DOM and
    in the browser's memory for as long as it was open. The page only ever needed to know whether
    the device is paired and where, so that is all it gets now. The token remains settable (POST
    below, or the CLOUD_TOKEN env var for headless provisioning) — it is just no longer readable
    back out over HTTP.
    """
    return {
        "paired": bool(CLOUD_TOKEN),
        "client_id": global_client_id,
        "broker": cloud_broker_url,
        "connection_state": cloud_connection_state,
        "connection_error": cloud_connection_error,
    }

@app.post("/api/cloud-settings/pair")
async def pair_with_cloud(req: CloudPairRequest):
    """Exchange a pairing code for this device's connection token, then connect.

    Redemption happens here, server-side, rather than from the browser: it keeps the token (which
    on AWS contains this device's private key) out of the page and off any clipboard, and avoids
    needing CORS on Cloud. What replaced carrying a base64 blob between two machines by hand is
    one short code typed into this form.
    """
    cloud_url = (req.cloud_url or DEFAULT_CLOUD_URL).strip().rstrip("/")
    if not cloud_url:
        return JSONResponse(status_code=400, content={"error": "A Cloud URL is required."})
    if not req.code.strip():
        return JSONResponse(status_code=400, content={"error": "A pairing code is required."})

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{cloud_url}/api/pair/redeem", json={"code": req.code})
        data = resp.json()
    except Exception as e:
        # Reaching Cloud over HTTP is the one new prerequisite pairing introduces, and on a LAN a
        # wrong address is the likeliest mistake — so say which address failed.
        return JSONResponse(
            status_code=502,
            content={"error": f"Could not reach Cloud at {cloud_url}: {e}"},
        )

    if resp.status_code != 200 or not data.get("token"):
        return JSONResponse(
            status_code=resp.status_code if resp.status_code != 200 else 502,
            content={"error": data.get("error") or "Pairing failed."},
        )

    # Reuse the existing token path verbatim — pairing only changes how the token is *obtained*,
    # never what it is or how it is applied, so there is one code path for connecting.
    return await update_cloud_settings(CloudSettingsRequest(token=data["token"]))


@app.post("/api/cloud-settings")
async def update_cloud_settings(req: CloudSettingsRequest):
    global CLOUD_TOKEN
    CLOUD_TOKEN = req.token

    # Save to .env
    env_lines = []
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH, "r") as f:
            env_lines = f.readlines()

    token_found = False
    for i, line in enumerate(env_lines):
        if line.startswith("CLOUD_TOKEN="):
            env_lines[i] = f"CLOUD_TOKEN={CLOUD_TOKEN}\n"
            token_found = True

    if not token_found:
        env_lines.append(f"CLOUD_TOKEN={CLOUD_TOKEN}\n")

    with open(ENV_PATH, "w") as f:
        f.writelines(env_lines)

    # Awaited (not fire-and-forget) so this response IS the validation result — the frontend
    # doesn't need a separate poll loop to find out whether the token actually works.
    await setup_broker()

    # Clearing the token is a deliberate, successful disconnect, not a failed connection attempt —
    # only report "error" when a token was actually supplied and it failed to connect.
    succeeded = (not CLOUD_TOKEN) or cloud_connection_state == "connected"
    return {
        "status": "success" if succeeded else "error",
        "connection_state": cloud_connection_state,
        "connection_error": cloud_connection_error,
    }

from .broker import LocalMQTTBroker, AWSIoTBroker


# What each workflow's runtime was when last published, so a finished run only re-sends the
# workflows whose typical duration actually moved (each sequence message is a whole body, and AWS
# IoT meters them in 5KB steps).
_published_runtime: dict = {}


def republish_changed_runtimes():
    """Re-send the retained sequence message of every workflow whose timing changed."""
    if not (global_broker and global_topic_prefix and global_client_id):
        return
    try:
        current = runtime.workflow_runtimes()
        for name in wf.list_workflow_names(WORKFLOWS_DIR):
            if current.get(name) == _published_runtime.get(name):
                continue
            body = wf.read_head(WORKFLOWS_DIR, name)
            global_broker.publish(
                f"{global_topic_prefix}/{global_client_id}/sequences/{name}",
                published_sequence(name, body), retain=True, qos=1,
            )
    except Exception as e:
        print(f"Could not republish workflow timings: {e}")


def published_sequence(name, body):
    """What goes out on `sequences/{name}`: the saved body plus this deck's verdict on it.

    Cloud has no HTTP path to a device, so the only way its Library can say "this workflow no
    longer runs here" is for the verdict to travel with the body it already mirrors. Computed by
    `compatibility.check`, the same call the edge Library's listing makes, so the two libraries
    cannot disagree about the same workflow. Not part of the body proper: `body_hash` ignores it,
    and a push from Cloud has it stripped before saving (see handle_sequence_push).
    """
    message = dict(body or {})
    try:
        message["compatibility"] = compatibility.check(
            name,
            body or {},
            getattr(app.state, "instrument_schemas", {}),
            getattr(app.state, "schema_fingerprint", ""),
            wf.list_workflow_names(WORKFLOWS_DIR),
        )
    except Exception as e:
        # A verdict is a courtesy; failing to compute one must not stop the body syncing.
        print(f"Could not check '{name}' against this deck: {e}")
    # How long it usually takes, from this device's own run history (runtime.py). Cloud shows it
    # beside the workflow and uses it to spell out what a repeat cadence adds up to.
    try:
        timing = runtime.workflow_runtimes().get(name)
        if timing:
            message["runtime"] = timing
        _published_runtime[name] = timing
    except Exception as e:
        print(f"Could not time '{name}': {e}")
    return message


async def handle_sequence_push(payload: dict):
    """Apply a workflow pushed down from Cloud, then echo it back as the acknowledgement.

    Deliberately goes through wf.save_version, the same path a local save uses, so a pushed
    workflow gets versioning, hashing and validation identical to one authored at the bench —
    a push is not a privileged back door that can write a body the local Designer would reject.

    The echo is the ack: republishing on this device's own retained sequences/{name} topic is
    already how Cloud learns about any workflow here, so a successful push simply looks like a
    normal update arriving. Cloud matches the returned body_hash to close out the push; if the
    echo never comes, the push stays unacknowledged rather than being assumed to have worked.
    """
    name = payload.get("name")
    body = payload.get("body")
    if not name or not isinstance(body, dict):
        print(f"Ignoring malformed sequence push: {payload!r}")
        return
    # A verdict Cloud echoes back describes the old body on this deck; it is recomputed on publish.
    body = {k: v for k, v in body.items() if k != "compatibility"}
    try:
        wf.validate_name(name)
        saved, version, _created = wf.save_version(
            WORKFLOWS_DIR, name, body,
            note=payload.get("note") or "Pushed from Cloud",
            author=payload.get("author") or "cloud",
        )
    except Exception as e:
        # No result topic: an unacknowledged push is reported by Cloud as "never echoed", which
        # covers this case and the dropped-message case with one mechanism instead of two.
        print(f"Refusing pushed workflow '{name}': {e}")
        return

    print(f"Applied pushed workflow '{name}' (version {version})")
    if global_broker and global_topic_prefix and global_client_id:
        try:
            global_broker.publish(
                f"{global_topic_prefix}/{global_client_id}/sequences/{name}",
                published_sequence(name, saved), retain=True, qos=1,
            )
        except Exception as e:
            print(f"Applied '{name}' but failed to echo it back: {e}")


def publish_task_status(cloud_run_id: str, cloud_node_id: str, status: str, error: str = None,
                        progress: dict = None):
    """Report a cloud-originated task's state back to Cloud.

    A dedicated topic, NOT .../status — that one is the plain {online, ts} device heartbeat
    daemon.js reads with `payload.online`, which is undefined (falsy) on this payload shape;
    publishing there was incorrectly flipping the device to "offline" in Supabase every time a
    cloud run started or finished.
    """
    if not (global_broker and global_topic_prefix):
        return
    payload = {"runId": cloud_run_id, "nodeId": cloud_node_id, "status": status}
    if error:
        payload["error"] = error
    if progress:
        payload["progress"] = progress
    try:
        global_broker.publish(
            f"{global_topic_prefix}/{global_broker.client_id}/task-status", payload,
            # A progress update is superseded by the next one, so it need not be redelivered;
            # a status change (running/completed/error) must arrive.
            qos=0 if progress else 1,
        )
    except Exception as e:
        print(f"Failed to emit cloud '{status}' status for {cloud_node_id}: {e}")


def publish_task_result(cloud_run_id: str, cloud_node_id: str, record: dict):
    """A finished Cloud task's run record (queue.build_cloud_result), once, at QoS 1.

    Its own topic rather than task-status: it is the one large message (up to ~100KB), and keeping
    it apart keeps every status and progress message small and cheap to parse.
    """
    if not (global_broker and global_topic_prefix):
        return
    try:
        global_broker.publish(
            f"{global_topic_prefix}/{global_broker.client_id}/task-result",
            {"runId": cloud_run_id, "nodeId": cloud_node_id, "result": record}, qos=1,
        )
    except Exception as e:
        print(f"Failed to send results for {cloud_node_id}: {e}")


async def handle_cloud_task(payload: dict):
    """Start a run dispatched by Cloud.

    Two payload shapes are accepted on this topic, normalised to one call:

      {block, runId, nodeId}       a single step — what Cloud sent before it could configure a
                                   node, still what a plain instrument step dispatches as.
      {run, runId, nodeId}         a whole run: {name, parameters, prep, sequence, cleanup}, the
                                   exact body POST /api/queue/runs accepts. This is what a
                                   spreadsheet node, an optimization node, or a merged linear
                                   chain arrives as.

    Both go through `start_run`, so a Cloud-dispatched run is the same run as a bench-started one
    rather than a reduced second notion of what a run is.
    """
    run_id = payload.get("runId")
    node_id = payload.get("nodeId")
    if not run_id or not node_id:
        print(f"Ignoring cloud task with no runId/nodeId: {payload!r}")
        return

    run = payload.get("run")
    if run is None:
        block = payload.get("block")
        if not block:
            print(f"Ignoring cloud task carrying neither 'run' nor 'block': {payload!r}")
            return
        run = {"sequence": [block], "name": payload.get("name")}

    parameters = dict(run.get("parameters") or {})
    parameters["cloud_run_id"] = run_id
    parameters["cloud_node_id"] = node_id

    try:
        await start_run(
            run.get("name") or _cloud_run_label(run),
            parameters,
            run.get("prep") or [],
            run.get("sequence") or [],
            run.get("cleanup") or [],
        )
    except Exception as e:
        # A cloud-dispatched node can reference a workflow this device doesn't have (or has since
        # renamed), or carry parameters this device rejects. Report the refusal back rather than
        # only printing it: the task otherwise sits at 'queued' in Cloud forever with nothing
        # explaining why, which is exactly the stuck-task hole that made a failed dispatch look
        # identical to a slow one.
        print(f"Refusing cloud task {node_id} for run {run_id}: {e}")
        publish_task_status(run_id, node_id, "error", str(e))


def _cloud_run_label(run: dict) -> str:
    """A readable name for a Cloud task that arrived without one: what it runs, not Cloud's ids.

    It used to be "Cloud Node node_1790192601858 (run_1790192697946)" -- two internal ids that mean
    nothing at the bench and that no one can match to anything in Data History.
    """
    first = next(iter(run.get("sequence") or []), None) or {}
    instrument = first.get("instrument") or first.get("module") or ""
    method = first.get("method") or first.get("action") or ""
    what = method if instrument == "Library Workflows" else ".".join(p for p in (instrument, method) if p)
    return f"{what or 'Step'} (from Cloud)"


async def handle_broker_message(topic: str, payload: dict):
    # Both cloud->edge topics land here; the last segment says which.
    if topic.rsplit("/", 1)[-1] == "sequences-push":
        await handle_sequence_push(payload)
        return
    if topic.rsplit("/", 1)[-1] == "cloud-queue":
        # Awareness only: Cloud never queues work here (it holds tasks until this device is
        # free), so this just lets the Queue page say what Cloud has waiting.
        queue_manager.cloud_queue = payload if isinstance(payload, dict) else None
        await queue_manager.broadcast_global_queue()
        return

    print(f"Received cloud task from topic {topic}: {payload}")
    await handle_cloud_task(payload)

def _safe_optimizer_catalog():
    """The optimizer catalog, or {} if building it raises.

    Guarded because this is called from the schema publish: an optimizer backend whose import or
    `get_schema()` blows up must cost Cloud the optimizer list, not the entire instrument schema.
    The registry's own import is already wrapped in a bare except (see optimizer/registry.py), so
    a broken backend is absent rather than fatal there too.
    """
    try:
        return get_optimizers()
    except Exception as e:
        print(f"Could not include optimizers in the published schema: {e}")
        return {}


def publish_schema(broker, topic_prefix, client_id):
    """Retained, published once per (re)connect rather than on every heartbeat — the instrument
    schema doesn't change without a server restart, and it's the one payload here big enough
    (many methods x type hints x docstrings) to actually matter for AWS IoT's per-5KB message
    metering if it were sent every few seconds like the old combined heartbeat did.

    Retained publishing needs the `iot:RetainPublish` action granted alongside `iot:Publish` in
    the device's IoT policy — a plain `iot:Publish` allow does NOT cover it. Without it, AWS IoT
    denies every retained publish with AUTHORIZATION_FAILURE and disconnects the client; since
    QoS-1 messages are auto-retried on reconnect, the still-denied retry disconnects it again,
    forever. That misconfigured policy (fixed now) was the actual cause of what earlier looked
    like an unrelated, unexplained connection-instability bug — see git history / AGENTS.md."""
    schema = {
        "instruments": dict(getattr(app.state, "instrument_schemas", {})),
        "instrument_meta": getattr(app.state, "instrument_meta", {}),
        # Which optimizer backends this particular machine actually has installed, with their real
        # configuration schemas -- the same thing GET /api/optimizers serves the local Optimize
        # page. Cloud cannot reach that endpoint (there is no HTTP path from Cloud to a device,
        # only these topics), and without it the Cloud-side optimization config would have to
        # offer a hardcoded list and let the device reject it after dispatch. A few names and
        # their field definitions, published once per connect alongside a payload orders of
        # magnitude larger, so this costs nothing against AWS IoT's metering.
        "optimizers": _safe_optimizer_catalog(),
        # Which recorded shape of this deck the schema above is -- see deck.py. Lets Cloud tell a
        # device whose drivers changed apart from one that merely reconnected.
        "deck_version": deck.current_version(),
    }
    broker.publish(f"{topic_prefix}/{client_id}/schema", schema, retain=True, qos=1)

def publish_sequences(broker, topic_prefix, client_id):
    """Retained, one message per saved workflow, republished on every (re)connect — this is the
    whole 'sync on reconnect' mechanism: a subscriber that comes online (or was already
    subscribed) always receives the latest retained body for every topic the moment it
    (re)subscribes, with no polling or explicit sync request needed on either side. See
    publish_schema's docstring for the IoT policy permission retained publishing needs."""
    try:
        # list_workflow_names, not a raw listdir: the directory also holds dot-prefixed bookkeeping
        # (.versions/, .meta.json), and a raw "*.json" sweep would publish `.meta` as if it were a
        # saved workflow.
        for name in wf.list_workflow_names(WORKFLOWS_DIR):
            try:
                data = wf.read_head(WORKFLOWS_DIR, name)
                broker.publish(
                    f"{topic_prefix}/{client_id}/sequences/{name}", published_sequence(name, data),
                    retain=True, qos=1,
                )
            except Exception as e:
                print(f"Failed to publish sequence '{name}': {e}")
    except Exception as e:
        print(f"Failed to list workflows for sync: {e}")

# Run states in which this device is not free to take another run: something is executing,
# paused mid-run, waiting on a person, or already queued here.
_OCCUPIED_RUN_STATES = ("pending", "running", "paused", "waiting_input")


async def device_busy() -> bool:
    """Whether this device has any run in progress or waiting in its queue, whoever started it.

    Cloud holds a ready task until the device is free rather than sending it to wait in this
    queue, where Cloud could no longer reorder or cancel it. Cloud only knows about its *own*
    tasks, though; a run started at the bench is invisible to it without this.
    """
    # Read from the runs' own states rather than the queue's `active_run_id`: the end-of-run
    # notification fires after the run is committed as finished but before the queue lets go of
    # it, and at that moment the device *is* free.
    try:
        async with async_session() as session:
            count = (await session.execute(
                select(func.count()).select_from(WorkflowRun)
                .where(WorkflowRun.status.in_(_OCCUPIED_RUN_STATES))
            )).scalar()
            if count:
                return True
            # A run that hit an error and is parked waiting for an operator to retry/skip/cancel
            # still holds the queue, though its recorded status already reads 'error'.
            active = queue_manager.active_run_id
            if active is not None and queue_manager.error_action is None:
                run = await session.get(WorkflowRun, active)
                return bool(run and run.status == "error" and not queue_manager.cancelled)
        return False
    except Exception:
        return False


# A new value on every broker connection, sent with the heartbeat. The heartbeat is retained, so a
# Cloud daemon starting up sees the *previous* connection's "online" and cannot tell that this
# process has since restarted and missed whatever it sent in between (the cloud-queue summary).
global_session: str = ""


async def publish_status():
    """The small retained heartbeat: `{online, busy, ts}`. One boolean more than before, so the
    per-message cost on AWS IoT is unchanged."""
    if not (global_broker and global_topic_prefix and global_client_id):
        return
    global_broker.publish(
        f"{global_topic_prefix}/{global_client_id}/status",
        {"online": True, "busy": await device_busy(), "ts": time.time(), "session": global_session},
        retain=True, qos=0,
    )


def notify_status_changed():
    """Send the heartbeat now instead of on the next 5s tick -- called when a run is queued or
    finishes, so Cloud neither sends into a queue that just filled nor waits to use a free device."""
    try:
        asyncio.get_running_loop().create_task(publish_status())
    except RuntimeError:
        pass


async def status_loop(broker, topic_prefix, client_id):
    """A cheap, frequent liveness signal — deliberately just {online, ts}, not the schema. Kept
    small on purpose: at a 5s interval this is what actually gets billed per-message on AWS IoT,
    and 'online' is also covered by the LWT for the ungraceful-disconnect case (see setup_broker).

    Also re-publishes schema/sequences on a decaying schedule after each (re)connect — NOT just
    once the way setup_broker's initial calls do, and no longer forever either.

    Why it repeats at all: those initial calls are one-shot QoS-1 publishes with no retry, and a
    real, reproduced bug was AWS IoT's connection needing a few rapid client-initiated reconnects
    to settle right after startup (root cause of *that* churn still open), which raced the
    one-shot schema/sequences publish and silently dropped it — status itself never showed a
    symptom because it's QoS-0 and re-sent every 5s regardless, so it just self-healed on the next
    tick. Confirmed directly: 284 'status' messages arrived at the daemon during testing, zero
    'schema' or 'sequences' ones, from the exact same connection.

    Why it now stops: that failure is a *connect-time race*, so repeating past the settling window
    buys nothing and is not free. Measured on a 7-instrument device with 11 saved workflows, the
    old every-60s republish shipped 36KB (1 schema + 11 retained sequence bodies) every minute
    forever — 50MB and ~20k messages per device per day, none of it changed since the last one,
    beside a `status` payload deliberately kept tiny for exactly that metering reason.

    So: republish at ~5s, 10s, 20s, 40s, 80s and 160s after connect, then stop until the next
    reconnect. That covers the racy window several times over with the same self-healing property,
    and drops steady-state traffic to zero. Nothing is lost on the Cloud side either: these are
    retained publishes, so a subscriber that appears later still receives the latest body
    immediately, and a save publishes its own sequence straight away (see the save route)."""
    # Tick indices (5s apart) at which to re-publish: 1, 2, 4, 8, 16, 32 -> ~5s..160s after
    # connect. A set, not a modulus, is what makes this terminate.
    RESYNC_TICKS = {1, 2, 4, 8, 16, 32}
    tick = 0
    while True:
        try:
            broker.publish(
                f"{topic_prefix}/{client_id}/status",
                {"online": True, "busy": await device_busy(), "ts": time.time(), "session": global_session},
                retain=True, qos=0,
            )
            if tick in RESYNC_TICKS:
                publish_schema(broker, topic_prefix, client_id)
                publish_sequences(broker, topic_prefix, client_id)
            # Cloud tasks a restart abandoned: say so once the connection is up, or Cloud keeps
            # them 'running' and holds every later task for this device behind them.
            while queue_manager.abandoned_cloud_tasks and tick >= 1:
                task = queue_manager.abandoned_cloud_tasks.pop(0)
                publish_task_status(task["runId"], task["nodeId"], "error",
                                    "The device restarted before this finished.")
        except Exception as e:
            print(f"Error publishing status: {e}")
        tick += 1
        await asyncio.sleep(5)

async def setup_broker():
    global global_broker, cloud_connection_state, cloud_connection_error, cloud_broker_url
    if global_broker:
        global_broker.disconnect()
        global_broker = None

    if not CLOUD_TOKEN:
        cloud_connection_state = "disconnected"
        cloud_connection_error = None
        cloud_broker_url = None
        return

    cloud_connection_state = "connecting"
    cloud_connection_error = None

    try:
        # Standardize token decoding: support raw JSON fallback if user didn't base64 encode
        try:
            token_data = json.loads(base64.b64decode(CLOUD_TOKEN).decode('utf-8'))
        except:
            token_data = json.loads(CLOUD_TOKEN)
            
        protocol = token_data.get("protocol")
        endpoint = token_data.get("endpoint", "")
        if ":" in endpoint:
            endpoint = endpoint.split(":")[0]
        if endpoint == "localhost":
            endpoint = "127.0.0.1"
        port = token_data.get("port", 1883 if protocol == "mqtt" else 8883)
        client_id = token_data.get("client_id", str(uuid.uuid4()))
        topic_prefix = token_data.get("topic_prefix", "ivoryos/edge")
        
        global global_topic_prefix, global_client_id
        global_topic_prefix = topic_prefix
        global_client_id = client_id

        cloud_broker_url = f"{'mqtts' if protocol == 'aws_iot' else 'mqtt'}://{endpoint}:{port}"

        if protocol == "mqtt":
            global_broker = LocalMQTTBroker(client_id, endpoint, port)
        elif protocol == "aws_iot":
            certs = token_data.get("certs", {})
            cert_dir = os.path.join(os.path.dirname(__file__), ".certs")
            os.makedirs(cert_dir, exist_ok=True)
            
            ca_cert_path = os.path.join(cert_dir, "root-CA.crt")
            cert_path = os.path.join(cert_dir, "device.cert.pem")
            key_path = os.path.join(cert_dir, "device.private.key")
            
            with open(ca_cert_path, "w") as f:
                f.write(certs.get("root_ca", ""))
            with open(cert_path, "w") as f:
                f.write(certs.get("cert_pem", ""))
            with open(key_path, "w") as f:
                f.write(certs.get("private_key", ""))
                
            global_broker = AWSIoTBroker(client_id, endpoint, ca_cert_path, cert_path, key_path)
            
        if global_broker:
            global_broker.set_callback(handle_broker_message)
            # If we drop off ungracefully (crash, network loss), the broker publishes this on our
            # behalf. Not retained — see set_will()'s docstring: AWS IoT Core silently refuses the
            # whole connection if the Last Will is retained. Only a client already subscribed at
            # the moment we drop sees this live; the periodic retained status_loop publish plus
            # daemon.js's staleness sweep is what catches everyone else.
            global_broker.set_will(f"{topic_prefix}/{client_id}/status", {"online": False, "ts": time.time()}, retain=False)
            global_broker.connect()

            # connect() only starts the handshake — paho reports the real CONNACK result
            # asynchronously via the on_connect callback, on a background thread. Poll briefly for
            # that instead of reporting "success" the instant the socket call returns, so a bad
            # cert or unreachable endpoint actually surfaces as a failure here rather than a
            # false-positive "connected" that only reveals itself later as silence.
            for _ in range(50):  # up to ~5s
                if global_broker.client.is_connected():
                    break
                await asyncio.sleep(0.1)
            else:
                raise TimeoutError("Timed out waiting to connect — check the endpoint and, for AWS IoT, that the certificate is registered and its policy allows this Thing to connect.")

            global global_session
            global_session = uuid.uuid4().hex[:8]
            global_broker.subscribe(f"{topic_prefix}/{client_id}/execute")
            # Cloud -> Edge workflow write-through. Without this the Cloud sequence editor could
            # only ever write to Cloud's own database: the device never learned about a workflow
            # authored there, so running it failed in expand_workflow_blocks (which resolves
            # against WORKFLOWS_DIR), and editing an existing one was silently reverted the next
            # time this device republished its own copy over the same {device_id, name} key.
            # The device still owns the durable copy — a push is a request to write, applied
            # through the same save path as a local save, and only real once this device echoes
            # it back on its own sequences/{name} topic.
            global_broker.subscribe(f"{topic_prefix}/{client_id}/sequences-push")
            # What Cloud is holding for this device, for the Queue page (awareness only).
            global_broker.subscribe(f"{topic_prefix}/{client_id}/cloud-queue")

            # Republish current state on every (re)connect — this IS the sync mechanism: a
            # subscriber (Cloud) always receives the latest retained schema/sequence bodies the
            # moment it (re)subscribes, so reconnecting after being offline needs no special
            # "catch me up" request/response round-trip on either side.
            publish_schema(global_broker, topic_prefix, client_id)
            publish_sequences(global_broker, topic_prefix, client_id)

            asyncio.create_task(status_loop(global_broker, topic_prefix, client_id))

            cloud_connection_state = "connected"
            cloud_connection_error = None

    except Exception as e:
        print(f"Failed to setup broker from token: {e}")
        cloud_connection_state = "error"
        cloud_connection_error = str(e)
        if global_broker:
            try:
                global_broker.disconnect()
            except Exception:
                pass
            global_broker = None

class ExecuteRequest(BaseModel):
    module: str
    method: str
    args: Dict[str, Any] = {}

# Dictionary to store active background tasks
active_tasks: Dict[str, asyncio.Task] = {}
# Dictionary to store completed/failed task results
task_results: Dict[str, Any] = {}

@app.on_event("startup")
async def startup_event():
    # Initialize the local database
    await init_db()
    
    # Initialize asyncio primitives for the queue manager
    await queue_manager.init_asyncio()
    
    # Cleanup any zombie runs that were 'running' when the server crashed
    await queue_manager.cleanup_zombies()
    
    # Introspect instruments on startup (from app.state.instruments)
    app.state.instrument_schemas = {}
    app.state.instrument_meta = {}
    for name, instance in app.state.instruments.items():
        app.state.instrument_schemas[name] = inspect_device_module(instance)
        app.state.instrument_meta[name] = {
            "module": instance.__class__.__module__,
            "class": instance.__class__.__name__
        }
        print(f"Introspected module '{name}': {list(app.state.instrument_schemas[name].keys())}")

    # The one moment the deck's shape can change: nothing writes instrument_schemas after this.
    # Saved workflows are checked against this fingerprint, so a verdict only goes stale when the
    # workflow changes (its body_hash) or the server restarts against different drivers.
    from .compatibility import schema_fingerprint
    app.state.schema_fingerprint = schema_fingerprint(app.state.instrument_schemas)

    # Keep this shape of the deck if it is new, so runs and saved workflows can say which deck
    # they belong to, and the Instruments page can show what changed between two of them.
    try:
        app.state.deck_version = deck.record(
            app.state.instrument_schemas, app.state.instrument_meta, app.state.schema_fingerprint,
        )
        print(f"Deck version {app.state.deck_version} ({app.state.schema_fingerprint})")
    except Exception as e:
        print(f"Could not record the deck version: {e}")
        
    try:
        import json
        with open("ivoryos_schema.json", "w") as f:
            json.dump({
                "instruments": app.state.instrument_schemas,
                "instrument_meta": app.state.instrument_meta
            }, f, indent=2, default=str)
        print("Dumped introspected schema to ivoryos_schema.json for local version control.")
    except Exception as e:
        print(f"Failed to dump ivoryos_schema.json: {e}")
        
    # Setup Message Broker
    await setup_broker()

@app.get("/api/status")
def get_status():
    return {
        "status": "running", 
        "cloud_connected": bool(CLOUD_TOKEN and global_broker),
        "instruments": getattr(app.state, "instrument_schemas", {}),
        "instrument_meta": getattr(app.state, "instrument_meta", {}),
        "active_tasks": list(active_tasks.keys()),
        "active_workflow_id": queue_manager.active_run_id,
        "queue_paused": queue_manager.paused,
        "cloud_queue": queue_manager.cloud_queue,
    }

@app.get("/api/optimizers")
def get_optimizers():
    """Lists the optimizer backends actually available in this environment, with each one's
    real configuration schema (parameter types, phases/models it supports, extra fields)."""
    from ivoryos_edge.optimizer.registry import OPTIMIZER_REGISTRY
    return {name: cls.get_schema() for name, cls in OPTIMIZER_REGISTRY.items()}

# --- Queue Manager Endpoints ---

@app.get("/api/queue/runs")
async def list_runs():
    runs = await queue_manager.get_all_runs()
    return {"runs": runs}

def _per_row_template(sequence):
    """The per-row step template for a Spreadsheet run, taken from what will actually run.

    `sequence_template` records which step in ONE row's sequence produced which named output, so
    Data History can put real result columns on the export. The submitter builds it from the
    blocks it authored -- but a `Library Workflows` block is one block there and fifteen steps
    here, and only this side knows that. A Cloud-dispatched spreadsheet therefore arrived claiming
    a one-step template for a run whose rows are fifteen steps each, and Data History, slicing the
    flat step list into chunks of that length, showed one step per row and silently dropped the
    other twenty-eight.

    Taking the first row's expanded steps is exact in every case the submitter cannot see:
    linked-workflow expansion, nested links, and batch steps (which belong to their group's first
    row). Steps carry `_row` from `toSubmittedStep`; a payload without it -- anything submitted
    before that existed -- leaves the caller's own template alone.
    """
    rows_seen = [s.get("params", {}).get("_row") for s in sequence]
    if not sequence or any(r is None for r in rows_seen):
        return None
    first_row = rows_seen[0]
    return [
        {
            "instrument": step.get("instrument"),
            "method": step.get("method"),
            "returnVar": step.get("params", {}).get("_return_var"),
            "returnBindings": step.get("params", {}).get("_return_bindings"),
        }
        for step in sequence
        if step.get("params", {}).get("_row") == first_row
    ]


async def start_run(name: str, parameters: dict, prep: list, sequence: list, cleanup: list) -> int:
    """Expand a run's links and hand it to the queue. The single entry point for starting a run.

    Deliberately not inlined in the HTTP route any more: a run can now arrive two ways — from a
    browser via POST /api/queue/runs, or from Cloud over the `execute` MQTT topic — and those two
    have to mean exactly the same thing. Cloud dispatching a spreadsheet or optimization run is
    the *same* run as one started at the bench, arriving by a different door, so both callers go
    through this function rather than the MQTT path growing its own reduced notion of what a run
    is (which is what it had: a single block, no prep/cleanup, no parameters at all).

    Returns the new run's id; raises WorkflowError for an unresolvable link.
    """
    # Every link followed while flattening is recorded and persisted onto the run, so a finished
    # run can state exactly which body of each subworkflow it executed. Without this, editing a
    # linked workflow silently made past runs unreproducible with nothing in the record to show it.
    resolved_links = []

    # Which deck this run executed against. Stamped here because every run -- bench or Cloud,
    # plain, spreadsheet or optimization -- starts through this function.
    if deck.current_version() is not None:
        parameters["deck_version"] = deck.current_version()

    prep = expand_workflow_blocks(prep, WORKFLOWS_DIR, "prep", resolved=resolved_links)
    sequence = expand_workflow_blocks(sequence, WORKFLOWS_DIR, "main", resolved=resolved_links)
    cleanup = expand_workflow_blocks(cleanup, WORKFLOWS_DIR, "cleanup", resolved=resolved_links)

    if parameters.get("type") == "Optimization":
        parameters["prep_template"] = prep
        parameters["cleanup_template"] = cleanup
        # The sequence_template is already inside parameters, but it's not expanded!
        if "sequence_template" in parameters:
            parameters["sequence_template"] = expand_workflow_blocks(
                parameters["sequence_template"], WORKFLOWS_DIR, resolved=resolved_links
            )

        if resolved_links:
            parameters["resolved_links"] = resolved_links

        # Send empty sequence because loop handles the sequence_template
        return await queue_manager.submit_sequence(name, [], parameters)

    if resolved_links:
        parameters["resolved_links"] = resolved_links

    if parameters.get("type") == "Spreadsheet":
        # Rebuilt from the expanded steps rather than trusted from the caller -- see
        # _per_row_template for the run this got wrong.
        rebuilt = _per_row_template(sequence)
        if rebuilt:
            parameters["sequence_template"] = rebuilt

    # Flatten everything into a single sequence
    return await queue_manager.submit_sequence(name, prep + sequence + cleanup, parameters)


@app.post("/api/queue/runs")
async def create_run(req: Request):
    data = await req.json()
    try:
        run_id = await start_run(
            data.get("name", "Unnamed Workflow"),
            data.get("parameters", {}),
            data.get("prep", []),
            data.get("sequence", []),
            data.get("cleanup", []),
        )
        return {"status": "started", "run_id": run_id}
    except WorkflowError as e:
        # A missing, cyclic or over-nested link aborts the run rather than dispatching a malformed
        # step. The message names the offending workflow so the Designer can show it verbatim.
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

@app.get("/api/queue/runs/{run_id}")
async def get_run(run_id: int):
    status = await queue_manager.get_run_status(run_id)
    if not status:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return status

@app.get("/api/queue/runs/{run_id}/plots")
def get_run_plots(run_id: int, plot_type: str = "default"):
    if queue_manager.active_optimizer_run_id != run_id or queue_manager.active_optimizer is None:
        return JSONResponse(status_code=400, content={"error": "No optimizer plots available for this run."})
    try:
        return queue_manager.active_optimizer.get_plots(plot_type)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/queue/runs/{run_id}/resolve")
async def resolve_run_error(run_id: int, req: Request):
    data = await req.json()
    action = data.get("action")
    if queue_manager.active_run_id == run_id:
        queue_manager.error_action = action
    return {"status": "success"}

@app.post("/api/queue/runs/{run_id}/input")
async def submit_run_input(run_id: int, req: Request):
    data = await req.json()
    value = data.get("value", "")
    if queue_manager.active_run_id != run_id or run_id not in queue_manager.pending_input_event:
        return JSONResponse(status_code=400, content={"error": "This run is not waiting for input"})
    queue_manager.submit_input(run_id, value)
    return {"status": "success"}

@app.patch("/api/queue/runs/{run_id}")
async def rename_run(run_id: int, req: Request):
    """Rename a queued run. Legacy IvoryOS let operators label queued tasks so a queue of five
    'Untitled Run' entries could be told apart at a glance."""
    data = await req.json()
    name = (data.get("name") or "").strip()
    if not name:
        return JSONResponse(status_code=400, content={"error": "Name cannot be empty"})

    from ivoryos_edge.models import async_session, WorkflowRun
    async with async_session() as session:
        run = await session.get(WorkflowRun, run_id)
        if not run:
            return JSONResponse(status_code=404, content={"error": "Run not found"})
        run.name = name[:128]
        await session.commit()
    await queue_manager.broadcast_global_queue()
    return {"status": "success", "name": name[:128]}


@app.delete("/api/queue/runs/{run_id}")
async def delete_run(run_id: int):
    """Remove a run from the queue entirely. Only runs that haven't started can be deleted —
    cancel a running one instead, so its partial results stay on record."""
    from ivoryos_edge.models import async_session, WorkflowRun
    async with async_session() as session:
        run = await session.get(WorkflowRun, run_id)
        if not run:
            return JSONResponse(status_code=404, content={"error": "Run not found"})
        if run.status not in ("pending", "cancelled", "completed", "error"):
            return JSONResponse(status_code=400, content={"error": f"Cannot delete a run that is {run.status}"})
        if queue_manager.active_run_id == run_id:
            return JSONResponse(status_code=400, content={"error": "Cannot delete the active run"})
        await session.delete(run)
        await session.commit()
    await queue_manager.broadcast_global_queue()
    return {"status": "deleted", "run_id": run_id}


@app.post("/api/queue/runs/{run_id}/move")
async def move_run(run_id: int, req: Request):
    """Move a pending run one slot up or down the queue by swapping its queue position with its
    neighbour's, so an urgent experiment can jump ahead without re-submitting it."""
    data = await req.json()
    direction = data.get("direction")
    if direction not in ("up", "down"):
        return JSONResponse(status_code=400, content={"error": "direction must be 'up' or 'down'"})

    from ivoryos_edge.models import async_session, WorkflowRun
    from ivoryos_edge.queue import queue_position_of
    from sqlalchemy import select

    async with async_session() as session:
        result = await session.execute(
            select(WorkflowRun).where(WorkflowRun.status == "pending").order_by(WorkflowRun.id)
        )
        pending = list(result.scalars())
        # The run at the head of the queue is the one about to start; it isn't reorderable.
        pending.sort(key=lambda r: (queue_position_of(r), r.id))

        index = next((i for i, r in enumerate(pending) if r.id == run_id), None)
        if index is None:
            return JSONResponse(status_code=400, content={"error": "Run is not pending"})

        target = index - 1 if direction == "up" else index + 1
        if target < 0 or target >= len(pending):
            edge = "front" if direction == "up" else "back"
            return JSONResponse(status_code=400, content={"error": f"Run is already at the {edge} of the queue"})

        # Rewrite every position from the reordered list so the ordering stays total and stable,
        # even for runs that were never moved before and have no stored position.
        pending[index], pending[target] = pending[target], pending[index]
        for position, run in enumerate(pending):
            params = dict(run.parameters or {})
            params["queue_position"] = position
            run.parameters = params
        await session.commit()

    await queue_manager.broadcast_global_queue()
    return {"status": "success"}


@app.websocket("/api/ws/runs/{run_id}")
async def ws_run_status(websocket: WebSocket, run_id: int):
    await websocket.accept()
    await queue_manager.subscribe(run_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await queue_manager.unsubscribe(run_id, websocket)

@app.websocket("/api/ws/queue")
async def ws_global_queue(websocket: WebSocket):
    await websocket.accept()
    await queue_manager.subscribe_global(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await queue_manager.unsubscribe_global(websocket)

@app.post("/api/queue/runs/{run_id}/pause")
async def pause_run(run_id: int):
    if queue_manager.active_run_id == run_id:
        queue_manager.pause()
        return {"status": "paused"}
    return JSONResponse(status_code=400, content={"error": "Workflow not active"})

@app.post("/api/queue/runs/{run_id}/resume")
async def resume_run(run_id: int):
    if queue_manager.active_run_id == run_id:
        queue_manager.resume()
        return {"status": "running"}
    return JSONResponse(status_code=400, content={"error": "Workflow not active"})

@app.post("/api/queue/runs/{run_id}/cancel")
async def cancel_run(run_id: int):
    if queue_manager.active_run_id == run_id:
        queue_manager.cancel()
        return {"status": "cancelling"}
        
    # Check if we can cancel a pending run directly in the DB
    from ivoryos_edge.models import async_session, WorkflowRun
    async with async_session() as session:
        run = await session.get(WorkflowRun, run_id)
        if run and run.status in ["pending", "error"]:
            run.status = "cancelled"
            await session.commit()
            return {"status": "cancelled"}
            
    return JSONResponse(status_code=400, content={"error": "Workflow not active"})

@app.put("/api/steps/{step_id}")
async def update_step(step_id: int, req: Request):
    data = await req.json()
    parameters = data.get("parameters")
    try:
        await queue_manager.update_step_parameters(step_id, parameters)
        return {"status": "updated"}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

# --- Single Action Endpoints (Legacy support for Designer / Manual tests) ---

async def run_and_track_task(task_id: str, method, args):
    """Wrapper to run a task and clean it up from active tracking when done."""
    import traceback
    try:
        if inspect.iscoroutinefunction(method):
            result = await method(**args)
        else:
            # Run sync methods in executor to prevent event loop blocking
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(None, lambda: method(**args))
            
        print(f"Task {task_id} completed successfully.")
        # Serialized like a workflow step's output. A driver that returns a dataclass or an enum
        # would otherwise either fail to encode on the way out or reach the Instruments page as
        # something it cannot display — the manual path deserves the same treatment as a run.
        from ivoryos_edge.introspection import serialize_result
        task_results[task_id] = {"status": "completed", "result": serialize_result(result)}
        return result
    except asyncio.CancelledError:
        print(f"Task {task_id} was cancelled!")
        task_results[task_id] = {"status": "error", "error": "Task was cancelled"}
        raise
    except Exception as e:
        print(f"Task {task_id} failed: {e}")
        task_results[task_id] = {
            "status": "error", 
            "error": str(e), 
            "traceback": traceback.format_exc()
        }
        raise
    finally:
        active_tasks.pop(task_id, None)

@app.post("/api/execute")
async def execute_method(req: ExecuteRequest):
    instruments = getattr(app.state, "instruments", {})
    if req.module not in instruments:
        return JSONResponse(status_code=404, content={"error": f"Module {req.module} not found"})
        
    instance = instruments[req.module]
    from ivoryos_edge.introspection import cast_arguments, has_member, resolve_callable
    if not has_member(instance, req.method):
        return JSONResponse(status_code=404, content={"error": f"Method {req.method} not found on {req.module}"})

    # resolve_callable, not getattr: a property getter/setter is a schema entry the designer can
    # place as a step, but it isn't a callable attribute until it's wrapped.
    method = resolve_callable(instance, req.method)

    req.args = cast_arguments(method, req.args or {})
    
    # Generate task ID and run in background
    task_id = str(uuid.uuid4())
    task_results[task_id] = {"status": "running"}
    task = asyncio.create_task(run_and_track_task(task_id, method, req.args))
    active_tasks[task_id] = task
    
    return {"status": "started", "task_id": task_id}

@app.get("/api/execute/{task_id}")
async def get_execution_status(task_id: str):
    if task_id in active_tasks:
        return {"status": "running"}
    
    if task_id in task_results:
        return task_results[task_id]
        
    return JSONResponse(status_code=404, content={"error": "Task not found"})

@app.delete("/api/execute/{task_id}")
async def kill_execution(task_id: str):
    if task_id not in active_tasks:
        return JSONResponse(status_code=404, content={"error": "Task not found or already completed"})
        
    task = active_tasks[task_id]
    task.cancel()
    return {"status": "cancelled", "task_id": task_id}

WORKFLOWS_DIR = os.path.join(os.path.dirname(__file__), "workflows")
os.makedirs(WORKFLOWS_DIR, exist_ok=True)

def _workflow_error(e, status=400, forceable=None):
    """`forceable` names a check the caller may re-submit past with `force: true`. It is what
    lets the Designer offer "save anyway" instead of just reporting a dead end."""
    content = {"error": str(e)}
    if forceable:
        content["forceable"] = forceable
    return JSONResponse(status_code=status, content=content)


def _workflow_summary(name):
    """List-row metadata. `links`/`linked_by` are what the Library page needs to warn a user that
    editing this workflow will change other ones."""
    filepath = wf.workflow_path(WORKFLOWS_DIR, name)
    body = {}
    try:
        # ensure_versioned rather than read_head: a workflow written before versioning existed (or
        # synced down from Cloud) is adopted as v1 here, so the listing never reports a null
        # version that the version badges and "vN available" checks would then have to special-case.
        body = wf.ensure_versioned(WORKFLOWS_DIR, name)
    except WorkflowError:
        pass
    return {
        "name": name,
        "description": body.get("description", ""),
        "created_at": os.path.getctime(filepath) * 1000,  # JS timestamp
        "updated_at": os.path.getmtime(filepath) * 1000,
        "version": body.get("version"),
        "body_hash": body.get("body_hash"),
        "note": body.get("note", ""),
        "author": body.get("author", ""),
        "links": wf.link_targets(body),
        "tags": wf.get_tags(WORKFLOWS_DIR, name),
    }


from . import compatibility


@app.get("/api/deck")
def get_deck():
    """The current deck version and the history of every recorded one (newest first)."""
    return {"version": deck.current_version(), "versions": deck.list_versions()}


@app.get("/api/deck/versions/{version}")
def get_deck_version(version: int):
    found = deck.get_version(version)
    if found is None:
        return JSONResponse(status_code=404, content={"error": f"No deck version {version}"})
    return found


@app.get("/api/deck/diff")
def get_deck_diff(to: Optional[int] = None, frm: Optional[int] = None):
    """What changed between two deck versions. `to` defaults to the current one and `frm` to the
    version before it, so a bare call answers "what changed at the last driver update?"."""
    to = to or deck.current_version()
    if to is None:
        return JSONResponse(status_code=404, content={"error": "No deck version recorded yet"})
    frm = frm if frm is not None else to - 1
    new, old = deck.get_version(to), deck.get_version(frm) if frm >= 1 else None
    if new is None:
        return JSONResponse(status_code=404, content={"error": f"No deck version {to}"})
    return {
        "from": frm if old else None,
        "to": to,
        "changes": deck.diff(old["schema"] if old else {}, new["schema"]),
    }


@app.get("/api/workflows")
def list_workflows():
    try:
        names = wf.list_workflow_names(WORKFLOWS_DIR)
        bodies = {}
        for name in names:
            try:
                bodies[name] = wf.ensure_versioned(WORKFLOWS_DIR, name)
            except WorkflowError:
                bodies[name] = {}

        # Typical durations from this device's run history, once for the whole listing (cached on
        # the newest finished run, so a listing with nothing new finished costs one query).
        try:
            timings = runtime.workflow_runtimes()
        except Exception as e:
            print(f"Could not time workflows: {e}")
            timings = {}

        summaries = []
        for name in names:
            summary = _workflow_summary(name)
            # Computed from the already-loaded bodies rather than re-reading every file per
            # workflow — this is O(n^2) over a lab's workflow library either way, but n is small
            # and one pass of disk reads keeps it cheap.
            summary["linked_by"] = [
                other for other in names
                if other != name and name in wf.link_targets(bodies.get(other) or {})
            ]
            # Still runnable against the drivers currently connected? The bodies are already in
            # hand for linked_by, and the verdict is cached per body_hash + deck fingerprint, so
            # this costs nothing on a listing where neither has changed — see compatibility.py.
            summary["runtime"] = timings.get(name)
            summary["compatibility"] = compatibility.check(
                name,
                bodies.get(name) or {},
                getattr(app.state, "instrument_schemas", {}),
                getattr(app.state, "schema_fingerprint", ""),
                names,
            )
            summaries.append(summary)
        return {"workflows": summaries, "tags": wf.all_tags(WORKFLOWS_DIR)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# The agent tool layer (/api/agent/*). Its write endpoints file proposals for a person to
# accept rather than saving or running anything themselves — see ivoryos_edge/agent/routes.py.
from .agent.routes import router as agent_router
app.include_router(agent_router)


@app.get("/api/plugins")
def list_plugins():
    return {"plugins": getattr(app.state, "plugins", [])}


@app.post("/api/workflows/expand")
async def expand_workflow_preview(req: Request):
    """Dry run: flatten a sequence exactly the way `create_run` will, without queueing anything.

    This is what the Designer's preview panel renders. It deliberately shares `expand_workflow_blocks`
    with the dispatch path — a preview generated by a second, parallel implementation could drift
    out of sync with what the hardware actually does, which is the one failure mode a safety
    preview must not have.

    Declared before `/api/workflows/{name}` so "expand" isn't swallowed as a workflow name.
    """
    try:
        data = await req.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    resolved = []
    try:
        prep = expand_workflow_blocks(data.get("prep", []), WORKFLOWS_DIR, "prep", resolved=resolved)
        main = expand_workflow_blocks(data.get("sequence", []), WORKFLOWS_DIR, "main", resolved=resolved)
        cleanup = expand_workflow_blocks(data.get("cleanup", []), WORKFLOWS_DIR, "cleanup", resolved=resolved)
    except WorkflowError as e:
        return _workflow_error(e)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

    return {
        "prep": prep,
        "sequence": main,
        "cleanup": cleanup,
        "resolved_links": resolved,
        "counts": {
            "prep": len(prep),
            "sequence": len(main),
            "cleanup": len(cleanup),
            "total": len(prep) + len(main) + len(cleanup),
        },
    }


@app.put("/api/workflows/{name}/tags")
async def set_workflow_tags(name: str, req: Request):
    """Re-file a workflow. Tags are stored beside the workflow rather than inside it, so changing
    one is not an edit to the protocol: no new version, no change to any pinned reference."""
    try:
        data = await req.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    try:
        wf.validate_name(name)
        if not os.path.exists(wf.workflow_path(WORKFLOWS_DIR, name)):
            raise wf.WorkflowNotFound(f"Workflow '{name}' not found")
        tags = wf.set_tags(WORKFLOWS_DIR, name, data.get("tags"))
    except wf.WorkflowNotFound as e:
        return _workflow_error(e, 404)
    except WorkflowError as e:
        return _workflow_error(e)

    return {"status": "success", "name": name, "tags": tags, "all_tags": wf.all_tags(WORKFLOWS_DIR)}


@app.get("/api/workflows/{name}")
def get_workflow(name: str, version: int = None):
    try:
        return wf.read_version(WORKFLOWS_DIR, name, version)
    except wf.WorkflowNotFound as e:
        return _workflow_error(e, 404)
    except WorkflowError as e:
        return _workflow_error(e)


@app.get("/api/workflows/{name}/versions")
def get_workflow_versions(name: str):
    """Newest first — the history panel and the diff view both read this."""
    try:
        wf.ensure_versioned(WORKFLOWS_DIR, name)
    except wf.WorkflowNotFound as e:
        return _workflow_error(e, 404)
    except WorkflowError as e:
        return _workflow_error(e)

    entries = []
    for version in reversed(wf.list_versions(WORKFLOWS_DIR, name)):
        try:
            body = wf.read_version(WORKFLOWS_DIR, name, version)
        except WorkflowError:
            continue
        entries.append({
            "version": version,
            "body_hash": body.get("body_hash"),
            "updated_at": (body.get("updated_at") or 0) * 1000,
            "note": body.get("note", ""),
            "author": body.get("author", ""),
            "steps": sum(len(body.get(k) or []) for k in ("prep", "script", "cleanup")),
        })
    return {"name": name, "versions": entries}


@app.get("/api/workflows/{name}/dependents")
def get_workflow_dependents(name: str):
    """Which saved workflows *link* to this one, and would therefore change if it is edited.

    Copies never appear here — an inlined copy holds no reference, which is exactly why copy is the
    safe default for reuse.
    """
    try:
        wf.validate_name(name)
        return {"name": name, "dependents": wf.dependents(WORKFLOWS_DIR, name)}
    except WorkflowError as e:
        return _workflow_error(e)


@app.post("/api/workflows/{name}")
async def save_workflow(name: str, req: Request):
    try:
        data = await req.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    # A rejection here is advice, not a verdict: building A before the B it calls exists is a
    # normal order to work in, and refusing to write anything means losing the edit. `force`
    # records that the author was told and chose to save anyway. The run path validates
    # independently and still refuses to dispatch a broken expansion, so nothing unsafe reaches
    # hardware either way.
    force = bool(data.pop("force", False))

    try:
        wf.validate_name(name)

        # Validate the link graph *before* writing. Server-side because both the Edge Designer and
        # the Cloud sequence editor POST here, and client-only validation in this project has
        # already drifted out of sync twice (see AGENTS.md section 3).
        missing = wf.missing_links(WORKFLOWS_DIR, data)
        if missing and not force:
            return _workflow_error(
                WorkflowError(
                    "This workflow links to a workflow that no longer exists: "
                    + ", ".join(sorted(missing))
                ),
                forceable="missing_links",
            )

        cycle = wf.find_cycle(WORKFLOWS_DIR, name, data)
        if cycle and not force:
            return _workflow_error(
                WorkflowError(
                    "Linked workflows would form a cycle: " + " -> ".join(cycle)
                    + ". A workflow cannot use itself, directly or indirectly."
                ),
                forceable="cycle",
            )

        body, version, created = wf.save_version(
            WORKFLOWS_DIR,
            name,
            data,
            note=data.get("note"),
            author=data.get("author"),
        )
    except WorkflowError as e:
        return _workflow_error(e)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

    # Push the change up immediately rather than waiting for the next reconnect — a saved
    # workflow should show up in Cloud right away, not just after a restart.
    if global_broker and global_topic_prefix and global_client_id:
        try:
            global_broker.publish(
                f"{global_topic_prefix}/{global_client_id}/sequences/{name}",
                published_sequence(name, body), retain=True, qos=1,
            )
        except Exception as e:
            print(f"Failed to publish saved workflow '{name}': {e}")

    return {
        "status": "success",
        "name": name,
        "version": version,
        "created_version": created,
        "body_hash": body.get("body_hash"),
        "dependents": wf.dependents(WORKFLOWS_DIR, name),
    }


@app.delete("/api/workflows/{name}")
def remove_workflow(name: str, force: bool = False):
    """Deleting a workflow other workflows still link to would break them at their next run, so it
    is refused unless explicitly forced. Version snapshots are kept either way — a completed run
    may still point at one."""
    try:
        wf.validate_name(name)
        linked_by = wf.dependents(WORKFLOWS_DIR, name)
        if linked_by and not force:
            return _workflow_error(
                WorkflowError(
                    f"'{name}' is linked by: {', '.join(linked_by)}. "
                    "Detach those steps first, or delete with force=true."
                ),
                409,
            )
        wf.delete_workflow(WORKFLOWS_DIR, name)

        # Clear the retained topic too, or Cloud never learns about the deletion. Retained
        # messages outlive the publisher by design — that is the whole reason sync-on-reconnect
        # needs no handshake — so a workflow deleted here kept being re-imported into Cloud on
        # every daemon start, forever, from a body still sitting on the broker. Observed with two
        # workflows that were gone from both this disk and this database while Cloud went on
        # listing them. An empty retained payload is MQTT's way of deleting a retained message.
        if global_broker and global_topic_prefix and global_client_id:
            try:
                global_broker.client.publish(
                    f"{global_topic_prefix}/{global_client_id}/sequences/{name}",
                    payload=b"", qos=1, retain=True,
                )
            except Exception as e:
                print(f"Deleted '{name}' but failed to clear its retained topic: {e}")

        return {"status": "deleted", "name": name, "was_linked_by": linked_by}
    except wf.WorkflowNotFound as e:
        return _workflow_error(e, 404)
    except WorkflowError as e:
        return _workflow_error(e)


# Frontend mounting is deferred to run() to ensure plugins are mounted first



def run(module_name: str, port: int = 8080, plugins: list = None):
    """
    Entry point to start the Edge Server. 
    It inspects the caller module for initialized instruments.
    """
    app.state.plugins = []
    
    # Auto-discover static plugins from a 'plugins' directory next to the caller script
    if module_name in sys.modules:
        caller_mod = sys.modules[module_name]
        if hasattr(caller_mod, '__file__') and caller_mod.__file__:
            caller_dir = os.path.dirname(os.path.abspath(caller_mod.__file__))
            plugins_dir = os.path.join(caller_dir, "plugins")
            if os.path.exists(plugins_dir) and os.path.isdir(plugins_dir):
                for folder in os.listdir(plugins_dir):
                    folder_path = os.path.join(plugins_dir, folder)
                    if os.path.isdir(folder_path):
                        if plugins is None:
                            plugins = []
                        # Avoid duplicates if user explicitly passed it
                        if not any(p.get("id") == folder for p in plugins):
                            plugins.append({
                                "id": folder,
                                "name": folder.replace("_", " ").title(),
                                "path": folder_path
                            })

    if plugins:
        for p in plugins:
            if "path" in p:
                if not os.path.exists(p["path"]):
                    print(f"Warning: Plugin path '{p['path']}' does not exist.")
                    continue
                app.mount(f"/plugins/{p['id']}", StaticFiles(directory=p["path"], html=True), name=f"plugin_{p['id']}")
                app.state.plugins.append({"id": p["id"], "name": p["name"], "url": f"/plugins/{p['id']}/index.html"})
            elif "url" in p:
                app.state.plugins.append(p)
                
    instruments = {}
    
    if module_name in sys.modules:
        caller_mod = sys.modules[module_name]
        # Inspect for objects that look like custom classes/instruments
        for var_name, var_value in vars(caller_mod).items():
            if var_name.startswith("_"):
                continue
            # Basic filter: must be an object instance (not a primitive, function, or class itself)
            if not inspect.isclass(var_value) and not inspect.isfunction(var_value) and not inspect.ismodule(var_value):
                # Ignore basic types
                if type(var_value).__module__ != "builtins":
                    instruments[var_name] = var_value
                    
    print(f"Found instruments in {module_name}: {list(instruments.keys())}")
    
    # Bind to app state
    app.state.instruments = instruments
    
    # Serve the static Next.js export last so it doesn't intercept plugin routes
    frontend_out = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "frontend/out")
    if os.path.exists(frontend_out):
        app.mount("/", StaticFiles(directory=frontend_out, html=True), name="static")
    else:
        print(f"Warning: Frontend build directory not found at {frontend_out}")
    
    # Start uvicorn
    print(f"Starting IvoryOS Edge Server on port {port}...")
    # NOTE: In an actual production package we would point uvicorn to the module path string
    # For this dynamic state passing, we must pass the app instance directly. 
    # (reload=True is not allowed when passing the app instance directly).
    uvicorn.run(app, host="0.0.0.0", port=port, reload=False)
