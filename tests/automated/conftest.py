import pytest
import asyncio
import dataclasses
from httpx import AsyncClient, ASGITransport
from ivoryos_edge.server import app


@dataclasses.dataclass
class AssayMetrics:
    purity: float
    peaks: int


@dataclasses.dataclass
class AssayResult:
    """A deliberately non-scalar result: one method call produces several numbers plus
    non-numeric metadata, which is the shape a return pointer has to address."""
    yield_pct: float
    metrics: AssayMetrics
    sample_id: str


class DummyInstrument:
    def __init__(self):
        self.counter = 0
        self.counter_b = 0.0

    def test_method(self, duration: int = 0):
        import time
        time.sleep(duration)
        return "done"

    def fail_method(self):
        raise ValueError("This is a simulated failure")

    def counting_method(self):
        """Returns an incrementing number each call — lets a test drive an optimization
        loop's objective value deterministically (e.g. to trigger early-stop at a known trial)."""
        self.counter += 1
        return self.counter

    def counting_method_b(self):
        """Increments at half the rate of counting_method — pairing them lets a test tell
        an ANY-mode early stop (fires when the faster one hits its target) apart from an
        ALL-mode one (must wait for the slower one too)."""
        self.counter_b += 0.5
        return self.counter_b

    def assay_method(self) -> AssayResult:
        """Returns a structured result whose numeric fields sit at different depths, so a test
        can bind an objective to a nested pointer rather than the whole object."""
        self.counter += 1
        return AssayResult(
            yield_pct=float(self.counter),
            metrics=AssayMetrics(purity=0.5 * self.counter, peaks=self.counter),
            sample_id=f"S{self.counter}",
        )

    def echo_method(self, value: str = ""):
        """Returns whatever it's given — no side effects, no sleep. Lets a test assert on the
        exact value a step actually received without caring what the value means."""
        return value

import pytest_asyncio

@pytest_asyncio.fixture(scope="session", autouse=True)
async def setup_app_state():
    from ivoryos_edge.server import app, queue_manager
    from ivoryos_edge.models import init_db
    
    app.state.instruments = {"dummy": DummyInstrument()}
    await init_db()
    await queue_manager.init_asyncio()
    yield
