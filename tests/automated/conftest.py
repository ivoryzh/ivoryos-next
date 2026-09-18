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
        self._flow_rate = 0.0

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

    @property
    def last_assay(self) -> AssayResult:
        """A property typed as a dataclass — the crossover between property introspection and
        return pointers, where a getter is a step whose result still needs addressing by field."""
        return AssayResult(
            yield_pct=float(self.counter),
            metrics=AssayMetrics(purity=0.5 * self.counter, peaks=self.counter),
            sample_id=f"S{self.counter}",
        )

    @property
    def flow_rate(self) -> float:
        """A setting exposed as a property rather than a method, the way plenty of real
        drivers do it -- so a run can prove the queue executes both halves of one."""
        return self._flow_rate

    @flow_rate.setter
    def flow_rate(self, value: float):
        self._flow_rate = value

    def echo_method(self, value: str = ""):
        """Returns whatever it's given — no side effects, no sleep. Lets a test assert on the
        exact value a step actually received without caring what the value means."""
        return value

import pytest_asyncio

@pytest_asyncio.fixture(scope="session", autouse=True)
async def setup_app_state():
    from ivoryos_edge.server import app, queue_manager
    from ivoryos_edge.models import init_db
    
    from ivoryos_edge.introspection import inspect_device_module

    app.state.instruments = {"dummy": DummyInstrument()}
    # The real startup_event introspects every instrument into instrument_schemas, and anything
    # reading the deck rather than driving it — /api/status, the agent tool layer — works from
    # that, not from the live objects. Without it those read an empty deck.
    app.state.instrument_schemas = {
        name: inspect_device_module(instance) for name, instance in app.state.instruments.items()
    }
    await init_db()
    await queue_manager.init_asyncio()
    yield


@pytest.fixture(autouse=True)
def isolated_workflow_store(tmp_path, monkeypatch):
    """Give every test its own workflow database.

    The store used to be a directory of JSON files, so handing a test its own tmp_path was enough
    to isolate it. Now the directory is only the mirror and the database is the source of truth --
    a shared one -- so without this a workflow saved by one test is still there for the next, and
    `list_workflow_names` on an empty scratch directory comes back full.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from ivoryos_edge import workflows as wf
    from ivoryos_edge.models import Base

    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / 'workflow_store.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    monkeypatch.setattr(wf, "sync_session", sessionmaker(bind=engine, expire_on_commit=False))
    try:
        yield
    finally:
        engine.dispose()


@pytest.fixture
def api_workflows_dir(tmp_path, monkeypatch):
    """Point the live endpoints at a scratch directory instead of the package's own workflows/.

    `isolated_workflow_store` above isolates the database, but the directory is the other half
    of the store and is shared — without this a test that saves a workflow writes a real JSON
    file into the repository, which then shows up in every later test's listing.
    """
    d = tmp_path / "api_workflows"
    d.mkdir()
    monkeypatch.setattr("ivoryos_edge.server.WORKFLOWS_DIR", str(d))
    return str(d)


@pytest_asyncio.fixture(autouse=True)
async def clean_agent_proposals():
    """Empty the agent review queue between tests.

    `isolated_workflow_store` isolates the workflow store, but proposals live in the main
    application database, which is shared and persists across runs. Without this, a test that
    asserts "nothing is waiting for review" passes or fails depending on what an earlier test —
    or an earlier *run* — happened to leave behind.
    """
    from sqlalchemy import delete
    from ivoryos_edge.models import AgentProposal, async_session

    async with async_session() as session:
        await session.execute(delete(AgentProposal))
        await session.commit()
    yield
