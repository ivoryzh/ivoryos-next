import os
import asyncio
import inspect
import sys
import time
import uuid
import httpx
import base64
import json
from typing import Dict, Any
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from dotenv import load_dotenv

from .introspection import inspect_device_module
from .models import init_db
from .queue import WorkflowQueueManager
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

class CloudSettingsRequest(BaseModel):
    token: str

@app.get("/api/cloud-settings")
def get_cloud_settings():
    return {
        "token": CLOUD_TOKEN,
        "connection_state": cloud_connection_state,
        "connection_error": cloud_connection_error,
    }

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

async def handle_broker_message(topic: str, payload: dict):
    print(f"Received cloud task from topic {topic}: {payload}")
    block = payload.get("block")
    runId = payload.get("runId")
    nodeId = payload.get("nodeId")
    if block and runId and nodeId:
        resolved_links = []
        try:
            expanded_blocks = expand_workflow_blocks(
                [block], WORKFLOWS_DIR, "main", resolved=resolved_links
            )
        except WorkflowError as e:
            # A cloud-dispatched node can reference a workflow this device doesn't have (or has
            # since renamed). Refusing loudly here beats queueing a malformed step: the old
            # expander's silent fallback would have sent "Library Workflows" to the executor as if
            # it were an instrument.
            print(f"Refusing cloud task {nodeId} for run {runId}: {e}")
            return
        await queue_manager.submit_sequence(
            f"Cloud Node {nodeId} ({runId})",
            expanded_blocks,
            {
                "cloud_run_id": runId,
                "cloud_node_id": nodeId,
                **({"resolved_links": resolved_links} if resolved_links else {}),
            }
        )

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
        "instrument_meta": getattr(app.state, "instrument_meta", {})
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
                broker.publish(f"{topic_prefix}/{client_id}/sequences/{name}", data, retain=True, qos=1)
            except Exception as e:
                print(f"Failed to publish sequence '{name}': {e}")
    except Exception as e:
        print(f"Failed to list workflows for sync: {e}")

async def status_loop(broker, topic_prefix, client_id):
    """A cheap, frequent liveness signal — deliberately just {online, ts}, not the schema. Kept
    small on purpose: at a 5s interval this is what actually gets billed per-message on AWS IoT,
    and 'online' is also covered by the LWT for the ungraceful-disconnect case (see setup_broker).

    Also periodically re-publishes schema/sequences (every 12th tick, ~60s) — NOT just once on
    connect the way setup_broker's initial calls do. Those initial calls are one-shot QoS-1
    publishes with no retry; a real, reproduced bug was AWS IoT's connection needing a few rapid
    client-initiated reconnects to settle right after startup (root cause of *that* churn still
    open), which raced the one-shot schema/sequences publish and silently dropped it — status
    itself never showed a symptom because it's QoS-0 and re-sent every 5s regardless, so it just
    self-healed on the next tick. Confirmed directly: 284 'status' messages arrived at the
    daemon during testing, zero 'schema' or 'sequences' ones, from the exact same connection.
    Folding schema/sequences into this already-repeating loop gives them the same self-healing
    property instead of trying to fix the one-shot call to race-proof itself."""
    tick = 0
    while True:
        try:
            broker.publish(f"{topic_prefix}/{client_id}/status", {"online": True, "ts": time.time()}, retain=True, qos=0)
            if tick % 12 == 0:
                publish_schema(broker, topic_prefix, client_id)
                publish_sequences(broker, topic_prefix, client_id)
        except Exception as e:
            print(f"Error publishing status: {e}")
        tick += 1
        await asyncio.sleep(5)

async def setup_broker():
    global global_broker, cloud_connection_state, cloud_connection_error
    if global_broker:
        global_broker.disconnect()
        global_broker = None

    if not CLOUD_TOKEN:
        cloud_connection_state = "disconnected"
        cloud_connection_error = None
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

            global_broker.subscribe(f"{topic_prefix}/{client_id}/execute")

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
        "queue_paused": queue_manager.paused
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

@app.post("/api/queue/runs")
async def create_run(req: Request):
    data = await req.json()
    name = data.get("name", "Unnamed Workflow")
    parameters = data.get("parameters", {})
    
    prep = data.get("prep", [])
    sequence = data.get("sequence", [])
    cleanup = data.get("cleanup", [])
    
    # Every link followed while flattening is recorded and persisted onto the run, so a finished
    # run can state exactly which body of each subworkflow it executed. Without this, editing a
    # linked workflow silently made past runs unreproducible with nothing in the record to show it.
    resolved_links = []

    try:
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
            run_id = await queue_manager.submit_sequence(name, [], parameters)
        else:
            if resolved_links:
                parameters["resolved_links"] = resolved_links

            # Flatten everything into a single sequence
            combined_sequence = prep + sequence + cleanup
            run_id = await queue_manager.submit_sequence(name, combined_sequence, parameters)

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
        task_results[task_id] = {"status": "completed", "result": result}
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
            summaries.append(summary)
        return {"workflows": summaries, "tags": wf.all_tags(WORKFLOWS_DIR)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


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
                f"{global_topic_prefix}/{global_client_id}/sequences/{name}", body, retain=True, qos=1
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
