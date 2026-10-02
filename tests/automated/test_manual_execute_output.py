"""Running a method by hand from the Instruments page has to report what it returned.

The Action Log rendered "Executed successfully." for every action, whatever the method gave
back, because the server recorded the value under `result` and the page read `return_value`.
The value was also the raw Python object, so a driver returning a dataclass had nothing to
convert it — the manual path never got the serialization the queue does.
"""

import asyncio
import dataclasses

import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge.introspection import serialize_result
from ivoryos_edge.server import app


@dataclasses.dataclass
class Inner:
    purity: float


@dataclasses.dataclass
class Outer:
    yield_pct: float
    inner: Inner
    label: str


def test_serialize_result_handles_what_a_driver_actually_returns():
    import enum

    class Mode(enum.Enum):
        FAST = "fast"

    assert serialize_result(Outer(1.5, Inner(0.9), "a")) == {
        "yield_pct": 1.5, "inner": {"purity": 0.9}, "label": "a",
    }
    assert serialize_result(Mode.FAST) == "fast"
    assert serialize_result([Inner(0.1), Inner(0.2)]) == [{"purity": 0.1}, {"purity": 0.2}]
    assert serialize_result({"a": Inner(0.3)}) == {"a": {"purity": 0.3}}
    # Scalars and None pass through untouched; a `-> None` method is not an error.
    assert serialize_result(5) == 5
    assert serialize_result(None) is None

    pydantic = pytest.importorskip("pydantic")

    class Model(pydantic.BaseModel):
        score: float

    assert serialize_result(Model(score=2.0)) == {"score": 2.0}


def test_serialize_result_never_returns_what_json_cannot_carry():
    """A colour-matching driver returned the Path of the data folder it created; the step's
    outputs then failed to flush and the execution loop crashed. Nothing this returns may do that."""
    import datetime
    import decimal
    import json
    import pathlib

    class Opaque:
        def __str__(self):
            return "<opaque>"

    cases = {
        "path": pathlib.Path("/data/run-1"),
        "when": datetime.datetime(2026, 9, 30, 14, 4, 12),
        "day": datetime.date(2026, 9, 30),
        "tags": {"a"},
        "money": decimal.Decimal("1.50"),
        "raw": b"ok",
        "other": Opaque(),
        "nested": {"paths": [pathlib.Path("x"), Outer(1.0, Inner(0.5), "l")]},
    }
    out = serialize_result(cases)
    json.dumps(out)  # the whole point
    assert out["path"] == str(pathlib.Path("/data/run-1"))
    assert out["when"] == "2026-09-30T14:04:12"
    assert out["day"] == "2026-09-30"
    assert out["tags"] == ["a"]
    assert out["money"] == 1.5
    assert out["raw"] == "ok"
    assert out["other"] == "<opaque>"
    assert out["nested"]["paths"] == ["x", {"yield_pct": 1.0, "inner": {"purity": 0.5}, "label": "l"}]

    numpy = pytest.importorskip("numpy")
    assert serialize_result(numpy.float64(2.5)) == 2.5
    assert serialize_result(numpy.array([1, 2])) == [1, 2]


async def _execute(ac, module, method, args=None):
    started = await ac.post("/api/execute", json={"module": module, "method": method, "args": args or {}})
    assert started.status_code == 200, started.text
    task_id = started.json()["task_id"]
    for _ in range(50):
        await asyncio.sleep(0.05)
        poll = await ac.get(f"/api/execute/{task_id}")
        if poll.json().get("status") in ("completed", "error"):
            return poll.json()
    raise AssertionError("the task never finished")


@pytest.mark.asyncio
async def test_a_scalar_return_reaches_the_action_log():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        data = await _execute(ac, "dummy", "echo_method", {"value": "hello"})
        assert data["status"] == "completed"
        # Under `result` — the key the page reads. This is the whole bug.
        assert data["result"] == "hello"


@pytest.mark.asyncio
async def test_a_structured_return_is_serialized_rather_than_lost():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        data = await _execute(ac, "dummy", "assay_method")
        assert data["status"] == "completed"
        assert set(data["result"]) == {"yield_pct", "metrics", "sample_id"}
        assert set(data["result"]["metrics"]) == {"purity", "peaks"}


@pytest.mark.asyncio
async def test_a_method_returning_nothing_reports_completion_not_a_value():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        data = await _execute(ac, "dummy", "test_method", {"duration": 0})
        assert data["status"] == "completed"
        assert data["result"] == "done"


@pytest.mark.asyncio
async def test_a_property_getter_run_by_hand_returns_its_value():
    """Properties are steps now, so they are also things a person can fire from the Instruments
    page — and a getter's whole point is the value it hands back."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await _execute(ac, "dummy", "flow_rate_(setter)", {"value": 2.5})
        data = await _execute(ac, "dummy", "flow_rate")
        assert data["status"] == "completed"
        assert data["result"] == 2.5


@pytest.mark.asyncio
async def test_a_failing_method_reports_the_error():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        data = await _execute(ac, "dummy", "fail_method")
        assert data["status"] == "error"
        assert "simulated failure" in data["error"]
