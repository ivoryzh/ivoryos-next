"""The agent tool layer: what an assistant can see, and what it is stopped from doing.

Two things are being pinned down here. First, that `validate_body` catches the specific
mistakes a language model makes when translating a protocol — because that validation is the
only reason a proposal can be trusted enough to show a scientist. Second, that every write
path files a proposal instead of writing: an agent must not be able to save a workflow or
start hardware, no matter what it posts.
"""

import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge.agent.validate import validate_body, summarise
from ivoryos_edge.agent.deck import describe_deck, describe_method
from ivoryos_edge.server import app


def _schema():
    """A deck shaped like a real one: numbers, an enum, a structured return, a None return."""
    return {
        "pump": {
            "dispense": {
                "description": "Dispense a volume.\nSecond line ignored in summaries.",
                "parameters": {
                    "volume_ml": {"type": "float", "required": True},
                    "rate": {"type": "float", "required": False, "default": 2.0},
                },
                "return_type": "None",
                "return_paths": [],
            },
        },
        "reactor": {
            "set_temperature": {
                "description": "Set the setpoint.",
                "parameters": {"setpoint_c": {"type": "float", "required": True}},
                "return_type": "None",
                "return_paths": [],
            },
            "set_mode": {
                "description": "Pick a mode.",
                "parameters": {"mode": {"type": "Literal", "required": True,
                                        "options": ["fast", "slow", "eco"]}},
                "return_type": "None",
                "return_paths": [],
            },
        },
        "hplc": {
            "analyze": {
                "description": "Full peak table.",
                "parameters": {},
                "return_type": "Report",
                "return_paths": [
                    {"path": "composition.yield_percent", "type": "float", "numeric": True},
                    {"path": "method", "type": "str", "numeric": False},
                ],
            },
        },
    }


def _step(instrument, method, args=None, **extra):
    return {"instrument": instrument, "action": method, "args": args or {}, **extra}


def _body(script, prep=None, cleanup=None):
    return {"name": "t", "prep": prep or [], "script": script, "cleanup": cleanup or []}


def _errors(issues):
    return [i for i in issues if i["severity"] == "error"]


def test_a_correct_workflow_validates_clean():
    body = _body([
        _step("reactor", "set_temperature", {"setpoint_c": 65}),
        _step("pump", "dispense", {"volume_ml": 1.5}),
        _step("hplc", "analyze", {}, **{
            "return": "yld",
            "return_bindings": [{"path": "composition.yield_percent", "var": "yld"}],
        }),
    ])
    assert validate_body(body, _schema()) == []
    assert summarise([]) == "Valid against the current deck."


def test_invented_instrument_and_method_are_caught_with_the_real_options():
    body = _body([_step("centrifuge", "spin", {"rpm": 3000})])
    issues = validate_body(body, _schema())
    assert "no instrument called 'centrifuge'" in issues[0]["message"]
    # The alternatives matter as much as the rejection: this is what the agent reads to retry.
    assert "hplc" in issues[0]["hint"] and "pump" in issues[0]["hint"]

    issues = validate_body(_body([_step("pump", "aspirate", {})]), _schema())
    assert "no method 'aspirate'" in issues[0]["message"]
    assert "dispense" in issues[0]["hint"]


def test_missing_required_parameter_is_an_error_but_a_defaulted_one_is_not():
    issues = validate_body(_body([_step("pump", "dispense", {})]), _schema())
    assert len(_errors(issues)) == 1
    assert "needs a value for 'volume_ml'" in issues[0]["message"]
    # `rate` has a default, so leaving it out is correct, not an omission.
    assert validate_body(_body([_step("pump", "dispense", {"volume_ml": 1})]), _schema()) == []


def test_unknown_parameter_is_caught():
    issues = validate_body(_body([_step("pump", "dispense", {"volume_ml": 1, "speed": 3})]), _schema())
    assert "has no parameter 'speed'" in issues[0]["message"]


def test_a_number_written_with_its_unit_is_rejected():
    """The classic protocol-translation slip: prose says "hold at 65 C" and the model keeps the
    unit, which only fails later when cast_value tries float("65 C")."""
    issues = validate_body(_body([_step("reactor", "set_temperature", {"setpoint_c": "65 C"})]), _schema())
    assert "expects a number" in issues[0]["message"]
    assert "no unit" in issues[0]["hint"]
    # A numeric string is fine — that is what every form on the frontend submits.
    assert validate_body(_body([_step("reactor", "set_temperature", {"setpoint_c": "65"})]), _schema()) == []


def test_value_outside_an_enum_is_rejected():
    issues = validate_body(_body([_step("reactor", "set_mode", {"mode": "turbo"})]), _schema())
    assert "must be one of" in issues[0]["message"]
    assert validate_body(_body([_step("reactor", "set_mode", {"mode": "eco"})]), _schema()) == []


def test_variable_must_be_produced_by_an_earlier_step():
    # Referenced before anything sets it.
    issues = validate_body(_body([
        _step("reactor", "set_temperature", {"setpoint_c": "#target"}),
    ]), _schema())
    assert issues[0]["severity"] == "warning"
    assert "#target" in issues[0]["message"]

    # Produced first, then read: clean. Order is what matters, not mere presence.
    ok = validate_body(_body([
        _step("Flow_Control", "User_Input",
              {"prompt": "Target?", "variable_name": "target", "input_type": "float"}),
        _step("reactor", "set_temperature", {"setpoint_c": "#target"}),
    ]), _schema())
    assert ok == []

    # Same two steps the wrong way round is still a warning — scope is positional.
    reversed_issues = validate_body(_body([
        _step("reactor", "set_temperature", {"setpoint_c": "#target"}),
        _step("Flow_Control", "User_Input", {"prompt": "Target?", "variable_name": "target"}),
    ]), _schema())
    assert any(i["severity"] == "warning" for i in reversed_issues)


def test_a_saved_return_variable_comes_into_scope():
    body = _body([
        _step("hplc", "analyze", {}, **{
            "return": "yld",
            "return_bindings": [{"path": "composition.yield_percent", "var": "yld"}],
        }),
        _step("reactor", "set_temperature", {"setpoint_c": "#yld"}),
    ])
    assert validate_body(body, _schema()) == []


def test_scope_carries_across_phases_in_run_order():
    body = _body(
        prep=[_step("Flow_Control", "User_Input", {"prompt": "T?", "variable_name": "t"})],
        script=[_step("reactor", "set_temperature", {"setpoint_c": "#t"})],
    )
    assert validate_body(body, _schema()) == []


def test_unclosed_flow_control_is_caught():
    issues = validate_body(_body([
        _step("Flow_Control", "While", {"condition": "True"}),
        _step("pump", "dispense", {"volume_ml": 1}),
    ]), _schema())
    assert any("never closed" in i["message"] for i in _errors(issues))

    issues = validate_body(_body([_step("Flow_Control", "End_If", {})]), _schema())
    assert "no matching 'If'" in issues[0]["message"]

    issues = validate_body(_body([
        _step("Flow_Control", "If", {"condition": "True"}),
        _step("Flow_Control", "End_While", {}),
    ]), _schema())
    assert any("no matching 'While'" in i["message"] for i in _errors(issues))


def test_balanced_flow_control_is_clean():
    body = _body([
        _step("hplc", "analyze", {}, **{"return": "yld",
              "return_bindings": [{"path": "composition.yield_percent", "var": "yld"}]}),
        _step("Flow_Control", "If", {"condition": "yld > 80"}),
        _step("pump", "dispense", {"volume_ml": 1}),
        _step("Flow_Control", "Else", {}),
        _step("pump", "dispense", {"volume_ml": 2}),
        _step("Flow_Control", "End_If", {}),
    ])
    assert validate_body(body, _schema()) == []


def test_condition_naming_an_unknown_variable_warns():
    issues = validate_body(_body([
        _step("Flow_Control", "While", {"condition": "purity < 95"}),
        _step("Flow_Control", "End_While", {}),
    ]), _schema())
    assert any("purity" in i["message"] for i in issues if i["severity"] == "warning")


def test_return_binding_must_name_a_real_field():
    issues = validate_body(_body([
        _step("hplc", "analyze", {}, **{"return": "yld",
              "return_bindings": [{"path": "composition.yeild_percent", "var": "yld"}]}),
    ]), _schema())
    assert "no result field" in issues[0]["message"]
    assert "composition.yield_percent" in issues[0]["hint"]


def test_binding_an_objective_to_a_non_numeric_field_is_flagged_as_info():
    """Legal, and the one thing that silently leaves an optimization run without the objective
    its author thought they configured — so it is said out loud rather than passed over."""
    issues = validate_body(_body([
        _step("hplc", "analyze", {}, **{"return": "m",
              "return_bindings": [{"path": "method", "var": "m"}]}),
    ]), _schema())
    assert _errors(issues) == []
    assert issues[0]["severity"] == "info"
    assert "not a number" in issues[0]["message"]


def test_empty_workflow_and_link_to_unknown_workflow():
    assert "has no steps" in validate_body(_body([]), _schema())[0]["message"]

    issues = validate_body(
        _body([_step("Library Workflows", "nonexistent", {})]),
        _schema(), known_workflows=["Suzuki coupling screen"],
    )
    assert "no saved workflow called 'nonexistent'" in issues[0]["message"]


def test_errors_sort_before_warnings_and_info():
    issues = validate_body(_body([
        _step("reactor", "set_temperature", {"setpoint_c": "#unknown"}),
        _step("pump", "dispense", {}),
    ]), _schema())
    assert issues[0]["severity"] == "error"
    assert [i["severity"] for i in issues] == sorted(
        [i["severity"] for i in issues], key=lambda s: {"error": 0, "warning": 1, "info": 2}[s]
    )


def test_deck_summary_is_smaller_than_the_raw_schema_but_keeps_what_matters():
    import json
    schema = _schema()
    described = describe_deck(schema)
    assert len(json.dumps(described["instruments"])) < len(json.dumps(schema))
    analyze = described["instruments"]["hplc"]["analyze"]
    # A summary is one line, and the numeric results survive — that is what a model needs to
    # answer "which of these can I optimize?".
    assert analyze["summary"] == "Full peak table."
    assert analyze["numeric_results"] == ["composition.yield_percent"]
    # Flow control is described even though no driver declares it.
    assert "User_Input" in described["flow_control"]["methods"]
    assert "#name" in described["conventions"]["variable"]


def test_describe_method_marks_which_results_are_numeric():
    described = describe_method(_schema(), "hplc", "analyze")
    assert described["returns"] == [
        {"save_from": "composition.yield_percent", "type": "float", "numeric": True},
        {"save_from": "method", "type": "str", "numeric": False},
    ]
    assert describe_method(_schema(), "hplc", "nope") is None


@pytest.mark.asyncio
async def test_proposing_a_workflow_does_not_save_it(api_workflows_dir):
    """The core guarantee: an agent posting a perfectly valid workflow still changes nothing."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        body = {"name": "Agent Draft", "description": "from a protocol",
                "prep": [], "script": [{"instrument": "dummy", "action": "test_method",
                                        "args": {"duration": 0}}], "cleanup": []}
        resp = await ac.post("/api/agent/propose", json={
            "name": "Agent Draft", "body": body,
            "summary": "Translated the paragraph about heating.", "source": "test",
        })
        assert resp.status_code == 200, resp.text
        proposal = resp.json()
        assert proposal["status"] == "pending"
        assert proposal["kind"] == "workflow"

        # Nothing in the library yet.
        listed = (await ac.get("/api/workflows")).json()["workflows"]
        assert "Agent Draft" not in [w["name"] for w in listed]

        # It is waiting for a person.
        pending = (await ac.get("/api/agent/proposals")).json()["proposals"]
        assert proposal["id"] in [p["id"] for p in pending]

        # Accepting is what writes it, and it lands as a real version.
        accept = await ac.post(f"/api/agent/proposals/{proposal['id']}/accept", json={})
        assert accept.status_code == 200, accept.text
        assert accept.json()["version"] == 1

        listed = (await ac.get("/api/workflows")).json()["workflows"]
        assert "Agent Draft" in [w["name"] for w in listed]

        # And it cannot be accepted twice.
        again = await ac.post(f"/api/agent/proposals/{proposal['id']}/accept", json={})
        assert again.status_code == 409


@pytest.mark.asyncio
async def test_rejecting_a_proposal_leaves_the_library_untouched(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/agent/propose", json={
            "name": "Rejected Draft",
            "body": {"name": "Rejected Draft", "prep": [], "cleanup": [],
                     "script": [{"instrument": "dummy", "action": "test_method", "args": {"duration": 0}}]},
        })
        pid = resp.json()["id"]
        rejected = await ac.post(f"/api/agent/proposals/{pid}/reject", json={"note": "wrong solvent"})
        assert rejected.status_code == 200

        listed = (await ac.get("/api/workflows")).json()["workflows"]
        assert "Rejected Draft" not in [w["name"] for w in listed]
        assert (await ac.get(f"/api/agent/proposals/{pid}")).json()["decided_note"] == "wrong solvent"


@pytest.mark.asyncio
async def test_a_run_request_does_not_start_anything_until_accepted(api_workflows_dir):
    """An agent may ask for a run. It may not cause one."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        body = {"name": "Runnable", "prep": [], "cleanup": [],
                "script": [{"instrument": "dummy", "action": "test_method", "args": {"duration": 0}}]}
        await ac.post("/api/workflows/Runnable", json=body)

        before = len((await ac.get("/api/queue/runs")).json()["runs"])

        requested = await ac.post("/api/agent/request-run", json={
            "name": "Runnable", "summary": "ready to screen", "source": "test",
        })
        assert requested.status_code == 200, requested.text
        assert requested.json()["kind"] == "run"
        assert requested.json()["status"] == "pending"

        # Still nothing queued.
        assert len((await ac.get("/api/queue/runs")).json()["runs"]) == before

        accepted = await ac.post(f"/api/agent/proposals/{requested.json()['id']}/accept", json={})
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["run_id"]
        assert len((await ac.get("/api/queue/runs")).json()["runs"]) == before + 1


@pytest.mark.asyncio
async def test_a_run_cannot_be_requested_for_a_workflow_that_does_not_exist(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/agent/request-run", json={"name": "No Such Protocol"})
        assert resp.status_code == 404
        assert "Propose and accept it first" in resp.json()["hint"]


@pytest.mark.asyncio
async def test_validate_endpoint_reports_issues_without_storing_anything(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        before = len((await ac.get("/api/agent/proposals?status=all")).json()["proposals"])
        resp = await ac.post("/api/agent/validate", json={"body": {
            "name": "x", "prep": [], "cleanup": [],
            "script": [{"instrument": "nope", "action": "nope", "args": {}}],
        }})
        assert resp.status_code == 200
        assert resp.json()["ok"] is False
        assert "must be fixed" in resp.json()["summary"]
        after = len((await ac.get("/api/agent/proposals?status=all")).json()["proposals"])
        assert after == before


def test_unbound_variables_are_the_ones_nothing_inside_the_workflow_sets():
    from ivoryos_edge.agent.validate import unbound_variables

    # Read but never produced: the Configure page or the optimizer fills these, and a one-shot
    # run has neither.
    body = _body([
        _step("reactor", "set_temperature", {"setpoint_c": "#target"}),
        _step("pump", "dispense", {"volume_ml": "#dose"}),
    ])
    assert unbound_variables(body) == ["target", "dose"]

    # Produced by an earlier step, so not missing.
    body = _body([
        _step("Flow_Control", "User_Input", {"prompt": "T?", "variable_name": "target"}),
        _step("reactor", "set_temperature", {"setpoint_c": "#target"}),
    ])
    assert unbound_variables(body) == []

    body = _body([
        _step("hplc", "analyze", {}, **{"return": "yld",
              "return_bindings": [{"path": "composition.yield_percent", "var": "yld"}]}),
        _step("reactor", "set_temperature", {"setpoint_c": "#yld"}),
    ])
    assert unbound_variables(body) == []

    # A condition's bare names count too.
    body = _body([
        _step("Flow_Control", "While", {"condition": "purity < 95"}),
        _step("Flow_Control", "End_While", {}),
    ])
    assert unbound_variables(body) == ["purity"]


@pytest.mark.asyncio
async def test_a_run_request_is_refused_when_values_are_missing(api_workflows_dir):
    """A workflow with open values would stop partway through — after reagent is already in the
    vial. The request is refused up front rather than handing a person a doomed approval."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/workflows/Needs Values", json={
            "name": "Needs Values", "prep": [], "cleanup": [],
            "script": [{"instrument": "dummy", "action": "echo_method", "args": {"value": "#sample_id"}}],
        })

        refused = await ac.post("/api/agent/request-run", json={"name": "Needs Values"})
        assert refused.status_code == 400
        assert refused.json()["missing_variables"] == ["sample_id"]
        assert "Configure page" in refused.json()["hint"]

        # Nothing was filed, so nothing is sitting in the review queue either.
        pending = (await ac.get("/api/agent/proposals")).json()["proposals"]
        assert all(p["name"] != "Needs Values" for p in pending)

        # Supplying the value makes it requestable, and the value reaches the real step.
        ok = await ac.post("/api/agent/request-run", json={
            "name": "Needs Values", "variables": {"sample_id": "A1"},
        })
        assert ok.status_code == 200, ok.text
        accepted = await ac.post(f"/api/agent/proposals/{ok.json()['id']}/accept", json={})
        assert accepted.status_code == 200, accepted.text

        run = (await ac.get(f"/api/queue/runs/{accepted.json()['run_id']}")).json()
        assert run["steps"][0]["parameters"]["value"] == "A1"
        assert run["parameters"]["agent_variables"] == {"sample_id": "A1"}


@pytest.mark.asyncio
async def test_a_proposal_with_errors_is_refused_and_the_errors_come_back(api_workflows_dir):
    """The agent has everything it needs to fix these, so it is sent back rather than filed —
    a scientist's review queue is not where you discover a draft was never going to run."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        broken = {"name": "Broken", "prep": [], "cleanup": [], "script": [
            {"instrument": "dummy", "action": "no_such_method", "args": {}},
        ]}
        resp = await ac.post("/api/agent/propose", json={"name": "Broken", "body": broken})
        assert resp.status_code == 422
        payload = resp.json()
        assert payload["filed"] is False
        assert any("no method 'no_such_method'" in i["message"] for i in payload["issues"])
        assert "allow_invalid" in payload["hint"]

        # Nothing reached the review queue.
        pending = (await ac.get("/api/agent/proposals")).json()["proposals"]
        assert all(p["name"] != "Broken" for p in pending)

        # The escape hatch still exists, for an agent that has tried and wants a person to look.
        forced = await ac.post("/api/agent/propose", json={
            "name": "Broken", "body": broken, "allow_invalid": True,
            "summary": "Could not find a method for the centrifugation step.",
        })
        assert forced.status_code == 200
        assert forced.json()["status"] == "pending"
        assert "unresolved errors" in forced.json()["note"]


@pytest.mark.asyncio
async def test_warnings_alone_do_not_block_a_proposal(api_workflows_dir):
    """An unresolved #variable is how a reusable workflow is meant to look — the optimizer or
    the spreadsheet fills it. Refusing those would make the agent unable to write one."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/agent/propose", json={
            "name": "Reusable", "body": {"name": "Reusable", "prep": [], "cleanup": [], "script": [
                {"instrument": "dummy", "action": "echo_method", "args": {"value": "#sample_id"}},
            ]},
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["validation"]["ok"] is True
        assert any(i["severity"] == "warning" for i in resp.json()["issues"])


def test_a_linked_workflow_is_checked_for_the_arguments_it_needs():
    """Decomposing a protocol into small reusable workflows only reduces mistakes if calling one
    is checked like calling a method. Its open '#variables' are its parameters — the expander
    substitutes them from the calling step's args by name."""
    charge = _body([
        _step("pump", "dispense", {"volume_ml": "#volume_ml"}),
        _step("reactor", "set_temperature", {"setpoint_c": "#temperature"}),
    ])
    resolve = lambda name: charge if name == "Charge vial" else None

    # Called with nothing: both inputs are reported, by name.
    caller = _body([_step("Library Workflows", "Charge vial", {})])
    issues = validate_body(caller, _schema(), ["Charge vial"], resolve)
    messages = [i["message"] for i in _errors(issues)]
    assert any("needs a value for 'volume_ml'" in m for m in messages)
    assert any("needs a value for 'temperature'" in m for m in messages)

    # Called with both: clean.
    caller = _body([_step("Library Workflows", "Charge vial",
                          {"volume_ml": 1.5, "temperature": 65})])
    assert validate_body(caller, _schema(), ["Charge vial"], resolve) == []

    # One from an earlier step's output is fine too — scope carries into the call.
    caller = _body([
        _step("hplc", "analyze", {}, **{"return": "temperature",
              "return_bindings": [{"path": "composition.yield_percent", "var": "temperature"}]}),
        _step("Library Workflows", "Charge vial", {"volume_ml": 1.5}),
    ])
    assert validate_body(caller, _schema(), ["Charge vial"], resolve) == []

    # An argument the sub-workflow does not take is a warning, not an error — harmless, but
    # almost always a sign the caller meant a different name.
    caller = _body([_step("Library Workflows", "Charge vial",
                          {"volume_ml": 1.5, "temperature": 65, "sovlent": "dioxane"})])
    issues = validate_body(caller, _schema(), ["Charge vial"], resolve)
    assert _errors(issues) == []
    assert any("does not use: sovlent" in i["message"] for i in issues)


def test_link_arguments_are_only_checked_when_the_body_can_be_read():
    """Without a resolver the old behaviour stands — existence only. The Designer's own
    client-side checks do not have the sub-workflow bodies to hand, so this has to degrade
    rather than invent errors."""
    caller = _body([_step("Library Workflows", "Charge vial", {})])
    assert validate_body(caller, _schema(), ["Charge vial"]) == []


def test_variadic_parameters_are_excluded_by_kind_not_by_name():
    """A variadic is never required — that is what * and ** mean — and it is not an argument a
    caller can name, so it is not a parameter at all. `required` is "has no default", and a
    variadic has no default to have, so it used to read as required and a form offered to fill
    it; filling it raises TypeError for * and lands a junk key for **.

    Deliberately spelled *positions / **options: an implementation that filtered on the names
    "args" and "kwargs" would pass the conventional case and fail here.
    """
    from ivoryos_edge.introspection import inspect_device_module

    class Device:
        def move(self, speed: float, *positions, **options): ...
        def conventional(self, speed: float, *args, **kwargs): ...
        def passthrough(self, *whatever, **rest): ...
        def plain(self, x: int): ...

    schema = inspect_device_module(Device())

    assert list(schema["move"]["parameters"]) == ["speed"]
    assert list(schema["conventional"]["parameters"]) == ["speed"]
    # A driver that wraps everything in ** shows no parameters, and calling it with none is
    # exactly what works.
    assert schema["passthrough"]["parameters"] == {}

    assert schema["move"]["accepts_kwargs"] is True
    assert schema["passthrough"]["accepts_kwargs"] is True
    assert schema["plain"]["accepts_kwargs"] is False

    # *-only takes no keywords at all, so it must not claim to.
    class StarOnly:
        def only_positional(self, *positions): ...

    assert inspect_device_module(StarOnly())["only_positional"]["accepts_kwargs"] is False


def test_a_kwargs_method_accepts_arguments_the_schema_cannot_list():
    """The flip side of dropping **kwargs from the schema: arguments outside the listed ones
    are real and get forwarded, so they must not be reported as typos."""
    schema = {
        "dev": {
            "flexible": {"description": "", "parameters": {"x": {"type": "int", "required": True}},
                         "accepts_kwargs": True, "return_type": "None", "return_paths": []},
            "strict": {"description": "", "parameters": {"x": {"type": "int", "required": True}},
                       "accepts_kwargs": False, "return_type": "None", "return_paths": []},
        }
    }
    assert validate_body(_body([_step("dev", "flexible", {"x": 1, "anything": "goes"})]), schema) == []

    issues = validate_body(_body([_step("dev", "strict", {"x": 1, "anything": "goes"})]), schema)
    assert any("has no parameter 'anything'" in i["message"] for i in _errors(issues))


def test_a_parameter_with_a_default_is_not_required():
    """The rule both the client and this validator now use: `required` is precisely "has no
    default", so a defaulted parameter left out is how you ask for the default."""
    schema = {
        "pump": {
            "dispense": {
                "description": "",
                "parameters": {
                    "volume_ml": {"type": "float", "required": True},
                    "flow_rate_ml_min": {"type": "float", "required": False, "default": 2.0},
                },
                "return_type": "None", "return_paths": [],
            }
        }
    }
    assert validate_body(_body([_step("pump", "dispense", {"volume_ml": 1.0})]), schema) == []
    issues = validate_body(_body([_step("pump", "dispense", {})]), schema)
    assert len(_errors(issues)) == 1
    assert "volume_ml" in issues[0]["message"]
