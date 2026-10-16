"""What is in each vessel, and the calls that change it: the safety guard's contents (safety.py).

A limit says what one call may ask of an instrument: a syringe draws at most 2.5 mL. Whether that
call is safe also depends on where the liquid goes. A 1.7 mL vial that already holds 1.2 mL takes
0.5 mL, not 1, and charging into a reactor slot with no vial in it spills the whole volume. That
needs two more things, and both are data, like the rest of the guard:

- **What a tray holds** (`trays.<name>.contents`): vessels, each with a capacity (vials, tubes,
  the reactor), or a stock (solvent bottles: a source, which this does not draw dry or overfill).
  And who keeps the numbers:

  - `kept_by: "ivoryos"`: this edge keeps a record of its own (`safety_contents.json`, beside
    `safety_state.json`), changed by the transfers below and set by a person on the Safety page.
    For a deck whose code tracks nothing.
  - `kept_by: "deck"`: the deck's code already keeps one (a deck's own container objects, PyLabRobot's
    volume trackers). It is read where it is: `read.from` says where (`deck.trays.extraction`: an
    instrument, then attributes or keys, then the position) and which of its fields hold the volume,
    the capacity and the liquids. Its volumes are never written here: the deck changes its own
    record as the call runs, and two records of one vial would only drift apart. What this edge does
    keep for such a tray is the one thing the deck may not: where each vessel is. A deck may go on
    listing a vial under its slot (`trays['extraction']['A1']`) after the arm has carried it into a
    reactor, so a charge into "extraction A1" would read a vial where there is an empty slot. A declared vessel move
    out of a tray of many positions marks that slot empty (`away`) until a move brings one back, and a
    vessel remembers where it came from (`home`), so a move that names no position (a "take the
    vial out of the reactor" call) puts it back there.

- **What a call moves** (`transfers`): declared once per method, like a state's `set_by`, because
  nothing in `charge_liquid(volume_ml, source_tray, source_index, ...)` says that it moves liquid.
  A transfer is an amount (an argument, and its unit) from a tray and position to another, or a
  whole vessel (`moves: "vessel"`: a vial carried to the reactor takes its contents and its capacity
  along). A method that moves several things (a step that charges a crude, an organic and an
  aqueous phase) lists one transfer each, in order, with `if` clauses for the optional ones. Only the step
  a workflow calls is seen, never the calls inside it, so a step's whole effect is declared on it.

      "trays": {"extraction": {..., "contents": {"role": "vessels", "capacity": 14.5, "unit": "mL",
                                                 "kept_by": "ivoryos", "empty": "vessel"}}},
      "transfers": [{"id": "charge", "name": "Charge liquid",
                     "when": {"target": "operations", "method": "charge_liquid"},
                     "moves": "liquid", "amount": {"arg": "volume_ml"}, "unit": "mL",
                     "from": {"tray": {"arg": "source_tray"}, "position": {"arg": "source_index"}},
                     "to": {"tray": {"arg": "destination_tray"}, "position": {"arg": "destination_index"}}}]

On a tray of one position (a reactor slot) the position a call gives can only mean that one.
A tray argument left empty names nothing, so that transfer does not apply: a step that skips a
phase whose tray is not given skips that phase's transfer with it.
A tray a call names that has no contents configured (a liquid handler's backing line) is not tracked:
liquid comes from it, or goes to it, unchecked. A position nobody has recorded holds an empty
vessel, or nothing (`empty: "nothing"`, a reactor slot or a holder): a rack of new vials is the
usual case. Volumes are kept in mL; `unit` says what a tray's capacity, a deck's numbers and a
transfer's amount are in, and they are converted only to be compared.

**One arithmetic, three places** (`Plan`). As a call is about to be sent (safety.Guard.enforce): it
is refused when a destination would overflow or there is no vessel where liquid would go, and, on a
tray that asks for it (`check_draws`), when a vessel is drawn beyond what it holds. Drawing too much
draws air, which spoils a sample and spills nothing, and a vial filled by hand is in no record unless
someone says so: refusing it everywhere would refuse every run that draws from a vial
someone prepared at the bench. When the call ends (Guard.finish): this edge's record takes the new
contents, or, for a call that failed, the positions it touched become unknown, because liquid may
have moved anyway; unknown blocks until a person says what is there. And over a whole run before it
starts (Guard.check_run): from the record as it is now, step by step, so a run that would overfill
row 4's vial is refused before row 1 begins. That walk sees what the run's steps say. An amount a
run only learns on the way (a '#name') stops it from following the positions involved; the steps
inside an If or a While are walked once each, as if they ran; and a run queued behind another is
walked from the deck as it is when submitted (each step is checked again as it is sent).
"""

import copy
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

UNITS = {"L": 1000.0, "mL": 1.0, "µL": 0.001, "uL": 0.001}
ROLES = ("vessels", "stock")
KEPT_BY = ("ivoryos", "deck")
EMPTY_HOLDS = ("vessel", "nothing")
MOVES = ("liquid", "vessel")
# A reading that is a little over or under (a gravimetric volume) is not an overflow.
EPS_ML = 1e-6


def _as_number(value) -> Optional[float]:
    """A number, from a plain value or an uncertainty-carrying one (a deck may keep volumes as
    `uncertainties.ufloat`; `.nominal_value` is its number). None for anything else."""
    value = getattr(value, "nominal_value", value)
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value.strip() if isinstance(value, str) else value)
    except (TypeError, ValueError):
        return None
    return None if number != number else number


def _tidy(number: float) -> str:
    return f"{round(number, 4):g}"


def amount_text(ml: float, unit: str) -> str:
    return f"{_tidy(ml / UNITS.get(unit, 1.0))} {unit}"


def _position_text(value) -> str:
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).strip()


class Later:
    """A value a run only learns on the way (a '#name'): the walk cannot follow it."""


# --- Validation -----------------------------------------------------------------------------------

def normalize_tray_contents(name: str, raw, tray: dict, where: str, deck, err, warn) -> Optional[dict]:
    """A tray's `contents`, checked. `tray` is the tray as already validated (its positions)."""
    from .safety import tray_positions
    if raw in (None, {}, ""):
        return None
    if not isinstance(raw, dict):
        err(where, f"Tray '{name}': 'contents' must be an object.")
        return None
    role = str(raw.get("role") or "vessels")
    if role not in ROLES:
        err(where, f"Tray '{name}': it holds 'vessels' or a 'stock', not '{role}'.")
        return None
    kept_by = str(raw.get("kept_by") or "ivoryos")
    if kept_by not in KEPT_BY:
        err(where, f"Tray '{name}': its contents are kept by 'ivoryos' or by the 'deck', not '{kept_by}'.")
        return None
    unit = str(raw.get("unit") or "mL")
    if unit not in UNITS:
        err(where, f"Tray '{name}': volumes are in {', '.join(UNITS)}, not '{unit}'.")
        return None
    out: Dict[str, Any] = {"role": role, "kept_by": kept_by, "unit": unit}
    if role == "vessels":
        if raw.get("capacity") not in (None, ""):
            capacity = _as_number(raw["capacity"])
            if capacity is None or capacity <= 0:
                err(where, f"Tray '{name}': a vessel's capacity is a number above 0, not {raw['capacity']!r}.")
                return None
            out["capacity"] = int(capacity) if float(capacity).is_integer() else capacity
        empty = str(raw.get("empty") or "vessel")
        if empty not in EMPTY_HOLDS:
            err(where, f"Tray '{name}': a position nobody has recorded holds an empty 'vessel' or 'nothing', not '{empty}'.")
            return None
        out["empty"] = empty
        # Drawing more than a vessel holds draws air: it spoils a sample and spills nothing, and a
        # vial filled by hand is in no record unless someone says so. So it is refused only where a
        # lab asks for it; overflowing a vessel, or pouring where there is none, always is.
        if raw.get("check_draws"):
            out["check_draws"] = True
    elif kept_by == "ivoryos" and raw.get("liquids"):
        # Which reagent each bottle holds. A position with none is named by itself ("A1").
        liquids = raw["liquids"]
        if not isinstance(liquids, dict):
            err(where, f"Tray '{name}': 'liquids' maps a position to the reagent it holds.")
        else:
            positions = set(tray_positions(tray))
            kept = {}
            for position, liquid in liquids.items():
                position = _position_text(position)
                if position not in positions:
                    err(where, f"Tray '{name}' names a reagent for '{position}', which is not one of its positions.")
                elif str(liquid or "").strip():
                    kept[position] = str(liquid).strip()
            if kept:
                out["liquids"] = kept
    aliases = raw.get("aliases") or []
    if isinstance(aliases, str):
        aliases = aliases.split(",")
    aliases = [str(a).strip() for a in aliases if str(a).strip() and str(a).strip() != name]
    if aliases:
        out["aliases"] = list(dict.fromkeys(aliases))
    if kept_by == "deck":
        read = raw.get("read") if isinstance(raw.get("read"), dict) else {}
        source = str(read.get("from") or "").strip()
        if not source:
            err(where, f"Tray '{name}': say where the deck keeps it, e.g. deck.trays.{name}.")
            return None
        fields = {"from": source}
        for key in ("volume", "capacity", "liquids", "liquid"):
            if str(read.get(key) or "").strip():
                fields[key] = str(read[key]).strip()
        if role == "vessels" and "volume" not in fields:
            err(where, f"Tray '{name}': say which field of the deck's vessel holds its volume (e.g. total_volume).")
            return None
        out["read"] = fields
        instrument = source.split(".")[0]
        if deck is not None and instrument not in deck.instruments and instrument not in deck.schemas:
            warn(where, f"Tray '{name}' is read from {source}, and '{instrument}' is not on this deck: "
                        "a call touching it will block until it is.")
    return out


def _side_operand(raw, label: str) -> Tuple[Optional[dict], Optional[str]]:
    """{"arg": name} or {"value": x}; (operand, problem)."""
    if raw is None:
        return None, None
    if not isinstance(raw, dict):
        return None, f"{label} is an argument of the call or a fixed value."
    if str(raw.get("arg") or "").strip():
        return {"arg": str(raw["arg"]).strip()}, None
    if raw.get("value") not in (None, ""):
        return {"value": raw["value"]}, None
    return None, None


def normalize_transfer(raw, index: int, config: dict, deck, err, warn, clause_check, ids: set) -> Optional[dict]:
    """One declared transfer, checked against the trays already validated in `config`."""
    where = f"transfers[{index}]"
    if not isinstance(raw, dict):
        err(where, "A transfer must be an object.")
        return None
    when = raw.get("when") if isinstance(raw.get("when"), dict) else {}
    target, method = str(when.get("target") or "").strip(), str(when.get("method") or "").strip()
    name = str(raw.get("name") or "").strip() or (f"{target}.{method}" if method else f"Transfer {index + 1}")
    if not target or not method or method == "*":
        err(where, f"'{name}': say which instrument's method moves it.")
        return None
    moves = str(raw.get("moves") or "liquid")
    if moves not in MOVES:
        err(where, f"'{name}' moves 'liquid' or a 'vessel', not '{moves}'.")
        return None
    transfer_id = str(raw.get("id") or "").strip()
    if not transfer_id or transfer_id in ids:
        transfer_id = uuid.uuid4().hex[:8]
    ids.add(transfer_id)
    out: Dict[str, Any] = {"id": transfer_id, "name": name, "enabled": raw.get("enabled", True) is not False,
                           "when": {"target": target, "method": method}, "moves": moves, "if": []}
    if moves == "liquid":
        amount, problem = _side_operand(raw.get("amount"), f"'{name}': the amount")
        if problem or amount is None:
            err(where, problem or f"'{name}': say how much it moves (an argument, or a fixed amount).")
            return None
        if "value" in amount and _as_number(amount["value"]) is None:
            err(where, f"'{name}': a fixed amount is a number, not {amount['value']!r}.")
            return None
        out["amount"] = amount
        unit = str(raw.get("unit") or "mL")
        if unit not in UNITS:
            err(where, f"'{name}': the amount is in {', '.join(UNITS)}, not '{unit}'.")
            return None
        out["unit"] = unit
    sides = 0
    for part in ("from", "to"):
        side = raw.get(part)
        if side in (None, {}):
            continue
        if not isinstance(side, dict):
            err(where, f"'{name}': '{part}' is a tray and a position.")
            return None
        tray, problem = _side_operand(side.get("tray"), f"'{name}': the tray it moves {part}")
        if problem or tray is None:
            err(where, problem or f"'{name}': say which tray it moves {part}.")
            return None
        position, problem = _side_operand(side.get("position"), f"'{name}': the position it moves {part}")
        if problem:
            err(where, problem)
            return None
        out[part] = {"tray": tray, **({"position": position} if position else {})}
        sides += 1
        if "value" in tray and not find_tray(config, str(tray["value"])):
            warn(where, f"'{name}' moves {part} '{tray['value']}', a tray with no contents configured: "
                        "that side is not checked.")
    if moves == "vessel" and sides < 2:
        err(where, f"'{name}' carries a vessel from one place to another: give both.")
        return None
    if sides == 0:
        err(where, f"'{name}': say where it moves liquid from, to, or both.")
        return None
    clauses = raw.get("if") or []
    for k, clause in enumerate(clauses if isinstance(clauses, list) else []):
        checked = clause_check(clause, f"{where}.if[{k}]", name, method)
        if checked:
            out["if"].append(checked)
    if deck is not None:
        matched = [n for n in deck.names() if deck.matches(n, target)]
        if not matched:
            warn(where, f"'{name}': no instrument on this deck matches '{target}', so it never applies yet.")
        elif not any(method in (deck.schemas.get(n) or {}) for n in matched):
            warn(where, f"'{name}': '{method}' is not a method of {target}.")
        else:
            params = set()
            for n in matched:
                params |= set(((deck.schemas.get(n) or {}).get(method) or {}).get("parameters") or {})
            named = [o["arg"] for o in _operands(out) if "arg" in o]
            for missing in [a for a in named if a not in params]:
                warn(where, f"'{name}': {method} has no argument '{missing}'.")
    return out


def _operands(transfer: dict) -> List[dict]:
    found = [transfer.get("amount")] if transfer.get("amount") else []
    for part in ("from", "to"):
        side = transfer.get(part) or {}
        found += [side.get("tray"), side.get("position")]
    return [o for o in found if o]


def find_tray(config: dict, named) -> Optional[str]:
    """The tray (with contents) a call means by `named`: its id or one of its aliases."""
    if named is None:
        return None
    named = _position_text(named)
    trays = config.get("trays") or {}
    for tray_id, tray in trays.items():
        if tray.get("contents") and named == tray_id:
            return tray_id
    for tray_id, tray in trays.items():
        contents = tray.get("contents")
        if contents and (named in (contents.get("aliases") or []) or named.lower() == tray_id.lower()):
            return tray_id
    return None


# --- Suggestions ----------------------------------------------------------------------------------

_AMOUNT_UNITS = (("_ul", "µL"), ("_ml", "mL"), ("_l", "L"))
_FROM = ("source", "src", "from")
_TO = ("destination", "dest", "dst", "to", "target")
_TRAY = ("tray", "container", "rack", "plate", "location")
_POSITION = ("index", "position", "well", "slot", "vial")


def _find(params, starts, ends) -> Optional[str]:
    for p in params:
        low = p.lower()
        if any(low.startswith(s + "_") for s in starts) and any(low.endswith("_" + e) or low == e for e in ends):
            return p
    return None


def suggest_transfers(deck, config: dict) -> List[dict]:
    """Transfers this deck's method signatures imply, ready to add: a method taking a volume plus a
    source and a destination (tray and position) moves liquid; one taking source and destination but
    no volume and named like a move carries a vessel. Only a starting point, as states' suggestions
    are; nothing is offered for a method a transfer already covers."""
    used = {(t["when"]["target"], t["when"]["method"]) for t in config.get("transfers") or []}
    out = []
    for instrument in deck.names():
        for method, schema in sorted((deck.schemas.get(instrument) or {}).items()):
            params = list((schema or {}).get("parameters") or {})
            if (instrument, method) in used or not params:
                continue
            sides = {}
            for part, starts in (("from", _FROM), ("to", _TO)):
                tray = _find(params, starts, _TRAY)
                if tray:
                    position = _find(params, starts, _POSITION)
                    sides[part] = {"tray": {"arg": tray}, **({"position": {"arg": position}} if position else {})}
            if len(sides) < 2:
                continue
            amount = next((p for p in params if "volume" in p.lower() or p.lower().endswith(("_ml", "_ul"))), None)
            if amount:
                unit = next((u for suffix, u in _AMOUNT_UNITS if amount.lower().endswith(suffix)), "mL")
                transfer = {"moves": "liquid", "amount": {"arg": amount}, "unit": unit}
            elif "move" in method.lower() or "transfer" in method.lower():
                transfer = {"moves": "vessel"}
            else:
                continue
            out.append({"id": uuid.uuid4().hex[:8], "name": method.replace("_", " ").capitalize(),
                        "enabled": True, "when": {"target": instrument, "method": method},
                        "if": [], **transfer, **sides})
    return out


# --- Positions as a check sees them ----------------------------------------------------------------

def _spot(volume=0.0, liquids=None, capacity=None, vacant=False, unknown=None, home=None) -> dict:
    """What one position holds as a check sees it. `home`: where the vessel there came from, [tray,
    position], when it is not its own place."""
    return {"volume": volume, "liquids": dict(liquids or {}), "capacity": capacity,
            "vacant": vacant, "unknown": unknown, "home": list(home) if home else None}


def follow(deck, path: str):
    """The object at `path` on the live deck: an instrument, then attributes or keys."""
    parts = [p for p in str(path).split(".") if p]
    if not parts:
        raise LookupError("no place on the deck given")
    obj = deck.instruments.get(parts[0])
    if obj is None:
        raise LookupError(f"'{parts[0]}' is not on this deck")
    for part in parts[1:]:
        if isinstance(obj, dict) and part in obj:
            obj = obj[part]
        elif hasattr(type(obj), part) or hasattr(obj, part):
            obj = getattr(obj, part)
        else:
            try:
                obj = obj[part]
            except Exception:
                raise LookupError(f"{path}: there is no '{part}'")
    return obj


class Plan:
    """Positions as one check sees them: each read once (from this edge's record or from the deck's
    own), then changed transfer by transfer. Nothing here writes anywhere: `writes()` says what this
    edge's record should become if the call (or the run) goes as declared."""

    def __init__(self, config: dict, record: dict, deck):
        self.config = config
        self.record = record or {}
        self.deck = deck
        self.spots: Dict[Tuple[str, str], dict] = {}
        self.lost: set = set()            # positions a walk can no longer follow
        self.touched: set = set()         # positions whose entry in this edge's record changes

    def tray(self, tray_id: str) -> dict:
        return self.config["trays"][tray_id]

    def label(self, tray_id: str, key: str) -> str:
        tray = self.tray(tray_id)
        name = tray.get("label") or tray_id
        positions = _positions(tray)
        return name if len(positions) == 1 else f"{name} {key}"

    # -- reading --

    def spot(self, tray_id: str, key: str) -> dict:
        found = self.spots.get((tray_id, key))
        if found is None:
            found = self.spots[(tray_id, key)] = self._load(tray_id, key)
        return found

    def _load(self, tray_id: str, key: str) -> dict:
        tray = self.tray(tray_id)
        contents = tray["contents"]
        capacity = _capacity(contents)
        entry = (self.record.get(tray_id) or {}).get(key)
        if contents["kept_by"] == "deck":
            # This edge keeps only where the vessel is; what it holds is the deck's.
            if entry and entry.get("unknown"):
                return _spot(capacity=capacity, unknown=entry["unknown"])
            if entry and entry.get("away"):
                return _spot(capacity=capacity, vacant=True)
            spot = self._read_deck(tray, key, capacity)
            spot["home"] = list(entry["home"]) if entry and entry.get("home") else None
            return spot
        if entry is None:
            return _spot(capacity=capacity, vacant=contents.get("empty") == "nothing")
        if entry.get("unknown"):
            return _spot(capacity=capacity, unknown=entry["unknown"])
        if entry.get("vacant"):
            return _spot(capacity=capacity, vacant=True)
        liquids = {str(k): float(v) for k, v in (entry.get("liquids") or {}).items() if _as_number(v)}
        held = entry.get("capacity_ml")
        return _spot(sum(liquids.values()), liquids, held if held is not None else capacity, home=entry.get("home"))

    def _read_deck(self, tray: dict, key: str, capacity) -> dict:
        contents = tray["contents"]
        read, unit = contents["read"], UNITS[contents["unit"]]
        try:
            vessel = self.deck_vessel(tray, key)
        except LookupError as e:
            return _spot(capacity=capacity, unknown=f"the deck's record could not be read ({e})")
        if vessel is None:
            return _spot(capacity=capacity, vacant=True)
        try:
            volume = _as_number(getattr(vessel, read["volume"])) if read.get("volume") else 0.0
            if read.get("capacity"):
                own = _as_number(getattr(vessel, read["capacity"]))
                capacity = own * unit if own is not None else capacity
            liquids = {}
            if read.get("liquids"):
                for name, amount in dict(getattr(vessel, read["liquids"]) or {}).items():
                    number = _as_number(amount)
                    if number:
                        liquids[str(name)] = number * unit
        except Exception as e:  # a renamed field: blocks rather than passes
            return _spot(capacity=capacity, unknown=f"the deck's record could not be read ({type(e).__name__}: {e})")
        if volume is None:
            return _spot(capacity=capacity, unknown=f"the deck's {read['volume']} is not a number")
        return _spot(volume * unit, liquids, capacity)

    def deck_vessel(self, tray: dict, key: str):
        """The deck's own object for a position: what `read.from` names, then its `[position]`. A
        tray of one position (the reactor) is read as the vessel itself (None: nothing there)."""
        place = follow(self.deck, tray["contents"]["read"]["from"])
        if len(_positions(tray)) == 1 or place is None:
            return place
        try:
            return place[key]
        except Exception:
            raise LookupError(f"it has no '{key}'")

    def stock_liquid(self, tray_id: str, key: str) -> str:
        contents = self.tray(tray_id)["contents"]
        if contents["kept_by"] == "deck" and contents["read"].get("liquid"):
            try:
                named = getattr(self.deck_vessel(self.tray(tray_id), key), contents["read"]["liquid"], None)
                if named:
                    return str(named)
            except LookupError:
                pass
        return (contents.get("liquids") or {}).get(key) or key

    # -- one transfer --

    def side(self, spec: Optional[dict], args: dict, schema: dict) -> Optional[dict]:
        """Which tray and position a transfer's side names in this call: {tray (an id, or None when
        it is not tracked), named, key (None: not given), why (why it cannot be followed)}."""
        if not spec:
            return None
        named = _value(spec["tray"], args, schema)
        if isinstance(named, Later):
            return {"tray": None, "named": "?", "key": None, "later": True}
        if named is None or _position_text(named) == "":
            return {"tray": None, "named": "", "key": None, "none": True}
        tray_id = find_tray(self.config, named)
        out = {"tray": tray_id, "named": "" if named is None else _position_text(named), "key": None}
        if tray_id is None:
            return out
        position = _value(spec["position"], args, schema) if spec.get("position") else None
        if isinstance(position, Later):
            out["later"] = True
            return out
        tray = self.tray(tray_id)
        positions = _positions(tray)
        if len(positions) == 1:
            # A tray of one place can only mean that place, whatever the call says about it (the
            # a deck may name a layer of the vial there: "top_layer").
            out["key"] = positions[0]
            return out
        if position in (None, ""):
            out["why"] = f"no position on {tray.get('label') or tray_id} is given (the deck would choose one)"
            return out
        key = _position_text(position)
        contents = tray["contents"]
        if contents["role"] == "vessels" and contents["kept_by"] == "ivoryos" and key not in positions:
            out["why"] = f"'{key}' is not a position on {tray.get('label') or tray_id}"
        out["key"] = key
        return out

    def apply(self, transfer: dict, args: dict, schema: dict, walking: bool = False) -> List[str]:
        """Change the positions as this transfer would. Returns why the call may not happen."""
        source = self.side(transfer.get("from"), args, schema)
        target = self.side(transfer.get("to"), args, schema)
        if any(s and s.get("none") for s in (source, target)):
            return []  # a tray left empty names nothing: nothing moves (an optional phase skipped)
        if transfer["moves"] == "vessel":
            return self._carry(source, target, walking)
        amount = _value(transfer["amount"], args, schema)
        if isinstance(amount, Later) or any(s and s.get("later") for s in (source, target)):
            self._lose(source, target)
            return []
        number = _as_number(amount)
        if number is None:
            if not any(s and s["tray"] for s in (source, target)):
                return []
            what = transfer["amount"].get("arg") or "the amount"
            return [f"How much {transfer['name']} moves cannot be checked: '{what}' is "
                    f"{'not given' if amount is None else repr(amount)}."]
        ml = number * UNITS[transfer["unit"]]
        problems: List[str] = []
        portion = self._draw(source, ml, problems, walking)
        if portion is None:
            return problems
        self._pour(target, ml, portion, problems, walking)
        return problems

    def _usable(self, side: dict, problems: List[str], walking: bool) -> Optional[dict]:
        """The spot a side names, when it can be checked; None (with a problem, or quietly) when not."""
        tray_id = side["tray"]
        contents = self.tray(tray_id)["contents"]
        if side.get("why"):
            if contents["kept_by"] == "ivoryos":
                problems.append(f"{side['why'][0].upper()}{side['why'][1:]}, so this edge cannot follow what it holds.")
            return None
        key = side["key"]
        if (tray_id, key) in self.lost:
            return None
        spot = self.spot(tray_id, key)
        if spot["unknown"]:
            if walking:
                return None  # checked again as the step is sent, when someone may have said
            advice = ("Say what it holds on the Safety page." if contents["kept_by"] == "ivoryos"
                      else "Check where the Safety page reads it from.")
            problems.append(f"What {self.label(tray_id, key)} holds is not known ({spot['unknown']}). {advice}")
            return None
        return spot

    def _draw(self, source: Optional[dict], ml: float, problems: List[str], walking: bool) -> Optional[dict]:
        """Take `ml` from the source; returns the portion taken ({liquid: mL})."""
        if source is None:
            return {"liquid": ml}
        if source["tray"] is None:
            return {source["named"] or "liquid": ml}
        contents = self.tray(source["tray"])["contents"]
        if contents["role"] == "stock":
            if source.get("why") or source["key"] is None:
                return {source["named"] or "liquid": ml}
            return {self.stock_liquid(source["tray"], source["key"]): ml}
        checked = bool(contents.get("check_draws"))
        spot = self._usable(source, problems if checked else [], walking)
        if spot is None:
            return None if problems else {source["named"] or "liquid": ml}
        where = self.label(source["tray"], source["key"])
        if spot["vacant"]:
            if checked:
                problems.append(f"There is no vessel at {where} to draw {amount_text(ml, contents['unit'])} from.")
                return None
            return {source["named"] or "liquid": ml}
        if checked and ml > spot["volume"] + EPS_ML:
            problems.append(f"{where} holds {amount_text(spot['volume'], contents['unit'])}: "
                            f"{amount_text(ml, contents['unit'])} cannot be drawn from it.")
            return None
        named = sum(spot["liquids"].values())
        portion = {k: ml * v / named for k, v in spot["liquids"].items()} if named > EPS_ML else {"liquid": ml}
        for k, v in portion.items():
            if k in spot["liquids"]:
                left = spot["liquids"][k] - v
                if left > EPS_ML:
                    spot["liquids"][k] = left
                else:
                    del spot["liquids"][k]
        spot["volume"] = max(spot["volume"] - ml, 0.0)
        self._touch(source)
        return portion

    def _pour(self, target: Optional[dict], ml: float, portion: dict, problems: List[str], walking: bool) -> None:
        if target is None or target["tray"] is None:
            return
        contents = self.tray(target["tray"])["contents"]
        if contents["role"] == "stock":
            return
        spot = self._usable(target, problems, walking)
        if spot is None:
            return
        where = self.label(target["tray"], target["key"])
        unit = contents["unit"]
        if spot["vacant"]:
            problems.append(f"There is no vessel at {where} to put {amount_text(ml, unit)} into.")
            return
        if spot["capacity"] is not None and spot["volume"] + ml > spot["capacity"] + EPS_ML:
            problems.append(f"{where} would hold {amount_text(spot['volume'] + ml, unit)}, more than its "
                            f"{amount_text(spot['capacity'], unit)} (it holds {amount_text(spot['volume'], unit)} now).")
            if walking:
                self.lost.add((target["tray"], target["key"]))
            return
        for k, v in portion.items():
            spot["liquids"][k] = spot["liquids"].get(k, 0.0) + v
        spot["volume"] += ml
        self._touch(target)

    def _carry(self, source: Optional[dict], target: Optional[dict], walking: bool) -> List[str]:
        """A vessel moves: its contents and its capacity go with it, and where it was is empty."""
        problems: List[str] = []
        moving = None
        if source and source.get("later") or target and target.get("later"):
            self._lose(source, target)
            return []
        if source and source["tray"] is not None:
            spot = self._usable(source, problems, walking)
            if problems:
                return problems
            if spot is None:
                self._lose(target)
                return []
            else:
                if spot["vacant"]:
                    return [f"There is no vessel at {self.label(source['tray'], source['key'])} to move."]
                moving = copy.deepcopy(spot)
                moving["home"] = moving.get("home") or [source["tray"], source["key"]]
                self.spots[(source["tray"], source["key"])] = _spot(capacity=spot["capacity"], vacant=True)
                self._mark(source)
        if target and target["tray"] is not None:
            tray = self.tray(target["tray"])
            # Put back without a position: to where it came from, when that is on this tray.
            if target.get("why") and moving and moving.get("home") and moving["home"][0] == target["tray"]:
                target = {**target, "key": moving["home"][1], "why": None}
            spot = self._usable(target, problems, walking)
            if problems:
                return problems
            if spot is None:
                return []
            if not spot["vacant"]:
                return [f"{self.label(target['tray'], target['key'])} already holds a vessel: move that one away first."]
            if moving is None:
                if source and source["tray"] is None:
                    # From somewhere untracked (an autosampler): the deck knows what its vessel holds,
                    # this edge does not.
                    moving = (self._read_deck(tray, target["key"], _capacity(tray["contents"]))
                              if tray["contents"]["kept_by"] == "deck"
                              else _spot(unknown="it came from somewhere whose contents are not tracked"))
                else:
                    moving = _spot(capacity=_capacity(tray["contents"]))
            if moving.get("home") == [target["tray"], target["key"]]:
                moving["home"] = None  # back in its own place
            self.spots[(target["tray"], target["key"])] = moving
            self._mark(target)
        return problems

    def _touch(self, side: dict) -> None:
        """Liquid moved here: this edge's record changes only where this edge keeps the contents."""
        if self.tray(side["tray"])["contents"]["kept_by"] == "ivoryos":
            self.touched.add((side["tray"], side["key"]))

    def _mark(self, side: dict) -> None:
        """A vessel moved here or away: recorded wherever it is, the deck's trays included."""
        self.touched.add((side["tray"], side["key"]))

    def _lose(self, *sides) -> None:
        for side in sides:
            if side and side["tray"] is not None and side.get("key") is not None:
                self.lost.add((side["tray"], side["key"]))

    def writes(self) -> Dict[str, Dict[str, Optional[dict]]]:
        """What this edge's record becomes for the positions changed: {tray: {position: entry}}."""
        out: Dict[str, Dict[str, Optional[dict]]] = {}
        for tray_id, key in self.touched:
            spot = self.spots[(tray_id, key)]
            tray = self.tray(tray_id)
            entry: Optional[Dict[str, Any]]
            if tray["contents"]["kept_by"] == "deck":
                # Only where the vessel is: an empty slot on a tray of many (a slot of one, the
                # reactor's, the deck reports itself), and where a vessel came from. None: nothing to keep.
                if spot["unknown"]:
                    entry = {"unknown": spot["unknown"]}
                elif spot["vacant"]:
                    entry = {"away": True} if len(_positions(tray)) > 1 else None
                else:
                    entry = {"home": spot["home"]} if spot.get("home") else None
            elif spot["unknown"]:
                entry = {"unknown": spot["unknown"]}
            elif spot["vacant"]:
                entry = {"vacant": True}
            else:
                entry = {"liquids": {k: round(v, 6) for k, v in spot["liquids"].items() if v > EPS_ML}}
                if spot["volume"] > sum(entry["liquids"].values()) + EPS_ML:
                    entry["liquids"]["liquid"] = round(spot["volume"] - sum(entry["liquids"].values()), 6)
                default = _capacity(self.tray(tray_id)["contents"])
                if spot["capacity"] is not None and spot["capacity"] != default:
                    entry["capacity_ml"] = spot["capacity"]
                if spot.get("home"):
                    entry["home"] = spot["home"]
            out.setdefault(tray_id, {})[key] = entry
        return out


def _positions(tray: dict) -> List[str]:
    from .safety import tray_positions
    return tray_positions(tray)


def _capacity(contents: dict) -> Optional[float]:
    if contents.get("capacity") is None:
        return None
    return float(contents["capacity"]) * UNITS[contents["unit"]]


def _set_presence(tray_id: str, tray: dict, record: dict, position, entry: dict, stamp: dict) -> dict:
    """On a tray the deck keeps, a person says only where a vessel is: in its place (the mark is
    dropped), away (an empty slot), or not known. What it holds is the deck's to say."""
    label = tray.get("label") or tray_id
    positions = _positions(tray)
    if entry.get("liquids") is not None:
        raise ValueError(f"{label} is kept by the deck: what its vessels hold is changed there, not here.")
    if position in (None, ""):
        reset = str(entry.get("reset") or "")
        if reset not in ("empty", "unknown"):
            raise ValueError("Reset a whole tray to 'empty' (every vessel in its place) or 'unknown'.")
        if reset == "empty":
            record.pop(tray_id, None)
        else:
            record[tray_id] = {key: {"unknown": "a person marked it as not known", **stamp} for key in positions}
        return record
    key = _position_text(position)
    if key not in positions:
        raise ValueError(f"'{key}' is not a position on {label}.")
    if entry.get("unknown"):
        record.setdefault(tray_id, {})[key] = {"unknown": "a person marked it as not known", **stamp}
    elif entry.get("vacant"):
        if len(positions) == 1:
            raise ValueError(f"The deck says whether {label} holds a vessel.")
        record.setdefault(tray_id, {})[key] = {"away": True, **stamp}
    else:
        (record.get(tray_id) or {}).pop(key, None)
        if tray_id in record and not record[tray_id]:
            del record[tray_id]
    return record


def _value(operand: dict, args: dict, schema: dict):
    """What an operand means in this call: an argument (at the driver's default when not given),
    or a fixed value. A '#name' is Later: the run fills it in on the way."""
    from .introspection import _MISSING
    from .safety import _argument, _is_reference
    if "value" in operand:
        value = operand["value"]
    else:
        value = _argument(args or {}, schema or {}, operand["arg"])
        if value is _MISSING:
            value = None
    if _is_reference(value):
        return Later()
    return value


# --- What a person sees, and sets ------------------------------------------------------------------

def describe_tray(config: dict, record: dict, deck, tray_id: str) -> dict:
    """Every position of a tray with contents, as it stands: for the Safety page's Contents tab."""
    from .safety import tray_grid
    tray = config["trays"][tray_id]
    contents = tray["contents"]
    plan = Plan(config, record, deck)
    unit = contents["unit"]
    positions = {}
    for key in _positions(tray):
        if contents["role"] == "stock":
            positions[key] = {"liquid": plan.stock_liquid(tray_id, key)}
            continue
        spot = plan.spot(tray_id, key)
        entry: Dict[str, Any] = {"vacant": spot["vacant"]}
        if spot.get("home") and not spot["vacant"]:
            home_tray = config["trays"].get(spot["home"][0]) or {}
            entry["from"] = f"{home_tray.get('label') or spot['home'][0]} {spot['home'][1]}"
        if spot["unknown"]:
            entry = {"unknown": spot["unknown"]}
        elif not spot["vacant"]:
            scale = UNITS[unit]
            entry.update({"volume": round(spot["volume"] / scale, 4),
                          "liquids": {k: round(v / scale, 4) for k, v in spot["liquids"].items()}})
            if spot["capacity"] is not None:
                entry["capacity"] = round(spot["capacity"] / scale, 4)
        stored = (record.get(tray_id) or {}).get(key)
        if stored:
            entry.update({"ts": stored.get("ts"), "by": stored.get("by")})
        positions[key] = entry
    return {"role": contents["role"], "kept_by": contents["kept_by"], "unit": unit,
            "capacity": contents.get("capacity"), "read": contents.get("read"),
            "label": tray.get("label") or tray_id, "grid": tray_grid(tray), "positions": positions}


def set_by_hand(config: dict, record: dict, tray_id: str, position: Optional[str], entry: dict) -> dict:
    """A person says what a position holds (or, with no position, resets the whole tray). Returns
    the new record. Only a tray this edge keeps can be set; the deck's own is the deck's."""
    tray = (config.get("trays") or {}).get(tray_id)
    if not tray or not tray.get("contents"):
        raise ValueError(f"'{tray_id}' is not a tray with contents.")
    contents = tray["contents"]
    if contents["role"] != "vessels":
        raise ValueError(f"{tray.get('label') or tray_id} is a stock: it has no contents to set.")
    record = copy.deepcopy(record or {})
    stamp = {"ts": time.time(), "by": "a person"}
    if contents["kept_by"] == "deck":
        return _set_presence(tray_id, tray, record, position, entry, stamp)
    if position in (None, ""):
        reset = str(entry.get("reset") or "")
        if reset not in ("empty", "unknown"):
            raise ValueError("Reset a whole tray to 'empty' (as nobody had recorded it) or 'unknown'.")
        if reset == "empty":
            record.pop(tray_id, None)
        else:
            record[tray_id] = {key: {"unknown": "a person marked it as not known", **stamp} for key in _positions(tray)}
        return record
    key = _position_text(position)
    if key not in _positions(tray):
        raise ValueError(f"'{key}' is not a position on {tray.get('label') or tray_id}.")
    if entry.get("unknown"):
        new = {"unknown": "a person marked it as not known"}
    elif entry.get("vacant"):
        new = {"vacant": True}
    else:
        scale = UNITS[contents["unit"]]
        liquids = {}
        for name, amount in (entry.get("liquids") or {}).items():
            number = _as_number(amount)
            if number is None or number < 0:
                raise ValueError(f"{name}: an amount is a number of {contents['unit']} (0 or more).")
            if number > 0 and str(name).strip():
                liquids[str(name).strip()] = number * scale
        capacity = _capacity(contents)
        if capacity is not None and sum(liquids.values()) > capacity + EPS_ML:
            raise ValueError(f"{tray.get('label') or tray_id} {key} holds at most {amount_text(capacity, contents['unit'])}.")
        new = {"liquids": liquids}
    record.setdefault(tray_id, {})[key] = {**new, **stamp}
    return record
