import os
import asyncio
import inspect
import sys
import uuid
import httpx
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

CLOUD_URL = os.getenv("CLOUD_URL", "http://localhost:3000")
REGISTRATION_KEY = os.getenv("REGISTRATION_KEY", "edge-default-01")

class CloudSettingsRequest(BaseModel):
    cloudUrl: str
    registrationKey: str

@app.get("/api/cloud-settings")
def get_cloud_settings():
    return {
        "cloudUrl": CLOUD_URL,
        "registrationKey": REGISTRATION_KEY
    }

@app.post("/api/cloud-settings")
def update_cloud_settings(req: CloudSettingsRequest):
    global CLOUD_URL, REGISTRATION_KEY
    CLOUD_URL = req.cloudUrl
    REGISTRATION_KEY = req.registrationKey
    
    # Save to .env
    env_lines = []
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH, "r") as f:
            env_lines = f.readlines()
            
    # Update or append
    cloud_url_found = False
    reg_key_found = False
    for i, line in enumerate(env_lines):
        if line.startswith("CLOUD_URL="):
            env_lines[i] = f"CLOUD_URL={CLOUD_URL}\n"
            cloud_url_found = True
        elif line.startswith("REGISTRATION_KEY="):
            env_lines[i] = f"REGISTRATION_KEY={REGISTRATION_KEY}\n"
            reg_key_found = True
            
    if not cloud_url_found:
        env_lines.append(f"CLOUD_URL={CLOUD_URL}\n")
    if not reg_key_found:
        env_lines.append(f"REGISTRATION_KEY={REGISTRATION_KEY}\n")
        
    with open(ENV_PATH, "w") as f:
        f.writelines(env_lines)
        
    return {"status": "success"}

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
            }, f, indent=2)
        print("Dumped introspected schema to ivoryos_schema.json for local version control.")
    except Exception as e:
        print(f"Failed to dump ivoryos_schema.json: {e}")
        
    # Start Cloud Polling Task
    async def poll_cloud():
        print(f"Starting cloud polling to {CLOUD_URL}...")
        while True:
            try:
                if not CLOUD_URL:
                    await asyncio.sleep(2)
                    continue

                library_workflows = {}
                try:
                    import json
                    if os.path.exists(WORKFLOWS_DIR):
                        for f in os.listdir(WORKFLOWS_DIR):
                            if f.endswith(".json"):
                                with open(os.path.join(WORKFLOWS_DIR, f), 'r') as fp:
                                    data = json.load(fp)
                                    wf_name = f.replace(".json", "")
                                    dynamic_params = {}
                                    
                                    def scan_blocks(blocks):
                                        for b in blocks:
                                            for k, val in b.get("args", {}).items():
                                                if isinstance(val, str) and val.startswith('#'):
                                                    param_name = val[1:]
                                                    param_type = b.get("arg_types", {}).get(k, "str")
                                                    dynamic_params[param_name] = {"type": param_type, "required": True}
                                                    
                                    scan_blocks(data.get("prep", []))
                                    scan_blocks(data.get("script", []))
                                    scan_blocks(data.get("cleanup", []))
                                    
                                    library_workflows[wf_name] = {
                                        "description": data.get("description", "Saved Workflow"),
                                        "parameters": dynamic_params,
                                        "return_type": "None"
                                    }
                except Exception as e:
                    pass

                current_instruments = dict(app.state.instrument_schemas)
                if library_workflows:
                    current_instruments["Library Workflows"] = library_workflows

                schema = {
                    "instruments": current_instruments,
                    "instrument_meta": app.state.instrument_meta
                }
                async with httpx.AsyncClient() as client:
                    resp = await client.post(f"{CLOUD_URL}/api/edge/heartbeat", json={
                        "deviceId": REGISTRATION_KEY,
                        "schema": schema
                    })
                    if resp.status_code == 200:
                        data = resp.json()
                        tasks = data.get("tasks", [])
                        for t in tasks:
                            print(f"Received cloud task: {t}")
                            block = t.get("block")
                            runId = t.get("runId")
                            nodeId = t.get("nodeId")
                            if block and runId and nodeId:
                                expanded_blocks = expand_workflow_blocks([block], WORKFLOWS_DIR, "main")
                                await queue_manager.submit_sequence(
                                    f"Cloud Node {nodeId} ({runId})", 
                                    expanded_blocks, 
                                    {"cloud_run_id": runId, "cloud_node_id": nodeId}
                                )
            except Exception as e:
                # Silently catch network errors during polling
                pass
            await asyncio.sleep(2)
            
    asyncio.create_task(poll_cloud())

@app.get("/api/status")
def get_status():
    return {
        "status": "running", 
        "cloud_connected": bool(CLOUD_URL),
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

import json

def expand_workflow_blocks(sequence_list, workflows_dir, default_phase="main"):
    expanded = []
    for block in sequence_list:
        if block.get("instrument") == "Library Workflows":
            wf_name = block.get("method")
            try:
                with open(os.path.join(workflows_dir, f"{wf_name}.json"), "r") as wf_file:
                    wf_data = json.load(wf_file)
                
                # Replace dynamic params (#var) with the values provided in the block
                params = block.get("params", {})
                
                def instantiate_blocks(blocks, phase, parent=None):
                    inst_blocks = []
                    for b in blocks:
                        # Copy the block
                        new_b = dict(b)
                        new_b["instrument"] = new_b.get("instrument", new_b.get("module"))
                        new_b["method"] = new_b.get("method", new_b.get("action"))
                        if "args" in new_b:
                            new_b["params"] = new_b.pop("args")
                        
                        # Replace # variables and inject metadata
                        new_args = {}
                        for k, v in new_b.get("params", {}).items():
                            if isinstance(v, str) and v.startswith("#"):
                                var_name = v[1:]
                                new_args[k] = params.get(var_name, v)
                            else:
                                new_args[k] = v
                        
                        new_args["_phase"] = phase
                        if parent:
                            new_args["_parent_workflow"] = parent
                            
                        ret_val = b.get("returnVar") or b.get("return")
                        if ret_val:
                            new_args["_return_var"] = ret_val
                            
                        new_b["params"] = new_args
                        inst_blocks.append(new_b)
                    return inst_blocks
                
                expanded.extend(instantiate_blocks(wf_data.get("prep", []), default_phase, wf_name))
                expanded.extend(instantiate_blocks(wf_data.get("script", []), default_phase, wf_name))
                expanded.extend(instantiate_blocks(wf_data.get("cleanup", []), default_phase, wf_name))
            except Exception as e:
                print(f"Failed to expand workflow {wf_name}: {e}")
                # Fallback: add original block
                expanded.append(block)
        else:
            new_b = dict(block)
            params = dict(new_b.get("params", {}))
            if "_phase" not in params:
                params["_phase"] = default_phase
                
            ret_val = block.get("returnVar") or block.get("return")
            if ret_val:
                params["_return_var"] = ret_val
                
            new_b["params"] = params
            expanded.append(new_b)
    return expanded

@app.post("/api/queue/runs")
async def create_run(req: Request):
    data = await req.json()
    name = data.get("name", "Unnamed Workflow")
    parameters = data.get("parameters", {})
    
    prep = data.get("prep", [])
    sequence = data.get("sequence", [])
    cleanup = data.get("cleanup", [])
    
    try:
        prep = expand_workflow_blocks(prep, WORKFLOWS_DIR, "prep")
        sequence = expand_workflow_blocks(sequence, WORKFLOWS_DIR, "main")
        cleanup = expand_workflow_blocks(cleanup, WORKFLOWS_DIR, "cleanup")
        
        if parameters.get("type") == "Optimization":
            parameters["prep_template"] = prep
            parameters["cleanup_template"] = cleanup
            # The sequence_template is already inside parameters, but it's not expanded!
            if "sequence_template" in parameters:
                parameters["sequence_template"] = expand_workflow_blocks(parameters["sequence_template"], WORKFLOWS_DIR)
            
            # Send empty sequence because loop handles the sequence_template
            run_id = await queue_manager.submit_sequence(name, [], parameters)
        else:
            # Flatten everything into a single sequence
            combined_sequence = prep + sequence + cleanup
            run_id = await queue_manager.submit_sequence(name, combined_sequence, parameters)
            
        return {"status": "started", "run_id": run_id}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

@app.get("/api/queue/runs/{run_id}")
async def get_run(run_id: int):
    status = await queue_manager.get_run_status(run_id)
    if not status:
        return JSONResponse(status_code=404, content={"error": "Not found"})
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
    if not hasattr(instance, req.method):
        return JSONResponse(status_code=404, content={"error": f"Method {req.method} not found on {req.module}"})
        
    method = getattr(instance, req.method)
    
    from ivoryos_edge.introspection import cast_arguments
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

@app.get("/api/workflows")
def list_workflows():
    try:
        import json
        workflows = []
        for f in os.listdir(WORKFLOWS_DIR):
            if f.endswith(".json"):
                filepath = os.path.join(WORKFLOWS_DIR, f)
                name = f.replace(".json", "")
                desc = ""
                created_at = os.path.getctime(filepath)
                updated_at = os.path.getmtime(filepath)
                try:
                    with open(filepath, 'r') as fp:
                        data = json.load(fp)
                        desc = data.get("description", "")
                except:
                    pass
                workflows.append({
                    "name": name,
                    "description": desc,
                    "created_at": created_at * 1000, # Return JS timestamp
                    "updated_at": updated_at * 1000
                })
        return {"workflows": workflows}
    except Exception as e:
        return {"error": str(e)}, 500

@app.get("/api/plugins")
def list_plugins():
    return {"plugins": getattr(app.state, "plugins", [])}

@app.get("/api/workflows/{name}")
def get_workflow(name: str):
    filepath = os.path.join(WORKFLOWS_DIR, f"{name}.json")
    if not os.path.exists(filepath):
        return JSONResponse(status_code=404, content={"error": "Workflow not found"})
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
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})
        
    filepath = os.path.join(WORKFLOWS_DIR, f"{name}.json")
    import json
    try:
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=4)
        return {"status": "success", "name": name}
    except Exception as e:
        return {"error": str(e)}, 500

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
