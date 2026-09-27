"""A deck described as data: which drivers to install, and which instruments to build from them.

The original way to start an edge is a Python script that constructs each instrument and hands its
own module to `run(__name__)` (see example/demo.py). That is fine for someone who writes Python,
and impossible for an app: the desktop launcher, and the Hub's "install this stack" flow behind
it, need to add, remove and reconfigure instruments without generating and editing code. So the
same information lives in a JSON file:

    {
      "format": "ivoryos-deck/1",
      "name": "Suzuki bench",
      "packages": ["vendor-pumps==1.4.2"],
      "paths": ["drivers"],
      "instruments": [
        {
          "name": "pump_1",
          "import": "vendor_pumps.syringe",
          "class": "SyringePump",
          "args": {"port": "COM3", "settings": {"$object": {"import": "vendor_pumps.syringe",
                                                             "class": "PumpSettings",
                                                             "args": {"max_rate": 20}}}},
          "calls": [{"method": "connect"}]
        }
      ]
    }

- `packages` are pip requirements. This module never installs anything: the desktop app (or a
  person, with `uv pip install`) does that before the server starts. It is here so one file
  describes the whole deck.
- `paths` are folders, relative to the deck file, added to `sys.path`, for a lab's own driver
  modules that are not packages.
- `args` are keyword arguments to the constructor. A value `{"$object": {import, class, args}}`
  builds that object first, which is how the Hub's nested init arguments are expressed.
- `calls` run after construction, in order: the structured form of the Hub's `python_command`
  (e.g. `device.connect()`), without evaluating a string of code.
- `"enabled": false` keeps an entry without loading it, e.g. an instrument that is unplugged.

**One instrument failing never stops the others.** A driver whose constructor cannot open its
serial port, a package that is not installed, a typo in a class name: each becomes an entry in
the errors list, the rest of the deck loads, and the Instruments page says what went wrong. A
script-started edge crashed on the first bad device instead, which on a real bench is the normal
state of affairs for at least one instrument on any given morning.
"""

import importlib
import json
import keyword
import os
import sys
import traceback
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

DECK_FORMAT = "ivoryos-deck/1"


class DeckFileError(Exception):
    """The deck file itself could not be read. Individual instrument problems are not raised."""


@dataclass
class DeckLoad:
    instruments: Dict[str, Any] = field(default_factory=dict)
    # One entry per instrument that did not load: {name, import, class, stage, error, detail}.
    errors: List[Dict[str, Any]] = field(default_factory=list)
    config: Dict[str, Any] = field(default_factory=dict)
    path: Optional[str] = None


def read_deck(path: str) -> Dict[str, Any]:
    """Parse and shape-check a deck file. Raises DeckFileError with a readable message."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            config = json.load(handle)
    except FileNotFoundError:
        raise DeckFileError(f"Deck file not found: {path}")
    except json.JSONDecodeError as e:
        raise DeckFileError(f"Deck file is not valid JSON ({path}, line {e.lineno}): {e.msg}")
    if not isinstance(config, dict):
        raise DeckFileError(f"Deck file must contain a JSON object: {path}")
    fmt = config.get("format", DECK_FORMAT)
    if fmt != DECK_FORMAT:
        raise DeckFileError(f"Unsupported deck format '{fmt}' (this edge reads '{DECK_FORMAT}')")
    for key in ("instruments", "packages", "paths"):
        if key in config and not isinstance(config[key], list):
            raise DeckFileError(f"'{key}' must be a list in {path}")
    return config


def load_deck(path: str) -> DeckLoad:
    """Read a deck file and build every enabled instrument in it.

    A file that cannot be read at all is reported as a single deck-level error with no
    instruments, rather than raised, so a server started from it still comes up and shows why.
    """
    path = os.path.abspath(path)
    result = DeckLoad(path=path)
    try:
        config = read_deck(path)
    except DeckFileError as e:
        result.errors.append({"name": None, "stage": "deck", "error": str(e)})
        return result
    result.config = config

    base = os.path.dirname(path)
    for rel in config.get("paths") or []:
        folder = os.path.normpath(os.path.join(base, str(rel)))
        if folder not in sys.path:
            sys.path.insert(0, folder)

    seen = set()
    for index, entry in enumerate(config.get("instruments") or []):
        if not isinstance(entry, dict):
            result.errors.append({"name": None, "stage": "config",
                                  "error": f"Instrument #{index + 1} is not an object"})
            continue
        if entry.get("enabled") is False:
            continue
        name = entry.get("name")
        problem = _name_problem(name, seen)
        if problem:
            result.errors.append(_error(entry, "config", problem))
            continue
        seen.add(name)
        try:
            result.instruments[name] = build_instrument(entry)
        except _StageError as e:
            result.errors.append(_error(entry, e.stage, str(e.__cause__ or e), e.detail))
    return result


def _name_problem(name, seen) -> Optional[str]:
    # The name is how a workflow step, a `#variable`, and generated Python refer to the
    # instrument, so it has to be usable as a Python identifier -- the same constraint the
    # script-based decks imposed implicitly by being variable names.
    if not isinstance(name, str) or not name:
        return "Instrument has no 'name'"
    if not name.isidentifier() or keyword.iskeyword(name):
        return f"'{name}' is not a valid instrument name (letters, digits and underscores; not starting with a digit)"
    if name.startswith("_"):
        return f"'{name}' starts with an underscore, which marks internal names"
    if name in seen:
        return f"Two instruments are named '{name}'"
    return None


class _StageError(Exception):
    def __init__(self, stage: str, detail: str = ""):
        super().__init__(stage)
        self.stage = stage
        self.detail = detail


def _error(entry, stage, message, detail=""):
    return {
        "name": entry.get("name"),
        "import": entry.get("import"),
        "class": entry.get("class"),
        "stage": stage,
        "error": message,
        **({"detail": detail} if detail else {}),
    }


def _resolve_class(import_path, class_name):
    if not import_path or not class_name:
        raise ValueError("needs both 'import' (a module path) and 'class'")
    module = importlib.import_module(str(import_path))
    try:
        return getattr(module, str(class_name))
    except AttributeError:
        raise AttributeError(f"module '{import_path}' has no class '{class_name}'")


def _build_value(value):
    """Turn `{"$object": {...}}` into the object it describes, recursively; leave the rest."""
    if isinstance(value, dict):
        if set(value.keys()) == {"$object"} and isinstance(value["$object"], dict):
            spec = value["$object"]
            cls = _resolve_class(spec.get("import"), spec.get("class"))
            return cls(**{k: _build_value(v) for k, v in (spec.get("args") or {}).items()})
        return {k: _build_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_build_value(v) for v in value]
    return value


def build_instrument(entry: Dict[str, Any]):
    """Import, construct and set up one instrument. Raises _StageError naming the failed stage."""
    try:
        cls = _resolve_class(entry.get("import"), entry.get("class"))
    except Exception as e:
        raise _StageError("import", traceback.format_exc(limit=3)) from e

    args = entry.get("args") or {}
    if not isinstance(args, dict):
        raise _StageError("config") from ValueError("'args' must be an object of keyword arguments")
    try:
        instance = cls(**{k: _build_value(v) for k, v in args.items()})
    except Exception as e:
        raise _StageError("init", traceback.format_exc(limit=5)) from e

    for call in entry.get("calls") or []:
        method_name = call.get("method") if isinstance(call, dict) else None
        try:
            if not method_name:
                raise ValueError("each entry in 'calls' needs a 'method'")
            method = getattr(instance, method_name)
            outcome = method(**{k: _build_value(v) for k, v in (call.get("args") or {}).items()})
            if hasattr(outcome, "__await__"):
                # A driver's async `connect()`: nothing is running an event loop yet at load
                # time, so run it to completion here rather than leaving a never-awaited coroutine.
                import asyncio
                asyncio.run(_await(outcome))
        except Exception as e:
            raise _StageError("setup", traceback.format_exc(limit=5)) from e
    return instance


async def _await(awaitable):
    return await awaitable
