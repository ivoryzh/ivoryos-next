"""What the deck can do, rendered for a language model rather than for a form.

`/api/status` hands out the full introspected schema, which is the right shape for building a
UI and the wrong shape for a prompt: a modest deck runs to tens of thousands of tokens once
every parameter's `required`/`default`/`options`/`is_object`/`fields` is spelled out, and most
of that detail is irrelevant until a model has already decided which method to call. These
renderings are deliberately lossy in a specific direction — keep everything needed to choose a
method and get its call shape right, drop everything that is only needed to draw a widget.
"""

# Flow control is not introspected from any driver: it is the designer's own vocabulary, and a
# model writing a workflow has to know it exists or it will reach for a nonexistent
# `wait`/`if` method on a real instrument. Kept here as the single description of the built-ins,
# matching what queue.py actually executes (Flow_Control + these method names).
FLOW_CONTROL_INSTRUMENT = "Flow_Control"

FLOW_CONTROL_METHODS = {
    "Sleep": {
        "description": "Pause for a fixed time. `duration_seconds` is a number of seconds.",
        "parameters": {"duration_seconds": {"type": "float", "required": True}},
    },
    "Comment": {
        "description": "Write a note into the run log. `message` may contain #variables.",
        "parameters": {"message": {"type": "str", "required": True}},
    },
    "User_Input": {
        "description": (
            "Stop and ask a person for a value, then continue. The value is saved under "
            "`variable_name` and later steps read it as #variable_name. Use this for anything "
            "the deck cannot measure or decide on its own."
        ),
        "parameters": {
            "prompt": {"type": "str", "required": True},
            "variable_name": {"type": "str", "required": True},
            "input_type": {"type": "str", "required": False, "options": ["str", "int", "float", "bool"]},
        },
    },
    "If": {
        "description": "Start a conditional. `condition` is a Python expression over #variables.",
        "parameters": {"condition": {"type": "str", "required": True}},
    },
    "Else": {"description": "Optional alternative branch of the enclosing If.", "parameters": {}},
    "End_If": {"description": "Close the enclosing If. Required.", "parameters": {}},
    "While": {
        "description": "Start a loop. `condition` is a Python expression over #variables.",
        "parameters": {"condition": {"type": "str", "required": True}},
    },
    "End_While": {"description": "Close the enclosing While. Required.", "parameters": {}},
}

LIBRARY_INSTRUMENT = "Library Workflows"


def _first_line(text):
    for line in (text or "").strip().splitlines():
        line = line.strip()
        if line:
            return line
    return ""


def _param_brief(name, info):
    """One parameter as `name: type` plus only the detail that changes what a caller may write."""
    out = {"type": info.get("type", "Any")}
    if info.get("options") is not None:
        out["options"] = info["options"]
    if not info.get("required", True):
        out["optional"] = True
        if "default" in info:
            out["default"] = info["default"]
    if info.get("is_object"):
        # A nested object is passed as a JSON object; naming its fields is enough to write the
        # call, and the full nested schema is available from describe_method.
        out["object_fields"] = sorted((info.get("fields") or {}).keys())
    return out


def describe_method(schema, instrument, method):
    """The full call shape of one method: every parameter, and every field its result exposes."""
    entry = (schema.get(instrument) or {}).get(method)
    if entry is None:
        return None

    described = {
        "instrument": instrument,
        "method": method,
        "description": entry.get("description") or "",
        "parameters": {k: _param_brief(k, v) for k, v in (entry.get("parameters") or {}).items()},
    }
    if entry.get("is_property"):
        described["property_access"] = entry.get("property_access")
        described["note"] = (
            "This is a property, not a method. Reading it takes no arguments; the matching "
            "'<name>_(setter)' entry writes it and takes a single `value`."
        )
    returns = entry.get("return_paths") or []
    if returns:
        # The numeric leaves are the ones an optimizer can use as an objective, which is the
        # single most common thing a model gets wrong when asked to "optimize yield".
        described["returns"] = [
            {"save_from": r["path"], "type": r["type"], "numeric": bool(r.get("numeric"))}
            for r in returns
        ]
    elif entry.get("return_type") not in (None, "None", "NoneType"):
        described["returns"] = [{"save_from": "", "type": entry.get("return_type"), "numeric": False}]
    return described


def describe_deck(schema, instrument=None, workflows=None):
    """The deck as a model should first see it.

    With no `instrument`, every instrument and a one-line summary per method — enough to pick.
    With one, the full parameter detail for that instrument's methods only. Splitting it this
    way is what keeps the first turn small on a deck with a dozen instruments.
    """
    if instrument is not None:
        if instrument == FLOW_CONTROL_INSTRUMENT:
            return {
                "instrument": instrument,
                "methods": {
                    name: {"description": m["description"],
                           "parameters": {k: _param_brief(k, v) for k, v in m["parameters"].items()}}
                    for name, m in FLOW_CONTROL_METHODS.items()
                },
            }
        if instrument not in schema:
            return None
        return {
            "instrument": instrument,
            "methods": {
                method: describe_method(schema, instrument, method)
                for method in sorted(schema[instrument])
            },
        }

    instruments = {}
    for inst in sorted(schema):
        methods = {}
        for method in sorted(schema[inst]):
            entry = schema[inst][method] or {}
            params = entry.get("parameters") or {}
            required = [k for k, v in params.items() if v.get("required", True)]
            summary = {"summary": _first_line(entry.get("description"))}
            if required:
                summary["required"] = required
            optional = [k for k in params if k not in required]
            if optional:
                summary["optional"] = optional
            numeric_returns = [r["path"] for r in (entry.get("return_paths") or []) if r.get("numeric")]
            if numeric_returns:
                summary["numeric_results"] = numeric_returns
            if entry.get("is_property"):
                summary["property"] = entry.get("property_access")
            methods[method] = summary
        instruments[inst] = methods

    out = {
        "instruments": instruments,
        "flow_control": {
            "instrument": FLOW_CONTROL_INSTRUMENT,
            "methods": {name: _first_line(m["description"]) for name, m in FLOW_CONTROL_METHODS.items()},
        },
        "conventions": {
            "variable": (
                "A parameter value of '#name' is resolved at run time, not sent literally. It "
                "comes from an earlier step's saved output, a User_Input step, or — in an "
                "optimization run — the optimizer's suggestion for that trial."
            ),
            "saving_results": (
                "A step saves results with `return` (a comma-separated list of variable names) "
                "and `return_bindings` ([{path, var}]), where `path` is one of the method's "
                "`returns[].save_from` values. Only numeric results can become an optimization "
                "objective."
            ),
            "structure": (
                "A workflow body is {name, description, prep[], script[], cleanup[]}. prep runs "
                "once at the start, script is the part repeated per sample or per optimization "
                "trial, cleanup runs once at the end."
            ),
        },
    }
    if workflows:
        out["saved_workflows"] = {
            "instrument": LIBRARY_INSTRUMENT,
            "note": "Call a saved workflow as a step by using this instrument and the workflow's name as the method.",
            "available": list(workflows),
        }
    return out
