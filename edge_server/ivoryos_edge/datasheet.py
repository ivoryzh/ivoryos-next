"""A run record as its datasheet, on the edge: one row per iteration, columns = inputs, typed-in
answers, then named outputs.

This is the Python reading of `packages/shared-ui/src/runRecord.ts` (`formatRun`, with
`readNamedOutput` from `returnValues.ts`), which Data History and Cloud's Results use. The edge
needs its own so the assistant can read history without a browser (agent/history.py, the MCP
server). Two readings of one record is the drift AGENTS.md section 3 warns about, so they are held
to one set of answers: `tests/fixtures/run_datasheets.json` holds run records and the datasheet the
TypeScript produces for each, and both `packages/shared-ui/test/runRecord.test.mjs` and
`tests/automated/test_datasheet.py` check against it. Change one reading, regenerate the fixtures
(`node packages/shared-ui/test/write-datasheet-fixtures.mjs`), and make the other pass.

The port is literal on purpose, including JavaScript's distinction between a value that is absent
(`undefined`, here `MISSING`) and one recorded as null (`None`): an output that was never recorded
reads '', a step that returned nothing reads None.
"""

from typing import Any, Dict, List, Optional

MISSING = object()


def _get(obj: Any, key: str) -> Any:
    """`obj?.[key]`: MISSING when obj is not a dict or has no such key."""
    if isinstance(obj, dict) and key in obj:
        return obj[key]
    return MISSING


def _absent(value: Any) -> bool:
    """What JavaScript's `??` falls through on: undefined or null."""
    return value is MISSING or value is None


def _or_blank(value: Any) -> Any:
    return "" if _absent(value) else value


def _params(step: Any) -> dict:
    params = _get(step, "parameters")
    return params if isinstance(params, dict) else {}


def _result(step: Any) -> Any:
    return _get(_get(step, "outputs"), "result")


def phase_of(step: Any) -> str:
    phase = str(_params(step).get("_phase") or "main").lower()
    return phase if phase in ("prep", "cleanup") else "main"


def _is_flow(step: Any) -> bool:
    return _get(step, "instrument") in ("Flow_Control", "Flow Control")


def _is_user_input(step: Any) -> bool:
    return _is_flow(step) and _get(step, "method") == "User_Input"


def _split_names(text: Any) -> List[str]:
    return [p.strip() for p in str(text or "").split(",") if p.strip()]


def _js_index(segment: str) -> Optional[int]:
    """`Number(segment)` when it is an integer, as `Number.isInteger` sees it ('' is 0)."""
    text = segment.strip()
    if text == "":
        return 0
    try:
        number = float(text)
    except ValueError:
        return None
    return int(number) if number.is_integer() else None


def resolve_result_path(result: Any, path: str) -> Any:
    """Walk a dotted pointer ("metrics.purity", "0", "" for the whole value) into a result."""
    if not path:
        return result
    current = result
    for segment in str(path).split("."):
        if _absent(current):
            return MISSING
        if isinstance(current, list):
            index = _js_index(segment)
            if index is None or index < 0 or index >= len(current):
                return MISSING
            current = current[index]
        elif isinstance(current, dict):
            current = current.get(segment, MISSING)
        else:
            return MISSING
    return current


def template_of(steps: List[Any]) -> List[dict]:
    """Each step's saved-output names, as a template `read_named_output` resolves against."""
    return [{
        "instrument": _get(s, "instrument"),
        "method": _get(s, "method"),
        "returnVar": _params(s).get("_return_var") or None,
        "returnBindings": _params(s).get("_return_bindings") or None,
    } for s in steps]


def read_named_output(name: str, template: List[Any], steps: List[Any]) -> Any:
    """The value of one named output within one iteration's steps, in template order; '' when
    the run has no record of it."""
    for i, tmpl in enumerate(template):
        if not tmpl:
            continue
        step = steps[i] if i < len(steps) else MISSING
        result = _result(step)

        bindings = tmpl.get("returnBindings") or []
        binding = next((b for b in bindings if isinstance(b, dict) and b.get("var") == name), None)
        if binding is not None:
            if result is MISSING:
                return ""
            value = resolve_result_path(result, binding.get("path") or "")
            return "" if value is MISSING else value

        parts = _split_names(tmpl.get("returnVar"))
        if name not in parts:
            continue
        idx = parts.index(name)
        if result is MISSING:
            return ""
        if len(parts) == 1:
            return result
        if isinstance(result, list):
            return _or_blank(result[idx] if idx < len(result) else MISSING)
        if isinstance(result, dict):
            values = list(result.values())
            return _or_blank(values[idx] if idx < len(values) else MISSING)
        return result
    return ""


def named_outputs_of(steps: List[Any]) -> List[str]:
    names: List[str] = []
    for t in template_of(steps):
        own = ([b.get("var") for b in t["returnBindings"] if isinstance(b, dict) and b.get("var")]
               if t["returnBindings"] else _split_names(t["returnVar"]))
        for n in own:
            if n not in names:
                names.append(n)
    return names


def user_input_vars_of(steps: List[Any]) -> List[str]:
    names: List[str] = []
    for s in steps:
        n = str(_params(s).get("variable_name") or "").strip()
        if _is_user_input(s) and n and n not in names:
            names.append(n)
    return names


def user_input_value(steps: List[Any], name: str) -> Any:
    step = next((s for s in steps if _is_user_input(s)
                 and str(_params(s).get("variable_name") or "").strip() == name), MISSING)
    return _or_blank(_result(step))


def never_ran(steps: List[Any]) -> bool:
    """Every step skipped with no error of its own: the run ended before it (a graceful stop)."""
    return len(steps) > 0 and all(_get(s, "status") == "skipped" and not _or_blank(_get(s, "error")) for s in steps)


def failed_then_skipped(step: Any) -> bool:
    return _get(step, "status") == "skipped" and bool(_or_blank(_get(step, "error")))


def aggregate_status(steps: List[Any]) -> str:
    statuses = [_get(s, "status") for s in steps]
    if "error" in statuses:
        return "error"
    if "running" in statuses or "waiting_input" in statuses:
        return "running"
    if any(failed_then_skipped(s) for s in steps):
        return "failed"
    if never_ran(steps):
        return "not_run"
    if steps and all(st in ("completed", "skipped") for st in statuses):
        return "completed"
    return "pending"


def _iteration_status(steps: List[Any]) -> str:
    statuses = [_get(s, "status") for s in steps]
    if "error" in statuses:
        return "error"
    if "running" in statuses:
        return "running"
    if any(failed_then_skipped(s) for s in steps):
        return "failed"
    if never_ran([s for s in steps if s is not MISSING and s]):
        return "not_run"
    if all(st == "pending" for st in statuses):
        return "pending"
    return "completed"


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _js_text(value: Any) -> str:
    """`${value}` for the numbers `_block` holds: 1.0 reads "1", as JavaScript writes it."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def format_run(record: Dict[str, Any]) -> Dict[str, Any]:
    """A raw run record (`/api/queue/runs/{id}` shape: parameters + steps) as its datasheet:
    `{id, name, type, timestamp, variables, rows: [{row, status, values}], deck_version,
    batch_size, prep, cleanup, config}`, prep and cleanup being their steps' statuses."""
    params = record.get("parameters") or {}
    variables = list(params.get("variables") or [])
    run_type = params.get("type") or ("Spreadsheet" if variables else "Sequence")
    if run_type not in ("Spreadsheet", "Optimization"):
        run_type = "Sequence"

    all_steps = record.get("steps") or []
    prep_steps = [s for s in all_steps if phase_of(s) == "prep"]
    cleanup_steps = [s for s in all_steps if phase_of(s) == "cleanup"]
    main_steps = [s for s in all_steps if phase_of(s) == "main"]

    rows: List[Dict[str, Any]] = []
    if run_type == "Sequence":
        inputs = user_input_vars_of(main_steps)
        outputs = [n for n in named_outputs_of(main_steps) if n not in inputs]
        template = template_of(main_steps)
        variables = inputs + outputs
        if main_steps:
            rows = [{
                "row": 1,
                "status": aggregate_status(main_steps),
                "values": [user_input_value(main_steps, n) for n in inputs]
                          + [read_named_output(n, template, main_steps) for n in outputs],
            }]
    elif run_type == "Optimization":
        param_names = [p.get("name") for p in params.get("parameter_space") or []]
        objective_names = [o.get("name") for o in params.get("objective_config") or []]
        seq_template = params.get("sequence_template") or []
        seq_length = len(seq_template)
        variables = param_names + [f"{n} (objective)" for n in objective_names]
        count = -(-len(main_steps) // seq_length) if seq_length > 0 else 0
        for i in range(count):
            steps = main_steps[i * seq_length:(i + 1) * seq_length]
            param_values = []
            for name in param_names:
                step = next((s for s in steps if name in _params(s)), None)
                param_values.append(_params(step)[name] if step is not None else "")
            rows.append({
                "row": i + 1,
                "status": _iteration_status(steps),
                "values": param_values + [read_named_output(n, seq_template, steps) for n in objective_names],
            })
    else:
        input_vars = variables
        table = params.get("rows") or []
        row_count = len(table)
        seq_template = params.get("sequence_template") or []
        return_vars: List[str] = []
        for t in seq_template:
            bindings = (t or {}).get("returnBindings") or []
            return_vars += ([b.get("var") for b in bindings if isinstance(b, dict) and b.get("var")]
                            if bindings else _split_names((t or {}).get("returnVar")))
        seq_length = len(seq_template) or (len(main_steps) // row_count if row_count > 0 and main_steps else 0)
        prompt_vars = [n for n in user_input_vars_of(main_steps) if n not in input_vars and n not in return_vars]
        variables = input_vars + prompt_vars + return_vars

        has_row_tags = bool(main_steps) and all("_row" in _params(s) for s in main_steps)

        def steps_for_row(i: int) -> List[Any]:
            if has_row_tags:
                return [s for s in main_steps if _params(s).get("_row") == i]
            return main_steps[i * seq_length:(i + 1) * seq_length]

        def block_keys(steps: List[Any]) -> List[str]:
            seen: Dict[Any, int] = {}
            keys = []
            for s in steps:
                block = _params(s).get("_block", MISSING)
                k = seen.get(block, 0)
                seen[block] = k + 1
                keys.append(f"{'undefined' if block is MISSING else _js_text(block)}:{k}")
            return keys

        has_block_tags = has_row_tags and all(_is_number(_params(s).get("_block")) for s in main_steps)
        first_row = min(_params(s)["_row"] for s in main_steps) if has_block_tags else 0
        template_keys = block_keys(steps_for_row(first_row)) if has_block_tags else []

        def aligned(row_steps: List[Any]) -> List[Any]:
            if not has_block_tags or len(template_keys) != len(seq_template):
                return row_steps
            by_key = dict(zip(block_keys(row_steps), row_steps))
            return [by_key.get(k, MISSING) for k in template_keys]

        def shared_output(row: int, name: str) -> Any:
            for s in main_steps:
                own = _get(_get(_get(s, "outputs"), "by_row"), str(row))
                if isinstance(own, dict) and name in own:
                    return own[name]
            return MISSING

        for i in range(row_count):
            row_steps = steps_for_row(i)
            row_values = table[i] if isinstance(table[i], dict) else {}
            output_values = []
            for rv in return_vars:
                shared = shared_output(i, rv)
                output_values.append(read_named_output(rv, seq_template, aligned(row_steps)) if _absent(shared) else shared)
            rows.append({
                "row": i + 1,
                "status": _iteration_status(row_steps),
                "values": [row_values.get(v) for v in input_vars]
                          + [user_input_value(row_steps, n) for n in prompt_vars]
                          + output_values,
            })

    return {
        "id": record.get("id"),
        "name": record.get("name") or "Unnamed Workflow",
        "type": run_type,
        "timestamp": record.get("start_time"),
        "variables": variables,
        "rows": rows,
        "deck_version": params.get("deck_version"),
        "batch_size": _batch_size(params.get("batch_size")),
        "prep": [_get(s, "status") for s in prep_steps],
        "cleanup": [_get(s, "status") for s in cleanup_steps],
        "config": {
            "optimizer": params.get("optimizer"),
            "budget": params.get("budget"),
            "parameter_space": params.get("parameter_space") or [],
            "objective_config": params.get("objective_config") or [],
        } if run_type == "Optimization" else None,
    }


def _batch_size(value: Any) -> Optional[int]:
    """`Number(value) || null`."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number == 0:
        return None
    return int(number) if number.is_integer() else number
