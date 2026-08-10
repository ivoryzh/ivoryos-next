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
