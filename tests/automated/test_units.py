"""Units. The lab's own, chosen on the Safety page beside a field's bounds and stored with the
limit (safety.py): nothing is asked of a driver, nothing is converted, and the unit reaches the
resolved limits every form reads and the guard's refusals. And the optional driver-declared kind
(ivoryos_edge.units, `Annotated[float, Unit("mL")]` on a parameter, a result, a dataclass or
Pydantic field, a property, a declared **kwargs key), which takes precedence where it exists."""

import importlib.util
import os
import types
from dataclasses import dataclass
from typing import Annotated, Optional, Tuple, TypedDict

import pytest

from ivoryos_edge import Unit
from ivoryos_edge.agent.deck import describe_method
from ivoryos_edge.introspection import cast_arguments, cast_value, inspect_device_module
from ivoryos_edge.safety import Deck, Guard, check_value, empty_config, resolve_fields, validate

try:
    from typing import Unpack
except ImportError:  # Python 3.10
    from typing_extensions import Unpack


@dataclass
class Composition:
    yield_percent: Annotated[float, Unit("%")]
    method: str


class LampOptions(TypedDict):
    slit_um: Annotated[int, Unit("µm")]


class Psi:
    """Another package's marker: no import from IvoryOS, just the method."""

    def ivoryos_schema(self):
        return {"unit": "psi"}


class Hotplate:
    def set_temperature(self, setpoint: Annotated[float, Unit("°C")],
                        ramp: Annotated[Optional[float], Unit("°C/min")] = None) -> Annotated[float, Unit("°C")]:
        return float(setpoint)

    def weigh(self) -> Tuple[Annotated[float, Unit("g")], str]:
        return 1.0, "stable"

    def analyze(self) -> Composition:
        return Composition(1.0, "fast")

    def pressurize(self, target: Annotated[float, Psi()]) -> None:
        pass

    def measure(self, wavelength_nm: float, **options: Unpack[LampOptions]) -> dict:
        return dict(options)

    def count(self, cycles: int = 2) -> int:
        return cycles

    @property
    def stir_rate(self) -> Annotated[int, Unit("rpm")]:
        return 400

    @stir_rate.setter
    def stir_rate(self, rpm: Annotated[int, Unit("rpm")]):
        pass


@pytest.fixture(scope="module")
def schema():
    return inspect_device_module(Hotplate())


def test_a_parameters_unit_is_in_the_schema_and_its_type_is_untouched(schema):
    params = schema["set_temperature"]["parameters"]
    assert params["setpoint"] == {"type": "float", "required": True, "numeric": True, "unit": "°C"}
    # Optional[Annotated[...]]: the unit is kept and the type still reads as an Optional float.
    assert params["ramp"]["unit"] == "°C/min" and params["ramp"]["type"] == "Optional[float]"
    assert params["ramp"]["optional"] is True and params["ramp"]["required"] is False
    assert "unit" not in schema["count"]["parameters"]["cycles"]


def test_a_results_unit_reaches_its_return_path(schema):
    assert schema["set_temperature"]["return_info"]["unit"] == "°C"
    assert schema["set_temperature"]["return_paths"] == [{"path": "", "type": "float", "numeric": True, "unit": "°C"}]
    first, second = schema["weigh"]["return_paths"]
    assert first["unit"] == "g" and "unit" not in second
    by_path = {p["path"]: p for p in schema["analyze"]["return_paths"]}
    assert by_path["yield_percent"]["unit"] == "%" and "unit" not in by_path["method"]
    assert schema["analyze"]["return_info"]["fields"]["yield_percent"]["unit"] == "%"
    assert "unit" not in schema["count"]["return_paths"][0]


def test_a_property_carries_its_unit_both_ways(schema):
    assert schema["stir_rate"]["return_paths"][0]["unit"] == "rpm"
    assert schema["stir_rate_(setter)"]["parameters"]["value"]["unit"] == "rpm"


def test_a_declared_kwargs_key_keeps_its_unit_and_its_cast(schema):
    assert schema["measure"]["parameters"]["slit_um"] == {"type": "int", "required": True, "numeric": True, "unit": "µm"}
    assert cast_arguments(Hotplate().measure, {"wavelength_nm": "312", "slit_um": "5"}) == {"wavelength_nm": 312.0, "slit_um": 5}


def test_a_marker_from_another_package_counts(schema):
    assert schema["pressurize"]["parameters"]["target"]["unit"] == "psi"


def test_the_unit_changes_nothing_about_casting():
    assert cast_arguments(Hotplate().set_temperature, {"setpoint": "65"}) == {"setpoint": 65.0}
    assert cast_value(Annotated[float, Unit("mL")], "2.5") == 2.5
    # A dataclass field: cast as the type underneath, the number as typed.
    made = cast_value(Composition, {"yield_percent": "3", "method": "a"})
    assert made.yield_percent == 3.0 and isinstance(made.yield_percent, float)


def test_a_unit_needs_text():
    with pytest.raises(ValueError):
        Unit("  ")
    assert Unit(" mL ").unit == "mL"


def test_a_pydantic_field_keeps_its_unit():
    pydantic = pytest.importorskip("pydantic")

    class Reading(pydantic.BaseModel):
        mass: Annotated[float, Unit("g")]
        note: str = ""

    class Balance:
        def read(self) -> Reading:
            return Reading(mass=1.0)

    paths = {p["path"]: p for p in inspect_device_module(Balance())["read"]["return_paths"]}
    assert paths["mass"]["unit"] == "g" and "unit" not in paths["note"]


def test_string_annotations_resolve_their_units():
    """PEP 563 (`from __future__ import annotations`): the marker is read from the resolved hint."""
    source = (
        "from __future__ import annotations\n"
        "from typing import Annotated\n"
        "from ivoryos_edge import Unit\n"
        "class Pump:\n"
        "    def dispense(self, volume: Annotated[float, Unit('mL')]) -> Annotated[float, Unit('mL')]:\n"
        "        return volume\n"
    )
    module = types.ModuleType("future_pump")
    exec(source, module.__dict__)
    schema = inspect_device_module(module.Pump())
    assert schema["dispense"]["parameters"]["volume"]["unit"] == "mL"
    assert schema["dispense"]["return_paths"][0]["unit"] == "mL"


def test_the_agent_is_told_the_unit(schema):
    described = describe_method({"hotplate": schema}, "hotplate", "set_temperature")
    assert described["parameters"]["setpoint"]["unit"] == "°C"
    assert described["returns"][0]["unit"] == "°C"
    assert "unit" not in describe_method({"hotplate": schema}, "hotplate", "count")["parameters"]["cycles"]


def test_a_limit_and_its_refusal_say_the_unit(schema, tmp_path):
    deck = Deck({"hotplate": Hotplate()}, {"hotplate": schema})
    guard = Guard(path=str(tmp_path / "safety.json"), state_path=str(tmp_path / "state.json"))
    guard.config["limits"] = [
        {"target": "hotplate", "method": "set_temperature", "param": "setpoint", "max": 120},
        {"target": "hotplate", "method": "count", "param": "cycles", "max": 3},
    ]
    fields = resolve_fields(guard.config, deck)
    # The unit rides on the resolved limit (what /api/status hands the forms), from the schema,
    # not from the configuration.
    assert fields["hotplate"]["set_temperature"]["setpoint"]["unit"] == "°C"
    assert "unit" not in fields["hotplate"]["count"]["cycles"]
    assert guard.check_params("hotplate", "set_temperature", {"setpoint": 150}, fields, deck) == [
        "hotplate.set_temperature: setpoint = 150 is above the maximum of 120 °C."
    ]
    assert guard.check_params("hotplate", "count", {"cycles": 7}, fields, deck) == [
        "hotplate.count: cycles = 7 is above the maximum of 3."
    ]
    assert guard.check_params("hotplate", "set_temperature", {"setpoint": 80}, fields, deck) == []
    assert check_value({"min": 10, "unit": "mL"}, 3, {}) == [("3", "is below the minimum of 10 mL")]


def test_the_hubs_class_level_schema_carries_the_same_units(schema):
    path = os.path.join(os.path.dirname(__file__), "..", "..", "schema_worker", "introspection.py")
    spec = importlib.util.spec_from_file_location("schema_worker_introspection_units", path)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    hub = worker.inspect_class(Hotplate)
    for method in ("set_temperature", "weigh", "analyze", "pressurize", "measure", "stir_rate", "stir_rate_(setter)"):
        assert hub[method]["parameters"] == schema[method]["parameters"], method
        assert hub[method]["return_paths"] == schema[method]["return_paths"], method


# --- the lab's own units, chosen with a limit ----------------------------------------------------


def test_a_unit_is_a_limit_on_its_own_and_is_kept_as_written():
    config, problems = validate({"limits": [
        {"target": "hotplate", "method": "count", "param": "cycles", "unit": " cycles "},
        {"target": "hotplate", "method": "count", "param": "other", "unit": "   "},
    ]})
    assert [p["message"] for p in problems] == [
        "hotplate.count.other sets nothing: give it a minimum, a maximum, allowed values, a tray or a unit."
    ]
    assert config["limits"] == [{"target": "hotplate", "method": "count", "param": "cycles", "unit": "cycles"}]


def test_the_chosen_unit_reaches_the_resolved_limit_and_the_refusal(schema, tmp_path):
    """A driver that says nothing about units (`count`): the Safety page's choice is the unit."""
    deck = Deck({"hotplate": Hotplate()}, {"hotplate": schema})
    guard = Guard(path=str(tmp_path / "safety.json"), state_path=str(tmp_path / "state.json"))
    guard.config = empty_config()
    guard.config["limits"] = [{"target": "hotplate", "method": "count", "param": "cycles", "max": 3, "unit": "cycles"}]
    fields = resolve_fields(guard.config, deck)
    assert fields["hotplate"]["count"]["cycles"]["unit"] == "cycles"
    assert guard.check_params("hotplate", "count", {"cycles": 7}, fields, deck) == [
        "hotplate.count: cycles = 7 is above the maximum of 3 cycles."
    ]
    # What the forms read (/api/status `safety`) carries it too, with no bounds at all.
    guard.config["limits"] = [{"target": "hotplate", "method": "count", "param": "cycles", "unit": "cycles"}]
    guard.app = types.SimpleNamespace(state=types.SimpleNamespace(instruments=deck.instruments, instrument_schemas=deck.schemas))
    assert guard.describe()["resolved"]["fields"]["hotplate"]["count"]["cycles"] == {"source": "hotplate", "unit": "cycles"}


def test_a_unit_the_driver_declared_wins_over_the_chosen_one(schema, tmp_path):
    deck = Deck({"hotplate": Hotplate()}, {"hotplate": schema})
    config = empty_config()
    config["limits"] = [{"target": "hotplate", "method": "set_temperature", "param": "setpoint", "max": 120, "unit": "K"}]
    assert resolve_fields(config, deck)["hotplate"]["set_temperature"]["setpoint"]["unit"] == "°C"
