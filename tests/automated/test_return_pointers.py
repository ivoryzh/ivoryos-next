"""Return-value introspection and per-field return pointers.

A driver method rarely returns one bare number — it returns a dataclass or Pydantic model
holding several numbers plus metadata. `build_return_paths` flattens that annotation into
addressable leaves (marking which are numeric, i.e. usable as an optimizer objective), and
`extract_return_values` binds a named variable to one specific leaf at run time instead of
zipping names onto whatever order the result's fields happen to come out in.
"""

import dataclasses
import typing

import pytest
import asyncio
from httpx import AsyncClient, ASGITransport

from ivoryos_edge.introspection import (
    build_return_paths,
    extract_type_info,
    inspect_device_module,
    resolve_output_path,
    _MISSING,
)
from ivoryos_edge.queue import extract_return_values
from ivoryos_edge.server import app


@dataclasses.dataclass
class Metrics:
    purity: float
    peaks: int
    note: str = ""


@dataclasses.dataclass
class Result:
    yield_pct: float
    metrics: Metrics
    sample_id: str
    ok: bool = True


def test_numeric_leaves_are_flagged_and_bool_is_not():
    assert extract_type_info(float).get("numeric") is True
    assert extract_type_info(int).get("numeric") is True
    # bool is an int subclass in Python, but "True" is never an objective value.
    assert extract_type_info(bool).get("numeric") is None
    assert extract_type_info(str).get("numeric") is None
    assert extract_type_info(typing.Optional[float]).get("numeric") is True


def test_dataclass_return_flattens_to_dotted_paths():
    paths = build_return_paths(Result)
    assert paths == [
        {"path": "yield_pct", "type": "float", "numeric": True},
        {"path": "metrics.purity", "type": "float", "numeric": True},
        {"path": "metrics.peaks", "type": "int", "numeric": True},
        {"path": "metrics.note", "type": "str", "numeric": False},
        {"path": "sample_id", "type": "str", "numeric": False},
        {"path": "ok", "type": "bool", "numeric": False},
    ]
    # Exactly the subset an optimizer can be pointed at.
    assert [p["path"] for p in paths if p["numeric"]] == ["yield_pct", "metrics.purity", "metrics.peaks"]


def test_pydantic_return_flattens_the_same_way():
    pydantic = pytest.importorskip("pydantic")

    class PMetrics(pydantic.BaseModel):
        purity: float
        label: str = "x"

    class PResult(pydantic.BaseModel):
        score: float
        metrics: PMetrics

    assert build_return_paths(PResult) == [
        {"path": "score", "type": "float", "numeric": True},
        {"path": "metrics.purity", "type": "float", "numeric": True},
        {"path": "metrics.label", "type": "str", "numeric": False},
    ]


def test_scalar_tuple_and_none_returns():
    # A scalar return is still one addressable leaf: the empty path means "the result itself".
    assert build_return_paths(float) == [{"path": "", "type": "float", "numeric": True}]
    # A fixed-length tuple is addressed by index.
    assert build_return_paths(typing.Tuple[float, str]) == [
        {"path": "0", "type": "float", "numeric": True},
        {"path": "1", "type": "str", "numeric": False},
    ]
    # Tuple[X, ...] is variadic — no fixed leaf to point at, so it stays one opaque result.
    assert build_return_paths(typing.Tuple[float, ...]) == [
        {"path": "", "type": "Tuple[float, ...]", "numeric": False}
    ]


def test_optional_object_return_still_exposes_its_fields():
    # Without Optional unwrapping this degraded to a single opaque leaf, so a method declared
    # `-> Optional[Result]` (very common for "may not have measured anything") lost every pointer.
    assert [p["path"] for p in build_return_paths(typing.Optional[Result])] == [
        "yield_pct", "metrics.purity", "metrics.peaks", "metrics.note", "sample_id", "ok",
    ]


def test_self_referencing_model_terminates():
    @dataclasses.dataclass
    class Node:
        value: float
        parent: typing.Optional["Node"] = None

    paths = build_return_paths(Node)
    assert {"path": "value", "type": "float", "numeric": True} in paths


def test_inspect_device_module_publishes_return_paths():
    class Device:
        def measure(self) -> Result: ...
        def reset(self) -> None: ...

    schema = inspect_device_module(Device())
    assert [p["path"] for p in schema["measure"]["return_paths"]][:2] == ["yield_pct", "metrics.purity"]
    # Nothing to point at on a method that returns nothing.
    assert schema["reset"]["return_paths"] == []


def test_property_getter_gets_return_paths_too():
    """A property is a step like any other (see AGENTS.md section 12), so a property typed as a
    dataclass has to be addressable by field — otherwise `reactor.readings` would be bindable
    only as one opaque object while `reactor.read_all()` was bindable field by field."""
    class Device:
        @property
        def readings(self) -> Result:
            raise AssertionError("introspection must never run a getter")

        @property
        def flow_rate(self) -> float:
            raise AssertionError("introspection must never run a getter")

        @flow_rate.setter
        def flow_rate(self, value: float):
            pass

    schema = inspect_device_module(Device())

    assert [p["path"] for p in schema["readings"]["return_paths"]][:2] == ["yield_pct", "metrics.purity"]
    # A scalar property is still one addressable leaf, and a numeric one at that.
    assert schema["flow_rate"]["return_paths"] == [{"path": "", "type": "float", "numeric": True}]
    # A setter returns nothing, so it has nothing to point at.
    assert schema["flow_rate_(setter)"]["return_paths"] == []


def test_resolve_output_path_walks_dicts_lists_and_objects():
    obj = Result(yield_pct=91.2, metrics=Metrics(purity=0.98, peaks=3), sample_id="A1")
    serialized = dataclasses.asdict(obj)

    assert resolve_output_path(serialized, "metrics.purity") == 0.98
    assert resolve_output_path(obj, "metrics.purity") == 0.98  # live object, by attribute
    assert resolve_output_path([1.5, "a"], "1") == "a"
    assert resolve_output_path(serialized, "") == serialized
    # A missing path is distinguishable from a field that is legitimately None.
    assert resolve_output_path(serialized, "metrics.nope") is _MISSING
    assert resolve_output_path({"a": None}, "a") is None


def test_pointers_bind_by_name_not_by_position():
    obj = Result(yield_pct=91.2, metrics=Metrics(purity=0.98, peaks=3), sample_id="A1")
    serialized = dataclasses.asdict(obj)

    values = extract_return_values(
        [{"path": "metrics.purity", "var": "p"}, {"path": "yield_pct", "var": "y"}],
        None, serialized, obj,
    )
    # Declared purity-first, and that's what each name gets — the legacy positional mapping
    # below would instead have handed "p" the first field of the result, whatever it is.
    assert values == {"p": 0.98, "y": 91.2}

    legacy = extract_return_values(None, "p, y", serialized, obj)
    assert legacy["p"] == 91.2  # positional: first field, not the one named


def test_pointer_with_empty_path_hands_over_the_live_object():
    obj = Result(yield_pct=1.0, metrics=Metrics(purity=0.1, peaks=1), sample_id="A")
    values = extract_return_values([{"path": "", "var": "r"}], None, dataclasses.asdict(obj), obj)
    assert values["r"] is obj


def test_unresolvable_pointer_is_skipped_not_recorded_as_none():
    values = extract_return_values(
        [{"path": "yield_pct", "var": "y"}, {"path": "not_a_field", "var": "bad"}],
        None, {"yield_pct": 2.0}, None,
    )
    assert values == {"y": 2.0}


def test_legacy_return_var_still_works_without_pointers():
    assert extract_return_values(None, "a", None, 5) == {"a": 5}
    assert extract_return_values(None, "a, b", {"x": 1, "y": 2}, {"x": 1, "y": 2}) == {"a": 1, "b": 2}
    assert extract_return_values(None, "a, b", [1, 2], (1, 2)) == {"a": 1, "b": 2}


@pytest.mark.asyncio
async def test_optimization_run_reads_objectives_from_nested_pointers():
    """End-to-end: a templated step returning a nested dataclass feeds two objectives, each
    bound to its own field, and a non-numeric pointer is dropped rather than failing the trial."""
    from ivoryos_edge.server import app as fastapi_app
    from ivoryos_edge.optimizer.registry import OPTIMIZER_REGISTRY
    from test_optimizer_wiring import MockOptimizer

    fastapi_app.state.instruments["dummy"].counter = 0
    OPTIMIZER_REGISTRY["mock"] = MockOptimizer
    MockOptimizer.observe_calls = []
    MockOptimizer._counter = 0
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            payload = {
                "name": "Test Return Pointers",
                "parameters": {
                    "type": "Optimization",
                    "optimizer": "mock",
                    "budget": 2,
                    "optimizer_config": {},
                    "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                    "objective_config": [{"name": "y", "minimize": True}, {"name": "purity", "minimize": False}],
                    "sequence_template": [{
                        "instrument": "dummy",
                        "method": "assay_method",
                        "params": {},
                        "returnVar": "y, purity, sid",
                        "returnBindings": [
                            {"path": "yield_pct", "var": "y"},
                            {"path": "metrics.purity", "var": "purity"},
                            {"path": "sample_id", "var": "sid"},
                        ],
                    }],
                },
            }
            resp = await ac.post("/api/queue/runs", json=payload)
            assert resp.status_code == 200, resp.text
            run_id = resp.json()["run_id"]

            status = "pending"
            for _ in range(50):
                runs = (await ac.get("/api/queue/runs")).json()["runs"]
                run = next((r for r in runs if r["id"] == run_id), None)
                if run and run["status"] in ["completed", "error", "cancelled"]:
                    status = run["status"]
                    break
                await asyncio.sleep(0.05)
            assert status == "completed"

            observed = [row for call in MockOptimizer.observe_calls for row in call]
            assert observed == [{"y": 1.0, "purity": 0.5}, {"y": 2.0, "purity": 1.0}]
            # 'sid' resolved fine but isn't a number, so it never reaches the optimizer.
            assert all("sid" not in row for row in observed)
    finally:
        OPTIMIZER_REGISTRY.pop("mock", None)
