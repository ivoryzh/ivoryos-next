import pytest
import asyncio
from httpx import AsyncClient, ASGITransport
from ivoryos_edge.server import app

@pytest.mark.asyncio
async def test_error_handling():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Test Error Execution",
            "sequence": [
                {"instrument": "dummy", "method": "fail_method", "params": {}}
            ]
        }
        
        response = await ac.post("/api/queue/runs", json=payload)
        assert response.status_code == 200, response.text
        run_id = response.json()["run_id"]
        
        # Wait for the task to be picked up and fail
        status = "pending"
        for _ in range(30):
            resp = await ac.get("/api/queue/runs")
            runs = resp.json()["runs"]
            run = next((r for r in runs if r["id"] == run_id), None)
            if run:
                status = run["status"]
                if status in ["completed", "error", "cancelled"]:
                    break
            await asyncio.sleep(0.1)
            
        assert status == "error", f"Expected 'error', got {status}"
        
        # Check that the server is still alive
        resp = await ac.get("/api/status")
        assert resp.status_code == 200
        assert resp.json()["status"] in ["ok", "running"]
