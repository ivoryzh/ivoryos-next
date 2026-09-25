import asyncio
import json
import re
import uuid
from datetime import datetime
from typing import List, Dict, Any, Optional
import traceback
import inspect

from sqlalchemy import update, select, or_, and_, func, String, cast
from sqlalchemy.orm import selectinload
from ivoryos_edge.introspection import serialize_result
from ivoryos_edge.models import async_session, WorkflowRun, WorkflowStep

def extract_return_values(return_bindings, return_var, serialized_res, result):
    """Map a step's declared outputs onto the value the step actually returned.

    Two shapes are supported, in priority order:

    * **Explicit pointers** (`return_bindings`) — ``[{"path": "metrics.purity", "var": "p"}]``,
      the shape the Designer produces from a method's introspected ``return_paths``. Each named
      variable is read from *its own* field of a structured (dataclass / Pydantic / dict /
      fixed-length tuple) result, so a method that returns a rich object can hand one numeric
      field to the optimizer and still keep the rest addressable. An empty path means the whole
      result.
    * **Legacy comma-separated names** (`return_var`) — "a, b" mapped *positionally* onto the
      result's values/elements. Kept because every sequence saved before pointers existed uses
      it, and because that positional mapping is exactly what pointers replace: it silently
      binds the wrong name to the wrong field the moment a driver reorders its return fields.

    Returns an ordered ``{var_name: value}`` dict. A pointer whose path isn't present in the
    real result is skipped rather than recorded as None, so a partially-shaped result doesn't
    poison the workflow context (or the optimizer) with placeholder values.
    """
    from ivoryos_edge.introspection import resolve_output_path, _MISSING

    values = {}

    if return_bindings:
        # Accept both the list-of-pointers shape and a plain {path: var} mapping.
        pairs = (return_bindings.items() if isinstance(return_bindings, dict)
                 else [(b.get("path", ""), b.get("var")) for b in return_bindings if isinstance(b, dict)])
        for path, var in pairs:
            if not var:
                continue
            if not path:
                # The whole result — hand over the live object, not its serialized form, so a
                # later step can pass it straight back into another driver method (what the
                # single legacy return variable has always done).
                values[var] = result
                continue
            resolved = resolve_output_path(serialized_res, path)
            if resolved is _MISSING:
                # The serialized form is the normal case, but a driver can return an object
                # that serialize_output left alone (an arbitrary class); fall back to walking
                # the live result by attribute before giving up on the pointer.
                resolved = resolve_output_path(result, path)
            if resolved is not _MISSING:
                values[var] = resolved
        if values:
            return values

    if not return_var:
        return values

    ret_vars = [v.strip() for v in str(return_var).split(",") if v.strip()]
    if len(ret_vars) > 1 and isinstance(serialized_res, dict):
        for k, v in zip(ret_vars, serialized_res.values()):
            values[k] = v
    elif len(ret_vars) > 1 and isinstance(result, (tuple, list)):
        for k, v in zip(ret_vars, result):
            values[k] = v
    elif ret_vars:
        key = ret_vars[0]
        if isinstance(result, dict) and key in result:
            values[key] = result[key]
        else:
            values[key] = result
    return values


def substitute_workflow_vars(obj, context: Dict[str, Any]):
    """Recursively resolve '#varname' parameter values against the live run's workflow_context.

    Values produced by a 'User_Input' step (or any step's return var) only exist once that
    step has actually run, so an unresolved reference raises rather than sending a literal
    '#varname' string to a real instrument.
    """
    if isinstance(obj, str) and obj.startswith("#"):
        var_name = obj[1:].strip()
        if var_name == "":
            return obj
        if var_name not in context:
            raise Exception(f"Variable '#{var_name}' is not available yet — no earlier step has set it.")
        return context[var_name]
    if isinstance(obj, dict):
        return {k: substitute_workflow_vars(v, context) for k, v in obj.items()}
    if isinstance(obj, list):
        return [substitute_workflow_vars(v, context) for v in obj]
    return obj


# Longest While history kept on the step. A loop that polls a sensor can run thousands of times;
# the log needs to show how it went, not every evaluation of it.
MAX_CONDITION_HISTORY = 50


def step_row(step) -> Optional[int]:
    """The spreadsheet row a step belongs to (`_row`, stamped by the Configure page), or None."""
    row = (step.parameters or {}).get("_row") if isinstance(step.parameters, dict) else None
    return row if isinstance(row, int) else None


def scoped_context(context: Dict[str, Any], row_contexts: Dict[int, Dict[str, Any]], step) -> Dict[str, Any]:
    """What a step reads `#name`s and conditions from: its own row's values over the run-wide ones.

    A batch groups rows and walks the sequence block by block, so `measure(r1) measure(r2)` both run
    before either row's `If absorbance > 1.5`. With one flat context every row's If read the *last*
    row's absorbance. Values a step produces are recorded under its row as well as run-wide (see
    `bind_values`), so a per-sample step sees its own sample's result, while a value no row has
    produced -- a batch step's, a prep step's -- still comes from the run-wide context.
    """
    row = step_row(step)
    if row is None or row not in row_contexts:
        return context
    return {**context, **row_contexts[row]}


def bind_values(context: Dict[str, Any], row_contexts: Dict[int, Dict[str, Any]], step, values: Dict[str, Any]) -> None:
    context.update(values)
    row = step_row(step)
    if row is not None:
        row_contexts.setdefault(row, {}).update(values)


def condition_record(condition: str, result: Any, context: Dict[str, Any], previous: Any = None) -> Dict[str, Any]:
    """What an If/While step logs: the expression, the values it read, and what it came to.

    Without this a finished run said only "If: completed" -- which branch ran had to be inferred from
    which steps were skipped, and the value that decided it was not recorded anywhere. A While keeps
    the outcome of every evaluation (capped), since "looped 3 times, then stopped" is the question.
    """
    names = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", str(condition)))
    variables = {}
    for name in sorted(names):
        if name in context:
            value = context[name]
            variables[name] = value if isinstance(value, (int, float, str, bool, type(None))) else repr(value)
    history = list((previous or {}).get("history") or []) if isinstance(previous, dict) else []
    history = (history + [bool(result)])[-MAX_CONDITION_HISTORY:]
    return {"result": bool(result), "condition": str(condition), "variables": variables, "history": history}


# Progress messages to Cloud: at most one per run every this many seconds. A step finishing every
# 200ms would otherwise be five messages a second, all but the last already out of date on
# arrival; a long step in between still gets its update, via the trailing send below.
PROGRESS_MIN_INTERVAL_S = 2.0
_DONE_STEP_STATUSES = ("completed", "skipped")


def run_progress_summary(run: Dict[str, Any]) -> Dict[str, Any]:
    """Where a run is up to, in as few bytes as will say it (~150-250 B of JSON).

    Sent to Cloud on the existing task-status topic. It is a *summary*, not the step list: AWS IoT
    meters in 5KB units, and a 60-step run's full state is several of those per update, while this
    is a fraction of one. Absent keys mean "not applicable" (no rows, not an optimization).
    """
    steps = sorted(run.get("steps") or [], key=lambda s: (s.get("sequence_index") or 0, s.get("id") or 0))
    params = run.get("parameters") or {}
    phase = lambda s: (s.get("parameters") or {}).get("_phase") or "main"
    main = [s for s in steps if phase(s) == "main"]
    done = sum(1 for s in steps if s.get("status") in _DONE_STEP_STATUSES)

    summary: Dict[str, Any] = {"done": done, "total": len(steps), "state": run.get("status")}

    current = next((s for s in steps if s.get("status") in ("running", "waiting_input", "error")), None) \
        or next((s for s in steps if s.get("status") == "pending"), None)
    if current:
        summary["phase"] = phase(current)
        flow = current.get("instrument") in ("Flow_Control", "Flow Control")
        summary["step"] = current.get("method") if flow else f"{current.get('instrument')}.{current.get('method')}"
        row = (current.get("parameters") or {}).get("_row")
        if isinstance(row, int):
            summary["row"] = row + 1

    if params.get("type") == "Optimization":
        # Trial steps are generated an iteration at a time, so the plan comes from the template.
        per_trial = len(params.get("sequence_template") or []) or 1
        budget = int(params.get("budget") or 0)
        main_done = sum(1 for s in main if s.get("status") in _DONE_STEP_STATUSES)
        planned_main = max(budget * per_trial, len(main))
        summary["total"] = len(steps) - len(main) + planned_main
        summary["iteration"] = min(budget, main_done // per_trial + (0 if run.get("status") == "completed" else 1))
        summary["budget"] = budget
    else:
        rows = sorted({(s.get("parameters") or {}).get("_row") for s in main} - {None})
        if len(rows) > 1:
            by_row = {r: [s for s in main if (s.get("parameters") or {}).get("_row") == r] for r in rows}
            summary["rows_total"] = len(rows)
            summary["rows_done"] = sum(
                1 for r in rows if all(s.get("status") in _DONE_STEP_STATUSES for s in by_row[r])
            )
    return summary


# AWS IoT refuses a message over 128KB; leave room for the envelope.
MAX_RESULT_BYTES = 100_000
_RESULT_STEP_KEYS = ("id", "sequence_index", "instrument", "method", "parameters", "outputs",
                     "status", "error", "start_time", "end_time")


def build_cloud_result(run: Dict[str, Any]) -> Dict[str, Any]:
    """A finished Cloud-dispatched run's record, for Cloud to keep a copy of.

    The same shape `/api/queue/runs` serves (parameters + steps), because Cloud reads it with the
    same `formatRun` Data History uses -- so the datasheet Cloud shows is the one the bench shows.
    Sent once per run, at the end. Bench runs are never sent: this is the data of runs Cloud asked
    for, not a mirror of the device's history.

    Past MAX_RESULT_BYTES it degrades rather than failing: first the per-step error text and
    timings go, then the steps themselves (`truncated: true`), and the full record stays on the
    device under `edgeRunId`.
    """
    params = {k: v for k, v in (run.get("parameters") or {}).items() if k not in ("cloud_run_id", "cloud_node_id")}
    steps = [{k: s.get(k) for k in _RESULT_STEP_KEYS} for s in run.get("steps") or []]
    record = {
        "edgeRunId": run.get("id"), "name": run.get("name"), "status": run.get("status"),
        "start_time": run.get("start_time"), "end_time": run.get("end_time"),
        "parameters": params, "steps": steps,
    }
    size = lambda r: len(json.dumps(r, default=str))
    if size(record) > MAX_RESULT_BYTES:
        record["steps"] = [{k: v for k, v in s.items() if k not in ("error", "start_time", "end_time")} for s in steps]
        record["trimmed"] = True
    if size(record) > MAX_RESULT_BYTES:
        record["steps"] = []
        record["truncated"] = True
    return record


def report_run_finished(run) -> None:
    """Everything that has to happen once a run reaches its final status, for every kind of run.

    Called from both the plain and the optimization paths. It used to live inline in the plain
    path only, so a Cloud-dispatched *optimization* never told Cloud it had finished: the task sat
    'queued' forever, and since Cloud now holds a device's next task until the current one is
    done, it also blocked every later Cloud task for that device.
    """
    params = run.parameters or {}
    # Imported lazily: server.py imports this module at load time.
    from ivoryos_edge.server import notify_status_changed, publish_task_status, republish_changed_runtimes
    if params.get("cloud_run_id"):
        publish_task_status(params["cloud_run_id"], params.get("cloud_node_id"), run.status)
    # Possibly free now, so a task Cloud is holding for this device can go without waiting.
    notify_status_changed()
    if run.status == "completed":
        # A finished run can move a workflow's typical duration; tell Cloud off the event loop,
        # since recomputing reads the run history synchronously.
        try:
            asyncio.get_running_loop().run_in_executor(None, republish_changed_runtimes)
        except RuntimeError:
            pass


def interpolate_message(text: str, context: Dict[str, Any]) -> str:
    """Replaces every '#varname' found inside free text (a Comment message or a User_Input
    prompt) with that variable's current value — a lightweight f-string using the same '#name'
    syntax as every other dynamic reference in the app. Unlike substitute_workflow_vars, this
    matches substrings within a larger message, and leaves an unresolved '#name' as literal text
    rather than raising, since a stray '#' in prose shouldn't take down the whole message.
    """
    def replace(match: "re.Match[str]") -> str:
        var_name = match.group(1)
        return str(context[var_name]) if var_name in context else match.group(0)
    return re.sub(r"#(\w+)", replace, text)


def coerce_input_value(value: Any, input_type: str) -> Any:
    """Cast a human-supplied value to the type the User_Input step declared.

    The UI already renders a matching control, but the value arrives over JSON (and can come
    from a script or curl), so the cast happens here too. An uncastable value is kept as-is
    rather than failing the run — the step that consumes it will report a clearer error.
    """
    if value is None:
        return value
    try:
        if input_type == "int":
            return int(float(value)) if not isinstance(value, bool) else int(value)
        if input_type == "float":
            return float(value)
        if input_type == "bool":
            if isinstance(value, str):
                return value.strip().lower() in ("true", "1", "yes", "y", "on")
            return bool(value)
    except (TypeError, ValueError):
        return value
    return value


def queue_position_of(run) -> float:
    """The sort key for a pending run: its explicit queue_position if it has one, else its id."""
    params = run.parameters or {}
    pos = params.get("queue_position")
    try:
        return float(pos) if pos is not None else float(run.id)
    except (TypeError, ValueError):
        return float(run.id)


class WorkflowQueueManager:
    def __init__(self, app):
        self.app = app
        self.active_run_id: Optional[int] = None
        
        self.paused = False
        self.cancelled = False
        self.pause_event: Optional[asyncio.Event] = None
        self.error_action: Optional[str] = None
        # Cloud tasks whose runs a restart abandoned (see cleanup_zombies): reported to Cloud as
        # errors once the broker is connected, since Cloud would otherwise wait on them forever.
        self.abandoned_cloud_tasks: List[Dict[str, Any]] = []
        # Cloud progress reporting (report_cloud_progress): which runs came from Cloud, and the
        # per-run throttle state.
        self._cloud_run_ids: Dict[int, bool] = {}
        # What Cloud is holding for this device (daemon.js publishCloudQueues), for awareness on
        # the Queue page only -- nothing here acts on it.
        self.cloud_queue: Optional[Dict[str, Any]] = None
        self._progress_state: Dict[int, Dict[str, Any]] = {}
        
        self.current_task: Optional[asyncio.Task] = None
        self.current_step_task: Optional[asyncio.Future] = None
        self._runner_lock: Optional[asyncio.Lock] = None

        # WebSocket tracking: run_id -> list of WebSockets
        self.active_connections: Dict[int, List[Any]] = {}
        self.global_connections: List[Any] = []

        # Human-in-the-loop "User_Input" step support: run_id -> pending Event/value
        self.pending_input_event: Dict[int, asyncio.Event] = {}
        self.pending_input_value: Dict[int, Any] = {}

        # The live optimizer instance for the active Optimization run, if any, so its
        # get_plots()/append_existing_data() can be reached from outside the execution loop.
        self.active_optimizer: Optional[Any] = None
        self.active_optimizer_run_id: Optional[int] = None

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
            # Fix stuck and pending runs. 'waiting_input' too: the prompt's answer is awaited on an
            # in-memory event, so after a restart nothing can ever resume it -- yet it went on
            # reading as "in progress", which now also tells Cloud this device is busy, forever.
            runs = await session.execute(
                select(WorkflowRun).where(WorkflowRun.status.in_(["running", "pending", "waiting_input", "paused"]))
            )
            for run in runs.scalars():
                run.status = "error"
                run.end_time = datetime.utcnow()
                params = run.parameters or {}
                if params.get("cloud_run_id"):
                    self.abandoned_cloud_tasks.append(
                        {"runId": params["cloud_run_id"], "nodeId": params.get("cloud_node_id")}
                    )

            # A run that stopped on a failed step is marked 'error' but deliberately left without
            # an end_time: the execution loop is still sitting on it, waiting for a retry / skip /
            # cancel decision. That wait lives in memory (`self.error_action`), so a restart
            # abandons it — nothing can ever resolve it, yet it still looks unfinished to every
            # reader. Left alone these accumulate forever and keep claiming the "currently
            # executing" slot in the UI. Close them out; the status stays 'error' because the run
            # really did fail.
            unresolved = await session.execute(
                select(WorkflowRun).where(WorkflowRun.status == "error", WorkflowRun.end_time.is_(None))
            )
            for run in unresolved.scalars():
                run.end_time = datetime.utcnow()


            # Fix stuck and pending steps
            steps = await session.execute(
                select(WorkflowStep).where(WorkflowStep.status.in_(["running", "pending", "waiting_input"]))
            )
            for step in steps.scalars():
                step.status = "error"
                step.error = "Server crashed or restarted before execution."
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

    # Statuses a run never leaves. Everything else is still the queue's business.
    TERMINAL_STATUSES = ("completed", "error", "cancelled")

    async def get_live_runs(self, recent: int = 10):
        """Every run still in the queue (pending, running, paused, waiting for input...) plus the
        `recent` newest runs, each with its steps.

        This is what the global queue broadcast carries. It used to carry `get_all_runs()` -- the
        whole history, every step of every run -- and it is sent after every single step, so the
        cost of running one step grew with the size of the lab's history. Nothing listening needs
        old runs: the queue pages want what is live and what just finished, and Data History pages
        through `list_run_summaries` instead.
        """
        async with async_session() as session:
            newest = select(WorkflowRun.id).order_by(WorkflowRun.id.desc()).limit(recent)
            runs = await session.execute(
                select(WorkflowRun)
                .options(selectinload(WorkflowRun.steps))
                .where(or_(WorkflowRun.status.not_in(self.TERMINAL_STATUSES), WorkflowRun.id.in_(newest)))
                .order_by(WorkflowRun.id.desc())
            )
            result = []
            for r in runs.scalars().unique():
                d = r.as_dict()
                d["steps"] = [s.as_dict() for s in r.steps]
                result.append(d)
            return result

    async def list_run_summaries(self, limit: int = 50, offset: int = 0, q: str = "",
                                 sort: str = "newest", status: str = "all"):
        """One page of run history, without steps: `{runs, total}`.

        Each word of `q` must match the run's name, its parameters (type, column names, values) or
        an instrument/method it called. `status` is a status name, `active` for anything not yet
        finished, or `all`. `sort` is newest, oldest, name or duration (longest first).
        """
        conditions = []
        for term in q.lower().split():
            like = f"%{term}%"
            step_match = (
                select(WorkflowStep.id)
                .where(WorkflowStep.run_id == WorkflowRun.id,
                       or_(func.lower(WorkflowStep.instrument).like(like), func.lower(WorkflowStep.method).like(like)))
                .exists()
            )
            conditions.append(or_(
                func.lower(WorkflowRun.name).like(like),
                func.lower(cast(WorkflowRun.parameters, String)).like(like),
                step_match,
            ))
        if status == "active":
            conditions.append(WorkflowRun.status.not_in(self.TERMINAL_STATUSES))
        elif status and status != "all":
            conditions.append(WorkflowRun.status == status)
        where = and_(*conditions) if conditions else None

        duration = func.julianday(WorkflowRun.end_time) - func.julianday(WorkflowRun.start_time)
        order = {
            "oldest": [WorkflowRun.start_time.asc(), WorkflowRun.id.asc()],
            "name": [func.lower(WorkflowRun.name).asc(), WorkflowRun.id.desc()],
            # An unfinished run has no duration; it sorts last rather than first.
            "duration": [duration.is_(None), duration.desc(), WorkflowRun.id.desc()],
        }.get(sort, [WorkflowRun.start_time.desc(), WorkflowRun.id.desc()])

        async with async_session() as session:
            count_q = select(func.count(WorkflowRun.id))
            page_q = select(WorkflowRun).order_by(*order).limit(max(1, min(limit, 500))).offset(max(0, offset))
            if where is not None:
                count_q = count_q.where(where)
                page_q = page_q.where(where)
            total = (await session.execute(count_q)).scalar_one()
            runs = list((await session.execute(page_q)).scalars())

            instruments: Dict[int, List[str]] = {}
            if runs:
                pairs = await session.execute(
                    select(WorkflowStep.run_id, WorkflowStep.instrument)
                    .where(WorkflowStep.run_id.in_([r.id for r in runs]))
                    .distinct()
                )
                for run_id, instrument in pairs:
                    if instrument and instrument not in ("Flow_Control", "Flow Control"):
                        instruments.setdefault(run_id, []).append(instrument)

        summaries = []
        for r in runs:
            params = r.parameters or {}
            variables = params.get("variables") or []
            summaries.append({
                "id": r.id,
                "name": r.name,
                "status": r.status,
                "start_time": r.start_time.isoformat() if r.start_time else None,
                "end_time": r.end_time.isoformat() if r.end_time else None,
                "type": params.get("type"),
                "variable_count": len(variables),
                "row_count": len(params.get("rows") or []) if variables else None,
                "instruments": sorted(instruments.get(r.id, [])),
            })
        return {"runs": summaries, "total": total}

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
                has_error = any(s['status'] == 'error' for s in run_dict['steps'])
                if self.cancelled:
                    run_dict['status'] = 'cancelling'
                elif has_error:
                    run_dict['status'] = 'error'
                elif self.paused and run_dict.get('status') == 'running':
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
            # The device just became busy; tell Cloud now rather than on the next heartbeat.
            from ivoryos_edge.server import notify_status_changed
            notify_status_changed()
            return run_id
            
    def pause(self):
        self.paused = True
        if self.pause_event: self.pause_event.clear()
        
    def resume(self):
        self.paused = False
        if self.pause_event: self.pause_event.set()
        
    def cancel(self):
        self.cancelled = True
        if self.current_step_task and not self.current_step_task.done():
            self.current_step_task.cancel()
        for event in self.pending_input_event.values():
            event.set() # Wake up any step waiting on human input so it observes the cancellation
        self.resume() # Make sure it wakes up to cancel

    def submit_input(self, run_id: int, value: Any):
        """Provide the value a running 'User_Input' step is waiting on."""
        self.pending_input_value[run_id] = value
        event = self.pending_input_event.get(run_id)
        if event:
            event.set()
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
            
        runs = await self.get_live_runs()
        payload = {
            "runs": runs,
            "status": {
                "status": "running", 
                "active_workflow_id": self.active_run_id,
                "queue_paused": self.paused,
                "cloud_queue": self.cloud_queue,
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
                if recent and recent.end_time:
                    # Only send recent run if it finished in the last 10 seconds
                    # This ensures the status bar auto-dismisses gracefully instead of lingering
                    if (datetime.utcnow() - recent.end_time).total_seconds() < 10:
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
            await self.report_cloud_progress(run_id)
        await self.broadcast_global_queue()

    async def publish_cloud_result(self, run_id: int) -> None:
        """Send a finished Cloud-dispatched run's record to Cloud (see build_cloud_result).

        Before the final status, on the same connection at QoS 1, so Cloud already holds the data
        when it learns the task is done.
        """
        try:
            run = await self.get_run_status(run_id)
            params = (run or {}).get("parameters") or {}
            if not params.get("cloud_run_id"):
                return
            from ivoryos_edge.server import publish_task_result
            publish_task_result(params["cloud_run_id"], params.get("cloud_node_id"), build_cloud_result(run))
        except Exception as e:
            print(f"[Run {run_id}] Could not send results to Cloud: {e}")

    async def report_cloud_progress(self, run_id: int) -> None:
        """Tell Cloud how far a Cloud-dispatched run has got (see run_progress_summary).

        Throttled to one message per PROGRESS_MIN_INTERVAL_S per run, with a trailing send so the
        last change before a long step is never the one that gets dropped. Bench runs are looked up
        once and then skipped. Sent at QoS 0: each message supersedes the last, so a lost one costs
        nothing a later one does not fix, and the final completed/error status still goes at QoS 1
        from report_run_finished. A late progress message after that is refused by Cloud's
        terminal-status guard, the same as a late "running".
        """
        if self._cloud_run_ids.get(run_id) is False:
            return
        try:
            run = await self.get_run_status(run_id)
        except Exception:
            return
        if not run:
            return
        params = run.get("parameters") or {}
        if not params.get("cloud_run_id"):
            self._cloud_run_ids[run_id] = False
            return
        self._cloud_run_ids[run_id] = True
        state = self._progress_state.setdefault(run_id, {"sent_at": 0.0, "sent": None, "timer": None})
        if run.get("status") in ("completed", "cancelled") or (run.get("status") == "error" and run.get("end_time")):
            # Finished: report_run_finished sends the final status. Nothing more to say.
            if state["timer"]:
                state["timer"].cancel()
            self._progress_state.pop(run_id, None)
            return

        summary = run_progress_summary(run)
        if summary == state["sent"]:
            return
        loop = asyncio.get_running_loop()
        wait = state["sent_at"] + PROGRESS_MIN_INTERVAL_S - loop.time()
        if wait > 0:
            if not state["timer"]:
                def flush():
                    state["timer"] = None
                    asyncio.ensure_future(self.report_cloud_progress(run_id))
                state["timer"] = loop.call_later(wait, flush)
            return

        from ivoryos_edge.server import publish_task_status
        publish_task_status(params["cloud_run_id"], params.get("cloud_node_id"), "running", progress=summary)
        state["sent_at"] = loop.time()
        state["sent"] = summary

    async def _execution_loop(self):
        while True:
            try:
                await self.pause_event.wait()
                
                async with async_session() as session:
                    # Pick the next pending run. Submission order (id) is the default, but a run
                    # the operator moved up/down carries an explicit queue_position that wins —
                    # sorted here in Python so reordering needs no schema change.
                    result = await session.execute(
                        select(WorkflowRun).where(WorkflowRun.status == "pending").order_by(WorkflowRun.id)
                    )
                    pending = list(result.scalars())
                    pending.sort(key=lambda r: (queue_position_of(r), r.id))
                    run = pending[0] if pending else None
                    if not run:
                        self.active_run_id = None
                        break # Queue is empty
                        
                    run_id = run.id
                    self.active_run_id = run_id
                    self.cancelled = False
                    
                    if run.parameters and run.parameters.get("type") == "Optimization":
                        if run.parameters.get("cloud_run_id"):
                            from ivoryos_edge.server import publish_task_status
                            publish_task_status(
                                run.parameters["cloud_run_id"], run.parameters.get("cloud_node_id"), "running",
                            )
                        await self._execute_optimization_run(run_id, session, run.parameters)
                        continue
                        
                    steps_query = await session.execute(
                        select(WorkflowStep).where(WorkflowStep.run_id == run_id).order_by(WorkflowStep.sequence_index)
                    )
                    steps = [s[0] for s in steps_query]
                    
                    workflow_context = {}
                    # Per spreadsheet row, see scoped_context.
                    row_contexts: Dict[int, Dict[str, Any]] = {}
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
                        
                        # Only emit 'running' status once per run when the first step starts
                        if run.status != "running":
                            run.status = "running"
                            await session.commit()
                            await self.broadcast_updates(run_id)
                            if run.parameters and run.parameters.get("cloud_run_id"):
                                # Imported lazily: server.py imports this module at load time, so a
                                # module-level import here would be circular.
                                from ivoryos_edge.server import publish_task_status
                                publish_task_status(
                                    run.parameters["cloud_run_id"],
                                    run.parameters.get("cloud_node_id"),
                                    "running",
                                )
                        else:
                            await session.commit()
                            await self.broadcast_updates(run_id)
                        
                        try:
                            if step.instrument in ("Flow_Control", "Flow Control"):
                                method = step.method
                                args = step.parameters or {}
                                
                                if method == "Sleep":
                                    duration = float(args.get("duration_seconds", 0))
                                    await asyncio.sleep(duration)
                                    step.status = "completed"
                                    step.end_time = datetime.utcnow()
                                    await session.commit()
                                    await self.broadcast_updates(run_id)
                                    index += 1
                                    continue

                                elif method == "Comment":
                                    message = interpolate_message(str(args.get("message", "")), scoped_context(workflow_context, row_contexts, step))
                                    print(f"[Run {run_id}] {message}")
                                    step.status = "completed"
                                    step.outputs = {"message": message}
                                    step.end_time = datetime.utcnow()
                                    await session.commit()
                                    await self.broadcast_updates(run_id)
                                    index += 1
                                    continue

                                elif method == "User_Input":
                                    var_name = (args.get("variable_name") or "").strip()
                                    if not var_name:
                                        raise Exception("User Input step is missing a variable name")
                                    prompt = interpolate_message(str(args.get("prompt", "Input required")), scoped_context(workflow_context, row_contexts, step))
                                    input_type = str(args.get("input_type") or "str").strip().lower()
                                    if input_type not in ("str", "int", "float", "bool"):
                                        input_type = "str"

                                    step.status = "waiting_input"
                                    # The type travels with the prompt so the UI can render the right
                                    # control (number spinner / checkbox) instead of a bare text box.
                                    step.outputs = {"prompt": prompt, "input_type": input_type}
                                    run.status = "waiting_input"
                                    event = asyncio.Event()
                                    self.pending_input_event[run_id] = event
                                    await session.commit()
                                    await self.broadcast_updates(run_id)

                                    await event.wait()
                                    self.pending_input_event.pop(run_id, None)
                                    value = self.pending_input_value.pop(run_id, None)

                                    if self.cancelled:
                                        step.status = "error"
                                        step.error = "Cancelled while waiting for input"
                                        step.end_time = datetime.utcnow()
                                        await session.commit()
                                        break

                                    value = coerce_input_value(value, input_type)

                                    bind_values(workflow_context, row_contexts, step, {var_name: value})
                                    step.status = "completed"
                                    step.outputs = {"result": value, "input_type": input_type}
                                    step.end_time = datetime.utcnow()
                                    run.status = "running"
                                    await session.commit()
                                    await self.broadcast_updates(run_id)
                                    index += 1
                                    continue

                                elif method == "If":
                                    condition = args.get("condition", "False")
                                    try:
                                        # Safe evaluation using only workflow variables
                                        scope = scoped_context(workflow_context, row_contexts, step)
                                        result = eval(condition, {"__builtins__": {}}, scope)
                                    except Exception as e:
                                        raise Exception(f"Failed to evaluate If condition: {e}")
                                    step.outputs = condition_record(condition, result, scope)

                                    if result:
                                        # True: just proceed into the block normally
                                        step.status = "completed"
                                        step.end_time = datetime.utcnow()
                                        await session.commit()
                                        index += 1
                                    else:
                                        # False: skip to matching Else or End_If
                                        depth = 0
                                        found = False
                                        for i in range(index + 1, len(steps)):
                                            s = steps[i]
                                            s.status = "skipped"
                                            if s.instrument in ("Flow_Control", "Flow Control"):
                                                if s.method == "If":
                                                    depth += 1
                                                elif s.method == "End_If":
                                                    if depth == 0:
                                                        s.status = "pending"
                                                        index = i
                                                        found = True
                                                        break
                                                    else:
                                                        depth -= 1
                                                elif s.method == "Else" and depth == 0:
                                                    s.status = "pending"
                                                    index = i
                                                    found = True
                                                    break
                                                    
                                        if not found:
                                            raise Exception("Matching Else or End_If not found for If statement")
                                            
                                        # Mark the If statement itself as completed
                                        step.status = "completed"
                                        step.end_time = datetime.utcnow()
                                        await session.commit()
                                        
                                elif method == "Else":
                                    # If we hit an Else normally, it means the preceding If was True.
                                    # So we skip to the End_If.
                                    depth = 0
                                    found = False
                                    for i in range(index + 1, len(steps)):
                                        s = steps[i]
                                        s.status = "skipped"
                                        if s.instrument in ("Flow_Control", "Flow Control"):
                                            if s.method == "If":
                                                depth += 1
                                            elif s.method == "End_If":
                                                if depth == 0:
                                                    s.status = "pending"
                                                    index = i
                                                    found = True
                                                    break
                                                else:
                                                    depth -= 1
                                                    
                                    if not found:
                                        raise Exception("Matching End_If not found for Else statement")
                                        
                                    step.status = "completed"
                                    step.end_time = datetime.utcnow()
                                    await session.commit()
                                    
                                elif method == "End_If":
                                    # Nothing to do, just pass
                                    step.status = "completed"
                                    step.end_time = datetime.utcnow()
                                    await session.commit()
                                    index += 1
                                    
                                elif method == "While":
                                    condition = args.get("condition", "False")
                                    try:
                                        scope = scoped_context(workflow_context, row_contexts, step)
                                        result = eval(condition, {"__builtins__": {}}, scope)
                                    except Exception as e:
                                        raise Exception(f"Failed to evaluate While condition: {e}")
                                    # Accumulates across iterations: End_While resets this step's
                                    # status for the next pass but leaves its outputs alone.
                                    step.outputs = condition_record(condition, result, scope, step.outputs)

                                    if result:
                                        # Enter loop
                                        step.status = "completed"
                                        step.end_time = datetime.utcnow()
                                        await session.commit()
                                        index += 1
                                    else:
                                        # Skip loop
                                        depth = 0
                                        found = False
                                        for i in range(index + 1, len(steps)):
                                            s = steps[i]
                                            s.status = "skipped"
                                            if s.instrument in ("Flow_Control", "Flow Control"):
                                                if s.method == "While":
                                                    depth += 1
                                                elif s.method == "End_While":
                                                    if depth == 0:
                                                        index = i + 1 # jump past the end
                                                        found = True
                                                        break
                                                    else:
                                                        depth -= 1
                                        if not found:
                                            raise Exception("Matching End_While not found for While statement")
                                            
                                        step.status = "completed"
                                        step.end_time = datetime.utcnow()
                                        await session.commit()
                                        
                                elif method == "End_While":
                                    # Loop iteration completed, jump back to While
                                    depth = 0
                                    found = False
                                    while_idx = -1
                                    for i in range(index - 1, -1, -1):
                                        s = steps[i]
                                        if s.instrument in ("Flow_Control", "Flow Control"):
                                            if s.method == "End_While":
                                                depth += 1
                                            elif s.method == "While":
                                                if depth == 0:
                                                    while_idx = i
                                                    found = True
                                                    break
                                                else:
                                                    depth -= 1
                                                    
                                    if not found:
                                        raise Exception("Matching While not found for End_While statement")
                                        
                                    # Mark End_While complete for this iteration (optional but good)
                                    step.status = "completed"
                                    step.end_time = datetime.utcnow()
                                    
                                    # Reset statuses for the next iteration (including the While loop itself and End_While!)
                                    for i in range(while_idx, index + 1):
                                        steps[i].status = "pending"
                                        
                                    await session.commit()
                                    index = while_idx
                                    
                                await self.broadcast_updates(run_id)
                                continue

                            instruments = getattr(self.app.state, "instruments", {})
                            if step.instrument not in instruments:
                                raise Exception(f"Instrument {step.instrument} not found")
                                
                            instance = instruments[step.instrument]
                            from ivoryos_edge.introspection import cast_arguments, has_member, resolve_callable
                            if not has_member(instance, step.method):
                                raise Exception(f"Method {step.method} not found on {step.instrument}")

                            # resolve_callable, not getattr: a property getter/setter is a real
                            # step in the designer but isn't a callable attribute on its own.
                            method = resolve_callable(instance, step.method)
                            args = substitute_workflow_vars(step.parameters or {}, scoped_context(workflow_context, row_contexts, step))

                            args = cast_arguments(method, args)
                            
                            if inspect.iscoroutinefunction(method):
                                self.current_step_task = asyncio.create_task(method(**args))
                            else:
                                loop = asyncio.get_running_loop()
                                self.current_step_task = loop.run_in_executor(None, lambda: method(**args))
                                
                            result = await self.current_step_task
                            self.current_step_task = None
                                
                            serialized_res = serialize_result(result)
                            step.status = "completed"
                            step.outputs = {"result": serialized_res}
                            
                            if step.parameters and (step.parameters.get("_return_bindings") or step.parameters.get("_return_var")):
                                bind_values(workflow_context, row_contexts, step, extract_return_values(
                                    step.parameters.get("_return_bindings"),
                                    step.parameters.get("_return_var"),
                                    serialized_res,
                                    result,
                                ))
                                
                            step.end_time = datetime.utcnow()
                            await session.commit()
                            await self.broadcast_updates(run_id)
                            index += 1
                            
                        except asyncio.CancelledError:
                            self.current_step_task = None
                            step.status = "error"
                            step.error = "Step execution cancelled"
                            step.end_time = datetime.utcnow()
                            await session.commit()
                            if self.cancelled:
                                break
                            else:
                                raise
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
                    await self.publish_cloud_result(run.id)
                    report_run_finished(run)
                    
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
        import os
        from ivoryos_edge.optimizer.registry import OPTIMIZER_REGISTRY
        import inspect

        opt_name = parameters.get("optimizer", "ax")
        budget = parameters.get("budget", 5)
        param_space = parameters.get("parameter_space", [])
        obj_config = parameters.get("objective_config", [])
        opt_config = parameters.get("optimizer_config", {})
        parameter_constraints = parameters.get("parameter_constraints")
        additional_params = parameters.get("additional_params")
        error_recovery = parameters.get("error_recovery", "stop")
        seq_template = parameters.get("sequence_template", [])
        early_stop = parameters.get("early_stop")
        # A var excluded from the search space can still differ per iteration (spreadsheet-style,
        # set on the Optimize page) instead of being one constant for the whole run — each is a
        # list of budget length, one literal value per iteration index.
        iteration_values = parameters.get("iteration_values", {})
        # How many trials the optimizer suggests, runs, and reports back at once per round —
        # default 1 (ask/run/tell one at a time, the original behavior). >1 means the optimizer
        # picks that many points together each round, useful when several identical setups can
        # run in parallel; every optimizer already supports suggest(n)/observe(list) in that shape.
        batch_size = max(1, parameters.get("batch_size", 1))
        # Prior data (e.g. from an earlier compatible run, or uploaded) to seed the optimizer with
        # before the first suggestion — a list of {param_or_objective_name: value} dicts. Every
        # optimizer backend already implements append_existing_data(); this was just never wired
        # up to a real run before.
        existing_data = parameters.get("existing_data")

        OptClass = OPTIMIZER_REGISTRY.get(opt_name)
        if not OptClass:
            raise Exception(f"Optimizer {opt_name} not found")

        optimizer_data_dir = os.path.join(os.path.dirname(__file__), "optimizer_data")
        os.makedirs(optimizer_data_dir, exist_ok=True)

        optimizer = OptClass(
            experiment_name=f"OptRun_{run_id}",
            parameter_space=param_space,
            objective_config=obj_config,
            optimizer_config=opt_config,
            parameter_constraints=parameter_constraints,
            datapath=optimizer_data_dir,
            additional_params=additional_params
        )
        self.active_optimizer = optimizer
        self.active_optimizer_run_id = run_id


        run = await session.get(WorkflowRun, run_id)
        run.status = "running"
        await session.commit()
        await self.broadcast_updates(run_id)

        if existing_data:
            try:
                import pandas as pd
                loop = asyncio.get_running_loop()
                df = pd.DataFrame(existing_data)
                await loop.run_in_executor(None, lambda: optimizer.append_existing_data(df))
            except Exception as e:
                run.status = "error"
                await session.commit()
                await self.broadcast_updates(run_id)
                print(f"Failed to append existing data: {e}\n{traceback.format_exc()}")
                return
        
        step_index = 0
        
        async def execute_template_block(template, suggestion_args=None):
            nonlocal step_index, run
            iteration_steps = []
            for tmpl_step in template:
                args = {}
                for k, v in tmpl_step.get("params", {}).items():
                    if isinstance(v, str) and v.startswith("#") and suggestion_args:
                        var_name = v[1:]
                        args[k] = suggestion_args.get(var_name, v)
                    else:
                        args[k] = v
                        
                db_step = WorkflowStep(
                    run_id=run_id,
                    sequence_index=step_index,
                    instrument=tmpl_step.get("instrument", tmpl_step.get("module")),
                    method=tmpl_step.get("method", tmpl_step.get("action")),
                    parameters=args,
                    status="pending"
                )
                session.add(db_step)
                iteration_steps.append((db_step, tmpl_step.get("returnVar", tmpl_step.get("return"))))
                step_index += 1
                
            await session.commit()
            await self.broadcast_updates(run_id)
            
            for db_step, return_var in iteration_steps:
                if self.cancelled:
                    return False, {}
                await self.pause_event.wait()
                
                db_step.status = "running"
                db_step.start_time = datetime.utcnow()
                await session.commit()
                await self.broadcast_updates(run_id)
                
                try:
                    from ivoryos_edge.server import app, run_and_track_task
                    instruments = getattr(app.state, "instruments", {})
                    instance = instruments.get(db_step.instrument)
                    from ivoryos_edge.introspection import cast_arguments, resolve_callable
                    method = resolve_callable(instance, db_step.method)

                    task_id = str(uuid.uuid4())
                    casted_args = cast_arguments(method, db_step.parameters or {})
                    self.current_step_task = asyncio.create_task(
                        run_and_track_task(task_id, method, casted_args)
                    )
                    result = await self.current_step_task
                    
                    db_step.status = "completed"
                    db_step.end_time = datetime.utcnow()
                    
                    # Very simple return var handling for optimization loop objective feedback
                    if return_var:
                        return True, {return_var: result}
                        
                    await session.commit()
                    await self.broadcast_updates(run_id)
                except Exception as e:
                    db_step.status = "error"
                    db_step.error = str(e) + "\n" + traceback.format_exc()
                    db_step.end_time = datetime.utcnow()
                    run.status = "error"
                    await session.commit()
                    await self.broadcast_updates(run_id)
                    return False, {}
            return True, {}

        # 1. Execute Prep Phase
        prep_template = parameters.get("prep_template", [])
        if prep_template:
            success, _ = await execute_template_block(prep_template)
            if not success:
                run.status = "error"
                await session.commit()
                await self.broadcast_updates(run_id)
                return

        # Trials are grouped into rounds of up to `batch_size`: the optimizer suggests a whole
        # round at once, every trial in the round runs, and only then does the whole round get
        # reported back via one observe() call — not one ask/run/tell per trial. batch_size=1
        # (the default) makes this behave exactly like the original one-at-a-time loop.
        completed = 0
        while completed < budget:
            if self.cancelled:
                break
            await self.pause_event.wait()

            n_this_round = min(batch_size, budget - completed)

            # 1. Ask optimizer for this round's suggestions
            try:
                loop = asyncio.get_running_loop()
                suggestions = await loop.run_in_executor(None, lambda: optimizer.suggest(n=n_this_round))
                if not isinstance(suggestions, list):
                    suggestions = [suggestions]
            except Exception as e:
                print(f"Optimizer suggest error: {e}")
                run.status = "error"
                break

            round_results = []

            for offset, suggestion in enumerate(suggestions):
                global_iteration = completed + offset

                # 2. Build steps from template for this one trial
                iteration_steps = []
                for tmpl_step in seq_template:
                    args = {}
                    # Which arguments came from a #name, so Data History can mark them after the
                    # values are substituted. `_`-prefixed, so cast_arguments never forwards it.
                    dynamic = {}
                    for k, v in tmpl_step.get("params", {}).items():
                        if isinstance(v, str) and v.startswith("#"):
                            var_name = v[1:]
                            if not k.startswith("_"):
                                dynamic[k] = var_name
                            if var_name in iteration_values:
                                values_for_var = iteration_values[var_name]
                                args[k] = values_for_var[global_iteration] if global_iteration < len(values_for_var) else v
                            else:
                                args[k] = suggestion.get(var_name, v)
                        else:
                            args[k] = v
                    if dynamic:
                        args["_vars"] = dynamic

                    db_step = WorkflowStep(
                        run_id=run_id,
                        sequence_index=step_index,
                        instrument=tmpl_step["instrument"],
                        method=tmpl_step["method"],
                        parameters=args,
                        status="pending"
                    )
                    session.add(db_step)
                    iteration_steps.append((db_step, tmpl_step.get("returnVar"), tmpl_step.get("returnBindings")))
                    step_index += 1

                await session.commit()
                await self.broadcast_updates(run_id)

                # 3. Execute steps for this trial
                trial_failed = False
                objective_values = {}

                for db_step, return_var, return_bindings in iteration_steps:
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
                        from ivoryos_edge.introspection import cast_arguments, resolve_callable
                        method = resolve_callable(instance, db_step.method)

                        casted_args = cast_arguments(method, db_step.parameters or {})

                        if inspect.iscoroutinefunction(method):
                            self.current_step_task = asyncio.create_task(method(**casted_args))
                        else:
                            loop = asyncio.get_running_loop()
                            self.current_step_task = loop.run_in_executor(None, lambda: method(**casted_args))

                        result = await self.current_step_task
                        self.current_step_task = None

                        serialized_res = serialize_result(result)
                        db_step.status = "completed"
                        db_step.outputs = {"result": serialized_res}

                        if return_bindings or return_var:
                            # An objective has to be a number; anything a pointer resolves to
                            # that isn't (a status string, a nested list) is simply not an
                            # objective and is dropped rather than crashing the trial.
                            for var_name, value in extract_return_values(
                                    return_bindings, return_var, serialized_res, result).items():
                                try:
                                    objective_values[var_name] = float(value)
                                except (TypeError, ValueError):
                                    pass
                    except asyncio.CancelledError:
                        self.current_step_task = None
                        db_step.status = "error"
                        db_step.error = "Step execution cancelled"
                        trial_failed = True
                    except Exception as e:
                        self.current_step_task = None
                        db_step.status = "error"
                        # traceback is imported at module level — a local re-import here (even
                        # this deep in a nested except) would make Python treat the name as local
                        # to the whole enclosing function, breaking the earlier, legitimate
                        # module-level traceback.format_exc() call in the existing-data handler
                        # above (UnboundLocalError, since it runs before this line ever would).
                        db_step.error = str(e) + "\n" + traceback.format_exc()
                        trial_failed = True

                    db_step.end_time = datetime.utcnow()
                    await session.commit()
                    await self.broadcast_updates(run_id)

                    if trial_failed:
                        break

                if self.cancelled:
                    break

                # 4. Handle this trial's result
                if trial_failed:
                    if error_recovery == "stop":
                        run.status = "error"
                        break
                    # "skip" and "retry" both just drop this trial from the round without
                    # observing it — "retry" doesn't actually retry yet, same simplification as
                    # the original single-trial loop had.
                else:
                    round_results.append(objective_values)

            if self.cancelled or run.status == "error":
                break

            # 5. Tell the optimizer about however many trials in this round actually succeeded,
            # then check early-stop against each of them.
            if round_results:
                try:
                    loop = asyncio.get_running_loop()
                    await loop.run_in_executor(None, lambda: optimizer.observe(round_results))
                except Exception as e:
                    print(f"Optimizer observe error: {e}")

                # Early stop: each objective can carry its own target threshold (direction is
                # derived from that objective's own minimize/maximize goal). With multiple
                # criteria defined, "mode" decides whether ANY one of them or ALL of them must
                # be met by a given trial to end the budget loop early. Ending early still
                # finishes the run as "completed", not "error".
                stop_early = False
                for trial_num, objective_values in enumerate(round_results):
                    if early_stop and early_stop.get("criteria"):
                        mode = early_stop.get("mode", "any")
                        reached_flags = []
                        for criterion in early_stop["criteria"]:
                            metric = criterion.get("metric")
                            threshold = criterion.get("threshold")
                            if metric not in objective_values or threshold is None:
                                continue
                            value = objective_values[metric]
                            minimize = next((o.get("minimize") for o in obj_config if o.get("name") == metric), False)
                            reached_flags.append((value <= threshold) if minimize else (value >= threshold))
                        if reached_flags:
                            stop = all(reached_flags) if mode == "all" else any(reached_flags)
                            if stop:
                                print(f"Early stop ({mode}): criteria met after {completed + trial_num + 1} trial(s)")
                                stop_early = True
                                break
                if stop_early:
                    break

            completed += n_this_round

        # 2. Execute Cleanup Phase — runs once after the budget loop, mirroring Prep. This was
        # previously never executed at all for Optimization runs even though the Optimize page
        # already lets you configure one. Skipped on cancellation: execute_template_block bails
        # out immediately once self.cancelled is set, so cleanup can't run through a cancel yet —
        # that would need its own bypass, left for later if it turns out to matter.
        cleanup_template = parameters.get("cleanup_template", [])
        if cleanup_template and not self.cancelled:
            success, _ = await execute_template_block(cleanup_template)
            if not success:
                run.status = "error"

        # Finish run
        run = await session.get(WorkflowRun, run_id)
        if self.cancelled:
            run.status = "cancelled"
        elif run.status != "error":
            run.status = "completed"
        run.end_time = datetime.utcnow()
        await session.commit()
        await self.publish_cloud_result(run.id)
        report_run_finished(run)
        
        if not self.cancelled:
            await self.pause_event.wait()
            
        self.active_run_id = None
        await self.broadcast_updates(run_id)
