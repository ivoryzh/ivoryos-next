"""Stopping, failing and stopping gracefully, and what each does to the queue behind the run.

* A failed step waits for a person (retry, skip or stop), in an optimization as in a normal run.
* Stop, and stopping a failed run, hold the queue: what was waiting does not start on its own
  until Resume queue. Stop used to let the next queued run start at once.
* A graceful stop finishes the iteration the run is in, skips the rest, runs the cleanup or not,
  and goes on with the queue or holds it, as asked.
"""

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from ivoryos_edge.server import app, queue_manager

DUMMY = "dummy"


def step(method, **params):
    return {"instrument": DUMMY, "method": method, "params": params}


async def submit(ac, name, sequence, parameters=None, cleanup=None):
    resp = await ac.post("/api/queue/runs", json={
        "name": name, "parameters": parameters or {"type": "Sequence"},
        "prep": [], "sequence": sequence, "cleanup": cleanup or [],
    })
    assert resp.status_code == 200, resp.text
    return resp.json()["run_id"]


async def until(check, tries=120, every=0.05):
    for _ in range(tries):
        if await check() if asyncio.iscoroutinefunction(check) else check():
            return True
        await asyncio.sleep(every)
    return False


async def status_of(ac, run_id):
    return (await ac.get(f"/api/queue/runs/{run_id}")).json()


@pytest.fixture(autouse=True)
def queue_left_running():
    """Each test starts and ends with the queue going, whatever it held."""
    queue_manager.resume()
    yield
    queue_manager.resume()


@pytest.mark.asyncio
async def test_stop_holds_the_queue_until_resumed():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        first = await submit(ac, "Stopped", [step("test_method", duration=1), step("echo_method", value="never")])
        second = await submit(ac, "Waiting behind", [step("echo_method", value="later")])
        assert await until(lambda: queue_manager.active_run_id == first)
        assert (await ac.post(f"/api/queue/runs/{first}/cancel")).status_code == 200
        assert await until(lambda: queue_manager.active_run_id is None)
        assert (await status_of(ac, first))["status"] == "cancelled"

        # Held: the run behind it does not start on its own.
        await asyncio.sleep(0.4)
        assert queue_manager.paused is True
        assert (await status_of(ac, second))["status"] == "pending"

        assert (await ac.post("/api/queue/resume")).json() == {"queue_paused": False}
        for _ in range(80):
            if (await status_of(ac, second))["status"] == "completed":
                break
            await asyncio.sleep(0.05)
        assert (await status_of(ac, second))["status"] == "completed"


@pytest.mark.asyncio
async def test_stopping_a_failed_step_holds_the_queue_too():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        failing = await submit(ac, "Fails", [step("fail_method"), step("echo_method", value="never")])
        behind = await submit(ac, "Behind a failure", [step("echo_method", value="later")])
        assert await until(lambda: queue_manager.awaiting_decision == failing)
        # Resume does not answer a failure; retry, skip or stop does.
        assert (await ac.post("/api/queue/resume")).status_code == 409
        assert (await ac.post(f"/api/queue/runs/{failing}/resolve", json={"action": "stop"})).status_code == 200
        assert await until(lambda: queue_manager.active_run_id is None)
        assert (await status_of(ac, failing))["status"] == "error"
        await asyncio.sleep(0.4)
        assert (await status_of(ac, behind))["status"] == "pending"
        await ac.post("/api/queue/resume")
        for _ in range(80):
            if (await status_of(ac, behind))["status"] == "completed":
                break
            await asyncio.sleep(0.05)
        assert (await status_of(ac, behind))["status"] == "completed"


@pytest.mark.asyncio
async def test_graceful_stop_finishes_the_row_then_runs_cleanup():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        rows = [step("test_method", duration=1, _row=r) for r in range(3)]
        sequence = [s for r in range(3) for s in (rows[r], step("echo_method", value=f"row {r}", _row=r))]
        run_id = await submit(ac, "Three rows", sequence,
                              parameters={"type": "Spreadsheet", "variables": [], "rows": [{}, {}, {}], "batch_size": 1},
                              cleanup=[step("echo_method", value="cleaned")])
        started = await until(lambda: queue_manager.active_run_id == run_id)
        assert started, (queue_manager.active_run_id, queue_manager.paused, (await status_of(ac, run_id)).get("status"),
                         [(x["method"], x["status"], (x.get("error") or "")[:120]) for x in (await status_of(ac, run_id))["steps"]])
        resp = await ac.post(f"/api/queue/runs/{run_id}/graceful-stop", json={"cleanup": True, "continue_queue": False})
        assert resp.status_code == 200, resp.text
        assert await until(lambda: queue_manager.active_run_id is None, tries=200)

        run = await status_of(ac, run_id)
        by_row = {}
        for s in run["steps"]:
            by_row.setdefault((s["parameters"] or {}).get("_row"), []).append(s["status"])
        assert by_row[0] == ["completed", "completed"]          # the row it was on, finished
        assert by_row[1] == ["skipped", "skipped"] and by_row[2] == ["skipped", "skipped"]
        assert by_row[None] == ["completed"]                     # cleanup ran
        assert run["status"] == "completed"
        assert (run["parameters"] or {}).get("_issues", {}).get("stopped_early") == 1
        assert queue_manager.paused is True                      # "do not continue the queue"


@pytest.mark.asyncio
async def test_graceful_stop_ends_an_optimization_after_the_trial_and_can_skip_cleanup():
    from ivoryos_edge.optimizer.registry import OPTIMIZER_REGISTRY
    from test_optimizer_wiring import MockOptimizer

    OPTIMIZER_REGISTRY["mock"] = MockOptimizer
    MockOptimizer.observe_calls = []
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            resp = await ac.post("/api/queue/runs", json={
                "name": "Stopped campaign",
                "parameters": {
                    "type": "Optimization", "optimizer": "mock", "budget": 5, "optimizer_config": {},
                    "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                    "objective_config": [{"name": "c", "minimize": False}],
                    "sequence_template": [step("test_method", duration=1), {**step("counting_method"), "returnVar": "c"}],
                },
                "prep": [], "sequence": [],
                "cleanup": [step("echo_method", value="cleaned")],
            })
            run_id = resp.json()["run_id"]
            assert await until(lambda: queue_manager.active_run_id == run_id)
            await ac.post(f"/api/queue/runs/{run_id}/graceful-stop", json={"cleanup": False, "continue_queue": True})
            assert await until(lambda: queue_manager.active_run_id is None, tries=200)

            run = await status_of(ac, run_id)
            trials = sum(1 for s in run["steps"] if s["method"] == "counting_method")
            assert 1 <= trials < 5
            assert all(s["status"] == "completed" for s in run["steps"])   # nothing half-run
            assert not any(s["method"] == "echo_method" for s in run["steps"])  # no cleanup
            assert run["status"] == "completed"
            assert (run["parameters"] or {}).get("_issues", {}).get("stopped_early") == 1
            assert queue_manager.paused is False                            # "continue the queue"
    finally:
        OPTIMIZER_REGISTRY.pop("mock", None)


@pytest.mark.asyncio
async def test_a_queued_run_can_be_changed_until_it_starts():
    """Editing a run that waits (new spreadsheet values, a new optimization configuration) replaces
    its steps and parameters and keeps its place in the queue; the one under way cannot be."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        running = await submit(ac, "Under way", [step("test_method", duration=1)])
        waiting = await submit(ac, "Edit me", [step("echo_method", value="old")],
                               parameters={"type": "Sequence", "queue_position": 0.5})
        assert await until(lambda: queue_manager.active_run_id == running)

        body = {"name": "", "parameters": {"type": "Sequence", "_source": {"page": "once"}},
                "prep": [], "cleanup": [], "sequence": [step("echo_method", value="new")]}
        assert (await ac.put(f"/api/queue/runs/{waiting}", json=body)).status_code == 200
        edited = await status_of(ac, waiting)
        assert edited["name"] == "Edit me"                                   # kept
        assert [s["parameters"]["value"] for s in edited["steps"]] == ["new"]
        assert edited["parameters"]["queue_position"] == 0.5                 # kept its place
        assert edited["parameters"]["_source"] == {"page": "once"}

        # The run under way, and a changed run that would not run, are refused.
        assert (await ac.put(f"/api/queue/runs/{running}", json=body)).status_code == 400
        bad = {**body, "sequence": [step("echo_method", value="#nothing")]}
        refused = await ac.put(f"/api/queue/runs/{waiting}", json=bad)
        assert refused.status_code == 400 and "#nothing" in refused.json()["error"]

        for _ in range(120):
            if (await status_of(ac, waiting))["status"] == "completed":
                break
            await asyncio.sleep(0.05)
        done = await status_of(ac, waiting)
        assert done["status"] == "completed" and done["steps"][0]["outputs"]["result"] == "new"


@pytest.mark.asyncio
async def test_stop_ends_a_long_wait_at_once():
    """A Sleep used to be one long sleep, so Stop waited for it to run out (a run read
    "cancelling" for the rest of a long wait)."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        run_id = await submit(ac, "Long wait", [{"instrument": "Flow_Control", "method": "Sleep", "params": {"duration_seconds": 60}}])
        assert await until(lambda: queue_manager.active_run_id == run_id)
        await asyncio.sleep(0.3)
        await ac.post(f"/api/queue/runs/{run_id}/cancel")
        assert await until(lambda: queue_manager.active_run_id is None, tries=40)   # well under a minute
        assert (await status_of(ac, run_id))["status"] == "cancelled"


def test_what_needs_a_person_is_named_once_per_moment():
    from ivoryos_edge.queue import attention_items
    waiting = {"id": 7, "name": "Screen", "status": "waiting_input", "steps": [
        {"id": 70, "status": "completed"},
        {"id": 71, "status": "waiting_input", "outputs": {"prompt": "Load vial 3"}},
    ]}
    assert attention_items(waiting, None) == [{
        "key": "input:7:71", "kind": "input", "run_id": 7, "run_name": "Screen",
        "title": "Input needed", "body": "Load vial 3",
    }]
    failed = {"id": 8, "name": "Screen", "status": "error", "steps": [
        {"id": 80, "status": "error", "instrument": "pump", "method": "dispense",
         "error": "Port busy\nTraceback ...", "outputs": {"attempts": [{}, {}]}},
    ]}
    item = attention_items(failed, 8)[0]
    assert item["kind"] == "error" and item["body"] == "pump.dispense: Port busy"
    assert item["key"] == "error:8:80:2"            # failing again after a retry is a new moment
    assert attention_items(failed, None) == []       # an error nobody is asked about: nothing
    assert attention_items(None, None) == []
