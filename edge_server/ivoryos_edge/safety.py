"""A safety guard that lives outside the drivers.

A driver says what an instrument *can* do. What a lab *allows* it to do is a different question,
and the answer belongs to the bench, not to the driver: this heater block may go to 150 C, but
with these vials nothing above 120; no pump dispenses while the reactor is hot; a rack has 24
positions and "A7" is not one of them. Writing that into driver code means editing a vendor's
package (or the Hub's), and it disappears with the next install. So it is data, one file per
edge (`safety.json` in the data folder, edited on the Safety page):

    {
      "format": "ivoryos-safety/1",
      "enabled": true,
      "trays": {
        "vial_rack": {"label": "Vial rack", "rows": 4, "columns": 6, "naming": "A1",
                      "order": "row", "blocked": ["D6"]}
      },
      "limits": [
        {"target": "reactor", "method": "set_temperature", "param": "setpoint_c", "min": 0, "max": 120},
        {"target": "class:SyringePump", "method": "dispense", "param": "volume_ml", "min": 0, "max": 10},
        {"target": "reactor", "method": "load_vial", "param": "vial_id", "tray": "vial_rack"},
        {"target": "handler", "method": "place_vial", "param": "station", "allowed": ["rack", "reactor"]}
      ],
      "rules": [
        {"id": "hot", "name": "No dispensing into a hot vial", "enabled": true,
         "when": {"target": "class:SyringePump", "method": "dispense"},
         "if": [{"left": {"arg": "volume_ml"}, "op": ">", "right": {"value": 1}}],
         "require": [{"left": {"read": "reactor.read_temperature"}, "op": "<=", "right": {"value": 60}}],
         "message": "Cool the reactor below 60 C before dispensing."}
      ]
    }

- **What a driver declares needs no limit.** A field typed as an Enum or a Literal takes only
  its own choices, checked with nothing configured (`declared_choices`).
- **Limits** are per field: a number range, a list of allowed values, or "a position on this
  tray". `target` is an instrument's name or `class:<DriverClass>`, which covers every instrument
  built from that class (or a subclass); an instrument's own limit wins over its class's. `param`
  is dotted for a field of an object argument (`config.mode`); a property setter is the method
  `<name>_(setter)` with the field `value`. An omitted argument is checked at the driver's default.
- **Trays** are row-by-column layouts with a naming scheme: `A1` (A1, A2 ... D6), `A01`, `1`
  (1, 2, 3 ...) or `0` (0, 1, 2 ...), the numbered ones counted along rows or along columns
  (`order`). `blocked` positions exist on the tray and may not be used.
- **Rules** are deck-level interlocks: when a call matches `when` (and every `if` clause is
  true), every `require` clause must be true or the call is blocked with `message`. A clause
  compares two operands: `{"arg": name}` (an argument of this call), `{"read": "inst.member"}`
  (a property or a method that needs no arguments, read at that moment; `path` picks a field of
  a structured result), `{"last": "inst.method.param"}` (the last value sent through this edge;
  `{"last": "inst"}` is the name of the last method called on it), or `{"value": x}`. Something
  that cannot be determined (a reading that fails, a value never sent since the edge started)
  blocks: a guard that passes what it cannot check is not a guard.

- **States** are the deck's condition in the lab's own words, because no two drivers agree on
  theirs (`arm.gripper(state="open")`, `arm.open_gripper()`): `"states": {"balance_door":
  {"label": "Balance door", "values": ["open", "closed"], ...}}`. Each driver is mapped onto a
  state here, in data, and nothing in a driver changes. A state gets its value one of two ways:
  `"read": {"read": "balance.door_state", "map": {"True": "open", "False": "closed"}}` asks the
  instrument every time it is needed, so a restart changes nothing; or `"set_by": [{"target":
  "balance", "method": "open_door", "value": "open"}, ...]` says which calls change it and to
  what (a fixed value, `{"arg": name}`, or `{"result": path}`), optionally only `"if"` some
  clauses hold. A value set that way is kept on disk and survives a restart: the container is
  still on the pan. A rule reads one as `{"state": "balance_door"}`. A state is unknown, which
  blocks, only when nothing has ever set it or a call that sets it did not finish; a person
  settles it on the Safety page. This is also how a driver method that does a whole sequence
  inside itself is handled: its net effect is declared on the one call, and what it does on the
  way is not the guard's business.

**Where it is enforced.** `enforce()` runs immediately before a call is handed to a driver, in
every place that happens: a run's step, an optimization trial's step, and a manual Execute. In a
run a blocked step is a failed step, so the run pauses and a person chooses retry, skip or stop
like any other failure. `check_run()` additionally refuses a run before anything moves when a
value already written into it is out of bounds (and an optimization whose search range reaches
past a limit): the same reason `unproduced_references` exists.

**A file that cannot be read blocks everything** until it is fixed or replaced on the Safety
page. Starting unguarded because of a stray comma would be the wrong way to fail.

The pages never compute a tray's position names themselves: `view()` hands them the grid.
"""

import asyncio
import inspect
import json
import os
import time
import uuid
from collections import deque
from typing import Any, Dict, List, Optional, Tuple

from . import paths
from .introspection import has_member, resolve_callable, resolve_output_path, serialize_result, _MISSING

SAFETY_FORMAT = "ivoryos-safety/1"
NAMINGS = ("A1", "A01", "1", "0")
ORDERS = ("row", "column")
MAX_TRAY_SIDE = 100
OPS = ("<", "<=", ">", ">=", "==", "!=", "in", "not in")
CLASS_PREFIX = "class:"
ANY = "*"
# A reading a rule depends on must not be able to hold the queue forever.
READ_TIMEOUT_S = 10.0
# How many problems a refused run lists before "and N more": 24 rows over one limit is one fact.
MAX_REPORTED = 6
_NOT_INSTRUMENTS = ("Flow Control", "Flow_Control", "Library Workflows")
# A rule's reading is *called* every time the rule is checked. A property getter is a reading by
# construction; a method is taken for one only when its name says so. Anything else may be saved,
# with a warning that says exactly that: `pump.prime` takes no arguments and returns something
# too, and a rule that "read" it would prime the pump before every dispense.
READING_PREFIXES = ("read", "get", "is_", "has_", "check", "query")


def looks_like_reading(member: str, entry: Optional[dict]) -> bool:
    if (entry or {}).get("property_access") == "get":
        return True
    return str(member).lower().startswith(READING_PREFIXES)


class SafetyViolation(Exception):
    """A call the guard refused. `problems` are complete sentences."""

    def __init__(self, problems: List[str]):
        self.problems = list(problems)
        super().__init__("Blocked by the safety guard: " + " ".join(self.problems))


class SafetyConfigError(Exception):
    """A configuration that cannot be saved. `problems` is validate()'s list."""

    def __init__(self, problems: List[dict]):
        self.problems = problems
        errors = [p["message"] for p in problems if p["level"] == "error"]
        super().__init__(" ".join(errors) or "The safety configuration is not valid.")


def empty_config() -> dict:
    return {"format": SAFETY_FORMAT, "enabled": True, "trays": {}, "states": {}, "limits": [], "rules": []}


# --- Values -----------------------------------------------------------------------------------

def _as_number(value) -> Optional[float]:
    """The value as a number, or None. NaN is not a number here: it compares false against every
    bound, so it would pass any limit."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value.strip() if isinstance(value, str) else value)
    except (TypeError, ValueError):
        return None
    return None if number != number else number


def _fmt(value) -> str:
    """A value as a person would write it: 120 rather than 120.0, text in quotes."""
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, (int, float)):
        return f"{value:g}" if abs(value) < 1e15 else str(value)
    if isinstance(value, str):
        return f"'{value}'"
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return str(value)


def _is_reference(value) -> bool:
    return isinstance(value, str) and value.strip().startswith("#")


def _dig(obj, path: str):
    """A dotted path into nested arguments, or _MISSING."""
    current = obj
    for part in str(path).split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return _MISSING
    return current


def _schema_param(method_schema: dict, path: str) -> Optional[dict]:
    """The schema entry of a (possibly nested) parameter, or None."""
    fields = (method_schema or {}).get("parameters") or {}
    entry = None
    for part in str(path).split("."):
        entry = fields.get(part) if isinstance(fields, dict) else None
        if entry is None:
            return None
        fields = entry.get("fields") or {}
    return entry


def _argument(args: dict, method_schema: dict, path: str):
    """What the driver will receive for `path`: the given value, else its default, else _MISSING."""
    value = _dig(args or {}, path)
    if value is _MISSING:
        entry = _schema_param(method_schema, path)
        if entry is not None and "default" in entry:
            return entry["default"]
    return value


# --- Trays ------------------------------------------------------------------------------------

def row_label(index: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA: a 1536-well plate has rows up to AF."""
    label = ""
    index += 1
    while index > 0:
        index, rem = divmod(index - 1, 26)
        label = chr(65 + rem) + label
    return label


def tray_grid(tray: dict) -> List[List[str]]:
    """Every position's name, as rows of columns, the way the tray looks from above."""
    rows, columns = tray["rows"], tray["columns"]
    naming = tray.get("naming", "A1")
    if naming in ("A1", "A01"):
        width = max(2, len(str(columns))) if naming == "A01" else 0
        return [[f"{row_label(r)}{c + 1:0{width}d}" for c in range(columns)] for r in range(rows)]
    start = 1 if naming == "1" else 0
    by_column = tray.get("order") == "column"
    return [[str(start + (c * rows + r if by_column else r * columns + c)) for c in range(columns)]
            for r in range(rows)]


def tray_positions(tray: dict) -> List[str]:
    return [name for row in tray_grid(tray) for name in row]


def describe_tray(name: str, tray: dict) -> str:
    grid = tray_grid(tray)
    names = [n for row in grid for n in row]
    first, last = names[0], names[-1]
    if tray.get("naming") in ("1", "0"):
        first, last = str(min(int(n) for n in names)), str(max(int(n) for n in names))
    return f"{tray.get('label') or name} ({tray['rows']} x {tray['columns']}, {first} to {last})"


def _position_text(value) -> str:
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).strip()


def check_value(constraint: dict, value, trays: dict) -> List[Tuple[str, str]]:
    """Why `value` breaks `constraint`: (the value as shown, the reason), one per offending value.

    A list is checked element by element (`wells: List[str]`). Nothing given and '#references'
    are skipped: the first is somebody else's error, the second is checked again once the run has
    put a real value there.
    """
    problems = []
    values = value if isinstance(value, (list, tuple)) else [value]
    for item in values:
        if item is None or item == "" or _is_reference(item):
            continue
        shown = _fmt(item)
        if "min" in constraint or "max" in constraint:
            number = _as_number(item)
            if number is None:
                problems.append((shown, "is not a number, and this field has a limit"))
                continue
            if "min" in constraint and number < constraint["min"]:
                problems.append((shown, f"is below the minimum of {_fmt(constraint['min'])}"))
            if "max" in constraint and number > constraint["max"]:
                problems.append((shown, f"is above the maximum of {_fmt(constraint['max'])}"))
        if constraint.get("allowed") is not None:
            allowed = [str(a) for a in constraint["allowed"]]
            if _position_text(item) not in allowed:
                # `declared`: the list is the driver's own (an Enum or Literal), not this bench's.
                why = "is not one of its choices (" if constraint.get("declared") else "is not allowed here (allowed: "
                problems.append((shown, why + ", ".join(allowed) + ")"))
        tray_name = constraint.get("tray")
        if tray_name:
            tray = trays.get(tray_name)
            if tray is None:
                problems.append((shown, f"cannot be checked: tray '{tray_name}' is not defined"))
                continue
            position = _position_text(item)
            if position not in tray_positions(tray):
                problems.append((shown, f"is not a position on {describe_tray(tray_name, tray)}"))
            elif position in (tray.get("blocked") or []):
                problems.append((shown, f"is a blocked position on {tray.get('label') or tray_name}"))
    return problems


def declared_choices(method_schema: dict, _fields: Optional[dict] = None, _prefix: str = "") -> Dict[str, dict]:
    """The choices a driver itself declares, per field: an Enum's values, a Literal's options.

    Nobody should have to write a limit to repeat what the type already says, and without this
    nothing held a value to it: `cast_value` passes a value outside an Enum or a Literal straight
    through, so `mode="warp"` reached a method declared `Literal["fast", "slow"]`. These are
    enforced with no configuration; a limit's own `allowed` can only narrow them. bool is left
    out: its "choices" are a form's True/False, and the cast accepts other spellings.
    """
    out: Dict[str, dict] = {}
    fields = (method_schema or {}).get("parameters") if _fields is None else _fields
    for name, info in (fields or {}).items():
        if not isinstance(info, dict):
            continue
        path = f"{_prefix}{name}"
        if info.get("is_object") and info.get("fields"):
            out.update(declared_choices({}, info["fields"], path + "."))
        elif info.get("options") is not None and str(info.get("type") or "").lower() != "bool":
            out[path] = {"allowed": list(info["options"]), "declared": True}
    return out


# --- The deck, as the guard needs it ------------------------------------------------------------

class Deck:
    """The instruments a configuration is checked against: live objects and their schemas."""

    def __init__(self, instruments: Optional[dict] = None, schemas: Optional[dict] = None):
        self.instruments = instruments or {}
        self.schemas = schemas or {}

    def names(self) -> List[str]:
        return list(dict.fromkeys([*self.schemas, *self.instruments]))

    def classes(self, name: str) -> List[str]:
        """The instrument's class and its bases, most derived first."""
        instance = self.instruments.get(name)
        if instance is None:
            return []
        return [c.__name__ for c in type(instance).__mro__ if c is not object]

    def specificity(self, name: str, target: str) -> Optional[int]:
        """How closely `target` names this instrument: 0 its own name, 1 its class, 2 a base
        class ..., None when it does not apply. The lowest wins."""
        if target == name:
            return 0
        if target.startswith(CLASS_PREFIX):
            classes = self.classes(name)
            wanted = target[len(CLASS_PREFIX):]
            if wanted in classes:
                return 1 + classes.index(wanted)
        return None

    def matches(self, name: str, target: str) -> bool:
        return target == ANY or self.specificity(name, target) is not None


def resolve_fields(config: dict, deck: Deck) -> Dict[str, Dict[str, Dict[str, dict]]]:
    """Every limit, laid out per instrument -> method -> field, class targets expanded."""
    out: Dict[str, Dict[str, Dict[str, dict]]] = {}
    rank: Dict[tuple, int] = {}
    for limit in config.get("limits") or []:
        for name in deck.names():
            closeness = deck.specificity(name, limit["target"])
            if closeness is None or limit["method"] not in (deck.schemas.get(name) or {}):
                continue
            key = (name, limit["method"], limit["param"])
            if key in rank and rank[key] <= closeness:
                continue
            rank[key] = closeness
            constraint = {k: limit[k] for k in ("min", "max", "allowed", "tray", "note") if k in limit}
            constraint["source"] = limit["target"]
            out.setdefault(name, {}).setdefault(limit["method"], {})[limit["param"]] = constraint
    return out


# --- Validation ---------------------------------------------------------------------------------

def _whole(value) -> Optional[int]:
    number = _as_number(value)
    return int(number) if number is not None and float(number).is_integer() else None


def _tidy_number(number: float):
    return int(number) if float(number).is_integer() else number


def validate(raw, deck: Optional[Deck] = None) -> Tuple[dict, List[dict]]:
    """Shape-check a configuration. Returns (the normalized configuration, problems).

    A problem is {level, where, message}. An `error` means the configuration cannot be saved. A
    `warning` is something that does nothing on *this* deck (a limit for an instrument that is
    not loaded this morning): saved anyway, because it will mean something again tomorrow.
    """
    problems: List[dict] = []

    def err(where, message):
        problems.append({"level": "error", "where": where, "message": message})

    def warn(where, message):
        problems.append({"level": "warning", "where": where, "message": message})

    config = empty_config()
    if not isinstance(raw, dict):
        err("config", "The safety configuration must be an object.")
        return config, problems
    if raw.get("format", SAFETY_FORMAT) != SAFETY_FORMAT:
        err("config", f"Unsupported format '{raw.get('format')}' (this edge reads '{SAFETY_FORMAT}').")
    config["enabled"] = raw.get("enabled", True) is not False

    trays = raw.get("trays") or {}
    if not isinstance(trays, dict):
        err("trays", "'trays' must be an object of named trays.")
        trays = {}
    for name, entry in trays.items():
        where = f"trays.{name}"
        name = str(name).strip()
        if not name or not isinstance(entry, dict):
            err(where, "A tray needs a name and a description.")
            continue
        rows, columns = _whole(entry.get("rows")), _whole(entry.get("columns"))
        if not rows or not columns or not (1 <= rows <= MAX_TRAY_SIDE) or not (1 <= columns <= MAX_TRAY_SIDE):
            err(where, f"Tray '{name}' needs rows and columns between 1 and {MAX_TRAY_SIDE}.")
            continue
        naming = str(entry.get("naming") or "A1")
        order = str(entry.get("order") or "row")
        if naming not in NAMINGS:
            err(where, f"Tray '{name}': positions are named one of {', '.join(NAMINGS)}, not '{naming}'.")
            continue
        if order not in ORDERS:
            err(where, f"Tray '{name}': numbering runs along 'row' or 'column', not '{order}'.")
            continue
        tray = {"label": str(entry.get("label") or name).strip(), "rows": rows, "columns": columns,
                "naming": naming, "order": order, "blocked": []}
        positions = set(tray_positions(tray))
        for blocked in entry.get("blocked") or []:
            position = _position_text(blocked)
            if position not in positions:
                err(where, f"Tray '{name}' blocks '{position}', which is not one of its positions.")
            elif position not in tray["blocked"]:
                tray["blocked"].append(position)
        config["trays"][name] = tray

    states = raw.get("states") or {}
    if not isinstance(states, dict):
        err("states", "'states' must be an object of named states.")
        states = {}
    # Known before any clause is read: a rule, or another state's condition, may name one.
    state_names = {str(name).strip() for name in states}
    for name, entry in states.items():
        checked = _validate_state(str(name).strip(), entry, f"states.{name}", deck, err, warn, state_names)
        if checked is not None:
            config["states"][str(name).strip()] = checked

    limits = raw.get("limits") or []
    if not isinstance(limits, list):
        err("limits", "'limits' must be a list.")
        limits = []
    seen = set()
    for index, limit in enumerate(limits):
        where = f"limits[{index}]"
        if not isinstance(limit, dict):
            err(where, "A limit must be an object.")
            continue
        target, method, param = (str(limit.get(k) or "").strip() for k in ("target", "method", "param"))
        if not (target and method and param):
            err(where, "A limit needs an instrument (or class), a method and a field.")
            continue
        label = f"{target}.{method}.{param}"
        entry: Dict[str, Any] = {"target": target, "method": method, "param": param}
        for bound in ("min", "max"):
            if limit.get(bound) in (None, ""):
                continue
            number = _as_number(limit[bound])
            if number is None:
                err(where, f"{label}: the {bound}imum must be a number, not {_fmt(limit[bound])}.")
            else:
                entry[bound] = _tidy_number(number)
        if "min" in entry and "max" in entry and entry["min"] > entry["max"]:
            err(where, f"{label}: the minimum ({_fmt(entry['min'])}) is above the maximum ({_fmt(entry['max'])}).")
        if limit.get("allowed") is not None:
            allowed = limit["allowed"]
            if not isinstance(allowed, list) or not allowed:
                err(where, f"{label}: 'allowed' must be a list with at least one value.")
            else:
                entry["allowed"] = allowed
        if limit.get("tray"):
            tray_name = str(limit["tray"]).strip()
            if tray_name not in config["trays"]:
                err(where, f"{label} uses tray '{tray_name}', which is not defined.")
            else:
                entry["tray"] = tray_name
        if limit.get("note"):
            entry["note"] = str(limit["note"])
        if not any(k in entry for k in ("min", "max", "allowed", "tray")):
            err(where, f"{label} sets nothing: give it a minimum, a maximum, allowed values or a tray.")
            continue
        if (target, method, param) in seen:
            err(where, f"{label} has two limits. Keep one.")
            continue
        seen.add((target, method, param))
        config["limits"].append(entry)
        if deck is not None:
            _warn_about_limit(entry, label, where, deck, config, warn)

    rules = raw.get("rules") or []
    if not isinstance(rules, list):
        err("rules", "'rules' must be a list.")
        rules = []
    ids = set()
    for index, rule in enumerate(rules):
        where = f"rules[{index}]"
        if not isinstance(rule, dict):
            err(where, "A rule must be an object.")
            continue
        when = rule.get("when") if isinstance(rule.get("when"), dict) else {}
        target = str(when.get("target") or "").strip()
        method = str(when.get("method") or "").strip() or ANY
        name = str(rule.get("name") or "").strip() or f"Rule {index + 1}"
        if not target:
            err(where, f"'{name}' needs the instrument (or class) it applies to.")
            continue
        rule_id = str(rule.get("id") or "").strip()
        if not rule_id or rule_id in ids:
            rule_id = uuid.uuid4().hex[:8]
        ids.add(rule_id)
        entry = {"id": rule_id, "name": name, "enabled": rule.get("enabled", True) is not False,
                 "when": {"target": target, "method": method}, "if": [], "require": [],
                 "message": str(rule.get("message") or "").strip()}
        for part in ("if", "require"):
            clauses = rule.get(part) or []
            if not isinstance(clauses, list):
                err(where, f"'{name}': '{part}' must be a list of conditions.")
                continue
            for j, clause in enumerate(clauses):
                checked = _validate_clause(clause, f"{where}.{part}[{j}]", name, method, deck, err, warn, state_names)
                if checked:
                    entry[part].append(checked)
        if not (rule.get("require") or []):
            err(where, f"'{name}' needs at least one condition that must hold.")
        if deck is not None and target != ANY:
            matched = [n for n in deck.names() if deck.matches(n, target)]
            if not matched:
                warn(where, f"'{name}': no instrument on this deck matches '{target}', so it does nothing yet.")
            elif method != ANY and not any(method in (deck.schemas.get(n) or {}) for n in matched):
                warn(where, f"'{name}': '{method}' is not a method of {target}.")
        config["rules"].append(entry)

    return config, problems


def _warn_about_limit(entry, label, where, deck: Deck, config, warn):
    matched = [n for n in deck.names() if deck.specificity(n, entry["target"]) is not None]
    if not matched:
        warn(where, f"{label}: no instrument on this deck matches '{entry['target']}', so this limit does nothing yet.")
        return
    schemas = [deck.schemas[n][entry["method"]] for n in matched if entry["method"] in (deck.schemas.get(n) or {})]
    if not schemas:
        warn(where, f"{label}: '{entry['method']}' is not a method of {entry['target']}.")
        return
    found = [(s, _schema_param(s, entry["param"])) for s in schemas]
    if all(info is None and not s.get("accepts_kwargs") for s, info in found):
        warn(where, f"{label}: '{entry['method']}' has no field '{entry['param']}'.")
        return
    info = next((i for _, i in found if i is not None), None) or {}
    type_name = str(info.get("type") or "").lower()
    numeric = info.get("numeric") or "int" in type_name or "float" in type_name
    if ("min" in entry or "max" in entry) and type_name and type_name not in ("any", "unknown") and not numeric:
        warn(where, f"{label} is a {info.get('type')}, so a number range may never be satisfied.")
    if entry.get("tray") and numeric and config["trays"][entry["tray"]]["naming"] in ("A1", "A01"):
        warn(where, f"{label} is a number, but tray '{entry['tray']}' names its positions with letters.")


def _validate_state(name, entry, where, deck, err, warn, state_names) -> Optional[dict]:
    if not name or "." in name or not isinstance(entry, dict):
        err(where, "A state needs a name (without a dot) and a description.")
        return None
    values = entry.get("values") or []
    if isinstance(values, str):
        values = values.split(",")
    if not isinstance(values, list):
        err(where, f"State '{name}': 'values' must be a list.")
        return None
    values = list(dict.fromkeys(str(v).strip() for v in values if str(v).strip()))
    state: Dict[str, Any] = {"label": str(entry.get("label") or name).strip(), "values": values, "set_by": []}

    def known(value, source) -> bool:
        if values and str(value) not in values:
            err(where, f"State '{name}': {source} gives {_fmt(value)}, which is not one of its values ({', '.join(values)}).")
            return False
        return True

    reading = entry.get("read")
    if isinstance(reading, str):
        reading = {"read": reading}
    if isinstance(reading, dict) and str(reading.get("read") or "").strip():
        operand = _validate_operand({"read": reading.get("read"), "path": reading.get("path")},
                                    where, name, ANY, deck, err, warn, state_names)
        mapping = reading.get("map") or {}
        if not isinstance(mapping, dict):
            err(where, f"State '{name}': 'map' must be an object of reading -> value.")
            mapping = {}
        mapping = {str(k): v for k, v in mapping.items() if str(k) != "" and v not in (None, "")}
        for raw_value, mapped in mapping.items():
            known(mapped, f"the reading {_fmt(raw_value)}")
        if operand:
            state["read"] = {**operand, **({"map": mapping} if mapping else {})}

    effects = entry.get("set_by") or []
    if not isinstance(effects, list):
        err(where, f"State '{name}': 'set_by' must be a list.")
        effects = []
    for index, effect in enumerate(effects):
        ewhere = f"{where}.set_by[{index}]"
        if not isinstance(effect, dict):
            err(ewhere, f"State '{name}': each thing that sets it must be an object.")
            continue
        target, method = (str(effect.get(k) or "").strip() for k in ("target", "method"))
        if not target or not method or method == ANY:
            err(ewhere, f"State '{name}': say which instrument's method sets it.")
            continue
        value = effect.get("value")
        if isinstance(value, dict):
            if str(value.get("arg") or "").strip():
                value = {"arg": str(value["arg"]).strip()}
            elif "result" in value:
                value = {"result": str(value.get("result") or "").strip()}
            else:
                err(ewhere, f"State '{name}': {target}.{method} sets it to a value, an argument or a field of its result.")
                continue
        elif value is None or value == "":
            err(ewhere, f"State '{name}': say what {target}.{method} sets it to.")
            continue
        elif not known(value, f"{target}.{method}"):
            continue
        item: Dict[str, Any] = {"target": target, "method": method, "value": value}
        conditions = effect.get("if") or []
        clauses = [c for c in (
            _validate_clause(clause, f"{ewhere}.if[{k}]", name, method, deck, err, warn, state_names)
            for k, clause in enumerate(conditions if isinstance(conditions, list) else [])
        ) if c]
        if clauses:
            item["if"] = clauses
        state["set_by"].append(item)
        if deck is not None and target != ANY:
            matched = [n for n in deck.names() if deck.matches(n, target)]
            if not matched:
                warn(ewhere, f"State '{name}': no instrument on this deck matches '{target}', so it never sets it.")
            elif not any(method in (deck.schemas.get(n) or {}) for n in matched):
                warn(ewhere, f"State '{name}': '{method}' is not a method of {target}.")
    if state.get("read") and state["set_by"]:
        warn(where, f"State '{name}' is read from the instrument, so what its methods would set is ignored.")
    return state


def _validate_clause(clause, where, rule_name, rule_method, deck, err, warn, states=None) -> Optional[dict]:
    if not isinstance(clause, dict):
        err(where, f"'{rule_name}': a condition must be an object.")
        return None
    op = str(clause.get("op") or "").strip()
    if op not in OPS:
        err(where, f"'{rule_name}': '{op}' is not a comparison (use one of {', '.join(OPS)}).")
        return None
    left = _validate_operand(clause.get("left"), where, rule_name, rule_method, deck, err, warn, states)
    right = _validate_operand(clause.get("right"), where, rule_name, rule_method, deck, err, warn, states)
    if left is None or right is None:
        return None
    if op in ("in", "not in"):
        if "value" not in right:
            err(where, f"'{rule_name}': '{op}' compares against a list of values.")
            return None
        values = right["value"]
        if isinstance(values, str):
            values = [v.strip() for v in values.split(",") if v.strip()]
        if not isinstance(values, list) or not values:
            err(where, f"'{rule_name}': '{op}' needs at least one value to compare against.")
            return None
        right = {"value": values}
    return {"left": left, "op": op, "right": right}


def _validate_operand(raw, where, rule_name, rule_method, deck, err, warn, states=None) -> Optional[dict]:
    if not isinstance(raw, dict):
        err(where, f"'{rule_name}': each side of a condition is an argument, a reading, a state, a last value or a fixed value.")
        return None
    if "state" in raw:
        name = str(raw.get("state") or "").strip()
        if not name or (states is not None and name not in states):
            err(where, f"'{rule_name}' uses the state '{name}', which is not defined.")
            return None
        return {"state": name}
    if "arg" in raw:
        name = str(raw.get("arg") or "").strip()
        if not name:
            err(where, f"'{rule_name}': choose which argument to compare.")
            return None
        if rule_method == ANY:
            err(where, f"'{rule_name}' reads the argument '{name}', so it has to name one method rather than any.")
            return None
        return {"arg": name}
    if "read" in raw:
        ref = str(raw.get("read") or "").strip()
        instrument, _, member = ref.partition(".")
        if not instrument or not member:
            err(where, f"'{rule_name}': a reading is written instrument.member, e.g. reactor.temperature.")
            return None
        if deck is not None:
            entry = (deck.schemas.get(instrument) or {}).get(member)
            if instrument not in deck.schemas:
                warn(where, f"'{rule_name}' reads {ref}, and '{instrument}' is not on this deck: the rule will block until it is.")
            elif entry is None:
                warn(where, f"'{rule_name}' reads {ref}, and '{instrument}' has no '{member}': the rule will block.")
            elif any(p.get("required") and "default" not in p for p in (entry.get("parameters") or {}).values()):
                err(where, f"'{rule_name}' reads {ref}, which needs arguments. A reading is a property, or a method that takes none.")
                return None
            elif not looks_like_reading(member, entry):
                warn(where, f"'{rule_name}' reads {ref} by calling it every time the rule is checked. "
                            f"If '{member}' moves or changes anything, read something else.")
        out = {"read": ref}
        if raw.get("path"):
            out["path"] = str(raw["path"]).strip()
        return out
    if "last" in raw:
        ref = str(raw.get("last") or "").strip()
        parts = ref.split(".")
        if not ref or len(parts) == 2 or not all(parts):
            err(where, f"'{rule_name}': a last value is an instrument (its last action) or instrument.method.field (the last value sent).")
            return None
        return {"last": ref}
    if "value" in raw:
        return {"value": raw["value"]}
    err(where, f"'{rule_name}': each side of a condition is an argument, a reading, a last value or a fixed value.")
    return None


# --- Comparing ----------------------------------------------------------------------------------

class _Unknown:
    """An operand that could not be determined, with the reason. Blocks."""

    def __init__(self, reason: str):
        self.reason = reason


def _same(left, right) -> bool:
    a, b = _as_number(left), _as_number(right)
    if a is not None and b is not None:
        return a == b
    if isinstance(left, bool) or isinstance(right, bool):
        return str(left).strip().lower() == str(right).strip().lower()
    return str(left).strip() == str(right).strip()


def _compare(left, op: str, right):
    """True, False, or _Unknown when the two cannot be compared that way."""
    if op == "==":
        return _same(left, right)
    if op == "!=":
        return not _same(left, right)
    if op in ("in", "not in"):
        inside = any(_same(left, item) for item in (right if isinstance(right, list) else [right]))
        return inside if op == "in" else not inside
    a, b = _as_number(left), _as_number(right)
    if a is None or b is None:
        odd = left if a is None else right
        return _Unknown(f"{_fmt(odd)} is not a number")
    return {"<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]


_OP_WORDS = {"==": "must be", "!=": "must not be", "in": "must be one of", "not in": "must not be one of",
             "<": "must be below", "<=": "must be at most", ">": "must be above", ">=": "must be at least"}


def _flatten(args: dict, prefix: str = "") -> Dict[str, Any]:
    out = {}
    for key, value in (args or {}).items():
        if str(key).startswith("_"):
            continue
        path = f"{prefix}{key}"
        if isinstance(value, dict):
            out.update(_flatten(value, path + "."))
        else:
            out[path] = value
    return out


# --- The guard ----------------------------------------------------------------------------------

class Guard:
    """One per edge process: the configuration, what was last sent, and what was blocked."""

    def __init__(self, path: Optional[str] = None, state_path: Optional[str] = None):
        self.path = path or paths.SAFETY_PATH
        self.state_path = state_path or paths.SAFETY_STATE_PATH
        self.app = None  # set by server.py; where the live deck is read from
        self.config = empty_config()
        self.load_error: Optional[str] = None
        # 'inst.method.param' -> the last value sent; 'inst' -> the last method called on it.
        self.last_values: Dict[str, Any] = {}
        self.last_actions: Dict[str, str] = {}
        self.blocked: deque = deque(maxlen=50)
        # Each tracked state's {value, ts, by}, or {unknown: why, ts, by}. On disk: see _save_state.
        self.state: Dict[str, dict] = {}
        self.load()
        self._load_state()

    # -- configuration --

    def deck(self) -> Deck:
        state = getattr(self.app, "state", None)
        return Deck(getattr(state, "instruments", None), getattr(state, "instrument_schemas", None))

    def load(self) -> None:
        self.load_error = None
        if not os.path.exists(self.path):
            self.config = empty_config()
            return
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except (OSError, ValueError) as e:
            self.config = empty_config()
            self.load_error = f"The safety configuration could not be read ({self.path}): {e}"
            return
        config, problems = validate(raw)
        errors = [p["message"] for p in problems if p["level"] == "error"]
        if errors:
            self.config = empty_config()
            self.load_error = "The safety configuration is not valid: " + " ".join(errors)
            return
        self.config = config

    def replace(self, raw) -> List[dict]:
        """Validate and save a new configuration. Returns its warnings; raises on errors."""
        config, problems = validate(raw, self.deck())
        if any(p["level"] == "error" for p in problems):
            raise SafetyConfigError(problems)
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        scratch = f"{self.path}.{os.getpid()}.tmp"
        with open(scratch, "w", encoding="utf-8") as handle:
            json.dump(config, handle, indent=2)
        os.replace(scratch, self.path)
        self.config = config
        self.load_error = None
        # A state that is gone, or is now read from its instrument, has nothing left to remember.
        tracked = {name for name, spec in config["states"].items() if not spec.get("read")}
        if set(self.state) - tracked:
            self.state = {name: entry for name, entry in self.state.items() if name in tracked}
            self._save_state()
        return problems

    # -- deck states --

    def _load_state(self) -> None:
        """What was known when the edge last stopped. A file that cannot be read is an empty one:
        every tracked state is then unknown, which blocks until someone says what it is."""
        try:
            with open(self.state_path, "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            self.state = {str(k): v for k, v in stored.items() if isinstance(v, dict)} if isinstance(stored, dict) else {}
        except (OSError, ValueError):
            self.state = {}

    def _save_state(self) -> None:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(self.state_path)), exist_ok=True)
            scratch = f"{self.state_path}.{os.getpid()}.tmp"
            with open(scratch, "w", encoding="utf-8") as handle:
                json.dump(self.state, handle, indent=2)
            os.replace(scratch, self.state_path)
        except OSError as e:
            print(f"Could not save the deck state ({self.state_path}): {e}")

    def _set_state(self, name: str, by: str, value=_MISSING, unknown: Optional[str] = None) -> None:
        entry: Dict[str, Any] = {"ts": time.time(), "by": by}
        if unknown is not None or value is _MISSING:
            entry["unknown"] = unknown or "it is not known"
        else:
            entry["value"] = serialize_result(value)
        self.state[name] = entry

    def set_state_by_hand(self, name: str, value) -> None:
        """A person says what a state is (or, with None, that they do not know)."""
        spec = self.config["states"].get(name)
        if spec is None:
            raise ValueError(f"There is no state called '{name}'.")
        if spec.get("read"):
            raise ValueError(f"'{name}' is read from the instrument; it cannot be set by hand.")
        if value is None or value == "":
            self._set_state(name, "a person", unknown="a person marked it as not known")
        else:
            if spec["values"] and str(value) not in spec["values"]:
                raise ValueError(f"'{name}' is one of {', '.join(spec['values'])}, not {_fmt(value)}.")
            self._set_state(name, "a person", value=value)
        self._save_state()

    async def _state_value(self, name: str, deck: Deck, reads: dict):
        """A state's value now, or _Unknown: asked of the instrument when it has a reading,
        otherwise what the last call (or person) to set it left."""
        spec = self.config["states"].get(name)
        if spec is None:
            return _Unknown("it is not defined")
        reading = spec.get("read")
        if reading:
            key = (reading["read"], reading.get("path") or "")
            if key not in reads:
                reads[key] = await self._read(key[0], key[1], deck)
            raw = reads[key]
            if isinstance(raw, _Unknown):
                return raw
            mapping = reading.get("map") or {}
            return mapping.get(str(raw), mapping.get(str(raw).lower(), raw))
        entry = self.state.get(name)
        if entry is None:
            return _Unknown("nothing has set it yet. Say what it is on the Safety page")
        if "unknown" in entry:
            return _Unknown(f"{entry['unknown']}. Say what it is on the Safety page")
        return entry.get("value")

    async def current_states(self) -> Dict[str, dict]:
        """Every state as it stands, for the Safety page. Readings are taken now."""
        deck, reads, out = self.deck(), {}, {}
        for name, spec in self.config["states"].items():
            value = await self._state_value(name, deck, reads)
            entry = {"source": "reading" if spec.get("read") else "tracked"}
            if isinstance(value, _Unknown):
                entry["unknown"] = value.reason
            else:
                entry["value"] = value
            stored = self.state.get(name) if not spec.get("read") else None
            if stored:
                entry.update({"ts": stored.get("ts"), "by": stored.get("by")})
            out[name] = entry
        return out

    async def _effects(self, instrument: str, method: str, args: dict) -> List[tuple]:
        """What this call will set, decided as it is sent: [(state, value | {"result": path} |
        _Unknown)]. Whether an effect applies depends on the arguments and on the deck as it is
        *before* the call, so it cannot be worked out afterwards."""
        if self.load_error:
            return []
        deck = self.deck()
        context = {"instrument": instrument, "method": method, "args": args or {}, "deck": deck,
                   "schema": (deck.schemas.get(instrument) or {}).get(method) or {}, "reads": {}}
        out = []
        for name, spec in self.config["states"].items():
            if spec.get("read"):
                continue
            for effect in spec["set_by"]:
                if effect["method"] != method or not deck.matches(instrument, effect["target"]):
                    continue
                applies: Optional[bool] = True
                for clause in effect.get("if") or []:
                    applies, detail = await self._clause(clause, context)
                    if applies is not True:
                        break
                if applies is False:
                    continue
                value = effect["value"]
                if applies is None:
                    # Cannot tell whether this call changes it: afterwards it is not known.
                    value = _Unknown(f"{instrument}.{method} may have changed it ({detail})")
                elif isinstance(value, dict) and "arg" in value:
                    given = _argument(args, context["schema"], value["arg"])
                    value = _Unknown(f"{instrument}.{method} was not given '{value['arg']}'") if given is _MISSING else given
                out.append((name, value))
                break  # the first thing that applies decides
        return out

    def finish(self, sent: Optional[dict], result=_MISSING, failed: bool = False) -> None:
        """A call `enforce` let through has ended: apply what it sets. One that did not finish
        (it raised, or was stopped) leaves those states unknown: the door may be half open."""
        if not sent or not sent.get("effects"):
            return
        call = f"{sent['instrument']}.{sent['method']}"
        for name, value in sent["effects"]:
            if failed:
                self._set_state(name, call, unknown=f"{call} did not finish")
            elif isinstance(value, _Unknown):
                self._set_state(name, call, unknown=value.reason)
            elif isinstance(value, dict) and "result" in value:
                found = resolve_output_path(serialize_result(result), value["result"]) if result is not _MISSING else _MISSING
                if found is _MISSING or found is None:
                    self._set_state(name, call, unknown=f"{call} did not report it")
                else:
                    self._set_state(name, call, value=found)
            else:
                self._set_state(name, call, value=value)
        self._save_state()

    @property
    def enabled(self) -> bool:
        return bool(self.config.get("enabled", True))

    def _unreadable(self) -> List[str]:
        return [f"{self.load_error} Nothing is sent to an instrument until it is fixed on the Safety page."]

    def view(self) -> dict:
        """What a form needs: each field's limit, and each tray laid out as a grid."""
        return _view(self.config, self.deck(), self.load_error)

    def describe(self) -> dict:
        deck = self.deck()
        _, problems = validate(self.config, deck)
        return {
            "config": self.config,
            "problems": problems,
            "resolved": _view(self.config, deck, self.load_error),
            "load_error": self.load_error,
            "path": self.path,
            "classes": {name: deck.classes(name) for name in deck.names()},
            "blocked": list(self.blocked),
            "suggested_states": suggest_states(deck, self.config),
        }

    # -- checks that need no hardware --

    def check_params(self, instrument: str, method: str, params: dict,
                     fields: Optional[dict] = None, deck: Optional[Deck] = None) -> List[str]:
        """The limits one call's arguments break, as sentences. Literal values only."""
        if not self.enabled or instrument in _NOT_INSTRUMENTS:
            return []
        deck = deck or self.deck()
        fields = fields if fields is not None else resolve_fields(self.config, deck)
        method_schema = (deck.schemas.get(instrument) or {}).get(method) or {}
        # What the driver declares (Enum, Literal) holds with nothing configured; a limit is laid
        # over it, and its own `allowed` is then the list that counts.
        constraints = declared_choices(method_schema)
        for param, limit in ((fields.get(instrument) or {}).get(method) or {}).items():
            merged = {**constraints.get(param, {}), **limit}
            if "allowed" in limit:
                merged.pop("declared", None)
            constraints[param] = merged
        out = []
        for param, constraint in constraints.items():
            value = _argument(params, method_schema, param)
            if value is _MISSING:
                continue
            # serialize_result: a value handed on from an earlier step may still be the live
            # object (an Enum member), and it is its value that is being checked.
            for shown, reason in check_value(constraint, serialize_result(value), self.config["trays"]):
                out.append(f"{instrument}.{method}: {param} = {shown} {reason}.")
        return out

    def check_run(self, parameters: dict, prep: list, sequence: list, cleanup: list) -> List[str]:
        """What is already known to be out of bounds in a run, before any of it is sent."""
        if self.load_error:
            return self._unreadable()
        if not self.enabled:
            return []
        deck = self.deck()
        fields = resolve_fields(self.config, deck)
        problems: List[str] = []

        def add(messages):
            for message in messages:
                if message not in problems:
                    problems.append(message)

        def literal(steps):
            for step in steps or []:
                if isinstance(step, dict):
                    add(self.check_params(_step_instrument(step), _step_method(step), _step_params(step), fields, deck))

        literal(prep)
        literal(sequence)
        literal(cleanup)
        if (parameters or {}).get("type") == "Optimization":
            template = parameters.get("sequence_template") or []
            literal(template)
            add(self._check_search_space(parameters, template, fields))
        if len(problems) > MAX_REPORTED:
            more = len(problems) - MAX_REPORTED
            problems = problems[:MAX_REPORTED] + [f"And {more} more."]
        return problems

    def _check_search_space(self, parameters: dict, template: list, fields: dict) -> List[str]:
        """An optimizer must not be given room to suggest what the guard would then refuse."""
        space = {p.get("name"): p for p in parameters.get("parameter_space") or [] if isinstance(p, dict)}
        per_iteration = parameters.get("iteration_values") or {}
        trays = self.config["trays"]
        out = []
        for step in template:
            if not isinstance(step, dict):
                continue
            instrument, method = _step_instrument(step), _step_method(step)
            for param, constraint in ((fields.get(instrument) or {}).get(method) or {}).items():
                value = _dig(_step_params(step), param)
                if not _is_reference(value):
                    continue
                name = value.strip()[1:].strip()
                field = f"{instrument}.{method}.{param}"
                if name in per_iteration:
                    for shown, reason in check_value(constraint, per_iteration[name], trays):
                        out.append(f"'{name}' is {shown} in one iteration, which {reason} ({field}).")
                elif name in space:
                    entry = space[name]
                    bounds = entry.get("bounds") or []
                    if entry.get("type") == "choice":
                        for shown, reason in check_value(constraint, bounds, trays):
                            out.append(f"The choice {shown} for '{name}' {reason} ({field}).")
                    else:
                        range_only = {k: constraint[k] for k in ("min", "max") if k in constraint}
                        for shown, reason in check_value(range_only, bounds[:2], trays):
                            out.append(f"The search range for '{name}' reaches {shown}, which {reason} ({field}).")
        return out

    # -- the check made as a call is about to be sent --

    async def check_call(self, instrument: str, method: str, args: dict) -> List[str]:
        if self.load_error:
            return self._unreadable()
        if not self.enabled:
            return []
        deck = self.deck()
        problems = self.check_params(instrument, method, args, deck=deck)
        context = {"instrument": instrument, "method": method, "args": args or {}, "deck": deck,
                   "schema": (deck.schemas.get(instrument) or {}).get(method) or {}, "reads": {}}
        for rule in self.config["rules"]:
            if not rule["enabled"] or not deck.matches(instrument, rule["when"]["target"]):
                continue
            if rule["when"]["method"] not in (ANY, method):
                continue
            problem = await self._check_rule(rule, context)
            if problem:
                problems.append(problem)
        return problems

    async def _check_rule(self, rule: dict, context: dict) -> Optional[str]:
        for clause in rule["if"]:
            holds, _ = await self._clause(clause, context)
            if holds is False:
                return None  # does not apply. Unknown counts as applying: the cautious reading.
        for clause in rule["require"]:
            holds, detail = await self._clause(clause, context)
            if holds is not True:
                text = (rule["message"] or rule["name"]).rstrip(". ")
                return f"{text} ({detail})."
        return None

    async def _clause(self, clause: dict, context: dict) -> Tuple[Optional[bool], str]:
        left_label, left = await self._operand(clause["left"], context)
        right_label, right = await self._operand(clause["right"], context)
        for label, value in ((left_label, left), (right_label, right)):
            if isinstance(value, _Unknown):
                return None, f"{label} is unknown: {value.reason}"
        result = _compare(left, clause["op"], right)
        if isinstance(result, _Unknown):
            return None, f"{left_label} cannot be compared: {result.reason}"
        wanted = _fmt(right) if "value" in clause["right"] else f"{right_label} ({_fmt(right)})"
        if isinstance(right, list):
            wanted = ", ".join(_fmt(item) for item in right)
        return result, f"{left_label} is {_fmt(left)}, {_OP_WORDS[clause['op']]} {wanted}"

    async def _operand(self, operand: dict, context: dict):
        if "value" in operand:
            return _fmt(operand["value"]), operand["value"]
        if "state" in operand:
            name = operand["state"]
            label = (self.config["states"].get(name) or {}).get("label") or name
            return label, await self._state_value(name, context["deck"], context["reads"])
        if "arg" in operand:
            name = operand["arg"]
            value = _argument(context["args"], context["schema"], name)
            if value is _MISSING:
                return name, _Unknown("this call does not set it")
            return name, value
        if "last" in operand:
            ref = operand["last"]
            if "." not in ref:
                label = f"the last action on {ref}"
                if ref not in self.last_actions:
                    return label, _Unknown(f"nothing has been sent to {ref} since the edge started")
                return label, self.last_actions[ref]
            label = f"the last {ref}"
            if ref not in self.last_values:
                return label, _Unknown("it has not been sent since the edge started")
            return label, self.last_values[ref]
        ref, path = operand["read"], operand.get("path") or ""
        label = f"{ref}.{path}" if path else ref
        key = (ref, path)
        if key not in context["reads"]:
            context["reads"][key] = await self._read(ref, path, context["deck"])
        return label, context["reads"][key]

    async def _read(self, ref: str, path: str, deck: Deck):
        instrument, _, member = ref.partition(".")
        instance = deck.instruments.get(instrument)
        if instance is None:
            return _Unknown(f"'{instrument}' is not on this deck")
        if not has_member(instance, member):
            return _Unknown(f"'{instrument}' has no '{member}'")
        try:
            reader = resolve_callable(instance, member)
            if inspect.iscoroutinefunction(reader):
                value = await asyncio.wait_for(reader(), READ_TIMEOUT_S)
            else:
                loop = asyncio.get_running_loop()
                value = await asyncio.wait_for(loop.run_in_executor(None, reader), READ_TIMEOUT_S)
        except asyncio.TimeoutError:
            return _Unknown(f"no answer within {READ_TIMEOUT_S:g} s")
        except Exception as e:
            return _Unknown(f"reading it failed ({e})")
        value = serialize_result(value)
        if path:
            value = resolve_output_path(value, path)
            if value is _MISSING:
                return _Unknown(f"the reading has no field '{path}'")
        return value

    # -- the one call every door makes --

    async def enforce(self, instrument: str, method: str, args: dict, source: str = "run") -> dict:
        """Raise SafetyViolation unless this call may be sent; note it as sent when it may.

        `args` are the arguments as the run holds them, before they are cast to the driver's
        types: plain JSON values, which is what a limit is written against.

        Returns what was sent. The caller hands it to `finish()` when the call ends, either way:
        that is when the states it sets take their new value (or become unknown)."""
        problems = await self.check_call(instrument, method, args)
        if problems:
            self.note_blocked(problems, source, instrument, method, args)
            raise SafetyViolation(problems)
        self.note_call(instrument, method, args)
        return {"instrument": instrument, "method": method, "effects": await self._effects(instrument, method, args)}

    def note_blocked(self, problems: List[str], source: str, instrument: str = "", method: str = "",
                     args: Optional[dict] = None) -> None:
        """Keep what was refused, for the Safety page: a call (`run`, `manual`) or a whole run
        refused before it started (`start`, with no instrument)."""
        self.blocked.append({
            "ts": time.time(), "instrument": instrument, "method": method, "source": source,
            "args": serialize_result(_flatten(args or {})), "problems": list(problems),
        })

    def note_call(self, instrument: str, method: str, args: dict) -> None:
        """Remember what is being sent, for rules that read the last value or the last action.
        Noted when the call is sent rather than when it returns: a command that raised half-way
        may still have reached the hardware."""
        self.last_actions[instrument] = method
        schema = (self.deck().schemas.get(instrument) or {}).get(method) or {}
        values = {name: info["default"] for name, info in (schema.get("parameters") or {}).items()
                  if isinstance(info, dict) and "default" in info}
        values.update(_flatten(args))
        for path, value in values.items():
            self.last_values[f"{instrument}.{method}.{path}"] = value


def _step_instrument(step: dict) -> str:
    return str(step.get("instrument") or step.get("module") or "")


def _step_method(step: dict) -> str:
    return str(step.get("method") or step.get("action") or "")


def _step_params(step: dict) -> dict:
    params = step.get("params")
    if params is None:
        params = step.get("args")
    return params if isinstance(params, dict) else {}


def _view(config: dict, deck: Deck, load_error: Optional[str]) -> dict:
    return {
        "enabled": bool(config.get("enabled", True)),
        "error": load_error,
        "fields": resolve_fields(config, deck),
        "trays": {name: {**tray, "grid": tray_grid(tray)} for name, tray in config["trays"].items()},
        "rules": sum(1 for rule in config["rules"] if rule["enabled"]),
    }


# Method names that come in pairs and say which state they leave: (does, undoes, then, otherwise).
_STATE_PAIRS = (
    ("open", "close", "open", "closed"), ("lock", "unlock", "locked", "unlocked"),
    ("turn_on", "turn_off", "on", "off"), ("start", "stop", "running", "stopped"),
    ("enable", "disable", "enabled", "disabled"), ("pick", "place", "holding", "empty"),
    ("grip", "release", "holding", "empty"), ("grab", "release", "holding", "empty"),
    ("load", "unload", "loaded", "empty"), ("attach", "detach", "attached", "detached"),
    ("clamp", "unclamp", "clamped", "released"), ("engage", "disengage", "engaged", "disengaged"),
    ("extend", "retract", "extended", "retracted"), ("raise", "lower", "raised", "lowered"),
)


def suggest_states(deck: Deck, config: dict) -> List[dict]:
    """States this deck's method names imply, ready to add: `balance.open_door` beside
    `balance.close_door` is a door that is open or closed. Only a starting point (a person adds
    the ones they want and names them); it is here so the first state is a click, not a blank page.
    Nothing is suggested for a pair some state already uses."""
    used = {(e["target"], e["method"]) for spec in config.get("states", {}).values() for e in spec.get("set_by", [])}
    out = []
    for instrument in deck.names():
        methods = set(deck.schemas.get(instrument) or {})
        for does, undoes, then, otherwise in _STATE_PAIRS:
            for method in sorted(methods):
                if method != does and not method.startswith(does + "_"):
                    continue
                noun = method[len(does):].lstrip("_")
                other = f"{undoes}_{noun}" if noun else undoes
                if other not in methods or (instrument, method) in used or (instrument, other) in used:
                    continue
                name = instrument if not noun or instrument.endswith(noun) else f"{instrument}_{noun}"
                if name in config.get("states", {}) or any(s["name"] == name for s in out):
                    continue
                out.append({"name": name, "state": {
                    "label": name.replace("_", " ").capitalize(), "values": [then, otherwise],
                    "set_by": [{"target": instrument, "method": method, "value": then},
                               {"target": instrument, "method": other, "value": otherwise}],
                }})
    return out


def preview(raw, deck: Deck) -> dict:
    """A draft, checked and laid out without saving it: what the Safety page shows while editing."""
    config, problems = validate(raw, deck)
    return {"config": config, "problems": problems, "resolved": _view(config, deck, None)}


guard = Guard()
