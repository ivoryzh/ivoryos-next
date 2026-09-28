"""cast_arguments must cast by the real type when a driver uses `from __future__ import
annotations`: every annotation is then the *string* "float", and casting against the string
passed the text "14" straight to the driver, while the schema (which already resolved the
strings) had promised a float. Found porting the barista demo, whose drivers use that import."""

import enum
import importlib
import textwrap

from ivoryos_edge.introspection import cast_arguments, inspect_device_module, resolve_callable

DRIVER = '''
from __future__ import annotations

import enum
from typing import Optional


class Mode(enum.Enum):
    FAST = "fast"
    GENTLE = "gentle"


class Machine:
    def add_beans(self, bean_grams: float, shots: int = 1, mode: Mode = Mode.FAST,
                  note: Optional[float] = None, **extra: int) -> float:
        return bean_grams
'''


def _machine(tmp_path, monkeypatch):
    (tmp_path / "pep563_driver.py").write_text(textwrap.dedent(DRIVER))
    monkeypatch.syspath_prepend(str(tmp_path))
    return importlib.import_module("pep563_driver")


def test_string_annotations_are_cast_by_their_real_type(tmp_path, monkeypatch):
    mod = _machine(tmp_path, monkeypatch)
    method = resolve_callable(mod.Machine(), "add_beans")
    out = cast_arguments(method, {"bean_grams": "14", "shots": "2", "mode": "gentle", "note": "1.5", "dose": "3"})
    assert out["bean_grams"] == 14.0 and isinstance(out["bean_grams"], float)
    assert out["shots"] == 2 and isinstance(out["shots"], int)
    assert out["mode"] is mod.Mode.GENTLE
    assert out["note"] == 1.5
    assert out["dose"] == 3          # **extra: int applies to unlisted arguments too


def test_optional_is_cast_as_its_inner_type():
    from typing import Optional, Union
    from ivoryos_edge.introspection import cast_value
    assert cast_value(Optional[float], "1.5") == 1.5
    assert cast_value(Union[int, None], "2") == 2
    assert cast_value(eval("float | None"), "1.5") == 1.5
    assert cast_value(Optional[float], None) is None
    assert cast_value(Union[int, str], "2") == "2"     # a real choice of types is left alone


def test_the_schema_and_the_cast_agree(tmp_path, monkeypatch):
    mod = _machine(tmp_path, monkeypatch)
    schema = inspect_device_module(mod.Machine())["add_beans"]["parameters"]
    assert schema["bean_grams"]["type"] == "float"
    assert schema["mode"]["options"] == ["fast", "gentle"]
