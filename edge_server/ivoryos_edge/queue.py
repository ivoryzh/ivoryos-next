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
from ivoryos_edge.safety import SafetyViolation, guard as safety_guard

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


FLOW_CONTROL_INSTRUMENTS = ("Flow Control", "Flow_Control")


def step_saved_names(step: dict) -> set:
    """The names a run step binds when it finishes: what the queue below puts in the context.

    Its outputs (`_return_var`, `_return_bindings`, and a linked workflow's renames in
    `_return_aliases`), or a User_Input step's `variable_name`.
    """
    params = step.get("params") or step.get("parameters") or {}
    names = {n.strip() for n in str(params.get("_return_var") or "").split(",") if n.strip()}
    names.update(str(b.get("var")).strip() for b in params.get("_return_bindings") or [] if isinstance(b, dict) and b.get("var"))
    names.update(str(p[1]) for p in params.get("_return_aliases") or [] if isinstance(p, (list, tuple)) and len(p) == 2 and p[1])
    if step.get("instrument") in FLOW_CONTROL_INSTRUMENTS and step.get("method") == "User_Input":
        if str(params.get("variable_name") or "").strip():
            names.add(str(params["variable_name"]).strip())
    return names


def attention_items(run: Optional[Dict[str, Any]], awaiting_decision: Optional[int]) -> List[Dict[str, Any]]:
    """What in the active run needs a person now, for notifications (the desktop app, a browser):
    a User input waiting for an answer, or a failed step waiting for retry, skip or stop.

    Each item has a `key` that names that moment, so a listener announces it once: the input step,
    or the failed step and how many times it has failed (a retry that fails again is a new moment).
    Decided here so every listener announces the same things.
    """
    if not run:
        return []
    steps = run.get("steps") or []
    name = run.get("name") or f"Run {run.get('id')}"
    items = []
    if run.get("status") == "waiting_input":
        step = next((s for s in steps if s.get("status") == "waiting_input"), None)
        if step:
            outputs = step.get("outputs") or {}
            paused = outputs.get("input_type") == "none"  # a User input with nothing to save: a pause
            items.append({
                "key": f"input:{run['id']}:{step.get('id')}", "kind": "input", "run_id": run["id"], "run_name": name,
                "title": "Paused for you" if paused else "Input needed",
                "body": str(outputs.get("prompt") or ("The run waits for you to continue." if paused else "A step is waiting for your answer.")),
            })
    if awaiting_decision == run.get("id"):
        step = next((s for s in steps if s.get("status") == "error"), None)
        if step:
            failures = len((step.get("outputs") or {}).get("attempts") or []) or 1
            first_line = str(step.get("error") or "").split("\n", 1)[0]
            items.append({
                "key": f"error:{run['id']}:{step.get('id')}:{failures}", "kind": "error", "run_id": run["id"], "run_name": name,
                "title": "A step failed",
                "body": f"{step.get('instrument')}.{step.get('method')}: {first_line}".strip(": "),
            })
    return items


def step_phase(step) -> str:
    """prep, main or cleanup: expand_workflow_blocks stamps every step of a run with `_phase`."""
    params = (step.get("params") if isinstance(step, dict) else getattr(step, "parameters", None)) or {}
    return params.get("_phase") or "main"


class NoImprovement:
    """The "no improvement in N iterations" stopping rule for an optimization run.

    An iteration improves when any objective beats its best so far (lower when minimized, higher
    when maximized), existing data included. Iterations of the random start (`random_start`) never
    count against it, and an improvement starts the count again. `add` says when to stop.
    """

    def __init__(self, objectives, patience: int, random_start: int = 0, existing=None):
        self.objectives = [(o.get("name"), bool(o.get("minimize"))) for o in objectives or []]
        self.patience = max(0, int(patience or 0))
        self.random_start = max(0, int(random_start or 0))
        self.best = {}
        self.since = 0
        for row in existing or []:
            self._improves(row)

    def _improves(self, values) -> bool:
        improved = False
        for name, minimize in self.objectives:
            try:
                value = float(values.get(name))
            except (TypeError, ValueError):
                continue
            best = self.best.get(name)
            if best is None or (value < best if minimize else value > best):
                self.best[name] = value
                improved = True
        return improved

    def add(self, trial_number: int, values) -> bool:
        """Record trial `trial_number` (1-based); True when the run should stop after it."""
        if self._improves(values or {}):
            self.since = 0
        elif trial_number > self.random_start:
            self.since += 1
        return bool(self.patience) and self.since >= self.patience


def graceful_stop_here(steps: list, index: int, batch_size: int = 1) -> bool:
    """Whether a graceful stop ends the main block before `steps[index]`.

    True for a main step that begins an iteration not yet started: a spreadsheet row, or its
    batch when rows run in batches (`_row // batch_size`; within a batch the walk interleaves its
    rows, so the batch is the iteration). A run without rows (a plain run) has no iterations, so
    it stops after the step it was on. Prep is always finished first.
    """
    step = steps[index]
    if step_phase(step) != "main":
        return False
    row = (step.parameters or {}).get("_row")
    if row is None:
        return True
    size = max(1, int(batch_size or 1))
    started = {
        int(s.parameters["_row"]) // size
        for s in steps[:index]
        if step_phase(s) == "main" and s.status != "pending" and (s.parameters or {}).get("_row") is not None
    }
    return int(row) // size not in started


def skip_after_graceful_stop(steps: list, index: int, cleanup: bool) -> int:
    """Mark what a graceful stop leaves out: every pending main step from `index` on, and the
    cleanup too unless it is wanted. Returns how many main steps it left out."""
    left_out = 0
    for s in steps[index:]:
        if s.status != "pending":
            continue
        phase = step_phase(s)
        if phase == "main" or (phase == "cleanup" and not cleanup):
            s.status = "skipped"
            left_out += phase == "main"
    return left_out


def unproduced_references(steps: list) -> list:
    """Every '#name' an instrument step will ask substitute_workflow_vars for that no step
    before it saves, as a sentence each.

    Such a run cannot succeed: the step raises when it is reached. It used to be found out
    there, after every step before it had already run (two pumps dispensed, then "'#test' is
    not available yet"), so start_run refuses it before anything moves. Only what the queue
    substitutes is checked: an instrument step's whole-value '#name' arguments. Free text
    (a Comment, a User_Input prompt) is interpolated and leaves an unknown name as it is, and a
    condition is an expression of its own.
    """
    produced: set = set()
    problems = []

    def reads(value, out):
        if isinstance(value, str):
            name = value[1:].strip() if value.startswith("#") else ""
            if name:
                out.append(name)
        elif isinstance(value, dict):
            for key, item in value.items():
                if not str(key).startswith("_"):
                    reads(item, out)
        elif isinstance(value, list):
            for item in value:
                reads(item, out)

    for number, step in enumerate(steps, start=1):
        if step.get("instrument") not in FLOW_CONTROL_INSTRUMENTS:
            names: list = []
            reads(step.get("params") or step.get("parameters") or {}, names)
            for name in dict.fromkeys(names):
                if name not in produced:
                    problems.append(
                        f"Step {number} ({step.get('instrument')}.{step.get('method')}) reads #{name}, "
                        f"but no step before it saves '{name}'."
                    )
        produced |= step_saved_names(step)
    return problems


def with_aliases(values: Dict[str, Any], aliases) -> Dict[str, Any]:
    """Also bind each value under the names a linked workflow step renamed it to.

    `aliases` is a step's `_return_aliases` (expand_workflow_blocks): ``[[inner, outer], ...]``,
    applied in order so a rename made by a nested link and then again by its caller resolves.
    """
    if not aliases:
        return values
    out = dict(values)
    for pair in aliases:
        if isinstance(pair, (list, tuple)) and len(pair) == 2 and pair[0] in out and pair[1]:
            out[pair[1]] = out[pair[0]]
    return out


def _result_key(result: dict, given: Any) -> Any:
    """The key a row's own value has in a result: the argument as given (`assay_plate[A1]`), or
    the well alone (`A1`), which is how most readers key a plate."""
    if given in result:
        return given
    text = str(given)
    if text in result:
        return text
    match = re.fullmatch(r"\s*[A-Za-z_][A-Za-z0-9_]*\s*\[\s*([^\],:;]+?)\s*\]\s*", text)
    return match.group(1) if match else text


def spread_over_rows(parameters: Optional[dict], values: Dict[str, Any]) -> Dict[int, Dict[str, Any]]:
    """Each row's own share of what a batch step returned for a whole group of rows.

    A batch step that was handed one value per row (`_rows`, and `_per_row` naming the arguments
    that carry them; spreadsheetRun.ts) acts on every sample of the group in one call, and what it
    returns covers all of them: a plate read gives `{"A1": 0.31, "B1": 0.52, ...}`. Left as one
    value, every row of the group would show the whole plate and a per-sample `If absorbance > 1`
    could not be written. So a result is handed back out to the rows it covers: a dict keyed by
    the values of one of those arguments (the wells, `assay_plate[A1]` or just `A1`) goes to each
    row by its own key, and a list
    as long as the group goes by position. Anything else stays one value for the group.
    """
    parameters = parameters or {}
    rows = parameters.get("_rows")
    if not isinstance(rows, list) or not rows:
        return {}
    shares: Dict[int, Dict[str, Any]] = {}
    for name, value in values.items():
        per_row = None
        if isinstance(value, dict):
            for argument in parameters.get("_per_row") or []:
                given = parameters.get(argument)
                if not isinstance(given, list) or len(given) != len(rows):
                    continue
                keys = [_result_key(value, g) for g in given]
                if all(k in value for k in keys):
                    per_row = [value[k] for k in keys]
                    break
        elif isinstance(value, (list, tuple)) and len(value) == len(rows):
            per_row = list(value)
        if per_row is None:
            continue
        for row, item in zip(rows, per_row):
            if isinstance(row, int):
                shares.setdefault(row, {})[name] = item
    return shares


def bind_values(context: Dict[str, Any], row_contexts: Dict[int, Dict[str, Any]], step, values: Dict[str, Any],
                shares: Optional[Dict[int, Dict[str, Any]]] = None) -> None:
    """`shares` is `spread_over_rows`: those names go to each row as its own value, and run-wide
    as the whole result for a later batch step to read."""
    context.update(values)
    spread = {name for own in (shares or {}).values() for name in own}
    row = step_row(step)
    if row is not None:
        row_contexts.setdefault(row, {}).update({k: v for k, v in values.items() if k not in spread})
    for covered, own in (shares or {}).items():
        row_contexts.setdefault(covered, {}).update(own)


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
# A prompt or error shown on a Cloud card, not a log: the device keeps the full traceback.
PAUSE_TEXT_MAX = 300


def pause_summary(run: Dict[str, Any], current: Dict[str, Any]) -> Dict[str, Any]:
    """What a run stopped for, when it stopped for a person: a question, or an error to decide on.

    `pause` names this one stop: the step and when it started, so a While loop asking the same
    question again, or a retried step failing again, is a different pause. A decision sent from
    Cloud carries it back and is applied only while it still matches (see apply_cloud_control),
    which is what makes it safe for Cloud to re-send a decision it never saw take effect.

    An error only counts while the run is still waiting on it. Once someone has chosen to stop,
    the run has an end_time and the error is the outcome, not a question.
    """
    state = run.get("status")
    if state == "waiting_input" and current.get("status") == "waiting_input":
        out = current.get("outputs") or {}
        return {
            "prompt": str(out.get("prompt") or "")[:PAUSE_TEXT_MAX],
            "input_type": out.get("input_type") or "str",
            "pause": f"input:{current.get('id')}:{current.get('start_time')}",
        }
    if state == "error" and current.get("status") == "error" and not run.get("end_time"):
        message = str(current.get("error") or "").strip().split("\n", 1)[0]
        return {
            "error": message[:PAUSE_TEXT_MAX] or "The step failed.",
            "pause": f"error:{current.get('id')}:{current.get('start_time')}",
        }
    return {}


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
    # When it started, by this device's clock (naive UTC, like every run time here).
    if run.get("start_time"):
        summary["started"] = run.get("start_time")

    current = next((s for s in steps if s.get("status") in ("running", "waiting_input", "error")), None) \
        or next((s for s in steps if s.get("status") == "pending"), None)
    if current:
        summary["phase"] = phase(current)
        flow = current.get("instrument") in ("Flow_Control", "Flow Control")
        summary["step"] = current.get("method") if flow else f"{current.get('instrument')}.{current.get('method')}"
        row = (current.get("parameters") or {}).get("_row")
        if isinstance(row, int):
            summary["row"] = row + 1
        summary.update(pause_summary(run, current))

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
    # `cloud_occurrence` stays in: it is which run of a repeated step this record is.
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


def record_failed_attempt(outputs: Optional[dict], error: str, start, end) -> dict:
    """A step's outputs with one more failed attempt on its record.

    Kept in `outputs` (no schema change) under `attempts`, and carried across a retry: a step that
    failed twice and then worked is not the same outcome as one that just worked, and without this
    a retry erased the failure entirely -- the run read "completed" as though nothing happened.
    """
    kept = dict(outputs or {})
    kept["attempts"] = list(kept.get("attempts") or []) + [{
        "error": str(error or "").strip().split("\n", 1)[0][:PAUSE_TEXT_MAX],
        "start_time": start.isoformat() if start else None,
        "end_time": end.isoformat() if end else None,
    }]
    return kept


def resolve_last_attempt(outputs: Optional[dict], resolution: str, when=None) -> dict:
    """Note what was decided about the latest failed attempt (retry, skip or stop), and when:
    between the failure and that moment the run was waiting for a person."""
    kept = dict(outputs or {})
    attempts = [dict(a) for a in kept.get("attempts") or []]
    if attempts:
        attempts[-1]["resolution"] = resolution
        if when is not None:
            attempts[-1]["resolved_time"] = when.isoformat()
    kept["attempts"] = attempts
    return kept


def with_attempts(outputs: dict, previous: Optional[dict]) -> dict:
    """New outputs for a step, keeping the failed attempts recorded before it succeeded."""
    attempts = (previous or {}).get("attempts")
    return {**outputs, "attempts": attempts} if attempts else outputs


def run_issues(steps: List[Dict[str, Any]]) -> Dict[str, int]:
    """What went wrong on the way to a run's outcome, even when the outcome is "completed".

    `retried`: failed attempts someone chose to retry; `skipped`: steps that failed and were
    skipped. Empty when nothing did. An If/While branch skip has no error and is not counted.
    Stored on the run when it finishes (parameters._issues) so every view -- the bench's Data
    History, Cloud's Results and canvas -- reads one verdict instead of recomputing it.
    """
    attempts = [a for s in steps for a in ((s.get("outputs") or {}).get("attempts") or [])]
    issues = {
        "retried": sum(1 for a in attempts if a.get("resolution") == "retry"),
        "skipped": sum(1 for s in steps if s.get("status") == "skipped" and s.get("error")),
    }
    return {k: v for k, v in issues.items() if v}


def report_run_finished(run, issues: Optional[Dict[str, int]] = None) -> None:
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
        publish_task_status(params["cloud_run_id"], params.get("cloud_node_id"), run.status, issues=issues or None)
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
        # The run whose failed step is waiting for a person (retry, skip or stop), if any.
        self.awaiting_decision: Optional[int] = None
        # A graceful stop asked for on the active run: {"cleanup": bool, "continue_queue": bool}.
        self.graceful: Optional[Dict[str, bool]] = None
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
                "issues": params.get("_issues") or None,
                # One stage of a design queued as several runs (server.py create_run_group).
                "group": params.get("group") or None,
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

                # The queue is held after a stop or an error (_hold_queue_after) so the runs that
                # were waiting do not start on their own. A run submitted now with nothing else
                # waiting is someone starting it, so it goes; one submitted behind held runs waits
                # with them for Resume queue.
                if self.paused and self.active_run_id is None:
                    waiting = await session.execute(
                        select(WorkflowRun.id).where(WorkflowRun.status == "pending", WorkflowRun.id != run_id).limit(1)
                    )
                    if waiting.first() is None:
                        self.resume()

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
            
    async def replace_pending_run(self, run_id: int, name: Optional[str], sequence: List[Dict[str, Any]], parameters: dict) -> None:
        """Swap a queued run's steps and parameters for edited ones, keeping its name (unless a
        new one is given) and its place in the queue. Refused once it has started: a run only
        changes while it is still waiting."""
        await self.init_asyncio()
        async with self._runner_lock:
            async with async_session() as session:
                run = await session.get(WorkflowRun, run_id)
                if not run:
                    raise LookupError("Run not found")
                if run.status != "pending" or self.active_run_id == run_id:
                    raise ValueError(f"This run is {run.status if run.status != 'pending' else 'starting'} and can no longer be changed.")
                # Its place in the queue, and the set of stages it belongs to: editing one stage's
                # values must not take it out of its set.
                kept = {k: v for k, v in (run.parameters or {}).items() if k in ("queue_position", "group")}
                await session.execute(WorkflowStep.__table__.delete().where(WorkflowStep.run_id == run_id))
                for idx, step in enumerate(sequence):
                    session.add(WorkflowStep(
                        run_id=run_id, sequence_index=idx, instrument=step["instrument"],
                        method=step["method"], parameters=step.get("params", {}),
                    ))
                run.parameters = {**(parameters or {}), **kept}
                if name and name.strip():
                    run.name = name.strip()[:128]
                await session.commit()
        await self.broadcast_global_queue()

    def pause(self):
        self.paused = True
        if self.pause_event: self.pause_event.clear()
        
    def resume(self):
        self.paused = False
        if self.pause_event: self.pause_event.set()
        
    def request_graceful_stop(self, cleanup: bool, continue_queue: bool):
        """Let the active run finish the iteration it is in (a spreadsheet row or batch, an
        optimization trial, or for a plain run the current step), skip the rest, then run its
        cleanup or not, and go on with the queue or hold it. A paused run is resumed so it can
        finish the iteration."""
        self.graceful = {"cleanup": bool(cleanup), "continue_queue": bool(continue_queue)}
        self.resume()

    async def _wait_for_error_decision(self, run_id: int, session, run, step, error: BaseException, trace: str) -> str:
        """A step failed: record why, pause the run and the queue, and wait for a person.

        Returns "retry" (the step is pending again), "skip" (it is skipped and the run goes on)
        or "stop". Nothing is retried or skipped on its own: for a normal run and an optimization
        alike, a failure waits for a decision. Optimizations used to follow an error_recovery
        setting that could skip or "retry" a failed trial unattended, which on real hardware is
        the risky choice.
        """
        step.status = "error"
        # A refusal by the safety guard is its own explanation; a traceback into the queue adds nothing.
        step.error = str(error) if isinstance(error, SafetyViolation) else str(error) + "\n" + trace
        step.end_time = datetime.utcnow()
        step.outputs = record_failed_attempt(step.outputs, str(error), step.start_time, step.end_time)
        run.status = "error"
        await session.commit()
        self.pause()
        self.error_action = None
        self.awaiting_decision = run_id
        await self.broadcast_updates(run_id)
        try:
            while self.error_action is None and not self.cancelled:
                await asyncio.sleep(0.5)
        finally:
            self.awaiting_decision = None
        action = "stop" if self.cancelled else self.error_action
        self.error_action = None
        decided = datetime.utcnow()
        if action == "retry":
            step.status = "pending"
            step.error = None
        elif action == "skip":
            step.status = "skipped"
        else:
            action = "stop"
        if action != "retry":
            # The step's story ends when a person ended it, not when it failed. Left at the
            # failure, the wait for a decision belonged to no step: on the timeline the rows either
            # side of it shrank to slivers around an unexplained gap. The moment it failed is still
            # on its record, in `attempts`. (A retry starts the step afresh, as it always has: when
            # it started is what tells one failure of a step from the next, see pause_summary.
            # Its earlier attempts and the waits between them are in `attempts` too, which is what
            # the timeline draws them from.)
            step.end_time = decided
        step.outputs = resolve_last_attempt(step.outputs, action, decided)
        if action != "stop":
            run.status = "running"
            self.resume()
        await session.commit()
        await self.broadcast_updates(run_id)
        return action

    async def _end_group_after(self, session, run) -> None:
        """One stage of a set failed or was stopped: the stages still waiting are not run.

        A design run in stages (`parameters.group`, server.py create_run_group) is one experiment
        queued as several runs, so that a stage which has not started can still be changed. It is
        still one experiment: solvent is not added to samples whose solids were never weighed.
        Holding the queue is not enough for that, since Resume queue would start the next stage.
        The stages left are marked cancelled, their steps "not run", and say why (`_issues.
        not_started`). A stage that finished normally, or was stopped gracefully and told to let
        the queue go on, leaves the rest alone.
        """
        group = (run.parameters or {}).get("group") or {}
        if not group.get("id") or run.status not in ("error", "cancelled"):
            return
        pending = await session.execute(select(WorkflowRun).where(WorkflowRun.status == "pending"))
        rest = [r for r in pending.scalars() if ((r.parameters or {}).get("group") or {}).get("id") == group["id"]]
        if not rest:
            return
        for other in rest:
            other.status = "cancelled"
            other.end_time = datetime.utcnow()
            other.parameters = {**(other.parameters or {}), "_issues": {"not_started": 1}}
        await session.execute(
            update(WorkflowStep)
            .where(WorkflowStep.run_id.in_([r.id for r in rest]), WorkflowStep.status == "pending")
            .values(status="skipped")
        )
        await session.commit()

    def _hold_queue_after(self, run) -> None:
        """After a run, hold the queue (nothing else starts until Resume queue) when it ended
        by Stop, on an error, or by a graceful stop told not to go on. Stop used to let the next
        queued run start at once, which is the opposite of what pressing Stop means."""
        graceful = self.graceful
        self.graceful = None
        if self.cancelled or run.status == "error" or (graceful and not graceful.get("continue_queue", True)):
            self.pause()

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

    async def apply_cloud_control(self, cloud_run_id: str, cloud_node_id: str, pause: str,
                                  action: str, value: Any = None) -> str:
        """Carry out a decision made in Cloud about a run stopped for a person.

        The same three answers the bench has -- an input value, or retry/skip/stop on an error --
        applied only while `pause` still names the stop the decision was made about. Cloud re-sends
        a decision it has not seen take effect, and the bench may have answered first; without this
        check a late "retry" would land on whatever error happens next. A stale decision is dropped
        and the current state re-sent, so Cloud stops showing a question that has gone.

        Stop differs from the bench's abort in one way: it resumes the queue. The bench leaves the
        queue paused after an abort for the operator standing there; a remote stop would leave the
        device holding every later Cloud task behind a pause nobody at the bench knows about.
        """
        run_id = self.active_run_id
        run = await self.get_run_status(run_id) if run_id is not None else None
        params = (run or {}).get("parameters") or {}
        if not run or params.get("cloud_run_id") != cloud_run_id or params.get("cloud_node_id") != cloud_node_id:
            return "not running here"
        if not pause or run_progress_summary(run).get("pause") != pause:
            await self.report_cloud_progress(run_id, force=True)
            return "stale"
        if action == "input" and pause.startswith("input:"):
            self.submit_input(run_id, value)
        elif action in ("retry", "skip") and pause.startswith("error:"):
            self.error_action = action
        elif action == "stop" and pause.startswith("error:"):
            self.error_action = "abort"
            self.resume()
        elif action == "stop":
            self.cancel()
        else:
            return "not applicable"
        return "applied"

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
                "awaiting_decision": self.awaiting_decision,
                "graceful_stop": self.graceful,
                "cloud_queue": self.cloud_queue,
            }
        }
        
        if self.active_run_id:
            payload["active_run"] = await self.get_run_status(self.active_run_id)
            payload["status"]["attention"] = attention_items(payload["active_run"], self.awaiting_decision)
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

    async def report_cloud_progress(self, run_id: int, force: bool = False) -> None:
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
        if summary == state["sent"] and not force:
            return
        loop = asyncio.get_running_loop()
        wait = state["sent_at"] + PROGRESS_MIN_INTERVAL_S - loop.time()
        # A run that has just stopped for a person is sent at once rather than after the throttle:
        # it is the one update someone is waiting to be told about.
        newly_paused = bool(summary.get("pause")) and summary.get("pause") != (state["sent"] or {}).get("pause")
        if wait > 0 and not (force or newly_paused):
            if not state["timer"]:
                def flush():
                    state["timer"] = None
                    asyncio.ensure_future(self.report_cloud_progress(run_id))
                state["timer"] = loop.call_later(wait, flush)
            return

        from ivoryos_edge.server import publish_task_status
        # A paused summary goes at QoS 1: nothing later supersedes it until someone answers, so a
        # lost copy would leave Cloud never knowing the run is waiting.
        publish_task_status(params["cloud_run_id"], params.get("cloud_node_id"), "running", progress=summary,
                            reliable=bool(summary.get("pause")))
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
                    self.graceful = None
                    
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
                    batch_size = (run.parameters or {}).get("batch_size") or 1
                    stopped_early = False
                    graceful_applied = False  # the cut is made once; cleanup then runs as usual
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

                        # A graceful stop takes effect between iterations (graceful_stop_here).
                        if self.graceful and not graceful_applied and (graceful_stop_here(steps, index, batch_size) or step_phase(step) == "cleanup"):
                            graceful_applied = True
                            stopped_early = skip_after_graceful_stop(steps, index, self.graceful["cleanup"]) > 0
                            await session.commit()
                            await self.broadcast_updates(run_id)
                            continue
                            
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
                            if step.instrument in FLOW_CONTROL_INSTRUMENTS:
                                next_index = await self._flow_control_step(
                                    run_id, session, run, steps, index,
                                    scope=lambda s: scoped_context(workflow_context, row_contexts, s),
                                    bind=lambda s, values: bind_values(workflow_context, row_contexts, s, values),
                                )
                                if next_index is None:
                                    break  # cancelled while waiting for input
                                index = next_index
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

                            # The last thing before the driver: limits, tray positions and the
                            # deck's rules, on the values this step really carries (safety.py).
                            # A refusal is a failed step, so it waits for a person like any other.
                            sent = await safety_guard.enforce(step.instrument, step.method, args)
                            args = cast_arguments(method, args)
                            
                            if inspect.iscoroutinefunction(method):
                                self.current_step_task = asyncio.create_task(method(**args))
                            else:
                                loop = asyncio.get_running_loop()
                                self.current_step_task = loop.run_in_executor(None, lambda: method(**args))
                                
                            try:
                                result = await self.current_step_task
                            except BaseException:
                                # Sent, and it did not finish: the deck states it sets are no
                                # longer known (safety.py finish).
                                safety_guard.finish(sent, failed=True)
                                raise
                            safety_guard.finish(sent, result)
                            self.current_step_task = None
                                
                            serialized_res = serialize_result(result)
                            step.status = "completed"
                            step.outputs = with_attempts({"result": serialized_res}, step.outputs)
                            
                            if step.parameters and (step.parameters.get("_return_bindings") or step.parameters.get("_return_var")):
                                values = with_aliases(extract_return_values(
                                    step.parameters.get("_return_bindings"),
                                    step.parameters.get("_return_var"),
                                    serialized_res,
                                    result,
                                ), step.parameters.get("_return_aliases"))
                                shares = spread_over_rows(step.parameters, values)
                                bind_values(workflow_context, row_contexts, step, values, shares)
                                if shares:
                                    # Recorded, so Data History shows each sample its own value
                                    # rather than re-deriving which share went where.
                                    step.outputs = {**step.outputs, "by_row": {
                                        str(row): serialize_result(own) for row, own in shares.items()}}
                                
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
                            action = await self._wait_for_error_decision(run_id, session, run, step, e, traceback.format_exc())
                            if action == "retry":
                                continue
                            if action == "skip":
                                index += 1
                                continue
                            break
                    
                    # Update run status
                    run = await session.get(WorkflowRun, run_id)
                    if self.cancelled:
                        run.status = "cancelled"
                    elif any(s.status == "error" for s in steps):
                        run.status = "error"
                    else:
                        run.status = "completed"
                    issues = run_issues([s.as_dict() for s in steps])
                    if stopped_early:
                        issues["stopped_early"] = 1
                    if issues:
                        run.parameters = {**(run.parameters or {}), "_issues": issues}
                    run.end_time = datetime.utcnow()
                    await session.commit()
                    await self.publish_cloud_result(run.id)
                    report_run_finished(run, issues)
                    await self._end_group_after(session, run)
                    self._hold_queue_after(run)
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

    async def _flow_control_step(self, run_id: int, session, run, steps: list, index: int, scope, bind) -> Optional[int]:
        """Run the Flow Control step at `steps[index]` and return the index to go on from, or None
        when the run was stopped while it waited (for input, or in a Sleep).

        One implementation for a normal run and for an optimization's prep, trials and cleanup.
        An optimization used to treat every step as an instrument, so a Sleep, a User input or an
        If in its workflow stopped it with "Instrument Flow_Control not found".

        `scope(step)` is what a condition or a message may read; `bind(step, values)` saves a User
        input's answer where later steps read it. A condition that cannot be evaluated, or a block
        with no matching end, raises: the caller decides what a failed step means for its run.
        An If or While that skips steps marks them "skipped", and End_While sets its loop's steps
        back to "pending", so a caller walks only steps that are "pending" (or "error").
        """
        step = steps[index]
        method = step.method
        args = step.parameters or {}

        def find_forward(opener, closer, stop_at_else=False):
            """The index of the matching `closer` (or a same-level Else), marking what it passes skipped."""
            depth = 0
            for i in range(index + 1, len(steps)):
                s = steps[i]
                s.status = "skipped"
                if s.instrument in FLOW_CONTROL_INSTRUMENTS:
                    if s.method == opener:
                        depth += 1
                    elif s.method == closer:
                        if depth == 0:
                            return i
                        depth -= 1
                    elif stop_at_else and s.method == "Else" and depth == 0:
                        return i
            return None

        async def done(outputs=None):
            step.status = "completed"
            if outputs is not None:
                step.outputs = outputs
            step.end_time = datetime.utcnow()
            await session.commit()
            await self.broadcast_updates(run_id)

        if method == "Sleep":
            # Waited in short slices so Stop ends it at once: one long sleep left a stopped run
            # "cancelling" until the wait ran out, which for a long incubation is hours.
            loop = asyncio.get_running_loop()
            until = loop.time() + float(args.get("duration_seconds", 0))
            while not self.cancelled and (remaining := until - loop.time()) > 0:
                await asyncio.sleep(min(0.5, remaining))
            if self.cancelled:
                step.status = "error"
                step.error = "Stopped during the wait"
                step.end_time = datetime.utcnow()
                await session.commit()
                return None
            await done()
            return index + 1

        if method == "Comment":
            message = interpolate_message(str(args.get("message", "")), scope(step))
            print(f"[Run {run_id}] {message}")
            await done({"message": message})
            return index + 1

        if method == "User_Input":
            # With no name to save under it is a pause: the message waits for Continue and nothing
            # is asked or saved (the original IvoryOS's `pause`). `input_type` "none" tells the UI.
            var_name = (args.get("variable_name") or "").strip()
            prompt = interpolate_message(str(args.get("prompt", "Input required")), scope(step))
            input_type = str(args.get("input_type") or "str").strip().lower()
            if input_type not in ("str", "int", "float", "bool"):
                input_type = "str"
            if not var_name:
                input_type = "none"

            step.status = "waiting_input"
            # The type travels with the prompt so the UI can render the right control (number
            # spinner / checkbox) instead of a bare text box.
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
                return None

            run.status = "running"
            if not var_name:
                await done({"prompt": prompt, "input_type": input_type, "acknowledged": True})
                return index + 1
            value = coerce_input_value(value, input_type)
            bind(step, {var_name: value})
            await done({"result": value, "input_type": input_type})
            return index + 1

        if method in ("If", "While"):
            condition = args.get("condition", "False")
            try:
                # Safe evaluation using only workflow variables
                values = scope(step)
                result = eval(condition, {"__builtins__": {}}, values)
            except Exception as e:
                raise Exception(f"Failed to evaluate {method} condition: {e}")
            # A While's record accumulates across iterations: End_While resets this step's
            # status for the next pass but leaves its outputs alone.
            step.outputs = condition_record(condition, result, values, step.outputs if method == "While" else None)
            if result:
                await done()
                return index + 1
            if method == "If":
                # False: on to the matching Else or End_If, which still runs.
                target = find_forward("If", "End_If", stop_at_else=True)
                if target is None:
                    raise Exception("Matching Else or End_If not found for If statement")
                steps[target].status = "pending"
                await done()
                return target
            target = find_forward("While", "End_While")
            if target is None:
                raise Exception("Matching End_While not found for While statement")
            await done()
            return target + 1  # past the end of the loop

        if method == "Else":
            # Reached by running the If's true branch to its end: skip to the End_If.
            target = find_forward("If", "End_If")
            if target is None:
                raise Exception("Matching End_If not found for Else statement")
            steps[target].status = "pending"
            await done()
            return target

        if method == "End_While":
            # One pass done: back to the While, with the loop's steps pending again.
            depth = 0
            while_idx = None
            for i in range(index - 1, -1, -1):
                s = steps[i]
                if s.instrument in FLOW_CONTROL_INSTRUMENTS:
                    if s.method == "End_While":
                        depth += 1
                    elif s.method == "While":
                        if depth == 0:
                            while_idx = i
                            break
                        depth -= 1
            if while_idx is None:
                raise Exception("Matching While not found for End_While statement")
            step.status = "completed"
            step.end_time = datetime.utcnow()
            for i in range(while_idx, index + 1):
                steps[i].status = "pending"
            await session.commit()
            await self.broadcast_updates(run_id)
            return while_idx

        # End_If, and any marker step with nothing to do.
        await done()
        return index + 1

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
        # Stop once no objective has improved for this many iterations in a row, counted from the
        # end of the random start (step_1's num_samples): random points are not expected to improve.
        patience = int(parameters.get("stop_after_no_improvement") or 0)
        random_start = int((opt_config.get("step_1") or {}).get("num_samples") or 0)
        no_improvement = NoImprovement(obj_config, patience, random_start, existing_data)

        OptClass = OPTIMIZER_REGISTRY.get(opt_name)
        if not OptClass:
            raise Exception(f"Optimizer {opt_name} not found")

        from .paths import OPTIMIZER_DATA_DIR
        optimizer_data_dir = OPTIMIZER_DATA_DIR
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

        async def finish(stopped_early: bool = False):
            """Every way out of an optimization ends here: final status, record, Cloud, queue hold.
            A failure in existing data or prep used to return early, leaving the run without an
            end time, Cloud never told it had ended, and the queue running on."""
            nonlocal run
            run = await session.get(WorkflowRun, run_id)
            if self.cancelled:
                run.status = "cancelled"
            elif run.status != "error":
                run.status = "completed"
            issues = {"stopped_early": 1} if stopped_early else {}
            if issues:
                run.parameters = {**(run.parameters or {}), "_issues": issues}
            run.end_time = datetime.utcnow()
            await session.commit()
            await self.publish_cloud_result(run.id)
            report_run_finished(run, issues)
            await self._end_group_after(session, run)
            self._hold_queue_after(run)
            self.active_run_id = None
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
                await finish()
                return
        
        step_index = 0
        # What this run's steps have saved so far, prep through cleanup: a later step's '#name'
        # reads it when it runs, as in a normal run (substitute_workflow_vars), so '#absorbance'
        # after a step that saves `absorbance` is that value, not something to optimize or ask for.
        run_context: Dict[str, Any] = {}

        async def run_steps(entries, context: Dict[str, Any], objectives: Optional[Dict[str, float]] = None) -> bool:
            """Run one block of this run's steps in order: prep, one trial, or cleanup.

            `entries` are (step, returnVar, returnBindings, aliases). Flow Control goes through
            the same _flow_control_step as a normal run; what a step saves goes into `context`,
            where later steps read it as '#name', and its numbers into `objectives` when given.
            False when a step failed (it records why) or the run was cancelled.
            """
            steps = [entry[0] for entry in entries]
            index = 0
            while index < len(steps):
                if self.cancelled:
                    return False
                await self.pause_event.wait()
                db_step = steps[index]
                if db_step.status not in ("pending", "error"):  # skipped by an If or a While
                    index += 1
                    continue
                _, return_var, return_bindings, return_aliases = entries[index]

                db_step.status = "running"
                db_step.start_time = datetime.utcnow()
                await session.commit()
                await self.broadcast_updates(run_id)

                try:
                    if db_step.instrument in FLOW_CONTROL_INSTRUMENTS:
                        next_index = await self._flow_control_step(
                            run_id, session, run, steps, index,
                            scope=lambda s: context,
                            bind=lambda s, values: context.update(values),
                        )
                        if next_index is None:
                            return False  # cancelled while waiting for input
                        index = next_index
                        continue

                    instruments = getattr(self.app.state, "instruments", {})
                    if db_step.instrument not in instruments:
                        raise Exception(f"Instrument {db_step.instrument} not found")
                    from ivoryos_edge.introspection import cast_arguments, resolve_callable
                    method = resolve_callable(instruments[db_step.instrument], db_step.method)
                    step_args = substitute_workflow_vars(db_step.parameters or {}, context)
                    # As in a normal run: an optimizer's suggestion is checked like a typed value.
                    sent = await safety_guard.enforce(db_step.instrument, db_step.method, step_args)
                    casted_args = cast_arguments(method, step_args)

                    if inspect.iscoroutinefunction(method):
                        self.current_step_task = asyncio.create_task(method(**casted_args))
                    else:
                        loop = asyncio.get_running_loop()
                        self.current_step_task = loop.run_in_executor(None, lambda: method(**casted_args))
                    try:
                        result = await self.current_step_task
                    except BaseException:
                        safety_guard.finish(sent, failed=True)
                        raise
                    safety_guard.finish(sent, result)
                    self.current_step_task = None

                    serialized_res = serialize_result(result)
                    db_step.status = "completed"
                    db_step.outputs = {"result": serialized_res}
                    if return_bindings or return_var:
                        saved = with_aliases(extract_return_values(
                            return_bindings, return_var, serialized_res, result), return_aliases)
                        context.update(saved)
                        if objectives is not None:
                            # An objective has to be a number; anything a pointer resolves to
                            # that isn't (a status string, a nested list) is simply not an
                            # objective and is dropped rather than crashing the trial.
                            for var_name, value in saved.items():
                                try:
                                    objectives[var_name] = float(value)
                                except (TypeError, ValueError):
                                    pass
                    db_step.end_time = datetime.utcnow()
                    await session.commit()
                    await self.broadcast_updates(run_id)
                    index += 1
                except asyncio.CancelledError:
                    self.current_step_task = None
                    db_step.status = "error"
                    db_step.error = "Step execution cancelled"
                    db_step.end_time = datetime.utcnow()
                    await session.commit()
                    await self.broadcast_updates(run_id)
                    return False
                except Exception as e:
                    self.current_step_task = None
                    # A failure waits for a person, as in a normal run: retry the step, skip it,
                    # or stop the run. (traceback is imported at module level; a local re-import
                    # in here would make the name local to the whole enclosing function.)
                    action = await self._wait_for_error_decision(run_id, session, run, db_step, e, traceback.format_exc())
                    if action == "retry":
                        continue
                    if action == "skip":
                        index += 1
                        continue
                    return False
            return True

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
                params = tmpl_step.get("params") or {}
                iteration_steps.append((
                    db_step,
                    tmpl_step.get("returnVar") or tmpl_step.get("return") or params.get("_return_var"),
                    tmpl_step.get("returnBindings") or params.get("_return_bindings"),
                    params.get("_return_aliases"),
                ))
                step_index += 1
                
            await session.commit()
            await self.broadcast_updates(run_id)

            # What it saves goes into the run's context and the block carries on (it used to
            # `return` at the first step that saved anything, skipping the rest).
            ok = await run_steps(iteration_steps, run_context)
            if not ok and not self.cancelled:
                run.status = "error"
                await session.commit()
                await self.broadcast_updates(run_id)
            return ok, run_context

        # 1. Execute Prep Phase
        prep_template = parameters.get("prep_template", [])
        if prep_template:
            success, _ = await execute_template_block(prep_template)
            if not success:
                run.status = "error"
                await session.commit()
                await finish()
                return

        stopped_early = False
        # Trials are grouped into rounds of up to `batch_size`: the optimizer suggests a whole
        # round at once, every trial in the round runs, and only then does the whole round get
        # reported back via one observe() call — not one ask/run/tell per trial. batch_size=1
        # (the default) makes this behave exactly like the original one-at-a-time loop.
        completed = 0
        trials_run = 0  # trials that actually ran, for "stopped early"
        while completed < budget:
            if self.cancelled:
                break
            await self.pause_event.wait()
            # A graceful stop asked for during prep, or between rounds: no more trials.
            if self.graceful:
                stopped_early = trials_run < budget
                break

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
            # What observe() is told: one entry per suggested trial, in the order suggest()
            # returned them, holding the values the trial ran with and, unless it failed, its
            # objective values. The adapters need both halves. Ax and NIMO pair a result with
            # its trial by position, so dropping a failed trial (as this used to) shifted every
            # later result onto the wrong trial; BayBE records measurements as parameter values
            # plus targets, so objectives alone were refused on every round, and the refusal
            # was caught below and printed: a BayBE run finished without its model ever seeing
            # a result.
            observations = []

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
                    # A step expanded from a linked workflow carries its outputs in its params
                    # (expand_workflow_blocks), not as top-level returnVar/returnBindings. Reading
                    # only the top level left every result of a linked workflow unseen by the
                    # optimizer, which then had no objective value for any trial.
                    tmpl_params = tmpl_step.get("params") or {}
                    iteration_steps.append((
                        db_step,
                        tmpl_step.get("returnVar") or tmpl_params.get("_return_var"),
                        tmpl_step.get("returnBindings") or tmpl_params.get("_return_bindings"),
                        tmpl_params.get("_return_aliases"),
                    ))
                    step_index += 1

                await session.commit()
                await self.broadcast_updates(run_id)

                # 3. Execute steps for this trial
                objective_values = {}
                # This trial's own saved values on top of what prep saved; a trial does not see
                # the previous trial's (each trial is one evaluation of the workflow).
                trial_context = dict(run_context)
                trial_failed = not await run_steps(iteration_steps, trial_context, objective_values)

                if self.cancelled:
                    break

                # 4. Handle this trial's result. A trial only fails here when someone chose Stop
                # on a failed step (run_steps waits for that decision); a skipped step leaves a
                # trial that completed, possibly without its objective.
                if trial_failed:
                    run.status = "error"
                    break
                observations.append({**(suggestion if isinstance(suggestion, dict) else {}), **objective_values})
                round_results.append(objective_values)
                trials_run += 1
                # Graceful stop: this trial is done; the rest of the round is not started.
                if self.graceful:
                    break

            if self.cancelled or run.status == "error":
                break

            # 5. Tell the optimizer about however many trials in this round actually succeeded,
            # then check early-stop against each of them.
            if observations:
                try:
                    loop = asyncio.get_running_loop()
                    await loop.run_in_executor(None, lambda: optimizer.observe(observations))
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
                if not stop_early:
                    for trial_num, objective_values in enumerate(round_results):
                        if no_improvement.add(completed + trial_num + 1, objective_values):
                            print(f"Stopped: no objective improved in {patience} iteration(s), "
                                  f"after {completed + trial_num + 1} trial(s)")
                            stop_early = True
                            break
                if stop_early:
                    break

            completed += n_this_round
            if self.graceful:
                stopped_early = trials_run < budget
                break

        # 2. Execute Cleanup Phase — runs once after the budget loop, mirroring Prep. This was
        # previously never executed at all for Optimization runs even though the Optimize page
        # already lets you configure one. Skipped on cancellation: execute_template_block bails
        # out immediately once self.cancelled is set, so cleanup can't run through a cancel yet —
        # that would need its own bypass, left for later if it turns out to matter.
        cleanup_template = parameters.get("cleanup_template", [])
        wants_cleanup = not self.graceful or self.graceful.get("cleanup", True)
        if cleanup_template and not self.cancelled and run.status != "error" and wants_cleanup:
            success, _ = await execute_template_block(cleanup_template)
            if not success:
                run.status = "error"

        await finish(stopped_early)
