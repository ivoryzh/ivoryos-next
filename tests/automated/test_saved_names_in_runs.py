"""A '#name' that reads what an earlier step saved, in a plain run.

Two shipped faults, both seen as "Variable '#test' is not available yet" after two pumps had
already dispensed:

* the Designer's Run sent each step's arguments but not what it saves, so nothing was bound;
* a run whose '#name' nothing saves was only found out when that step was reached, after every
  step before it had run. start_run now refuses it before anything moves.
"""

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from ivoryos_edge.queue import unproduced_references
from ivoryos_edge.server import app


async def _finish(ac, run_id):
    run = {}
    for _ in range(80):
        run = (await ac.get(f"/api/queue/runs/{run_id}")).json()
        if run.get("status") in ["completed", "error", "cancelled"]:
            break
        await asyncio.sleep(0.05)
    return run


@pytest.mark.asyncio
async def test_a_value_saved_by_the_designer_run_is_read_by_a_later_step():
    app.state.instruments["dummy"].counter = 0
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # The Designer's Run payload: saved names beside params, as Configure sends them.
        resp = await ac.post("/api/queue/runs", json={
            "name": "Saved then read",
            "parameters": {"type": "Sequence"},
            "prep": [], "cleanup": [],
            "sequence": [
                {"instrument": "dummy", "method": "counting_method", "params": {}, "returnVar": "test"},
                {"instrument": "dummy", "method": "echo_method", "params": {"value": "#test"}},
            ],
        })
        assert resp.status_code == 200, resp.text
        run = await _finish(ac, resp.json()["run_id"])
        assert run["status"] == "completed", run
        counted, echoed = run["steps"]
        # The echo got the counted value, not the text "#test".
        assert str(echoed["outputs"]["result"]) == str(counted["outputs"]["result"]) == "1"


@pytest.mark.asyncio
async def test_a_run_reading_a_name_nothing_saves_is_refused_before_anything_moves():
    app.state.instruments["dummy"].counter = 0
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        before = (await ac.get("/api/queue/history?limit=1")).json().get("total")
        resp = await ac.post("/api/queue/runs", json={
            "name": "Nothing saves test",
            "parameters": {"type": "Sequence"},
            "prep": [], "cleanup": [],
            "sequence": [
                {"instrument": "dummy", "method": "counting_method", "params": {}},
                {"instrument": "dummy", "method": "echo_method", "params": {"value": "#test"}},
            ],
        })
        assert resp.status_code == 400
        error = resp.json()["error"]
        assert "Step 2 (dummy.echo_method) reads #test, but no step before it saves 'test'." in error
        assert "Nothing was run." in error
        # No run was recorded and the first step never ran.
        assert (await ac.get("/api/queue/history?limit=1")).json().get("total") == before
        assert app.state.instruments["dummy"].counter == 0


def test_what_counts_as_saved_before_a_read():
    step = lambda inst, method, **params: {"instrument": inst, "method": method, "params": params}
    # Read before it is saved: refused, even though a later step saves it.
    assert unproduced_references([
        step("dummy", "echo_method", value="#x"),
        step("dummy", "counting_method", _return_var="x"),
    ]) == ["Step 1 (dummy.echo_method) reads #x, but no step before it saves 'x'."]
    # A User input, a field pointer and a linked workflow's rename all save a name.
    assert unproduced_references([
        step("Flow Control", "User_Input", variable_name="a", prompt="#not_checked"),
        step("dummy", "assay_method", _return_bindings=[{"path": "yield_pct", "var": "b"}]),
        step("dummy", "counting_method", _return_var="inner", _return_aliases=[["inner", "c"]]),
        step("dummy", "echo_method", value={"nested": ["#a", "#b", "#c"]}),
    ]) == []
    # Free text and flow control are not substituted, so they are not checked; nor is '#' alone,
    # nor the step's own bookkeeping.
    assert unproduced_references([
        step("Flow Control", "Comment", message="#later"),
        step("Flow_Control", "Sleep", duration_seconds="#later"),
        step("dummy", "echo_method", value="#", _vars={"value": "#later"}),
    ]) == []
