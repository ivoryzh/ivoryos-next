"""Iterate's "Stop early": a sample whose results reach a target ends the run (queue.py).

Checked as each sample finishes; the rest of the samples are skipped, cleanup still runs, and the
run is a success: it got where it was going, so nothing is recorded as stopped early.
"""
import asyncio

import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge.queue import target_reached
from ivoryos_edge.server import app


def test_any_needs_one_condition_and_all_needs_every_one():
    any_of = {"mode": "any", "criteria": [{"metric": "y", "op": ">=", "threshold": 3},
                                          {"metric": "impurity", "op": "<=", "threshold": 0.1}]}
    assert target_reached(any_of, {"y": 2, "impurity": 0.5}) is None
    assert target_reached(any_of, {"y": 3, "impurity": 0.5}) == ["y ≥ 3 (3)"]
    assert target_reached(any_of, {"y": 1, "impurity": 0.05}) == ["impurity ≤ 0.1 (0.05)"]

    all_of = {**any_of, "mode": "all"}
    assert target_reached(all_of, {"y": 3, "impurity": 0.5}) is None
    assert target_reached(all_of, {"y": 4, "impurity": 0.1}) == ["y ≥ 3 (4)", "impurity ≤ 0.1 (0.1)"]
    # A result missing or not a number meets nothing.
    assert target_reached(all_of, {"y": 4}) is None
    assert target_reached(any_of, {"y": "n/a"}) is None
    assert target_reached(None, {"y": 9}) is None
    assert target_reached({"mode": "any", "criteria": []}, {"y": 9}) is None


async def _finished(ac, name):
    for _ in range(200):
        runs = (await ac.get("/api/queue/runs")).json()["runs"]
        run = next((r for r in runs if r["name"] == name), None)
        if run and run["status"] in ("completed", "error", "cancelled"):
            return run
        await asyncio.sleep(0.05)
    raise AssertionError(f"{name} did not finish")


def _rows(n):
    return [{"instrument": "dummy", "method": "counting_method", "params": {"_row": r, "_block": 0}, "returnVar": "y"}
            for r in range(n)]


@pytest.mark.asyncio
async def test_an_iterate_run_stops_once_a_sample_reaches_the_target():
    app.state.instruments["dummy"].counter = 0
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/queue/runs", json={
            "name": "Stops at three",
            "parameters": {"type": "Spreadsheet", "variables": ["x"], "rows": [{"x": i} for i in range(6)],
                           "early_stop": {"mode": "any", "criteria": [{"metric": "y", "op": ">=", "threshold": 3}]}},
            "prep": [],
            "sequence": _rows(6),
            "cleanup": [{"instrument": "dummy", "method": "test_method", "params": {"duration": 0}}],
        })
        run = await _finished(ac, "Stops at three")
    assert run["status"] == "completed"
    main = [s for s in run["steps"] if (s["parameters"] or {}).get("_phase", "main") == "main"]
    # counting_method gives 1, 2, 3, ...: the third sample reaches 3; the other three never run.
    assert [s["status"] for s in main] == ["completed"] * 3 + ["skipped"] * 3
    cleanup = [s for s in run["steps"] if (s["parameters"] or {}).get("_phase") == "cleanup"]
    assert [s["status"] for s in cleanup] == ["completed"]
    assert "stopped_early" not in ((run["parameters"] or {}).get("_issues") or {})


@pytest.mark.asyncio
async def test_in_batches_the_batch_finishes_first():
    app.state.instruments["dummy"].counter = 0
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/queue/runs", json={
            "name": "Stops after its batch",
            "parameters": {"type": "Spreadsheet", "variables": ["x"], "rows": [{"x": i} for i in range(6)],
                           "batch_size": 3,
                           "early_stop": {"mode": "any", "criteria": [{"metric": "y", "op": ">=", "threshold": 2}]}},
            "prep": [], "sequence": _rows(6), "cleanup": [],
        })
        run = await _finished(ac, "Stops after its batch")
    statuses = [s["status"] for s in run["steps"]]
    # Sample 2 reaches 2 inside the first batch of three: that batch is finished, the next is not run.
    assert statuses == ["completed"] * 3 + ["skipped"] * 3
