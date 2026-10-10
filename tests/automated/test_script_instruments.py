"""run(__name__) puts a script's instruments on the deck, and nothing else.

`from typing import List, Union, Optional` at the top of a driver script used to show up on the
Instruments page as three "instruments": typing's special forms are objects, not classes, and their
type is not a builtin. IvoryOS Classic avoided them by skipping every capitalised name; NextGen
skips values whose type is Python's own instead, so a capitalised instrument (`HPLC = HPLC()`)
stays on the deck.
"""
import collections
import collections.abc
import datetime
import enum
import functools
import logging
import os
import pathlib
import queue
import re
import sys
import threading
import types
import typing
import uuid
from typing import Callable, List, Optional, Union
from typing import List as seq  # a lowercase alias: no name rule would catch it

from ivoryos_edge.plugins import Plugin
from ivoryos_edge.server import _script_instruments


class Pump:
    def dispense(self, volume_ml: float):
        return volume_ml


class Mode(enum.Enum):
    FAST = 1


class LabConfig:
    def load(self):
        return {}


def _script(**names):
    module = types.ModuleType("deck_script")
    module.__dict__.update(names)
    return module


def test_typing_names_are_not_instruments():
    pump = Pump()
    found, skipped = _script_instruments(_script(
        pump=pump,
        List=List, Union=Union, Optional=Optional, Callable=Callable, seq=seq,
        vector=list[float], maybe_float=Optional[float], reading=Union[int, float],
        handler=collections.abc.Callable[[int], str], number=typing.TypeVar("number"),
    ))
    assert found == {"pump": pump}
    assert set(skipped) == {"List", "Union", "Optional", "Callable", "seq", "vector",
                            "maybe_float", "reading", "handler", "number"}


def test_capitalised_instruments_stay_on_the_deck():
    hplc, pump = Pump(), Pump()
    found, _ = _script_instruments(_script(HPLC=hplc, PUMP_2=pump))
    assert found == {"HPLC": hplc, "PUMP_2": pump}


def test_standard_library_values_and_enum_members_are_said_and_skipped():
    found, skipped = _script_instruments(_script(
        DATA_DIR=pathlib.Path("."), LOCK=threading.Lock(), EVENT=threading.Event(), Q=queue.Queue(),
        PATTERN=re.compile("x"), TIMEOUT=datetime.timedelta(seconds=5), START=datetime.datetime.now(),
        DEFAULTS=collections.OrderedDict(), COUNTS=collections.defaultdict(int), RUN_ID=uuid.uuid4(),
        PARTIAL=functools.partial(print), logger=logging.getLogger("pump"), MODE=Mode.FAST,
    ))
    assert found == {}
    assert skipped["DATA_DIR"].endswith("from Python itself")
    assert skipped["MODE"] == "a Mode value"


def test_exclude_names_leaves_out_the_scripts_own_objects():
    pump = Pump()
    found, skipped = _script_instruments(_script(pump=pump, CONFIG=LabConfig()), exclude_names=["CONFIG"])
    assert found == {"pump": pump}
    assert skipped == {"CONFIG": "exclude_names"}


def test_quiet_skips():
    found, skipped = _script_instruments(_script(
        _private=Pump(), Pump=Pump, helper=lambda: None, typing=typing,
        plugin=Plugin(id="viz", name="Viz"), speed=5, name="bench", PORT="COM3",
    ))
    assert found == {} and skipped == {}


def test_a_driver_file_named_like_a_standard_module_is_still_user_code(tmp_path, monkeypatch):
    # `test` is a standard module name; a driver called test.py beside the script shadows it.
    (tmp_path / "test.py").write_text("class Pump:\n    def dispense(self, v: float):\n        return v\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.delitem(sys.modules, "test", raising=False)
    import test as driver
    assert os.path.dirname(driver.__file__) == str(tmp_path)
    pump = driver.Pump()
    found, _ = _script_instruments(_script(pump=pump))
    assert found == {"pump": pump}
