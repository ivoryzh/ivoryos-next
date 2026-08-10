import pytest
import asyncio
from httpx import AsyncClient, ASGITransport
from ivoryos_edge.server import app

class DummyInstrument:
    def test_method(self, duration: int = 0):
        import time
        time.sleep(duration)
        return "done"
        
    def fail_method(self):
        raise ValueError("This is a simulated failure")

import pytest_asyncio

@pytest_asyncio.fixture(scope="session", autouse=True)
async def setup_app_state():
    from ivoryos_edge.server import app, queue_manager
    from ivoryos_edge.models import init_db
    
    app.state.instruments = {"dummy": DummyInstrument()}
    await init_db()
    await queue_manager.init_asyncio()
    yield
