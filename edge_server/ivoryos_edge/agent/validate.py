"""Check a workflow body against the live deck, before a human is asked to look at it.

The point of this module is that a language model's output is a *proposal*, not an edit. Every
mistake it can plausibly make while translating a protocol — inventing a method, omitting a
required argument, writing "65 C" where a float belongs, referencing a variable no earlier step
produces, leaving an If unclosed, pointing an objective at a field that is a string — is
mechanically detectable against the schema the deck already publishes. Catching them here means
the scientist reviews a workflow that at least *runs*, and the agent gets told precisely what to
fix instead of being asked to guess from a stack trace.

Deliberately not a linter for style: everything reported is something that would fail, or
silently do the wrong thing, on real hardware.
"""

import re

from ivoryos_edge.agent.deck import (
    FLOW_CONTROL_INSTRUMENT,
    FLOW_CONTROL_METHODS,
    LIBRARY_INSTRUMENT,
)

PHASES = ("prep", "script", "cleanup")

_VAR_RE = re.compile(r"#(\w+)")
# Python keywords and literals that may appear bare in an If/While condition and are not
# variable references — `while x < 10 and not done` must not demand a variable named `and`.
_CONDITION_WORDS = {
    "and", "or", "not", "in", "is", "if", "else", "True", "False", "None",
    "abs", "min", "max", "round", "len", "int", "float", "str", "bool",
}


def _issue(severity, where, message, hint=None, **extra):
    out = {"severity": severity, "where": where, "message": message}
    if hint:
        out["hint"] = hint
    out.update(extra)
    return out


def _block_instrument(block):
    return (block.get("instrument") or block.get("module") or "").strip()


def _block_method(block):
    return (block.get("action") or block.get("method") or "").strip()


def _block_params(block):
    params = block.get("args")
    if params is None:
        params = block.get("params")
    return params or {}


def _is_reference(value):
    return isinstance(value, str) and value.strip().startswith("#")


def _numeric_ok(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return True
    try:
        float(str(value).strip())
        return True
    except (TypeError, ValueError):
        return False


def _flatten_return_names(block):
    names = [n.strip() for n in str(block.get("return") or block.get("returnVar") or "").split(",")]
    names = [n for n in names if n]
    bindings = block.get("return_bindings") or block.get("returnBindings") or []
    for b in bindings:
        var = (b or {}).get("var")
        if var and var not in names:
            names.append(var)
    return names


def _check_params(where, entry, params, issues, known_vars, instrument, method):
    schema_params = (entry.get("parameters") or {})

    for name, info in schema_params.items():
        if not info.get("required", True):
            continue
        if "default" in info:
            continue
        value = params.get(name)
        if value is None or (isinstance(value, str) and value.strip() == ""):
            issues.append(_issue(
                "error", where,
                f"{instrument}.{method} needs a value for '{name}' ({info.get('type', 'Any')}).",
                hint="Give it a literal value, or '#name' to take it from an earlier step.",
            ))

    for name, value in params.items():
        if name.startswith("_"):
            continue
        info = schema_params.get(name)
        if info is None:
            issues.append(_issue(
                "error", where,
                f"{instrument}.{method} has no parameter '{name}'.",
                hint=("Parameters are: " + ", ".join(sorted(schema_params)) if schema_params
                      else "This method takes no parameters."),
            ))
            continue

        if _is_reference(value):
            ref = value.strip()[1:].strip()
            if not ref:
                issues.append(_issue("error", where, f"'{name}' is a bare '#' with no variable name."))
            elif ref not in known_vars:
                # Not an error: an optimization run supplies these per trial, and the Configure
                # page fills them from a spreadsheet. It is only wrong if nothing ever sets it,
                # which this function cannot know.
                issues.append(_issue(
                    "warning", where,
                    f"'{name}' reads #{ref}, which no earlier step produces.",
                    hint=("It must come from the optimizer, the spreadsheet, or a "
                          "User_Input step — otherwise the run stops here."),
                ))
            continue

        type_name = str(info.get("type", "")).lower()
        if ("int" in type_name or "float" in type_name) and not _numeric_ok(value):
            issues.append(_issue(
                "error", where,
                f"'{name}' expects a number ({info.get('type')}) but got {value!r}.",
                hint="Write the bare number, with no unit — 65, not '65 C'.",
            ))

        options = info.get("options")
        if options and not _is_reference(value):
            allowed = [str(o) for o in options]
            if str(value) not in allowed:
                issues.append(_issue(
                    "error", where,
                    f"'{name}' must be one of {allowed}, not {value!r}.",
                ))


def _check_returns(where, entry, block, issues, instrument, method):
    bindings = block.get("return_bindings") or block.get("returnBindings") or []
    if not bindings:
        return
    paths = {r["path"] for r in (entry.get("return_paths") or [])}
    numeric = {r["path"] for r in (entry.get("return_paths") or []) if r.get("numeric")}
    for binding in bindings:
        path = (binding or {}).get("path", "")
        var = (binding or {}).get("var")
        if not var:
            issues.append(_issue("error", where, f"A return binding on {instrument}.{method} has no variable name."))
            continue
        if paths and path not in paths:
            issues.append(_issue(
                "error", where,
                f"{instrument}.{method} has no result field '{path}'.",
                hint="Available fields: " + ", ".join(sorted(p or "(the result itself)" for p in paths)),
            ))
        elif path and path not in numeric:
            # Worth saying out loud: it is legal, and it is the single thing that quietly stops
            # an optimization run from having the objective the author thought they configured.
            issues.append(_issue(
                "info", where,
                f"'{var}' saves {instrument}.{method}'s '{path}', which is not a number.",
                hint="It can be passed to later steps but cannot be an optimization objective.",
            ))


def validate_body(body, schema, known_workflows=(), resolve_workflow=None):
    """Return a list of issues, most severe first. An empty list means the body is runnable.

    `schema` is the live instrument schema (`app.state.instrument_schemas`). `known_workflows`
    names the saved workflows a `Library Workflows` step may call, and `resolve_workflow` reads
    one's body by name — supply it and a link's arguments are checked too, not just its target.
    """
    issues = []
    body = body or {}

    if not any((body.get(phase) or []) for phase in PHASES):
        issues.append(_issue(
            "error", "body",
            "The workflow has no steps.",
            hint="Put the repeated part of the protocol in 'script'.",
        ))

    # Variables are only in scope after the step that produces them, and phases always run
    # prep -> script -> cleanup, so scope accumulates across them in that order.
    known_vars = set()
    flow_stack = []

    for phase in PHASES:
        blocks = body.get(phase) or []
        if not isinstance(blocks, list):
            issues.append(_issue("error", phase, f"'{phase}' must be a list of steps."))
            continue

        for index, block in enumerate(blocks):
            where = f"{phase}[{index}]"
            if not isinstance(block, dict):
                issues.append(_issue("error", where, "A step must be an object."))
                continue

            instrument = _block_instrument(block)
            method = _block_method(block)
            params = _block_params(block)

            if not instrument or not method:
                issues.append(_issue("error", where, "A step needs both an instrument and a method."))
                continue

            if instrument in (FLOW_CONTROL_INSTRUMENT, "Flow Control"):
                entry = FLOW_CONTROL_METHODS.get(method)
                if entry is None:
                    issues.append(_issue(
                        "error", where,
                        f"There is no flow-control block called '{method}'.",
                        hint="Available: " + ", ".join(sorted(FLOW_CONTROL_METHODS)),
                    ))
                    continue

                if method == "If":
                    flow_stack.append(("If", where))
                elif method == "While":
                    flow_stack.append(("While", where))
                elif method == "Else":
                    if not flow_stack or flow_stack[-1][0] != "If":
                        issues.append(_issue("error", where, "'Else' is not inside an 'If'."))
                elif method == "End_If":
                    if not flow_stack or flow_stack[-1][0] != "If":
                        issues.append(_issue("error", where, "'End_If' has no matching 'If'."))
                    else:
                        flow_stack.pop()
                elif method == "End_While":
                    if not flow_stack or flow_stack[-1][0] != "While":
                        issues.append(_issue("error", where, "'End_While' has no matching 'While'."))
                    else:
                        flow_stack.pop()

                _check_params(where, entry, params, issues, known_vars, instrument, method)

                if method == "User_Input":
                    var_name = str(params.get("variable_name") or "").strip()
                    if var_name:
                        known_vars.add(var_name)
                if method in ("If", "While"):
                    for ref in _VAR_RE.findall(str(params.get("condition") or "")):
                        if ref not in known_vars:
                            issues.append(_issue(
                                "warning", where,
                                f"The condition reads #{ref}, which no earlier step produces.",
                            ))
                    # A condition written as bare names (`temperature > 40`) is the documented
                    # form, so check those too rather than only the '#name' ones.
                    bare = set(re.findall(r"\b[A-Za-z_]\w*\b", str(params.get("condition") or "")))
                    for ref in sorted(bare - _CONDITION_WORDS - known_vars):
                        if f"#{ref}" not in str(params.get("condition") or ""):
                            issues.append(_issue(
                                "warning", where,
                                f"The condition mentions '{ref}', which no earlier step produces.",
                                hint="Conditions read variables by bare name, e.g. `yield_percent > 80`.",
                            ))
                continue

            if instrument == LIBRARY_INSTRUMENT:
                if known_workflows and method not in known_workflows:
                    issues.append(_issue(
                        "error", where,
                        f"There is no saved workflow called '{method}'.",
                        hint="Available: " + ", ".join(sorted(known_workflows)),
                    ))
                elif resolve_workflow is not None:
                    # A linked workflow is a call, and its open '#variables' are its arguments:
                    # the expander substitutes them from this step's args by name. Checking only
                    # that the target exists would leave the one error decomposition actually
                    # introduces — calling a sub-protocol without telling it the volume — to be
                    # discovered at run time instead of here.
                    try:
                        target = resolve_workflow(method)
                    except Exception:
                        target = None
                    if target:
                        needed = unbound_variables(target)
                        supplied = set(params) | known_vars
                        for var in needed:
                            if var not in supplied:
                                issues.append(_issue(
                                    "error", where,
                                    f"'{method}' needs a value for '{var}', which this step does not pass.",
                                    hint=(f"Add \"{var}\": <value> to this step's args, or '#{var}' "
                                          f"to take it from an earlier step."),
                                ))
                        extra = [k for k in params if k not in needed and not k.startswith("_")]
                        if extra and needed:
                            issues.append(_issue(
                                "warning", where,
                                f"'{method}' does not use: " + ", ".join(sorted(extra)) + ".",
                                hint="Its inputs are: " + ", ".join(needed) + ".",
                            ))
                known_vars.update(_flatten_return_names(block))
                continue

            instrument_schema = schema.get(instrument)
            if instrument_schema is None:
                issues.append(_issue(
                    "error", where,
                    f"There is no instrument called '{instrument}' on this deck.",
                    hint="Available: " + ", ".join(sorted(schema)),
                ))
                continue

            entry = instrument_schema.get(method)
            if entry is None:
                issues.append(_issue(
                    "error", where,
                    f"'{instrument}' has no method '{method}'.",
                    hint="Available: " + ", ".join(sorted(instrument_schema)),
                ))
                continue

            _check_params(where, entry, params, issues, known_vars, instrument, method)
            _check_returns(where, entry, block, issues, instrument, method)
            known_vars.update(_flatten_return_names(block))

    for kind, where in flow_stack:
        issues.append(_issue(
            "error", where,
            f"'{kind}' is never closed.",
            hint=f"Add an 'End_{kind}' step after the block it controls.",
        ))

    order = {"error": 0, "warning": 1, "info": 2}
    issues.sort(key=lambda i: order.get(i["severity"], 3))
    return issues


def summarise(issues):
    """A one-line verdict, for a model that has just been handed a list of issues."""
    errors = [i for i in issues if i["severity"] == "error"]
    warnings = [i for i in issues if i["severity"] == "warning"]
    if errors:
        return f"{len(errors)} error(s) must be fixed before this can run."
    if warnings:
        return f"No errors. {len(warnings)} warning(s) — check these are supplied at run time."
    return "Valid against the current deck."


def unbound_variables(body, schema=None):
    """The '#variables' a body reads that nothing inside it ever sets.

    These are not errors in a saved workflow — they are how it stays reusable: the Configure
    page fills them from a spreadsheet and an optimization run fills them per trial. They *are*
    errors for a plain one-shot run, which has nothing to fill them from, so a run request has
    to either supply them or be refused. Finding that out before dispatch rather than four
    steps into a reaction is the entire point.
    """
    known = set()
    unbound = []

    def note(name):
        if name and name not in known and name not in unbound:
            unbound.append(name)

    def walk(value):
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.startswith("#"):
                note(stripped[1:].strip())
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    for phase in PHASES:
        for block in (body or {}).get(phase) or []:
            if not isinstance(block, dict):
                continue
            params = _block_params(block)
            instrument = _block_instrument(block)
            method = _block_method(block)

            if instrument in (FLOW_CONTROL_INSTRUMENT, "Flow Control") and method in ("If", "While"):
                # A condition reads bare names rather than '#name', so those are checked too.
                condition = str(params.get("condition") or "")
                for ref in _VAR_RE.findall(condition):
                    note(ref)
                for ref in re.findall(r"\b[A-Za-z_]\w*\b", condition):
                    if ref not in _CONDITION_WORDS and f"#{ref}" not in condition:
                        note(ref)
            else:
                walk(params)

            if instrument in (FLOW_CONTROL_INSTRUMENT, "Flow Control") and method == "User_Input":
                var_name = str(params.get("variable_name") or "").strip()
                if var_name:
                    known.add(var_name)
            known.update(_flatten_return_names(block))

    return unbound
