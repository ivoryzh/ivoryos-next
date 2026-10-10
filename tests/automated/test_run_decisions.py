"""Every way a run can stop for a person, and what each choice does (queue.py _await_choice).

* A failed step: retry, skip, stop, and, when there is a cleanup to go to, "Stop and run cleanup".
  Plain stop leaves the cleanup out: a failed instrument may have left the deck in a state the
  cleanup should not walk into, so running it is the person's call.
* The optimizer failing to suggest (retry, cleanup, stop: there is nothing to skip) or to record a
  round (retry, skip, cleanup, stop) waits the same way. It used to end the run, or, for observe,
  print the error and carry on without the round.
* A trial that gave no result is left out by default; with `on_missing_result: "ask"` it waits.
"""

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from ivoryos_edge.optimizer.base_optimizer import OptimizerBase
from ivoryos_edge.optimizer.registry import OPTIMIZER_REGISTRY
from ivoryos_edge.server import app, queue_manager

SPACE = [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}]
CLEANUP = [{"instrument": "dummy", "method": "echo_method", "params": {"value": "teardown"}}]


class Flaky(OptimizerBase):
    """suggest() and observe() fail the first `fail_*` times they are called, then work."""
    fail_suggest = 0
    fail_observe = 0
    observed = []

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.n = 0

    def suggest(self, n=1):
        if Flaky.fail_suggest:
            Flaky.fail_suggest -= 1
            raise RuntimeError("the model would not fit")
        self.n += 1
        return [{"x": self.n * 0.1} for _ in range(n)]

    def observe(self, results):
        if Flaky.fail_observe:
            Flaky.fail_observe -= 1
            raise ValueError("cannot record this round")
        Flaky.observed.extend(results)

    def append_existing_data(self, existing_data, file_path=None):
        pass

    def get_plots(self, plot_type):
        return None

    @staticmethod
    def get_schema():
        return {"parameter_types": ["range"], "multiple_objectives": False, "optimizer_config": {}}


@pytest.fixture(autouse=True)
def flaky_optimizer():
    OPTIMIZER_REGISTRY["flaky"] = Flaky
    Flaky.fail_suggest = Flaky.fail_observe = 0
    Flaky.observed = []
    queue_manager.resume()
    yield
    del OPTIMIZER_REGISTRY["flaky"]
    queue_manager.resume()


def optimization(name, budget=2, value="1.5", **parameters):
    return {
        "name": name,
        "parameters": {
            "type": "Optimization", "optimizer": "flaky", "budget": budget, "optimizer_config": {},
            "parameter_space": SPACE, "objective_config": [{"name": "y", "minimize": False}],
            "sequence_template": [{"instrument": "dummy", "method": "echo_method", "params": {"value": value}, "returnVar": "y"}],
            **parameters,
        },
        "cleanup": CLEANUP,
    }


async def until(check, tries=160, every=0.05):
    for _ in range(tries):
        if check():
            return True
        await asyncio.sleep(every)
    return False


async def submit(ac, payload):
    resp = await ac.post("/api/queue/runs", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()["run_id"]


async def decision_for(run_id, after=None):
    """The decision the run is waiting on; with `after`, a new one (the queue takes an answer
    within half a second, so the previous decision can still be showing)."""
    fresh = lambda: queue_manager.awaiting_decision == run_id and queue_manager.decision \
        and queue_manager.decision["key"] != (after or {}).get("key")
    assert await until(fresh), "the run did not stop for a decision"
    assert queue_manager.paused is True
    return queue_manager.decision


async def finished(ac, run_id):
    # While it waits for a decision a run reads "error", so wait for it to leave the queue too.
    for _ in range(160):
        run = (await ac.get(f"/api/queue/runs/{run_id}")).json()
        if run["status"] in ("completed", "error", "cancelled") and queue_manager.active_run_id != run_id:
            return run
        await asyncio.sleep(0.05)
    raise AssertionError(f"the run did not end: {run['status']}")


def teardowns(run):
    return [s for s in run["steps"] if (s.get("outputs") or {}).get("result") == "teardown"]


@pytest.mark.asyncio
async def test_a_suggest_error_waits_and_cannot_be_skipped():
    Flaky.fail_suggest = 1
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        run_id = await submit(ac, optimization("Suggest fails once"))
        decision = await decision_for(run_id)
        assert decision["kind"] == "suggest"
        assert decision["choices"] == ["retry", "cleanup", "stop"]
        assert "the model would not fit" in decision["error"]
        status = (await ac.get("/api/queue/runs?recent=5")).json()
        assert status  # the queue is still answering while it waits

        refused = await ac.post(f"/api/queue/runs/{run_id}/resolve", json={"action": "skip"})
        assert refused.status_code == 400
        assert queue_manager.awaiting_decision == run_id  # still waiting

        assert (await ac.post(f"/api/queue/runs/{run_id}/resolve", json={"action": "retry"})).status_code == 200
        run = await finished(ac, run_id)
        assert run["status"] == "completed"
        assert len(Flaky.observed) == 2 and len(teardowns(run)) == 1
        assert [d["action"] for d in run["parameters"]["_decisions"]] == ["retry"]


@pytest.mark.asyncio
async def test_a_suggest_error_stopped_leaves_the_cleanup_out():
    Flaky.fail_suggest = 1
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        run_id = await submit(ac, optimization("Suggest fails, stopped"))
        await decision_for(run_id)
        await ac.post(f"/api/queue/runs/{run_id}/resolve", json={"action": "stop"})
        run = await finished(ac, run_id)
        assert run["status"] == "error"
        assert teardowns(run) == []
        assert queue_manager.paused is True  # and the queue is held, as after any stopped failure


@pytest.mark.asyncio
async def test_an_observe_error_can_end_the_run_after_cleanup():
    Flaky.fail_observe = 1
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        run_id = await submit(ac, optimization("Observe fails, cleanup", budget=3))
        decision = await decision_for(run_id)
        assert decision["kind"] == "observe"
        assert decision["choices"] == ["retry", "skip", "cleanup", "stop"]
        await ac.post(f"/api/queue/runs/{run_id}/resolve", json={"action": "cleanup"})
        run = await finished(ac, run_id)
        assert run["status"] == "error"
        assert len(teardowns(run)) == 1
        assert [s["method"] for s in run["steps"]] == ["echo_method", "echo_method"]  # one trial, then cleanup


@pytest.mark.asyncio
async def test_an_observe_error_skipped_goes_on_without_that_round():
    Flaky.fail_observe = 1
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        run_id = await submit(ac, optimization("Observe fails, skipped", budget=2))
        await decision_for(run_id)
        await ac.post(f"/api/queue/runs/{run_id}/resolve", json={"action": "skip"})
        run = await finished(ac, run_id)
        assert run["status"] == "completed"
        assert len(Flaky.observed) == 1  # the second round only; the first was refused


@pytest.mark.asyncio
async def test_a_trial_without_a_result_is_left_out_unless_the_run_asks():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # Default: the trial goes to observe() without a value and the run carries on.
        run_id = await submit(ac, optimization("No result, default", value="nan"))
        run = await finished(ac, run_id)
        assert run["status"] == "completed"
        assert queue_manager.decision is None

        Flaky.observed = []
        run_id = await submit(ac, optimization("No result, asked", value="nan", on_missing_result="ask"))
        decision = await decision_for(run_id)
        assert decision["kind"] == "no_result"
        assert decision["choices"] == ["skip", "cleanup", "stop"]
        assert "no value for y" in decision["error"]
        await ac.post(f"/api/queue/runs/{run_id}/resolve", json={"action": "skip"})
        await decision_for(run_id, after=decision)  # the second trial gives no result either
        await ac.post(f"/api/queue/runs/{run_id}/resolve", json={"action": "skip"})
        run = await finished(ac, run_id)
        assert run["status"] == "completed"
        assert len(Flaky.observed) == 2


@pytest.mark.asyncio
async def test_a_failed_step_can_stop_with_or_without_cleanup():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        body = lambda name: {
            "name": name, "parameters": {"type": "Sequence"}, "prep": [],
            "sequence": [{"instrument": "dummy", "method": "fail_method", "params": {}},
                         {"instrument": "dummy", "method": "echo_method", "params": {"value": "never"}}],
            "cleanup": CLEANUP,
        }
        run_id = await submit(ac, body("Step fails, cleanup"))
        decision = await decision_for(run_id)
        assert decision["kind"] == "step" and decision["choices"] == ["retry", "skip", "cleanup", "stop"]
        await ac.post(f"/api/queue/runs/{run_id}/resolve", json={"action": "cleanup"})
        run = await finished(ac, run_id)
        assert run["status"] == "error"
        assert [s["status"] for s in run["steps"]] == ["error", "skipped", "completed"]

        queue_manager.resume()
        run_id = await submit(ac, body("Step fails, stopped"))
        await decision_for(run_id)
        await ac.post(f"/api/queue/runs/{run_id}/resolve", json={"action": "stop"})
        run = await finished(ac, run_id)
        assert run["status"] == "error"
        assert teardowns(run) == []


@pytest.mark.asyncio
async def test_a_failed_cleanup_step_offers_no_cleanup_choice():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        run_id = await submit(ac, {
            "name": "Cleanup fails", "parameters": {"type": "Sequence"}, "prep": [],
            "sequence": [{"instrument": "dummy", "method": "echo_method", "params": {"value": "ok"}}],
            "cleanup": [{"instrument": "dummy", "method": "fail_method", "params": {}}],
        })
        decision = await decision_for(run_id)
        assert decision["choices"] == ["retry", "skip", "stop"]
        await ac.post(f"/api/queue/runs/{run_id}/resolve", json={"action": "stop"})
        await finished(ac, run_id)
