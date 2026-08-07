import os
import asyncio
import socketio
import inspect
import sys
import uuid
from typing import Dict, Any
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from dotenv import load_dotenv

from .introspection import inspect_device_module
from .models import init_db
from .queue import WorkflowQueueManager

load_dotenv()

app = FastAPI(title="IvoryOS Edge Server")
queue_manager = WorkflowQueueManager(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Socket.io Client to connect to Cloud Orchestrator
# handle_sigint=False prevents socket.io from fighting with uvicorn's shutdown handlers
sio = socketio.AsyncClient(handle_sigint=False)
CLOUD_URL = os.getenv("CLOUD_URL", "http://localhost:4000")
REGISTRATION_KEY = os.getenv("REGISTRATION_KEY", "edge-default-01")

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
        print(f"Connecting to Cloud Orchestrator at {CLOUD_URL}...")
        await sio.connect(CLOUD_URL, auth={"token": REGISTRATION_KEY})
        print("Connected to Cloud Orchestrator successfully.")
    except Exception as e:
        print(f"Failed to connect to Cloud Orchestrator: {e}")

@app.on_event("shutdown")
async def shutdown_event():
    try:
        if sio.connected:
            await sio.disconnect()
    except Exception as e:
        print(f"Graceful shutdown of socket.io failed: {e}")

@sio.event
async def connect():
    print("Socket.io connection established with Cloud Orchestrator.")

@sio.event
async def disconnect():
    print("Socket.io disconnected from Cloud Orchestrator.")

@sio.event
async def execute_workflow(data):
    print(f"Received workflow execution request from cloud: {data}")
    # TODO: Pass to local execution engine
    await sio.emit("workflow_status", {"status": "started", "workflow": data.get("id")})

@app.get("/api/status")
def get_status():
    return {
        "status": "running", 
        "cloud_connected": sio.connected,
        "instruments": getattr(app.state, "instrument_schemas", {}),
        "instrument_meta": getattr(app.state, "instrument_meta", {}),
        "active_tasks": list(active_tasks.keys()),
        "active_workflow_id": queue_manager.active_run_id,
        "queue_paused": queue_manager.paused
    }

# --- Queue Manager Endpoints ---

@app.get("/api/queue/runs")
async def list_runs():
    runs = await queue_manager.get_all_runs()
    return {"runs": runs}

@app.post("/api/queue/runs")
async def create_run(req: Request):
    data = await req.json()
    name = data.get("name", "Unnamed Workflow")
    sequence = data.get("sequence", [])
    parameters = data.get("parameters", {})
    try:
        run_id = await queue_manager.submit_sequence(name, sequence, parameters)
        return {"status": "started", "run_id": run_id}
    except Exception as e:
        return {"error": str(e)}, 400

@app.get("/api/queue/runs/{run_id}")
async def get_run(run_id: int):
    status = await queue_manager.get_run_status(run_id)
    if not status:
        return {"error": "Not found"}, 404
    return status

@app.post("/api/queue/runs/{run_id}/resolve")
async def resolve_run_error(run_id: int, req: Request):
    data = await req.json()
    action = data.get("action")
    if queue_manager.active_run_id == run_id:
        queue_manager.error_action = action
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
    return {"error": "Workflow not active"}, 400

@app.post("/api/queue/runs/{run_id}/resume")
async def resume_run(run_id: int):
    if queue_manager.active_run_id == run_id:
        queue_manager.resume()
        return {"status": "running"}
    return {"error": "Workflow not active"}, 400

@app.post("/api/queue/runs/{run_id}/cancel")
async def cancel_run(run_id: int):
    if queue_manager.active_run_id == run_id:
        queue_manager.cancel()
        return {"status": "cancelling"}
        
    # Check if we can cancel a pending run directly in the DB
    from ivoryos_edge.models import async_session, WorkflowRun
    async with async_session() as session:
        run = await session.get(WorkflowRun, run_id)
        if run and run.status == "pending":
            run.status = "cancelled"
            await session.commit()
            return {"status": "cancelled"}
            
    return {"error": "Workflow not active"}, 400

@app.put("/api/steps/{step_id}")
async def update_step(step_id: int, req: Request):
    data = await req.json()
    parameters = data.get("parameters")
    try:
        await queue_manager.update_step_parameters(step_id, parameters)
        return {"status": "updated"}
    except Exception as e:
        return {"error": str(e)}, 400

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
        return {"error": f"Module {req.module} not found"}, 404
        
    instance = instruments[req.module]
    if not hasattr(instance, req.method):
        return {"error": f"Method {req.method} not found on {req.module}"}, 404
        
    method = getattr(instance, req.method)
    
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
        
    return {"error": "Task not found"}, 404

@app.delete("/api/execute/{task_id}")
async def kill_execution(task_id: str):
    if task_id not in active_tasks:
        return {"error": "Task not found or already completed"}, 404
        
    task = active_tasks[task_id]
    task.cancel()
    return {"status": "cancelled", "task_id": task_id}

WORKFLOWS_DIR = os.path.join(os.path.dirname(__file__), "workflows")
os.makedirs(WORKFLOWS_DIR, exist_ok=True)

@app.get("/api/workflows")
def list_workflows():
    try:
        files = [f for f in os.listdir(WORKFLOWS_DIR) if f.endswith(".json")]
        return {"workflows": [f.replace(".json", "") for f in files]}
    except Exception as e:
        return {"error": str(e)}, 500

@app.get("/api/workflows/{name}")
def get_workflow(name: str):
    filepath = os.path.join(WORKFLOWS_DIR, f"{name}.json")
    if not os.path.exists(filepath):
        return {"error": "Workflow not found"}, 404
    import json
    try:
        with open(filepath, 'r') as f:
            data = json.load(f)
        return data
    except Exception as e:
        return {"error": str(e)}, 500

@app.post("/api/workflows/{name}")
async def save_workflow(name: str, req: Request):
    try:
        data = await req.json()
    except Exception as e:
        return {"error": "Invalid JSON"}, 400
        
    filepath = os.path.join(WORKFLOWS_DIR, f"{name}.json")
    import json
    try:
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=4)
        return {"status": "success", "name": name}
    except Exception as e:
        return {"error": str(e)}, 500

# Serve the static Next.js export
frontend_out = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "frontend/out")
if os.path.exists(frontend_out):
    app.mount("/", StaticFiles(directory=frontend_out, html=True), name="static")
else:
    print(f"Warning: Frontend build directory not found at {frontend_out}")


def run(module_name: str, port: int = 8080):
    """
    Entry point to start the Edge Server. 
    It inspects the caller module for initialized instruments.
    """
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
    
    # Start uvicorn
    print(f"Starting IvoryOS Edge Server on port {port}...")
    # NOTE: In an actual production package we would point uvicorn to the module path string
    # For this dynamic state passing, we must pass the app instance directly. 
    # (reload=True is not allowed when passing the app instance directly).
    uvicorn.run(app, host="0.0.0.0", port=port, reload=False)
