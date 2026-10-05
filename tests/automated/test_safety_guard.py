"""The safety guard: limits, trays and rules kept outside the drivers (ivoryos_edge/safety.py).

What matters is that every door to an instrument goes past it -- a run refused before it starts,
a step refused as it is about to be sent, a call made by hand -- and that it fails closed.
"""

import asyncio
import os
from typing import Literal

import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge import safety
from ivoryos_edge.safety import Deck, check_value, empty_config, guard, row_label, tray_grid, validate
from ivoryos_edge.server import app, queue_manager


def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture(autouse=True)
def fresh_guard():
    """Each test starts with no configuration, nothing remembered and the queue going."""
    def reset():
        if os.path.exists(guard.path):
            os.remove(guard.path)
        if os.path.exists(guard.state_path):
            os.remove(guard.state_path)
        guard.load()
        guard.state.clear()
        guard.last_values.clear()
        guard.last_actions.clear()
        guard.blocked.clear()
        queue_manager.resume()
    reset()
    yield
    reset()


async def until(predicate, tries=100, delay=0.05):
    for _ in range(tries):
        if predicate():
            return True
        await asyncio.sleep(delay)
    return False


def step(method, **params):
    return {"instrument": "dummy", "method": method, "params": params}


async def save(ac, **config):
    response = await ac.put("/api/safety", json={**empty_config(), **config})
    assert response.status_code == 200, response.text
    return response.json()


async def run_status(ac, run_id):
    return (await ac.get(f"/api/queue/runs/{run_id}")).json()


async def finished(ac, run_id):
    for _ in range(100):
        run = await run_status(ac, run_id)
        if run["status"] in ("completed", "error", "cancelled"):
            return run
        await asyncio.sleep(0.05)
    return run


DURATION_MAX_2 = {"target": "dummy", "method": "test_method", "param": "duration", "max": 2}


# --- Trays ------------------------------------------------------------------------------------

def test_tray_positions_follow_the_naming_scheme():
    tray = {"rows": 2, "columns": 3, "naming": "A1", "order": "row"}
    assert tray_grid(tray) == [["A1", "A2", "A3"], ["B1", "B2", "B3"]]
    assert tray_grid({**tray, "naming": "A01"})[1] == ["B01", "B02", "B03"]
    assert tray_grid({**tray, "naming": "1"}) == [["1", "2", "3"], ["4", "5", "6"]]
    # Counted down each column instead: the same tray, numbered the other way.
    assert tray_grid({**tray, "naming": "1", "order": "column"}) == [["1", "3", "5"], ["2", "4", "6"]]
    assert tray_grid({**tray, "naming": "0"})[0] == ["0", "1", "2"]
    assert [row_label(i) for i in (0, 25, 26, 31)] == ["A", "Z", "AA", "AF"]


def test_a_tray_field_takes_only_its_positions():
    trays = {"rack": {"label": "Vial rack", "rows": 2, "columns": 3, "naming": "A1", "order": "row", "blocked": ["B3"]}}
    limit = {"tray": "rack"}
    assert check_value(limit, "A2", trays) == []
    assert "is not a position on Vial rack (2 x 3, A1 to B3)" in check_value(limit, "A7", trays)[0][1]
    # Strict on purpose: a driver that wants 'A1' may not accept 'a1'.
    assert check_value(limit, "a1", trays)
    assert "blocked" in check_value(limit, "B3", trays)[0][1]
    # A list of wells is checked one by one, and a '#name' is left for the run to check.
    assert [shown for shown, _ in check_value(limit, ["A1", "C1", "A3"], trays)] == ["'C1'"]
    assert check_value(limit, "#well", trays) == []
    numbered = {"plate": {"rows": 2, "columns": 2, "naming": "1", "order": "row", "blocked": []}}
    assert check_value({"tray": "plate"}, 4, numbered) == []
    assert check_value({"tray": "plate"}, 5, numbered)


def test_a_number_limit_refuses_what_is_not_a_number():
    assert check_value({"min": 0, "max": 10}, "5", {}) == []
    assert "above the maximum of 10" in check_value({"max": 10}, 10.5, {})[0][1]
    assert "below the minimum of 0" in check_value({"min": 0}, "-1", {})[0][1]
    assert "not a number" in check_value({"max": 10}, "ten", {})[0][1]
    # NaN compares false against every bound, so it would otherwise pass any limit.
    assert "not a number" in check_value({"max": 10}, float("nan"), {})[0][1]
    assert "not allowed" in check_value({"allowed": ["rack", "reactor"]}, "waste", {})[0][1]


# --- Configuration ------------------------------------------------------------------------------

def test_a_bad_configuration_says_what_is_wrong():
    _, problems = validate({
        "trays": {"rack": {"rows": 2, "columns": 3, "blocked": ["Z9"]}, "huge": {"rows": 0, "columns": 3}},
        "limits": [
            {"target": "dummy", "method": "test_method", "param": "duration", "min": 5, "max": 1},
            {"target": "dummy", "method": "echo_method", "param": "value", "tray": "nowhere"},
            {"target": "dummy", "method": "echo_method", "param": "value"},
        ],
        "rules": [
            {"name": "No condition", "when": {"target": "dummy", "method": "echo_method"}},
            {"name": "Any method", "when": {"target": "dummy", "method": "*"},
             "require": [{"left": {"arg": "value"}, "op": "==", "right": {"value": 1}}]},
        ],
    })
    text = " ".join(p["message"] for p in problems if p["level"] == "error")
    for expected in ("blocks 'Z9'", "rows and columns between 1", "minimum (5) is above the maximum (1)",
                     "tray 'nowhere', which is not defined", "sets nothing", "at least one condition",
                     "has to name one method"):
        assert expected in text, expected


def test_a_limit_for_something_not_on_this_deck_is_a_warning_not_an_error():
    deck = Deck(app.state.instruments, app.state.instrument_schemas)
    _, problems = validate({"limits": [
        {"target": "pump_9", "method": "dispense", "param": "volume_ml", "max": 5},
        {"target": "dummy", "method": "test_method", "param": "no_such_field", "max": 5},
        {"target": "dummy", "method": "echo_method", "param": "value", "max": 5},
    ]}, deck)
    assert [p["level"] for p in problems] == ["warning", "warning", "warning"]
    assert "does nothing yet" in problems[0]["message"]
    assert "no field 'no_such_field'" in problems[1]["message"]
    assert "may never be satisfied" in problems[2]["message"]


def test_a_class_limit_covers_its_instruments_and_an_instruments_own_limit_wins():
    deck = Deck(app.state.instruments, app.state.instrument_schemas)
    config, _ = validate({"limits": [
        {"target": "class:DummyInstrument", "method": "test_method", "param": "duration", "max": 9},
        {"target": "class:DummyInstrument", "method": "echo_method", "param": "value", "allowed": ["a"]},
        DURATION_MAX_2,
    ]}, deck)
    fields = safety.resolve_fields(config, deck)["dummy"]
    assert fields["test_method"]["duration"]["max"] == 2
    assert fields["test_method"]["duration"]["source"] == "dummy"
    assert fields["echo_method"]["value"]["source"] == "class:DummyInstrument"


@pytest.mark.asyncio
async def test_saving_refuses_errors_and_status_carries_the_limits_and_grids():
    async with client() as ac:
        bad = await ac.put("/api/safety", json={"limits": [{**DURATION_MAX_2, "min": 5}]})
        assert bad.status_code == 400 and "above the maximum" in bad.json()["error"]

        await save(ac, trays={"rack": {"rows": 2, "columns": 2}},
                   limits=[DURATION_MAX_2, {"target": "dummy", "method": "echo_method", "param": "value", "tray": "rack"}])
        view = (await ac.get("/api/status")).json()["safety"]
        assert view["enabled"] is True
        assert view["fields"]["dummy"]["test_method"]["duration"]["max"] == 2
        assert view["trays"]["rack"]["grid"] == [["A1", "A2"], ["B1", "B2"]]

        # A draft is laid out without being saved.
        draft = (await ac.post("/api/safety/check", json={"trays": {"plate": {"rows": 1, "columns": 2, "naming": "1"}}})).json()
        assert draft["resolved"]["trays"]["plate"]["grid"] == [["1", "2"]]
        assert "plate" not in (await ac.get("/api/safety")).json()["config"]["trays"]


# --- Before a run starts ------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_run_with_a_value_over_a_limit_is_refused_before_anything_moves():
    async with client() as ac:
        await save(ac, limits=[DURATION_MAX_2])
        instrument = app.state.instruments["dummy"]
        before = instrument.counter
        refused = await ac.post("/api/queue/runs", json={"name": "Too long", "sequence": [
            step("counting_method"), step("test_method", duration=5),
        ]})
        assert refused.status_code == 400
        message = refused.json()["error"]
        assert "dummy.test_method: duration = 5 is above the maximum of 2" in message
        assert message.endswith("Nothing was run.")
        assert instrument.counter == before, "the step before the bad one must not have run"
        assert (await ac.get("/api/safety")).json()["blocked"][-1]["source"] == "start"

        allowed = await ac.post("/api/queue/runs", json={"name": "Fine", "sequence": [step("test_method", duration=0)]})
        assert (await finished(ac, allowed.json()["run_id"]))["status"] == "completed"


@pytest.mark.asyncio
async def test_an_omitted_argument_is_checked_at_the_drivers_default():
    async with client() as ac:
        await save(ac, limits=[{"target": "dummy", "method": "test_method", "param": "duration", "min": 1}])
        refused = await ac.post("/api/queue/runs", json={"name": "Default", "sequence": [step("test_method")]})
        assert refused.status_code == 400
        assert "duration = 0 is below the minimum of 1" in refused.json()["error"]


@pytest.mark.asyncio
async def test_an_optimization_may_not_search_past_a_limit():
    async with client() as ac:
        await save(ac, limits=[DURATION_MAX_2])
        def body(high):
            return {"name": "Search", "parameters": {
                "type": "Optimization", "optimizer": "ax", "budget": 2,
                "parameter_space": [{"name": "d", "type": "range", "bounds": [0, high], "value_type": "float"}],
                "objective_config": [], "sequence_template": [step("test_method", duration="#d")],
            }}
        refused = await ac.post("/api/queue/runs", json=body(10))
        assert refused.status_code == 400
        assert "search range for 'd' reaches 10" in refused.json()["error"]


# --- As a step is about to be sent --------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_value_a_run_only_learns_on_the_way_is_stopped_at_its_step():
    async with client() as ac:
        await save(ac, limits=[DURATION_MAX_2])
        instrument = app.state.instruments["dummy"]
        instrument.counter = 6
        run_id = (await ac.post("/api/queue/runs", json={"name": "Learns late", "sequence": [
            {**step("counting_method"), "returnVar": "n"},   # 7
            step("test_method", duration="#n"),
            step("echo_method", value="after"),
        ]})).json()["run_id"]
        # A blocked step is a failed step: the run waits for a person.
        assert await until(lambda: queue_manager.awaiting_decision == run_id)
        steps = (await run_status(ac, run_id))["steps"]
        assert steps[1]["status"] == "error"
        assert steps[1]["error"].startswith("Blocked by the safety guard: dummy.test_method: duration = 7")
        assert "Traceback" not in steps[1]["error"]
        assert steps[2]["status"] == "pending", "nothing after the blocked step ran"
        blocked = (await ac.get("/api/safety")).json()["blocked"]
        assert blocked[-1]["method"] == "test_method" and blocked[-1]["source"] == "run"

        await ac.post(f"/api/queue/runs/{run_id}/resolve", json={"action": "stop"})
        assert await until(lambda: queue_manager.active_run_id is None)


@pytest.mark.asyncio
async def test_a_call_made_by_hand_goes_past_the_guard_too():
    async with client() as ac:
        await save(ac, limits=[DURATION_MAX_2])
        refused = await ac.post("/api/execute", json={"module": "dummy", "method": "test_method", "args": {"duration": 3}})
        assert refused.status_code == 409
        assert refused.json()["blocked_by"] == "safety"
        assert "duration = 3 is above the maximum of 2" in refused.json()["error"]
        allowed = await ac.post("/api/execute", json={"module": "dummy", "method": "test_method", "args": {"duration": 0}})
        assert allowed.status_code == 200 and allowed.json()["status"] == "started"


@pytest.mark.asyncio
async def test_switched_off_it_lets_everything_through():
    async with client() as ac:
        await save(ac, enabled=False, limits=[DURATION_MAX_2])
        run = await ac.post("/api/queue/runs", json={"name": "Unguarded", "sequence": [step("echo_method", value="x")]})
        assert run.status_code == 200
        assert guard.check_params("dummy", "test_method", {"duration": 50}) == []
        await finished(ac, run.json()["run_id"])


@pytest.mark.asyncio
async def test_a_file_that_cannot_be_read_blocks_everything_until_it_is_replaced():
    async with client() as ac:
        with open(guard.path, "w") as handle:
            handle.write("{ not json")
        guard.load()
        assert guard.load_error
        refused = await ac.post("/api/execute", json={"module": "dummy", "method": "echo_method", "args": {"value": "x"}})
        assert refused.status_code == 409 and "could not be read" in refused.json()["error"]
        run = await ac.post("/api/queue/runs", json={"name": "Blocked", "sequence": [step("echo_method", value="x")]})
        assert run.status_code == 400 and "could not be read" in run.json()["error"]

        await save(ac)
        assert guard.load_error is None
        again = await ac.post("/api/execute", json={"module": "dummy", "method": "echo_method", "args": {"value": "x"}})
        assert again.status_code == 200


# --- Rules --------------------------------------------------------------------------------------

async def execute(ac, method, **args):
    return await ac.post("/api/execute", json={"module": "dummy", "method": method, "args": args})


async def set_flow(ac, value):
    assert (await execute(ac, "flow_rate_(setter)", value=value)).status_code == 200
    instrument = app.state.instruments["dummy"]
    assert await until(lambda: instrument.flow_rate == value)


@pytest.mark.asyncio
async def test_a_rule_reads_the_deck_at_the_moment_of_the_call():
    async with client() as ac:
        await save(ac, rules=[{
            "name": "Slow flow before echo", "message": "Lower the flow rate first.",
            "when": {"target": "class:DummyInstrument", "method": "echo_method"},
            "require": [{"left": {"read": "dummy.flow_rate"}, "op": "<=", "right": {"value": 5}}],
        }])
        await set_flow(ac, 10.0)
        refused = await execute(ac, "echo_method", value="x")
        assert refused.status_code == 409
        assert refused.json()["problems"] == ["Lower the flow rate first (dummy.flow_rate is 10, must be at most 5)."]
        # The rule names echo_method only: other calls on the same instrument are not its business.
        assert (await execute(ac, "counting_method")).status_code == 200

        await set_flow(ac, 2.0)
        assert (await execute(ac, "echo_method", value="x")).status_code == 200


@pytest.mark.asyncio
async def test_a_rule_applies_only_when_its_if_holds_and_can_compare_two_things():
    async with client() as ac:
        await save(ac, rules=[{
            "name": "Long waits need a slow flow",
            "when": {"target": "dummy", "method": "test_method"},
            "if": [{"left": {"arg": "duration"}, "op": ">", "right": {"value": 0}}],
            # The right side is a reading too: the argument against the live value.
            "require": [{"left": {"arg": "duration"}, "op": "<=", "right": {"read": "dummy.flow_rate"}}],
        }])
        await set_flow(ac, 0.0)
        assert (await execute(ac, "test_method", duration=0)).status_code == 200, "if not met: rule does not apply"
        refused = await execute(ac, "test_method", duration=1)
        assert refused.status_code == 409
        assert "duration is 1, must be at most dummy.flow_rate (0)" in refused.json()["error"]


@pytest.mark.asyncio
async def test_a_rule_on_the_last_value_sent_blocks_until_it_is_known():
    async with client() as ac:
        await save(ac, rules=[{
            "name": "Flow must have been set to 2",
            "when": {"target": "dummy", "method": "echo_method"},
            "require": [
                {"left": {"last": "dummy.flow_rate_(setter).value"}, "op": "==", "right": {"value": 2}},
                {"left": {"last": "dummy"}, "op": "in", "right": {"value": "flow_rate_(setter), echo_method"}},
            ],
        }])
        unknown = await execute(ac, "echo_method", value="x")
        assert unknown.status_code == 409 and "has not been sent since the edge started" in unknown.json()["error"]
        await set_flow(ac, 2)
        assert (await execute(ac, "echo_method", value="x")).status_code == 200
        # Another action in between: the last action on the instrument is no longer an allowed one.
        assert (await execute(ac, "counting_method")).status_code == 200
        refused = await execute(ac, "echo_method", value="x")
        assert refused.status_code == 409 and "the last action on dummy is 'counting_method'" in refused.json()["error"]


def test_a_rule_that_reads_by_calling_an_action_is_warned_about():
    """A reading is called every time its rule is checked, so a method not named like one
    (`pump.prime`) is saved with a warning rather than quietly primed before every dispense."""
    deck = Deck(app.state.instruments, app.state.instrument_schemas)
    def problems_for(read):
        return validate({"rules": [{
            "name": "R", "when": {"target": "dummy", "method": "echo_method"},
            "require": [{"left": {"read": read}, "op": "==", "right": {"value": 1}}],
        }]}, deck)[1]
    assert problems_for("dummy.flow_rate") == [], "a property getter is a reading"
    warned = problems_for("dummy.counting_method")
    assert [p["level"] for p in warned] == ["warning"]
    assert "by calling it every time the rule is checked" in warned[0]["message"]
    # One that needs arguments cannot be read at all.
    assert problems_for("dummy.flow_rate_(setter)")[0]["level"] == "error"


@pytest.mark.asyncio
async def test_a_reading_that_fails_blocks_rather_than_passes():
    async with client() as ac:
        await save(ac, rules=[{
            "name": "Depends on a broken reading",
            "when": {"target": "dummy", "method": "echo_method"},
            "require": [{"left": {"read": "dummy.fail_method"}, "op": "==", "right": {"value": 1}}],
        }])
        refused = await execute(ac, "echo_method", value="x")
        assert refused.status_code == 409
        assert "dummy.fail_method is unknown: reading it failed" in refused.json()["error"]


# --- The agent ----------------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_the_agent_is_told_about_a_limit_it_breaks():
    async with client() as ac:
        await save(ac, limits=[DURATION_MAX_2])
        body = {"prep": [], "cleanup": [], "script": [{"instrument": "dummy", "action": "test_method", "args": {"duration": 30}}]}
        verdict = (await ac.post("/api/agent/validate", json={"body": body})).json()
        assert verdict["ok"] is False
        assert any("above the maximum of 2" in issue["message"] for issue in verdict["issues"])
        described = (await ac.get("/api/agent/deck/dummy/test_method")).json()
        assert described["limits"]["duration"]["max"] == 2


# --- Deck states --------------------------------------------------------------------------------

async def execute_and_wait(ac, method, **args):
    """A call by hand, waited for: a state changes when the call ends, not when it is sent."""
    started = await execute(ac, method, **args)
    assert started.status_code == 200, started.text
    task_id = started.json()["task_id"]
    for _ in range(100):
        done = (await ac.get(f"/api/execute/{task_id}")).json()
        if done.get("status") in ("completed", "error"):
            return done
        await asyncio.sleep(0.02)
    return done


async def states_now(ac):
    return (await ac.get("/api/safety/state")).json()["states"]


# The dummy's echo stands in for a door: echo_method("open") / echo_method("closed").
DOOR = {"label": "Door", "values": ["open", "closed"], "set_by": [
    {"target": "dummy", "method": "echo_method", "value": {"arg": "value"}},
]}
NEEDS_OPEN_DOOR = {
    "name": "Door open first", "message": "Open the door first.",
    "when": {"target": "dummy", "method": "test_method"},
    "require": [{"left": {"state": "door"}, "op": "==", "right": {"value": "open"}}],
}


@pytest.mark.asyncio
async def test_a_state_is_set_by_the_calls_that_change_it_and_a_rule_reads_it():
    async with client() as ac:
        await save(ac, states={"door": DOOR}, rules=[NEEDS_OPEN_DOOR])
        # Nothing has set it yet: not known, so it blocks.
        unknown = await execute(ac, "test_method", duration=0)
        assert unknown.status_code == 409
        assert "Door is unknown: nothing has set it yet" in unknown.json()["error"]

        await execute_and_wait(ac, "echo_method", value="closed")
        closed = await execute(ac, "test_method", duration=0)
        assert closed.json()["problems"] == ["Open the door first (Door is 'closed', must be 'open')."]

        await execute_and_wait(ac, "echo_method", value="open")
        assert (await execute(ac, "test_method", duration=0)).status_code == 200
        now = (await states_now(ac))["door"]
        assert now["value"] == "open" and now["by"] == "dummy.echo_method" and now["source"] == "tracked"


@pytest.mark.asyncio
async def test_a_state_set_inside_a_run_holds_for_the_next_step():
    async with client() as ac:
        await save(ac, states={"door": DOOR}, rules=[NEEDS_OPEN_DOOR])
        run_id = (await ac.post("/api/queue/runs", json={"name": "Open then go", "sequence": [
            step("echo_method", value="open"), step("test_method", duration=0),
        ]})).json()["run_id"]
        assert (await finished(ac, run_id))["status"] == "completed"


@pytest.mark.asyncio
async def test_a_tracked_state_survives_a_restart_and_a_person_can_settle_one():
    async with client() as ac:
        await save(ac, states={"door": DOOR})
        await execute_and_wait(ac, "echo_method", value="open")
        # A new process reads the same files: the door is still open.
        restarted = safety.Guard(guard.path, guard.state_path)
        assert restarted.state["door"]["value"] == "open"

        assert (await ac.post("/api/safety/state", json={"name": "door", "value": "ajar"})).status_code == 400
        settled = (await ac.post("/api/safety/state", json={"name": "door", "value": "closed"})).json()["states"]["door"]
        assert settled["value"] == "closed" and settled["by"] == "a person"
        cleared = (await ac.post("/api/safety/state", json={"name": "door", "value": None})).json()["states"]["door"]
        assert "unknown" in cleared


@pytest.mark.asyncio
async def test_a_call_that_does_not_finish_leaves_what_it_sets_unknown():
    async with client() as ac:
        await save(ac, states={
            "armed": {"values": ["yes", "no"], "set_by": [{"target": "dummy", "method": "fail_method", "value": "yes"}]},
            "count": {"set_by": [{"target": "dummy", "method": "counting_method", "value": {"result": ""}}]},
        })
        guard.set_state_by_hand("armed", "no")
        assert (await execute_and_wait(ac, "fail_method"))["status"] == "error"
        now = await states_now(ac)
        assert "dummy.fail_method did not finish" in now["armed"]["unknown"]
        # A value can also be what the method returned.
        result = (await execute_and_wait(ac, "counting_method"))["result"]
        assert (await states_now(ac))["count"]["value"] == result


@pytest.mark.asyncio
async def test_a_state_read_from_its_instrument_is_asked_every_time_and_never_stored():
    async with client() as ac:
        await save(ac, states={"flow": {"values": ["stopped", "flowing"], "read": {
            "read": "dummy.flow_rate", "map": {"0.0": "stopped", "3.0": "flowing"}}}},
            rules=[{"name": "Only while stopped", "when": {"target": "dummy", "method": "echo_method"},
                    "require": [{"left": {"state": "flow"}, "op": "==", "right": {"value": "stopped"}}]}])
        await set_flow(ac, 3.0)
        refused = await execute(ac, "echo_method", value="x")
        assert refused.status_code == 409 and "flow is 'flowing', must be 'stopped'" in refused.json()["error"]
        await set_flow(ac, 0.0)
        assert (await execute(ac, "echo_method", value="x")).status_code == 200
        assert (await states_now(ac))["flow"] == {"source": "reading", "value": "stopped"}
        assert "flow" not in guard.state
        assert (await ac.post("/api/safety/state", json={"name": "flow", "value": "stopped"})).status_code == 400


def test_a_state_is_checked_like_the_rest_of_the_configuration():
    _, problems = validate({
        "states": {
            "door": {"values": ["open", "closed"], "set_by": [
                {"target": "dummy", "method": "echo_method", "value": "ajar"},
                {"target": "dummy", "method": "echo_method"},
            ]},
            "lid": {"values": "on, off", "read": {"read": "dummy.flow_rate", "map": {"1": "sideways"}}},
        },
        "rules": [{"name": "R", "when": {"target": "dummy", "method": "echo_method"},
                   "require": [{"left": {"state": "hatch"}, "op": "==", "right": {"value": "open"}}]}],
    })
    text = " ".join(p["message"] for p in problems if p["level"] == "error")
    for expected in ("gives 'ajar', which is not one of its values", "say what dummy.echo_method sets it to",
                     "gives 'sideways'", "uses the state 'hatch', which is not defined"):
        assert expected in text, expected


def test_method_names_that_come_in_pairs_suggest_a_state():
    entry = {"parameters": {}}
    deck = Deck({}, {"balance": {"open_door": entry, "close_door": entry, "weigh": entry},
                     "pump": {"start": entry, "stop": entry}})
    suggested = {s["name"]: s["state"] for s in safety.suggest_states(deck, empty_config())}
    assert suggested["balance_door"]["values"] == ["open", "closed"]
    assert suggested["balance_door"]["set_by"][1] == {"target": "balance", "method": "close_door", "value": "closed"}
    assert suggested["pump"]["values"] == ["running", "stopped"]
    # A pair a state already uses is not offered again.
    config, _ = validate({"states": {"door": suggested["balance_door"]}}, deck)
    assert [s["name"] for s in safety.suggest_states(deck, config)] == ["pump"]


# --- Plain words to a draft ---------------------------------------------------------------------

class ScriptedModel:
    name = "scripted"
    model = "scripted-1"

    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    async def complete(self, system, messages, json_mode=False):
        self.calls.append(messages)
        return self.replies.pop(0)


@pytest.mark.asyncio
async def test_a_sentence_becomes_a_draft_and_the_model_is_told_what_it_got_wrong(monkeypatch):
    import json
    from ivoryos_edge.agent import routes

    wrong = {"summary": "first try", "add": {"rules": [{
        "name": "Door open first", "when": {"target": "dummy", "method": "test_method"},
        "require": [{"left": {"state": "door"}, "op": "==", "right": {"value": "open"}}]}]}}
    right = {"summary": "Blocks test_method unless the door is open.",
             "add": {"states": {"door": DOOR}, "rules": wrong["add"]["rules"]}, "questions": ["Which door?"]}
    model = ScriptedModel([json.dumps(wrong), json.dumps(right)])
    monkeypatch.setattr(routes, "build_provider", lambda settings: model)

    async with client() as ac:
        reply = await ac.post("/api/agent/safety", json={"message": "test_method only with the door open"})
        assert reply.status_code == 200, reply.text
        draft = reply.json()
        assert draft["ok"] is True and draft["attempts"] == 2
        assert draft["added"] == {"states": ["door"], "limits": [], "rules": ["Door open first"]}
        assert draft["config"]["states"]["door"]["values"] == ["open", "closed"]
        assert draft["questions"] == ["Which door?"]
        # The second request carried the first one's mistake, by name.
        assert "uses the state 'door', which is not defined" in model.calls[1][-1]["content"]
        # A draft is a draft: nothing was saved, so nothing is enforced.
        assert (await ac.get("/api/safety")).json()["config"]["rules"] == []
        assert (await execute(ac, "test_method", duration=0)).status_code == 200


# --- What the driver itself declares ------------------------------------------------------------

class Chooser:
    """A method whose type already says what it takes: nobody should have to write a limit for it."""

    def pick(self, mode: Literal["fast", "slow"] = "slow", careful: bool = True) -> str:
        return mode


@pytest.fixture
def chooser():
    from ivoryos_edge.introspection import inspect_device_module
    app.state.instruments["chooser"] = Chooser()
    app.state.instrument_schemas["chooser"] = inspect_device_module(app.state.instruments["chooser"])
    yield
    app.state.instruments.pop("chooser")
    app.state.instrument_schemas.pop("chooser")


@pytest.mark.asyncio
async def test_a_literal_or_enum_holds_with_nothing_configured(chooser):
    """Before this a value outside a Literal went straight to the driver: the cast lets it through."""
    async with client() as ac:
        pick = lambda **args: ac.post("/api/execute", json={"module": "chooser", "method": "pick", "args": args})
        refused = await pick(mode="warp")
        assert refused.status_code == 409
        assert refused.json()["problems"] == ["chooser.pick: mode = 'warp' is not one of its choices (fast, slow)."]
        assert (await pick(mode="fast")).status_code == 200
        assert (await pick()).status_code == 200, "the default is one of its choices"
        # bool is not held to the spelling a form uses.
        assert (await pick(careful="true")).status_code == 200

        run = await ac.post("/api/queue/runs", json={"name": "Warp", "sequence": [
            {"instrument": "chooser", "method": "pick", "params": {"mode": "warp"}}]})
        assert run.status_code == 400 and "is not one of its choices" in run.json()["error"]

        # A limit can only narrow what the driver offers.
        await save(ac, limits=[{"target": "chooser", "method": "pick", "param": "mode", "allowed": ["slow"]}])
        narrowed = await pick(mode="fast")
        assert narrowed.status_code == 409 and "is not allowed here (allowed: slow)" in narrowed.json()["error"]


def test_a_choice_is_checked_by_its_value_and_inside_an_object():
    import enum

    class Way(enum.Enum):
        UP = "up"

    schema = {"arm": {"move": {"parameters": {
        "way": {"type": "Way", "options": ["up", "down"]},
        "config": {"type": "Config", "is_object": True, "fields": {"speed": {"type": "Literal", "options": [1, 2]}}},
    }}}}
    deck = Deck({}, schema)
    assert guard.check_params("arm", "move", {"way": Way.UP, "config": {"speed": "2"}}, deck=deck) == []
    assert guard.check_params("arm", "move", {"way": "up", "config": {"speed": 3}}, deck=deck) == [
        "arm.move: config.speed = 3 is not one of its choices (1, 2)."]
