import pytest
from httpx import AsyncClient, ASGITransport
from ivoryos_edge.server import app

@pytest.mark.asyncio
async def test_get_status():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/status")
    assert response.status_code == 200, response.text
    data = response.json()
    assert "status" in data
    assert data["status"] in ["ok", "running"]
    assert "instruments" in data
