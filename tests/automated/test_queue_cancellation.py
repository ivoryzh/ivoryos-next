import pytest
import asyncio
from httpx import AsyncClient, ASGITransport
from ivoryos_edge.server import app

@pytest.mark.asyncio
async def test_queue_cancellation():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Test Cancel Execution",
            "sequence": [
                {"instrument": "dummy", "method": "test_method", "params": {"duration": 5}}
            ]
        }
        
        # Start a long running task
        response = await ac.post("/api/queue/runs", json=payload)
        assert response.status_code == 200, response.text
        run_id = response.json()["run_id"]
        
        # Give it a moment to start running
        await asyncio.sleep(0.5)
        
        # Cancel the task
        cancel_resp = await ac.post(f"/api/queue/runs/{run_id}/cancel")
        assert cancel_resp.status_code == 200
        
        # Wait for the queue manager to abort it
        status = "running"
        for _ in range(20):
            resp = await ac.get("/api/queue/runs")
            runs = resp.json()["runs"]
            run = next((r for r in runs if r["id"] == run_id), None)
            if run:
                status = run["status"]
                if status in ["completed", "error", "cancelled"]:
                    break
            await asyncio.sleep(0.1)
            
        assert status == "cancelled", f"Expected 'cancelled', got {status}"
