"""Labware: the plates, tip racks and reservoirs on an instrument's worktable.

Every other instrument on a deck is a bag of methods taking numbers and names. A liquid handler
is not: its arguments are *places* (well A1 of the assay plate), and one call acts on many of
them at once. This module is the vocabulary that lets a driver say so, and nothing more. It
knows nothing about any robot or library. The PyLabRobot liquid handler that speaks it is the
`plr-ivoryos` package (`plr_ivoryos.LiquidHandler`, and its Labware view plugin,
`plr_ivoryos.labware_view`), which defines its own copies of these markers:
the edge reads them by duck typing (anything in `Annotated[...]` with an `ivoryos_schema()`, and
the dunder methods below), so a driver package needs nothing from ivoryos_edge.

A well is written the way PyLabRobot writes it, as text: `assay_plate[A1:H1]` is PyLabRobot's
`assay_plate["A1:H1"]`, so one argument names the labware and its wells together, as a PyLabRobot
`Well` does. A driver marks its arguments:

    from typing import Annotated
    from ivoryos_edge.labware import Labware, Wells, PerWell, WellSelection

    def transfer(self,
        source: Annotated[WellSelection, Wells("plate", "reservoir")],      # "reservoir[A1]"
        targets: Annotated[WellSelection, Wells("plate")],                  # "assay_plate[A1:H3]"
        target_vols: Annotated[Union[float, List[float]], PerWell("targets")]): ...

and says what is on its worktable through one method the edge looks for:

    def __ivoryos_labware__(self) -> dict     # layout(): see `layout_of`
    def __ivoryos_labware_state__(self) -> dict     # what is in each well, which tips are left

From that the edge gets, with no further configuration:

- `Labware(...)` arguments offered as a list of the names on the worktable (schema `options`,
  so the safety guard holds a step to them like any Enum).
- `Wells(...)` arguments picked on a picture of the plate (the picker chooses the plate too), and
  checked against it: every labware is a tray the driver declared (safety.py `declared_trays`),
  so "A13 is not a position on assay_plate" is refused before a run starts.
- `Wells` and `PerWell` arguments of a *batch* step given the whole batch: one value per row of
  the spreadsheet, in one call (shared-ui spreadsheetRun.ts). That is what makes one row per
  sample and one call per column of eight the same workflow.

Dunder-style names, so introspection does not publish them as steps (it skips a leading
underscore).
"""

import re
from typing import Any, Dict, Iterable, List, Optional, Union

# What a wells argument carries: "plate[A1]", "plate[A1:H1, A3]", "plate" (all of it), several
# separated by commas, or a list of those (a batch step's rows).
WellSelection = Union[str, List[str]]

LAYOUT_METHOD = "__ivoryos_labware__"
STATE_METHOD = "__ivoryos_labware_state__"
EVENTS_METHOD = "__ivoryos_labware_events__"
# Optional: a worktable that can be rearranged from the Labware view. `catalog()` says what can be
# put on it and which robots it can become: {"labware": [{"definition", "category"}], "decks":
# [{"kind", "label"}], "deck": <current kind>}. `edit("place", site=, definition=, name=)`,
# `edit("remove", name=)` and `edit("deck", deck=)` change it and raise ValueError for what
# cannot be done.
CATALOG_METHOD = "__ivoryos_labware_catalog__"
EDIT_METHOD = "__ivoryos_labware_edit__"
ALL = "all"


class Labware:
    """`Annotated[str, Labware("plate")]`: the name of something on this instrument's worktable.
    Categories narrow the choice ("plate", "tip_rack", "reservoir", "tube_rack"); none means any."""

    def __init__(self, *categories: str):
        self.categories = list(categories)

    def ivoryos_schema(self) -> dict:
        return {"labware": self.categories}


class Wells:
    """`Annotated[WellSelection, Wells("plate")]`: wells written with their labware,
    `assay_plate[A1:H1]`. Categories narrow which labware ("plate", "tip_rack", ...)."""

    def __init__(self, *categories: str):
        self.categories = list(categories)

    def ivoryos_schema(self) -> dict:
        return {"type": "wells", "wells": {"labware": self.categories}}


class PerWell:
    """`Annotated[Union[float, List[float]], PerWell("targets")]`: one value for every well of that
    argument, or one per well in the same order."""

    def __init__(self, of: str):
        self.of = of

    def ivoryos_schema(self) -> dict:
        return {"type": "float", "numeric": True, "per_well": self.of}


class Site:
    """`Annotated[str, Site()]`: a place on the worktable a labware can be put (a slot, a carrier
    position)."""

    def ivoryos_schema(self) -> dict:
        return {"labware_site": True}


# --- What an instrument reports ------------------------------------------------------------------

def layout_of(instrument) -> Optional[dict]:
    """The instrument's worktable, or None when it has none (or cannot say right now).

        {"deck": {"name", "kind", "width", "depth"},          only on the instrument that owns it
         "labware": {name: {"label", "category", "model", "rows", "columns", "grid",
                            "site", "x", "y", "w", "h", "spots": {well: [x, y, w, h, round]}}},
         "sites": [{"name", "label", "x", "y", "w", "h", "holds"}],
         "fixtures": [{"name", "category", "x", "y", "w", "h"}]}

    Millimetres seen from above, origin at the front left. `grid` is the labware's position
    names as rows of columns, the same shape a safety tray has.
    """
    method = getattr(instrument, LAYOUT_METHOD, None)
    if not callable(method):
        return None
    try:
        layout = method()
    except Exception as e:
        print(f"Labware layout of {type(instrument).__name__} could not be read: {e}")
        return None
    return layout if isinstance(layout, dict) else None


def state_of(instrument) -> Optional[dict]:
    method = getattr(instrument, STATE_METHOD, None)
    if not callable(method):
        return None
    try:
        state = method()
    except Exception as e:
        print(f"Labware state of {type(instrument).__name__} could not be read: {e}")
        return None
    return state if isinstance(state, dict) else None


def tray_key(instrument: str, labware: Any) -> str:
    """The name a labware goes by among the safety guard's trays."""
    return f"{instrument}:{labware}"


def tray_of(name: str, entry: dict) -> dict:
    """One labware as a tray: the shape safety.py and the pages' tray picker already take."""
    grid = entry.get("grid") or [["A1"]]
    return {"label": entry.get("label") or name, "rows": len(grid), "columns": len(grid[0]) if grid else 0,
            "naming": "A1", "order": "column", "blocked": [], "grid": grid, "declared": True,
            "category": entry.get("category")}


def declared_trays(instruments: dict) -> Dict[str, dict]:
    """Every labware on every instrument that has a worktable, as `{"<instrument>:<labware>": tray}`."""
    out: Dict[str, dict] = {}
    for instrument, instance in (instruments or {}).items():
        layout = layout_of(instance)
        for name, entry in ((layout or {}).get("labware") or {}).items():
            out[tray_key(instrument, name)] = tray_of(name, entry)
    return out


def fill_options(instrument, schema: dict) -> None:
    """Give each `Labware`/`Site` argument its choices: the names on this instrument's worktable.

    They go in the schema as `options`, deliberately: a workflow that names `assay_plate` is
    broken on a worktable without one, and that is what the deck version and the Library's
    compatibility check exist to say.
    """
    layout = layout_of(instrument)
    if not layout:
        return
    labware = layout.get("labware") or {}
    sites = [s.get("label") or s.get("name") for s in layout.get("sites") or []]
    for entry in schema.values():
        for info in (entry.get("parameters") or {}).values():
            if not isinstance(info, dict):
                continue
            if "labware" in info:
                wanted = info["labware"]
                info["options"] = [name for name, item in labware.items()
                                   if not wanted or item.get("category") in wanted]
            elif info.get("labware_site"):
                info["options"] = list(sites)


# --- Well selections -----------------------------------------------------------------------------

def _index(grid: List[List[str]]) -> Dict[str, tuple]:
    return {name: (r, c) for r, row in enumerate(grid) for c, name in enumerate(row)}


def _span(a: int, b: int) -> Iterable[int]:
    return range(a, b + 1) if a <= b else range(a, b - 1, -1)


def expand_wells(selection: Any, grid: List[List[str]]) -> List[str]:
    """A selection as the list of positions it names, in visiting order.

    "A1:H1" runs down a column, "A1:A12" along a row, and a range whose corners differ in both
    is the rectangle between them, column by column (the order a multichannel head works in).
    "all" is the whole labware in that same order. Raises ValueError naming what is not a
    position: a typo must not become a smaller transfer.
    """
    index = _index(grid)
    if isinstance(selection, (list, tuple)):
        tokens = [str(t).strip() for t in selection]
    else:
        tokens = [t for t in re.split(r"[,;\s]+", str(selection if selection is not None else "").strip()) if t]
    out: List[str] = []
    for token in tokens:
        if not token:
            continue
        if token.lower() in (ALL, "*"):
            columns = len(grid[0]) if grid else 0
            out.extend(grid[r][c] for c in range(columns) for r in range(len(grid)))
            continue
        if ":" in token:
            first, _, last = token.partition(":")
            first, last = first.strip(), last.strip()
            for corner in (first, last):
                if corner not in index:
                    raise ValueError(f"'{corner}' is not a position")
            (r1, c1), (r2, c2) = index[first], index[last]
            out.extend(grid[r][c] for c in _span(c1, c2) for r in _span(r1, r2))
            continue
        if token not in index:
            raise ValueError(f"'{token}' is not a position")
        out.append(token)
    return out


def compact_wells(positions: Iterable[str], grid: List[List[str]]) -> str:
    """The shortest selection that expands back to exactly `positions`, in order: runs down a
    column or along a row become "A1:H1", and full-height neighbouring columns one rectangle."""
    index = _index(grid)
    names = [str(p) for p in positions]
    if any(n not in index for n in names):
        return ", ".join(names)
    runs: List[List[str]] = []
    for name in names:
        run = runs[-1] if runs else None
        if run:
            (r0, c0), (r1, c1), (r, c) = index[run[0]], index[run[-1]], index[name]
            step = (r1 - r0, c1 - c0) if len(run) > 1 else None
            down = c == c1 and r == r1 + 1 and step in (None, (len(run) - 1, 0))
            across = r == r1 and c == c1 + 1 and step in (None, (0, len(run) - 1))
            if down or across:
                run.append(name)
                continue
        runs.append([name])
    # Neighbouring columns covering the same rows are one rectangle ("A1:H12").
    merged: List[List[str]] = []
    for run in runs:
        previous = merged[-1] if merged else None
        if previous and len(run) > 1:
            (pr0, pc0), (pr1, pc1) = index[previous[0]], index[previous[-1]]
            (r0, c0), (r1, c1) = index[run[0]], index[run[-1]]
            vertical = c0 == c1 and r0 == pr0 and r1 == pr1 and c0 == pc1 + 1
            if vertical and pr1 > pr0:
                previous[-1] = run[-1]
                continue
        merged.append([run[0], run[-1]] if len(run) > 1 else run)
    return ", ".join(f"{run[0]}:{run[-1]}" if len(run) > 1 else run[0] for run in merged)


# --- Wells with their labware ---------------------------------------------------------------------

_REFERENCE = re.compile(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[([^\]]*)\])?\s*[,;]?\s*")
_WELL_NAME = re.compile(r"[A-Za-z]{1,2}[0-9]{1,3}")


def parse_references(value: Any) -> List[tuple]:
    """`assay_plate[A1:H1], reservoir[A1]` (or a list of such) as [(labware, selection or None)].
    A bare name (`assay_plate`) has no selection. Raises ValueError for anything else."""
    items = value if isinstance(value, (list, tuple)) else [value]
    out: List[tuple] = []
    for item in items:
        text = str(item if item is not None else "").strip()
        position = 0
        while position < len(text):
            match = _REFERENCE.match(text, position)
            if not match or match.end() == position:
                raise ValueError(f"'{text}' is not written as labware[wells], e.g. assay_plate[A1:H1]")
            out.append((match.group(1), match.group(2)))
            position = match.end()
    if not out:
        raise ValueError("no wells were given")
    return out


def expand_references(value: Any, grids: Dict[str, List[List[str]]], kinds: Optional[Dict[str, str]] = None,
                      categories: Iterable[str] = ()) -> List[tuple]:
    """Every (labware, well) a value names, in order. `grids` is each labware's position names;
    a bare name is all of them. Raises ValueError saying what is wrong, naming the labware."""
    wanted = list(categories or ())
    out: List[tuple] = []
    for labware, selection in parse_references(value):
        if labware not in grids:
            hint = " (write wells with their labware, e.g. assay_plate[A1])" if _WELL_NAME.fullmatch(labware) else ""
            raise ValueError(f"'{labware}' is not on this worktable{hint}; it has {', '.join(grids) or 'nothing'}")
        kind = (kinds or {}).get(labware)
        if wanted and kind and kind not in wanted:
            raise ValueError(f"'{labware}' is a {kind.replace('_', ' ')}, not a {' or '.join(c.replace('_', ' ') for c in wanted)}")
        grid = grids[labware]
        try:
            wells = expand_wells(ALL if selection is None else selection, grid)
        except ValueError as e:
            raise ValueError(f"{e} on {labware}") from None
        out.extend((labware, well) for well in wells)
    return out
