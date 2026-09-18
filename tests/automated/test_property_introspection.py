"""Properties are steps too.

A driver that exposes `pump.speed = 5` has no callable for it, so an introspection pass that
only looks at callables drops that capability from the schema entirely and the designer can
never offer it. These tests pin the two halves: a property shows up as a readable step under
its own name, and a writable one shows up again as "<name>_(setter)" taking a single `value`.
"""

import enum
import inspect

import pytest

from ivoryos_edge.introspection import (
    PROPERTY_SETTER_SUFFIX,
    cast_arguments,
    has_member,
    inspect_device_module,
    resolve_callable,
)


class Mode(enum.Enum):
    IDLE = "idle"
    RUN = "run"


class Pump:
    def __init__(self):
        self._speed = 1.0
        self._mode = Mode.IDLE
        self.reads = 0

    @property
    def speed(self) -> float:
        """Flow rate in mL/min."""
        self.reads += 1
        return self._speed

    @speed.setter
    def speed(self, value: float):
        self._speed = value

    @property
    def serial_number(self) -> str:
        """Fixed at the factory."""
        return "SN-1"

    @property
    def mode(self) -> Mode:
        return self._mode

    @mode.setter
    def mode(self, value: Mode):
        self._mode = value

    def dose(self, volume_ml: float = 1.0) -> str:
        """Dispense a volume."""
        return f"dosed {volume_ml}"


@pytest.fixture
def schema():
    return inspect_device_module(Pump())


def test_read_write_property_yields_a_getter_and_a_setter(schema):
    assert "speed" in schema
    assert f"speed{PROPERTY_SETTER_SUFFIX}" in schema

    getter = schema["speed"]
    assert getter["parameters"] == {}
    assert getter["return_type"] == "float"
    assert getter["is_property"] is True
    assert getter["property_access"] == "get"
    assert getter["has_setter"] is True
    assert getter["description"] == "Flow rate in mL/min."

    setter = schema[f"speed{PROPERTY_SETTER_SUFFIX}"]
    assert setter["property_access"] == "set"
    assert setter["property_name"] == "speed"
    assert setter["return_type"] == "None"
    assert list(setter["parameters"]) == ["value"]
    assert setter["parameters"]["value"]["type"] == "float"
    assert setter["parameters"]["value"]["required"] is True


def test_read_only_property_has_no_setter_entry(schema):
    assert "serial_number" in schema
    assert schema["serial_number"]["has_setter"] is False
    assert f"serial_number{PROPERTY_SETTER_SUFFIX}" not in schema


def test_setter_value_keeps_enum_choices(schema):
    value = schema[f"mode{PROPERTY_SETTER_SUFFIX}"]["parameters"]["value"]
    assert value["type"] == "Mode"
    assert value["options"] == ["idle", "run"]


def test_plain_methods_are_untouched(schema):
    assert schema["dose"]["parameters"]["volume_ml"]["type"] == "float"
    assert "is_property" not in schema["dose"]


def test_building_the_schema_never_runs_a_getter():
    # The point of reading properties off the class: on a real driver, fget talks to hardware.
    pump = Pump()
    inspect_device_module(pump)
    assert pump.reads == 0


def test_resolved_setter_assigns_and_resolved_getter_reads():
    pump = Pump()

    setter = resolve_callable(pump, f"speed{PROPERTY_SETTER_SUFFIX}")
    setter(**cast_arguments(setter, {"value": "2.5"}))
    assert pump._speed == 2.5

    getter = resolve_callable(pump, "speed")
    assert getter() == 2.5


def test_resolved_setter_signature_drives_argument_casting():
    pump = Pump()
    setter = resolve_callable(pump, f"mode{PROPERTY_SETTER_SUFFIX}")
    # A step's parameters arrive as JSON, so the enum has to be reconstructed from its value --
    # which only happens because the wrapper carries the property's own annotation.
    assert cast_arguments(setter, {"value": "run"}) == {"value": Mode.RUN}
    assert list(inspect.signature(setter).parameters) == ["value"]
    setter(**cast_arguments(setter, {"value": "run"}))
    assert pump._mode is Mode.RUN


def test_resolve_callable_still_returns_plain_methods():
    pump = Pump()
    assert resolve_callable(pump, "dose")(volume_ml=3) == "dosed 3"


def test_has_member_covers_both_halves_without_reading():
    pump = Pump()
    assert has_member(pump, "speed")
    assert has_member(pump, f"speed{PROPERTY_SETTER_SUFFIX}")
    assert has_member(pump, "dose")
    # A read-only property must not advertise a setter the execution path can't honour.
    assert not has_member(pump, f"serial_number{PROPERTY_SETTER_SUFFIX}")
    assert not has_member(pump, "nonexistent")
    assert pump.reads == 0


def test_resolving_a_setter_for_a_read_only_property_fails_loudly():
    with pytest.raises(AttributeError):
        resolve_callable(Pump(), f"serial_number{PROPERTY_SETTER_SUFFIX}")


@pytest.mark.asyncio
async def test_a_queued_run_sets_and_reads_a_property():
    """The whole path, not just the wrapper: a run that assigns a property, reads it back into
    a workflow variable, and feeds that variable to a later step."""
    import asyncio

    from httpx import ASGITransport, AsyncClient
    from ivoryos_edge.server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Property Round Trip",
            "sequence": [
                {"instrument": "dummy", "method": f"flow_rate{PROPERTY_SETTER_SUFFIX}",
                 "params": {"value": "2.5"}},
                {"instrument": "dummy", "method": "flow_rate",
                 "params": {"_return_var": "rate"}},
                {"instrument": "dummy", "method": "echo_method", "params": {"value": "#rate"}},
            ],
        }
        response = await ac.post("/api/queue/runs", json=payload)
        assert response.status_code == 200, response.text
        run_id = response.json()["run_id"]

        status = "pending"
        for _ in range(50):
            runs = (await ac.get("/api/queue/runs")).json()["runs"]
            run = next((r for r in runs if r["id"] == run_id), None)
            if run:
                status = run["status"]
                if status in ("completed", "error", "cancelled"):
                    break
            await asyncio.sleep(0.1)
        assert status == "completed", f"Expected 'completed', got {status}"

        steps = (await ac.get(f"/api/queue/runs/{run_id}")).json()["steps"]
        # The string "2.5" is cast to a float by the property's own annotation, ...
        assert steps[1]["outputs"]["result"] == 2.5
        # ... and the value read back through the getter reaches the next step, which declares
        # `value: str`, so cast_arguments renders it as one.
        assert steps[2]["outputs"]["result"] == "2.5"
        assert app.state.instruments["dummy"]._flow_rate == 2.5


def test_framework_properties_are_not_offered_as_steps():
    """A pydantic model carries `model_extra` / `model_fields_set` from its base class. They
    describe the modelling library, not the instrument, so they must not become steps."""
    pydantic = pytest.importorskip("pydantic")

    class Config(pydantic.BaseModel):
        speed: float = 1.0

    class Driver:
        def __init__(self):
            self.config = Config()

        @property
        def label(self) -> str:
            return "real"

    schema = inspect_device_module(Driver())
    assert "label" in schema
    assert not [name for name in schema if name.startswith("model_")]
