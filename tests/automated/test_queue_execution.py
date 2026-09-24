import pytest
import asyncio
from httpx import AsyncClient, ASGITransport
from ivoryos_edge.server import app

@pytest.mark.asyncio
async def test_queue_execution():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Test Queue Execution",
            "sequence": [
                {"instrument": "dummy", "method": "test_method", "params": {"duration": 1}}
            ]
        }
        
        response = await ac.post("/api/queue/runs", json=payload)
        assert response.status_code == 200, response.text
        data = response.json()
        assert "run_id" in data
        run_id = data["run_id"]
        
        # Wait for the task to be picked up and executed
        # Since it's a background asyncio task, we poll the status
        status = "pending"
        for _ in range(30):  # Wait up to 3 seconds
            resp = await ac.get("/api/queue/runs")
            assert resp.status_code == 200
            runs = resp.json()["runs"]
            run = next((r for r in runs if r["id"] == run_id), None)
            if run:
                status = run["status"]
                if status in ["completed", "error", "cancelled"]:
                    break
            await asyncio.sleep(0.1)
            
        assert status == "completed", f"Expected 'completed', got {status}"


@pytest.mark.asyncio
async def test_if_and_while_record_what_they_decided():
    """A finished run should say which way each condition went and on what values -- not just
    'If: completed', leaving the branch taken to be inferred from which steps were skipped."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Condition logging",
            "sequence": [
                {"instrument": "dummy", "method": "counting_method", "params": {}, "returnVar": "count"},
                {"instrument": "Flow_Control", "method": "If", "params": {"condition": "count == count"}},
                {"instrument": "Flow_Control", "method": "End_If", "params": {}},
                {"instrument": "Flow_Control", "method": "While", "params": {"condition": "count != count"}},
                {"instrument": "Flow_Control", "method": "End_While", "params": {}},
            ],
        }
        run_id = (await ac.post("/api/queue/runs", json=payload)).json()["run_id"]
        for _ in range(50):
            run = next(r for r in (await ac.get("/api/queue/runs")).json()["runs"] if r["id"] == run_id)
            if run["status"] in ("completed", "error", "cancelled"):
                break
            await asyncio.sleep(0.1)
        assert run["status"] == "completed", run

        steps = (await ac.get(f"/api/queue/runs/{run_id}")).json()["steps"]
        by_method = {s["method"]: s for s in steps}
        taken = by_method["If"]["outputs"]
        assert taken["result"] is True and taken["condition"] == "count == count"
        assert "count" in taken["variables"], "the value that decided it is recorded"
        loop = by_method["While"]["outputs"]
        assert loop["result"] is False and loop["history"] == [False]


@pytest.mark.asyncio
async def test_each_row_reads_its_own_outputs_in_a_batch():
    """A batch walks block by block, so both rows are measured before either row's If runs. Each
    If must still decide on *its own* row's value -- a flat context gave both rows the last one."""
    def row(n, step):
        step["params"] = {**step.get("params", {}), "_row": n}
        return step

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        sequence = [
            row(0, {"instrument": "dummy", "method": "echo_method", "params": {"value": "low"}, "returnVar": "reading"}),
            row(1, {"instrument": "dummy", "method": "echo_method", "params": {"value": "high"}, "returnVar": "reading"}),
        ]
        for n in (0, 1):
            sequence += [
                row(n, {"instrument": "Flow_Control", "method": "If", "params": {"condition": "reading == 'high'"}}),
                row(n, {"instrument": "dummy", "method": "echo_method", "params": {"value": "#reading"}}),
                row(n, {"instrument": "Flow_Control", "method": "End_If", "params": {}}),
            ]
        run_id = (await ac.post("/api/queue/runs", json={"name": "Row scoping", "sequence": sequence})).json()["run_id"]
        for _ in range(50):
            run = next(r for r in (await ac.get("/api/queue/runs")).json()["runs"] if r["id"] == run_id)
            if run["status"] in ("completed", "error", "cancelled"):
                break
            await asyncio.sleep(0.1)
        assert run["status"] == "completed", run

        steps = (await ac.get(f"/api/queue/runs/{run_id}")).json()["steps"]
        ifs = [s for s in steps if s["method"] == "If"]
        assert [s["outputs"]["result"] for s in ifs] == [False, True]
        assert [s["outputs"]["variables"]["reading"] for s in ifs] == ["low", "high"]
        inner = [s for s in steps if s["method"] == "echo_method"][2:]
        assert [s["status"] for s in inner] == ["skipped", "completed"]
        assert inner[1]["outputs"]["result"] == "high"
