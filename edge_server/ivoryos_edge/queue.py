import asyncio
from datetime import datetime
from typing import List, Dict, Any, Optional
import traceback
import inspect

from sqlalchemy import update, select
from sqlalchemy.orm import selectinload
from ivoryos_edge.models import async_session, WorkflowRun, WorkflowStep

class WorkflowQueueManager:
    def __init__(self, app):
        self.app = app
        self.active_run_id: Optional[int] = None
        
        self.paused = False
        self.cancelled = False
        self.pause_event: Optional[asyncio.Event] = None
        self.error_action: Optional[str] = None
        
        self.current_task: Optional[asyncio.Task] = None
        self._runner_lock: Optional[asyncio.Lock] = None
        
        # WebSocket tracking: run_id -> list of WebSockets
        self.active_connections: Dict[int, List[Any]] = {}
        self.global_connections: List[Any] = []

    async def init_asyncio(self):
        if self.pause_event is None:
            self.pause_event = asyncio.Event()
            self.pause_event.set()
        if self._runner_lock is None:
            self._runner_lock = asyncio.Lock()

    async def cleanup_zombies(self):
        from ivoryos_edge.models import async_session, WorkflowRun, WorkflowStep
        from datetime import datetime
        async with async_session() as session:
            # Fix stuck runs
            runs = await session.execute(
                select(WorkflowRun).where(WorkflowRun.status == "running")
            )
            for run in runs.scalars():
                run.status = "error"
                run.end_time = datetime.utcnow()
            
            # Fix stuck steps
            steps = await session.execute(
                select(WorkflowStep).where(WorkflowStep.status == "running")
            )
            for step in steps.scalars():
                step.status = "error"
                step.error = "Server crashed during execution."
                step.end_time = datetime.utcnow()
                
            await session.commit()

    async def get_all_runs(self):
        async with async_session() as session:
            runs = await session.execute(
                select(WorkflowRun).options(selectinload(WorkflowRun.steps)).order_by(WorkflowRun.id.desc())
            )
            result = []
            for r in runs.scalars().unique():
                d = r.as_dict()
                d["steps"] = [s.as_dict() for s in r.steps]
                result.append(d)
            return result

    async def get_run_status(self, run_id: int):
        async with async_session() as session:
            run = await session.get(WorkflowRun, run_id)
            if not run: return None
            
            steps = await session.execute(
                select(WorkflowStep).where(WorkflowStep.run_id == run_id).order_by(WorkflowStep.sequence_index)
            )
            
            run_dict = run.as_dict()
            run_dict['steps'] = [s[0].as_dict() for s in steps]
            
            # Immediate UI feedback for active runs
            if self.active_run_id == run_id:
                if self.cancelled:
                    run_dict['status'] = 'cancelling'
                elif self.paused:
                    run_dict['status'] = 'paused'
                    
            return run_dict

    async def update_step_parameters(self, step_id: int, parameters: dict):
        async with async_session() as session:
            step = await session.get(WorkflowStep, step_id)
            if not step:
                raise Exception("Step not found")
            if step.status != "pending":
                raise Exception("Cannot edit step that has already started")
            step.parameters = parameters
            await session.commit()

    async def submit_sequence(self, name: str, sequence: List[Dict[str, Any]], parameters: dict = None) -> int:
        """Submit a new sequence. Adds to pending queue and starts runner if not active."""
        await self.init_asyncio()
        async with self._runner_lock:
            async with async_session() as session:
                run = WorkflowRun(name=name, status="pending", parameters=parameters)
                session.add(run)
                await session.flush()
                
                for idx, step in enumerate(sequence):
                    db_step = WorkflowStep(
                        run_id=run.id,
                        sequence_index=idx,
                        instrument=step["instrument"],
                        method=step["method"],
                        parameters=step.get("params", {})
                    )
                    session.add(db_step)
                
                await session.commit()
                run_id = run.id

            if not self.current_task or self.current_task.done():
                self.paused = False
                self.cancelled = False
                self.pause_event.set()
                self.current_task = asyncio.create_task(self._execution_loop())
                
            await self.broadcast_global_queue()
            return run_id
            
    def pause(self):
        self.paused = True
        if self.pause_event: self.pause_event.clear()
        
    def resume(self):
        self.paused = False
        if self.pause_event: self.pause_event.set()
        
    def cancel(self):
        self.cancelled = True
        self.resume() # Make sure it wakes up to cancel

    async def subscribe(self, run_id: int, websocket: Any):
        if run_id not in self.active_connections:
            self.active_connections[run_id] = []
        self.active_connections[run_id].append(websocket)
        # Send initial state immediately
        await self.broadcast_run_status(run_id)
        
    async def unsubscribe(self, run_id: int, websocket: Any):
        if run_id in self.active_connections:
            if websocket in self.active_connections[run_id]:
                self.active_connections[run_id].remove(websocket)
            if not self.active_connections[run_id]:
                del self.active_connections[run_id]

    async def broadcast_run_status(self, run_id: int):
        if run_id not in self.active_connections:
            return
            
        status = await self.get_run_status(run_id)
        if status:
            dead_conns = []
            for ws in self.active_connections[run_id]:
                try:
                    await ws.send_json(status)
                except Exception:
                    dead_conns.append(ws)
            for ws in dead_conns:
                await self.unsubscribe(run_id, ws)

    async def subscribe_global(self, websocket: Any):
        self.global_connections.append(websocket)
        await self.broadcast_global_queue()

    async def unsubscribe_global(self, websocket: Any):
        if websocket in self.global_connections:
            self.global_connections.remove(websocket)

    async def broadcast_global_queue(self):
        if not self.global_connections:
            return
            
        runs = await self.get_all_runs()
        payload = {
            "runs": runs,
            "status": {
                "status": "running", 
                "active_workflow_id": self.active_run_id,
                "queue_paused": self.paused
            }
        }
        
        if self.active_run_id:
            payload["active_run"] = await self.get_run_status(self.active_run_id)
        else:
            # If no active run, send the most recently completed/errored run to show final status
            async with async_session() as session:
                recent_query = await session.execute(
                    select(WorkflowRun)
                    .where(WorkflowRun.status.in_(["completed", "error", "cancelled"]))
                    .order_by(WorkflowRun.end_time.desc())
                    .limit(1)
                )
                recent = recent_query.scalar_one_or_none()
                if recent:
                    payload["recent_run"] = await self.get_run_status(recent.id)
                
        dead_conns = []
        for ws in self.global_connections:
            try:
                await ws.send_json(payload)
            except Exception:
                dead_conns.append(ws)
        for ws in dead_conns:
            await self.unsubscribe_global(ws)

    async def broadcast_updates(self, run_id: Optional[int] = None):
        """Helper to broadcast both run status and global queue"""
        if run_id is not None:
            await self.broadcast_run_status(run_id)
        await self.broadcast_global_queue()

    async def _execution_loop(self):
        while True:
            try:
                await self.pause_event.wait()
                
                async with async_session() as session:
                    # Find the oldest pending run
                    result = await session.execute(
                        select(WorkflowRun).where(WorkflowRun.status == "pending").order_by(WorkflowRun.id).limit(1)
                    )
                    run = result.scalar_one_or_none()
                    if not run:
                        self.active_run_id = None
                        break # Queue is empty
                        
                    run_id = run.id
                    self.active_run_id = run_id
                    self.cancelled = False
                    
                    if run.parameters and run.parameters.get("type") == "Optimization":
                        await self._execute_optimization_run(run_id, session, run.parameters)
                        continue
                        
                    steps_query = await session.execute(
                        select(WorkflowStep).where(WorkflowStep.run_id == run_id).order_by(WorkflowStep.sequence_index)
                    )
                    steps = [s[0] for s in steps_query]
                    
                    index = 0
                    while index < len(steps):
                        step = steps[index]
                        if step.status != "pending" and step.status != "error":
                            index += 1
                            continue
                            
                        # Wait if paused
                        await self.pause_event.wait()
                        
                        if self.cancelled:
                            break
                            
                        # Refresh step in case params were edited while paused
                        await session.refresh(step)
                            
                        step.status = "running"
                        step.error = None
                        step.start_time = datetime.utcnow()
                        
                        run = await session.get(WorkflowRun, run_id)
                        run.status = "running"
                        
                        await session.commit()
                        await self.broadcast_updates(run_id)
                        
                        try:
                            instruments = getattr(self.app.state, "instruments", {})
                            if step.instrument not in instruments:
                                raise Exception(f"Instrument {step.instrument} not found")
                                
                            instance = instruments[step.instrument]
                            if not hasattr(instance, step.method):
                                raise Exception(f"Method {step.method} not found on {step.instrument}")
                                
                            method = getattr(instance, step.method)
                            args = step.parameters or {}
                            
                            if inspect.iscoroutinefunction(method):
                                result = await method(**args)
                            else:
                                loop = asyncio.get_running_loop()
                                result = await loop.run_in_executor(None, lambda: method(**args))
                                
                            step.status = "completed"
                            step.outputs = {"result": result}
                            
                            step.end_time = datetime.utcnow()
                            await session.commit()
                            await self.broadcast_updates(run_id)
                            index += 1
                            
                        except Exception as e:
                            step.status = "error"
                            step.error = str(e) + "\n" + traceback.format_exc()
                            step.end_time = datetime.utcnow()
                            
                            run.status = "error"
                            await session.commit()
                            
                            self.pause()
                            self.error_action = None
                            
                            await self.broadcast_updates(run_id)
                            
                            while self.error_action is None and not self.cancelled:
                                await asyncio.sleep(0.5)
                                
                            if self.cancelled:
                                break
                                
                            if self.error_action == "retry":
                                step.status = "pending"
                                step.error = None
                                await session.commit()
                                self.error_action = None
                                self.resume()
                                continue
                            elif self.error_action == "skip":
                                step.status = "skipped"
                                await session.commit()
                                index += 1
                                self.error_action = None
                                self.resume()
                                continue
                            else:
                                break # Unknown action or cancel
                    
                    # Update run status
                    run = await session.get(WorkflowRun, run_id)
                    if self.cancelled:
                        run.status = "cancelled"
                    elif any(s.status == "error" for s in steps):
                        run.status = "error"
                    else:
                        run.status = "completed"
                    run.end_time = datetime.utcnow()
                    await session.commit()
                    
                    if not self.cancelled:
                        await self.pause_event.wait()
                        
                    self.active_run_id = None
                    await self.broadcast_updates(run_id)
                    
            except Exception as e:
                print(f"Workflow {self.active_run_id} execution loop crashed: {e}")
                try:
                    async with async_session() as session:
                        run = await session.get(WorkflowRun, self.active_run_id)
                        if run:
                            run.status = "error"
                            run.end_time = datetime.utcnow()
                            await session.commit()
                            await self.broadcast_updates(self.active_run_id)
                except:
                    pass
                self.active_run_id = None
                await asyncio.sleep(1)

    async def _execute_optimization_run(self, run_id: int, session, parameters: dict):
        """Executes an optimization loop run, generating steps dynamically."""
        from ivoryos_edge.optimizer.registry import OPTIMIZER_REGISTRY
        import inspect
        
        opt_name = parameters.get("optimizer", "ax")
        budget = parameters.get("budget", 5)
        param_space = parameters.get("parameter_space", [])
        obj_config = parameters.get("objective_config", [])
        error_recovery = parameters.get("error_recovery", "stop")
        seq_template = parameters.get("sequence_template", [])
        
        OptClass = OPTIMIZER_REGISTRY.get(opt_name)
        if not OptClass:
            raise Exception(f"Optimizer {opt_name} not found")
            
        optimizer = OptClass(
            experiment_name=f"OptRun_{run_id}",
            parameter_space=param_space,
            objective_config=obj_config,
            optimizer_config={}
        )
        
        run = await session.get(WorkflowRun, run_id)
        run.status = "running"
        await session.commit()
        await self.broadcast_updates(run_id)
        
        step_index = 0
        
        for iteration in range(budget):
            if self.cancelled:
                break
            await self.pause_event.wait()
            
            # 1. Ask optimizer for suggestion
            try:
                loop = asyncio.get_running_loop()
                suggestion = await loop.run_in_executor(None, lambda: optimizer.suggest(n=1))
                if isinstance(suggestion, list) and len(suggestion) > 0:
                    suggestion = suggestion[0]
            except Exception as e:
                print(f"Optimizer suggest error: {e}")
                run.status = "error"
                break
                
            # 2. Build steps from template
            iteration_steps = []
            for tmpl_step in seq_template:
                args = {}
                for k, v in tmpl_step.get("params", {}).items():
                    if isinstance(v, str) and v.startswith("#"):
                        var_name = v[1:]
                        args[k] = suggestion.get(var_name, v)
                    else:
                        args[k] = v
                        
                db_step = WorkflowStep(
                    run_id=run_id,
                    sequence_index=step_index,
                    instrument=tmpl_step["instrument"],
                    method=tmpl_step["method"],
                    parameters=args,
                    status="pending"
                )
                session.add(db_step)
                iteration_steps.append((db_step, tmpl_step.get("returnVar")))
                step_index += 1
                
            await session.commit()
            await self.broadcast_updates(run_id)
            
            # 3. Execute steps
            iteration_failed = False
            objective_values = {}
            
            for db_step, return_var in iteration_steps:
                if self.cancelled:
                    break
                await self.pause_event.wait()
                
                db_step.status = "running"
                db_step.start_time = datetime.utcnow()
                await session.commit()
                await self.broadcast_updates(run_id)
                
                try:
                    instruments = getattr(self.app.state, "instruments", {})
                    if db_step.instrument not in instruments:
                        raise Exception(f"Instrument {db_step.instrument} not found")
                    instance = instruments[db_step.instrument]
                    method = getattr(instance, db_step.method)
                    
                    if inspect.iscoroutinefunction(method):
                        result = await method(**(db_step.parameters or {}))
                    else:
                        loop = asyncio.get_running_loop()
                        result = await loop.run_in_executor(None, lambda: method(**(db_step.parameters or {})))
                        
                    db_step.status = "completed"
                    db_step.outputs = {"result": result}
                    if return_var:
                        # Extract the numeric objective if possible
                        if isinstance(result, dict) and return_var in result:
                            objective_values[return_var] = float(result[return_var])
                        else:
                            try:
                                objective_values[return_var] = float(result)
                            except:
                                pass
                except Exception as e:
                    db_step.status = "error"
                    import traceback
                    db_step.error = str(e) + "\n" + traceback.format_exc()
                    iteration_failed = True
                    
                db_step.end_time = datetime.utcnow()
                await session.commit()
                await self.broadcast_updates(run_id)
                
                if iteration_failed:
                    break
                    
            if self.cancelled:
                break
                
            # 4. Handle results & tell optimizer
            if iteration_failed:
                if error_recovery == "stop":
                    run.status = "error"
                    break
                elif error_recovery == "skip":
                    # provide dummy bad data or ignore
                    try:
                        # pass NaN or some large penalty? Actually Baybe/Ax might crash on NaN.
                        # For now we'll just not observe it if skipped.
                        pass
                    except: pass
                elif error_recovery == "retry":
                    # In a real system, we'd decrement iteration and continue
                    # For simplicity, treat retry as skip for the optimizer loop
                    pass
            else:
                try:
                    loop = asyncio.get_running_loop()
                    await loop.run_in_executor(None, lambda: optimizer.observe(objective_values))
                except Exception as e:
                    print(f"Optimizer observe error: {e}")
                    
        # Finish run
        run = await session.get(WorkflowRun, run_id)
        if self.cancelled:
            run.status = "cancelled"
        elif run.status != "error":
            run.status = "completed"
        run.end_time = datetime.utcnow()
        await session.commit()
        
        if not self.cancelled:
            await self.pause_event.wait()
            
        self.active_run_id = None
        await self.broadcast_updates(run_id)
