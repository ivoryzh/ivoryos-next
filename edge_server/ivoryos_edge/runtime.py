"""How long each saved workflow takes, from the runs this device has actually executed.

Everything needed is already in the run history -- every step has a start and an end -- so this is
bookkeeping, not measurement. What makes it work is knowing which steps were *which workflow*:

- **Linked** (`Library Workflows`) steps carry `_parent_path`, the chain of workflows they were
  expanded from (`expand_workflow_blocks`). A step counts toward every workflow on its path, so a
  workflow that links another is timed including it. This covers everything Cloud dispatches.
- **Direct** runs -- the Designer running a saved workflow's own inlined steps -- carry
  `parameters.workflow_name`, stamped by the Designer only when the canvas is that saved workflow
  unedited (an edited canvas is not the workflow, and timing it as one would skew the numbers).

Per workflow the result is the median of the recent samples of each phase: prep, one iteration of
the body (a spreadsheet row, an optimization trial, or the one pass of a plain run), and cleanup.
`typical_s` is prep + one iteration + cleanup, i.e. one Once run. Medians, not means: one run
held up at a User Input prompt over lunch must not make a ten-minute workflow read as two hours.

Only completed work counts. A run that errored or was cancelled stopped early, so its duration
says nothing about how long the workflow takes.
"""

from collections import defaultdict
from statistics import median

from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from .models import WorkflowRun, WorkflowStep, sync_session

# How far back to look, and how many samples per phase to keep. Recent behaviour is what matters:
# a workflow edited last week to add a 20-minute hold should read as the slower one now.
MAX_RUNS_SCANNED = 400
MAX_SAMPLES = 20

_DONE = ("completed", "skipped")
_cache = {"key": None, "value": {}}


def _span(steps):
    """Wall-clock from the first step's start to the last step's end, in seconds."""
    starts = [s.start_time for s in steps if s.start_time]
    ends = [s.end_time for s in steps if s.end_time]
    if not starts or not ends:
        return None
    seconds = (max(ends) - min(starts)).total_seconds()
    return seconds if seconds >= 0 else None


def _phase(step):
    p = str((step.parameters or {}).get("_phase") or "main").lower()
    return p if p in ("prep", "cleanup") else "main"


def _iterations(main_steps, trial_length=None):
    """Split a run's body into iterations: by spreadsheet row where rows are recorded, by link
    expansion otherwise (each expansion of a linked body is one pass), else the whole body.

    An optimization's trials are all built from one expanded template, so they share an expansion
    id; they are split by the template's length instead (`trial_length`)."""
    if trial_length:
        ordered = sorted(main_steps, key=lambda s: s.sequence_index or 0)
        return [ordered[i:i + trial_length] for i in range(0, len(ordered), trial_length)]
    groups = defaultdict(list)
    for s in main_steps:
        params = s.parameters or {}
        if params.get("_row") is not None:
            key = ("row", params["_row"])
        elif params.get("_expansion_id") is not None:
            key = ("expansion", params["_expansion_id"])
        else:
            key = ("all", 0)
        groups[key].append(s)
    return list(groups.values())


def _collect(run, steps, samples, trial_length=None):
    """Add this run's timings for the given steps (all belonging to one workflow) to `samples`."""
    if not steps or any(s.status not in _DONE for s in steps):
        return
    by_phase = defaultdict(list)
    for s in steps:
        by_phase[_phase(s)].append(s)
    iteration_spans = [
        x for x in (_span(g) for g in _iterations(by_phase["main"], trial_length)) if x is not None
    ]
    if not iteration_spans:
        return
    samples["iteration"].extend(iteration_spans)
    for phase in ("prep", "cleanup"):
        span = _span(by_phase[phase]) if by_phase[phase] else None
        if span is not None:
            samples[phase].append(span)
    samples["runs"] += 1
    end = run.end_time or max((s.end_time for s in steps if s.end_time), default=None)
    if end and (samples["last_at"] is None or end > samples["last_at"]):
        samples["last_at"] = end


def _new_samples():
    return {"iteration": [], "prep": [], "cleanup": [], "runs": 0, "last_at": None}


def workflow_runtimes():
    """`{workflow_name: {runs, prep_s, iteration_s, cleanup_s, typical_s, last_at}}`.

    Cached on the newest finished run: the answer can only change when a run finishes.
    """
    with sync_session() as session:
        key = session.execute(
            select(func.max(WorkflowRun.id), func.max(WorkflowRun.end_time))
            .where(WorkflowRun.status == "completed")
        ).one()
        if key == _cache["key"]:
            return _cache["value"]

        runs = session.execute(
            select(WorkflowRun)
            .where(WorkflowRun.status == "completed")
            .order_by(WorkflowRun.id.desc())
            .limit(MAX_RUNS_SCANNED)
            .options(selectinload(WorkflowRun.steps))
        ).scalars().all()

        per_workflow = defaultdict(_new_samples)
        for run in runs:  # newest first, so the sample caps keep the most recent behaviour
            steps = list(run.steps or [])
            params = run.parameters or {}
            trial_length = (
                len(params.get("sequence_template") or []) or None
                if params.get("type") == "Optimization" else None
            )
            direct = params.get("workflow_name")
            if direct:
                inlined = [s for s in steps if not (s.parameters or {}).get("_parent_path")]
                if inlined and len(per_workflow[direct]["iteration"]) < MAX_SAMPLES:
                    _collect(run, inlined, per_workflow[direct], trial_length)

            linked = defaultdict(list)
            for s in steps:
                step_params = s.parameters or {}
                path = step_params.get("_parent_path") or (
                    [step_params["_parent_workflow"]] if step_params.get("_parent_workflow") else []
                )
                for name in dict.fromkeys(path):
                    linked[name].append(s)
            for name, own in linked.items():
                if len(per_workflow[name]["iteration"]) < MAX_SAMPLES:
                    _collect(run, own, per_workflow[name], trial_length)

    result = {}
    for name, s in per_workflow.items():
        if not s["runs"]:
            continue
        iteration = median(s["iteration"])
        prep = median(s["prep"]) if s["prep"] else 0.0
        cleanup = median(s["cleanup"]) if s["cleanup"] else 0.0
        result[name] = {
            "runs": s["runs"],
            "prep_s": round(prep, 1),
            "iteration_s": round(iteration, 1),
            "cleanup_s": round(cleanup, 1),
            "typical_s": round(prep + iteration + cleanup, 1),
            "last_at": s["last_at"].isoformat() if s["last_at"] else None,
        }
    _cache.update(key=key, value=result)
    return result


def forget():
    _cache.update(key=None, value={})
