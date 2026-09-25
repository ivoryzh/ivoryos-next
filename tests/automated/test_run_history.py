"""Data History pages through run summaries instead of loading every run with every step, and the
global queue broadcast carries only live and recent runs -- see `list_run_summaries` and
`get_live_runs` in queue.py."""
import asyncio
import uuid

import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge.server import app, queue_manager


async def _run(ac, name, sequence, parameters=None):
    body = {"name": name, "sequence": sequence}
    if parameters is not None:
        body["parameters"] = parameters
    run_id = (await ac.post("/api/queue/runs", json=body)).json()["run_id"]
    for _ in range(50):
        run = (await ac.get(f"/api/queue/runs/{run_id}")).json()
        if run["status"] in ("completed", "error", "cancelled"):
            return run
        await asyncio.sleep(0.1)
    raise AssertionError(f"run {run_id} did not finish")


@pytest.mark.asyncio
async def test_history_searches_pages_and_sorts_without_steps():
    tag = uuid.uuid4().hex[:8]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await _run(ac, f"alpha {tag}", [{"instrument": "dummy", "method": "echo_method", "params": {"value": "x"}}])
        await _run(ac, f"beta {tag}", [{"instrument": "dummy", "method": "counting_method", "params": {}}],
                   parameters={"type": "Spreadsheet", "variables": [f"col_{tag}"], "rows": [{f"col_{tag}": 1}, {f"col_{tag}": 2}]})
        await _run(ac, f"gamma {tag}", [{"instrument": "dummy", "method": "echo_method", "params": {"value": "y"}}])

        page = (await ac.get("/api/queue/history", params={"q": tag})).json()
        assert page["total"] == 3
        assert [r["name"] for r in page["runs"]] == [f"gamma {tag}", f"beta {tag}", f"alpha {tag}"]
        assert "steps" not in page["runs"][0]
        assert page["runs"][0]["instruments"] == ["dummy"]

        beta = page["runs"][1]
        assert (beta["type"], beta["variable_count"], beta["row_count"]) == ("Spreadsheet", 1, 2)

        # Every word must match: the name, a method the run called, or a column name.
        by_method = (await ac.get("/api/queue/history", params={"q": f"{tag} counting_method"})).json()
        assert [r["name"] for r in by_method["runs"]] == [f"beta {tag}"]
        by_column = (await ac.get("/api/queue/history", params={"q": f"col_{tag}"})).json()
        assert [r["name"] for r in by_column["runs"]] == [f"beta {tag}"]

        paged = (await ac.get("/api/queue/history", params={"q": tag, "limit": 2, "offset": 2})).json()
        assert paged["total"] == 3 and [r["name"] for r in paged["runs"]] == [f"alpha {tag}"]

        oldest = (await ac.get("/api/queue/history", params={"q": tag, "sort": "oldest"})).json()
        assert oldest["runs"][0]["name"] == f"alpha {tag}"
        by_name = (await ac.get("/api/queue/history", params={"q": tag, "sort": "name"})).json()
        assert [r["name"] for r in by_name["runs"]] == [f"alpha {tag}", f"beta {tag}", f"gamma {tag}"]

        failed = (await ac.get("/api/queue/history", params={"q": tag, "status": "error"})).json()
        assert failed["total"] == 0


@pytest.mark.asyncio
async def test_live_runs_are_bounded_by_recent_count():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        for i in range(3):
            await _run(ac, f"filler {i}", [{"instrument": "dummy", "method": "echo_method", "params": {}}])
        everything = (await ac.get("/api/queue/runs")).json()["runs"]
        live = await queue_manager.get_live_runs(recent=2)
        newest_two = sorted((r["id"] for r in everything), reverse=True)[:2]
        # The two newest, plus anything not finished (the shared test database holds a few runs
        # other tests left mid-flight) -- and no finished run older than those two.
        assert [r["id"] for r in live[:2]] == newest_two
        assert all(r["status"] not in ("completed", "error", "cancelled") for r in live[2:])
        assert len(live) < len(everything)
        # With their steps, which the human-in-the-loop prompt reads.
        assert "steps" in live[0]
        via_api = (await ac.get("/api/queue/runs", params={"recent": 2})).json()["runs"]
        assert [r["id"] for r in via_api] == [r["id"] for r in live]
