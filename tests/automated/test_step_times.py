"""When a failed step ends: at the moment a person ended it, not at the moment it failed."""

import asyncio

import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge.server import app, queue_manager


@pytest.fixture(autouse=True)
def queue_going():
    queue_manager.resume()
    yield
    queue_manager.resume()


async def until(predicate, tries=120, delay=0.05):
    for _ in range(tries):
        if predicate():
            return True
        await asyncio.sleep(delay)
    return False


@pytest.mark.asyncio
async def test_a_failed_step_that_is_skipped_ends_when_it_was_skipped():
    """Left ending at the failure, the wait for a decision belonged to no step, and on the
    timeline the rows either side of it were slivers around an unexplained gap."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        run_id = (await ac.post("/api/queue/runs", json={"name": "Skipped failure", "sequence": [
            {"instrument": "dummy", "method": "fail_method", "params": {}},
            {"instrument": "dummy", "method": "echo_method", "params": {"value": "after"}},
        ]})).json()["run_id"]
        assert await until(lambda: queue_manager.awaiting_decision == run_id)
        await asyncio.sleep(0.4)  # the person takes a moment
        await ac.post(f"/api/queue/runs/{run_id}/resolve", json={"action": "skip"})
        assert await until(lambda: queue_manager.active_run_id is None)

        run = (await ac.get(f"/api/queue/runs/{run_id}")).json()
        failed, after = run["steps"]
        assert failed["status"] == "skipped" and failed["error"], "skipped, and still says why"
        attempt = failed["outputs"]["attempts"][0]
        assert attempt["resolution"] == "skip"
        # It failed at once; it ended when it was skipped, 0.4 s later, and the next step follows on.
        assert attempt["end_time"] < attempt["resolved_time"] == failed["end_time"]
        assert failed["end_time"] >= attempt["end_time"][:17] and failed["end_time"] <= after["start_time"]
        assert run["status"] == "completed" and run["parameters"]["_issues"] == {"skipped": 1}
