"""A PyLabRobot liquid handler as an IvoryOS instrument.

PyLabRobot already has what IvoryOS should not rebuild: worktables for the Hamilton STAR and
Vantage, the Opentrons OT-2 and the Tecan EVO, several hundred plate, tip-rack and carrier
definitions with their real geometry, tip and volume tracking, and a simulator backend. What it
does not have is a call a form can fill in: `lh.aspirate(plate["A1:H1"], vols=[50] * 8)` takes
live Python objects. This adapter is that missing layer and nothing else. Its steps take names
and well selections ("assay_plate", "A1:H1"), marked with `labware.py`'s annotations so the
Designer offers the worktable's labware and a plate to pick wells on, and it reports the
worktable (`__ivoryos_labware__`) for the Labware view and the safety guard.

The worktable is data, so it fits a deck file as well as a script:

    handler = PLRLiquidHandler(
        deck="ot2", backend="simulator", channels=8,
        layout=[{"slot": 1, "labware": "opentrons_96_tiprack_300ul", "name": "tips_300"},
                {"slot": 2, "labware": "cor_96_wellplate_360uL_Fb", "name": "assay_plate"}],
        liquids=[{"labware": "reservoir", "wells": "A1", "liquid": "buffer", "volume_ul": 12000}])

`labware` is the name of a definition in `pylabrobot.resources`. On a Hamilton, labware sits on
carriers: `{"rails": 15, "carrier": "PLT_CAR_L5AC_A00", "name": "plates", "sites": {"0":
{"labware": "cor_96_wellplate_360uL_Fb", "name": "assay_plate"}}}`. A script that already builds
its own `pylabrobot.liquid_handling.LiquidHandler` passes it as `handler=` instead.

With `layout_file` (a name in the data folder, or a path) the worktable can be rearranged from
the Labware view: what is placed or removed there is saved to that file, which then replaces
`layout` the next time the deck starts. The edge reads labware names into its schema at startup,
so a changed worktable takes a restart before steps offer it.

Nothing touches the robot until the first step: `LiquidHandler.setup()` opens the connection,
and a deck has to be constructible with the robot switched off.

Only the simulator backend has been run. "ot2", "star", "vantage" and "evo" construct the
PyLabRobot backend of that name with `backend_args`; they are untested here.
"""

import asyncio
import copy
import difflib
import inspect
import json
import os
import re
from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from .labware import ALL, Labware, PerWell, Site, WellSelection, Wells, expand_wells

try:
    import pylabrobot.resources as plr_resources
    from pylabrobot.liquid_handling import LiquidHandler
    from pylabrobot.resources import (Carrier, Container, ItemizedResource, Plate, ResourceHolder, TipRack, Trash,
                                      set_tip_tracking, set_volume_tracking)
except ImportError as e:  # pragma: no cover - exercised only without the extra installed
    raise ImportError("ivoryos_edge.plr needs PyLabRobot: pip install 'ivoryos-edge[plr]' (or pip install pylabrobot)") from e

DECKS = {"ot2": "OTDeck", "starlet": "STARLetDeck", "star": "STARDeck", "vantage": "VantageDeck"}
BACKENDS = {"ot2": "OpentronsOT2Backend", "star": "STARBackend", "vantage": "VantageBackend", "evo": "EVOBackend"}
LIQUID_CONTAINERS = ("plate", "reservoir", "tube_rack")
# A liquid nobody named: the volume is tracked, what it is is not.
UNKNOWN = "liquid"
# Channels of a multichannel head sit 9 mm apart.
CHANNEL_PITCH_MM = 9.0


def _make(definition: str, name: str):
    factory = getattr(plr_resources, str(definition), None)
    if not callable(factory):
        close = difflib.get_close_matches(str(definition), dir(plr_resources), n=3)
        hint = f" Did you mean {', '.join(close)}?" if close else ""
        raise ValueError(f"'{definition}' is not a labware definition in pylabrobot.resources.{hint}")
    return factory(name=name)


_catalog: Optional[list] = None


def catalog() -> List[Dict[str, str]]:
    """Every plate, tip rack and reservoir PyLabRobot defines, by the name `layout` takes.
    Read from each definition's return type, so nothing is constructed to find out."""
    global _catalog
    if _catalog is None:
        kinds = {"Plate": "plate", "TipRack": "tip_rack", "TubeRack": "tube_rack", "Trough": "reservoir"}
        found = []
        for name in dir(plr_resources):
            factory = getattr(plr_resources, name)
            if name.startswith("_") or inspect.isclass(factory) or not callable(factory):
                continue
            try:
                signature = inspect.signature(factory)
                returns = signature.return_annotation
                kind = kinds.get(returns if isinstance(returns, str) else getattr(returns, "__name__", ""))
                if not kind or list(signature.parameters)[:1] != ["name"]:
                    continue
                if "deprecated" in inspect.getsource(factory).lower():
                    continue  # an old spelling kept as an alias of the current one
            except (TypeError, ValueError, OSError):
                continue
            if kind == "plate" and ("trough" in name.lower() or "reservoir" in name.lower()):
                kind = "reservoir"
            found.append({"definition": name, "category": kind})
        _catalog = sorted(found, key=lambda entry: (entry["category"], entry["definition"].lower()))
    return _catalog


def _category(resource) -> str:
    if isinstance(resource, TipRack):
        return "tip_rack"
    if isinstance(resource, Plate):
        model = str(getattr(resource, "model", "") or "").lower()
        return "reservoir" if "trough" in model or "reservoir" in model else "plate"
    if isinstance(resource, Container):
        return "reservoir"
    return str(getattr(resource, "category", None) or "rack")


def _grid(resource) -> List[List[str]]:
    """Position names as rows of columns. PyLabRobot orders items column by column."""
    if not isinstance(resource, ItemizedResource):
        return [["A1"]]
    rows, columns = resource.num_items_y, resource.num_items_x
    items = resource.get_all_items()
    names = [resource.get_child_identifier(item) for item in items]
    if len(names) != rows * columns:
        return [names]
    return [[names[c * rows + r] for c in range(columns)] for r in range(rows)]


def _box(resource) -> Dict[str, float]:
    at = resource.get_absolute_location()
    return {"x": round(at.x, 2), "y": round(at.y, 2),
            "w": round(resource.get_absolute_size_x(), 2), "h": round(resource.get_absolute_size_y(), 2)}


class PLRLiquidHandler:
    """A liquid handler driven through PyLabRobot. Steps take labware names and wells."""

    def __init__(self, deck: str = "ot2", backend: str = "simulator", channels: int = 8,
                 layout: Optional[list] = None, liquids: Optional[list] = None,
                 backend_args: Optional[dict] = None, step_delay_s: float = 0.0, handler: Any = None,
                 layout_file: Optional[str] = None):
        set_tip_tracking(True)
        set_volume_tracking(True)
        # The worktable as data, kept so it can be edited and saved. None for a `handler` built
        # elsewhere: there is no telling which definition each of its resources came from.
        self._placements: Optional[list] = None
        self._layout_file: Optional[str] = None
        self._deck_kind = deck
        if handler is not None:
            self._lh = handler
        else:
            if deck not in DECKS:
                raise ValueError(f"deck must be one of {', '.join(DECKS)}, not '{deck}'")
            worktable = getattr(plr_resources, DECKS[deck])()
            self._lh = LiquidHandler(backend=self._backend(backend, channels, backend_args or {}), deck=worktable)
            self._placements = copy.deepcopy(layout or [])
            if layout_file:
                from . import paths
                self._layout_file = layout_file if os.path.isabs(layout_file) else os.path.join(
                    paths.DATA_DIR or os.getcwd(), layout_file)
                saved = self._saved_layout()
                if saved is not None:
                    self._placements = saved
            self._place(self._placements)
        self._simulated = type(self._lh.backend).__name__.endswith("ChatterboxBackend")
        self._channels = int(getattr(self._lh.backend, "num_channels", channels) if self._simulated else channels)
        self._delay = float(step_delay_s) if self._simulated else 0.0
        self._ready = False
        self._setting_up: Optional[asyncio.Lock] = None
        # What each well holds, by liquid: PyLabRobot tracks a well's volume, not what it is.
        self._contents: Dict[tuple, Dict[str, float]] = {}
        self._in_tips: Dict[int, Dict[str, float]] = {}
        self._listeners: list = []
        self._layout: Optional[dict] = None
        for entry in liquids or []:
            if entry["labware"] not in self._labware_map():
                # Taken off the worktable since (a saved layout): nothing to fill.
                print(f"Liquid '{entry['liquid']}' not loaded: {entry['labware']} is not on the worktable")
                continue
            self._load(entry["labware"], entry.get("wells", ALL), entry["liquid"], entry["volume_ul"])

    # --- construction ---------------------------------------------------------------------------

    @staticmethod
    def _backend(kind: str, channels: int, args: dict):
        import pylabrobot.liquid_handling.backends as backends
        if kind == "simulator":
            return backends.LiquidHandlerChatterboxBackend(num_channels=int(channels))
        if kind not in BACKENDS:
            raise ValueError(f"backend must be simulator, {', '.join(BACKENDS)}, not '{kind}'")
        return getattr(backends, BACKENDS[kind])(**args)

    def _place(self, placements: list) -> None:
        deck = self._lh.deck
        for entry in placements:
            if "carrier" in entry:
                resource = _make(entry["carrier"], entry["name"])
                for site, item in (entry.get("sites") or {}).items():
                    resource[int(site)] = _make(item["labware"], item["name"])
            else:
                resource = _make(entry["labware"], entry["name"])
            if "slot" in entry:
                deck.assign_child_at_slot(resource, int(entry["slot"]))
            elif "rails" in entry:
                deck.assign_child_resource(resource, rails=int(entry["rails"]))
            else:
                raise ValueError(f"'{entry.get('name')}' needs a slot (Opentrons) or rails (Hamilton) to sit on")

    def _saved_layout(self) -> Optional[list]:
        """The layout last saved from the Labware view, if it was made for this kind of deck."""
        try:
            with open(self._layout_file) as f:
                saved = json.load(f)
        except (OSError, ValueError):
            return None
        return saved.get("layout") if saved.get("deck") == self._deck_kind else None

    def __ivoryos_labware_catalog__(self) -> list:
        return catalog() if self._placements is not None else []

    def __ivoryos_labware_edit__(self, action: str, **change) -> None:
        """Place or remove a labware (the Labware view's editor). Nothing moves: this says what a
        person put on the worktable, exactly as `layout` does."""
        if self._placements is None:
            raise ValueError("This worktable was built in a script (handler=...), so it is changed there")
        if self._mounted():
            raise ValueError("Tips are on the head: drop them before changing the worktable")
        if action == "place":
            self._edit_place(str(change.get("site", "")), str(change.get("definition", "")), str(change.get("name", "")).strip())
        elif action == "remove":
            self._edit_remove(str(change.get("name", "")))
        else:
            raise ValueError(f"'{action}' is not something that can be done to a worktable")
        self._layout = None
        if self._layout_file:
            os.makedirs(os.path.dirname(self._layout_file) or ".", exist_ok=True)
            with open(self._layout_file, "w") as f:
                json.dump({"format": "ivoryos-worktable/1", "deck": self._deck_kind, "layout": self._placements}, f, indent=2)
        for listener in self._listeners:
            try:
                listener({"action": "layout", "labware": change.get("name"), "wells": []})
            except Exception as e:
                print(f"Labware listener failed: {e}")

    def _edit_place(self, site: str, definition: str, name: str) -> None:
        sites = self._site_map()
        if site not in sites:
            raise ValueError(f"'{site}' is not a place on this worktable")
        holder = sites[site]
        if holder.children:
            raise ValueError(f"{site} already holds {holder.children[0].name}")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", name):
            raise ValueError("A labware's name starts with a letter and has only letters, digits and _")
        if self._lh.deck.has_resource(name):
            raise ValueError(f"Something on this worktable is already called '{name}'")
        holder.assign_child_resource(_make(definition, name))
        carrier = holder.parent if isinstance(holder.parent, Carrier) else None
        if carrier is None:
            self._placements.append({"slot": int(site), "labware": definition, "name": name})
            return
        entry = next(e for e in self._placements if e.get("name") == carrier.name)
        entry.setdefault("sites", {})[str(carrier.children.index(holder))] = {"labware": definition, "name": name}

    def _edit_remove(self, name: str) -> None:
        self._resource(name).unassign()
        for key in [k for k in self._contents if k[0] == name]:
            del self._contents[key]
        kept = []
        for entry in self._placements:
            if "carrier" in entry:
                entry["sites"] = {k: v for k, v in (entry.get("sites") or {}).items() if v.get("name") != name}
            elif entry.get("name") == name:
                continue
            kept.append(entry)
        self._placements[:] = kept

    async def _setup(self) -> None:
        if self._ready:
            return
        if self._setting_up is None:
            self._setting_up = asyncio.Lock()
        async with self._setting_up:
            if not self._ready:
                if not getattr(self._lh, "setup_finished", False):
                    await self._lh.setup()
                self._ready = True

    # --- the worktable, as IvoryOS reads it -------------------------------------------------------

    def _labware_map(self) -> Dict[str, Any]:
        """Everything addressable on the worktable: racks and plates, and troughs on their own."""
        found: Dict[str, Any] = {}

        def walk(resource):
            for child in resource.children:
                if isinstance(child, Trash):
                    continue  # a Container to PyLabRobot, not something a step addresses
                if isinstance(child, (ItemizedResource, Container)):
                    found[child.name] = child
                else:
                    walk(child)

        walk(self._lh.deck)
        return found

    def _site_map(self) -> Dict[str, Any]:
        """Places a labware can sit, by the label a person uses: "5" on an OT-2, the carrier
        position's own name ("plates-0") on a Hamilton."""
        deck, out = self._lh.deck, {}

        def walk(resource):
            for child in resource.children:
                if isinstance(child, ResourceHolder):
                    prefix = f"{deck.name}_slot_"
                    out[child.name[len(prefix):] if child.name.startswith(prefix) else child.name] = child
                elif isinstance(child, Carrier) or not isinstance(child, (ItemizedResource, Container, Trash)):
                    walk(child)

        walk(deck)
        return out

    def __ivoryos_labware__(self) -> dict:
        if self._layout is not None:
            return self._layout
        deck = self._lh.deck
        sites = self._site_map()
        site_of = {id(holder): label for label, holder in sites.items()}
        labware = {}
        for name, resource in self._labware_map().items():
            box = _box(resource)
            spots = {}
            items = resource.get_all_items() if isinstance(resource, ItemizedResource) else [resource]
            for item in items:
                spot = _box(item)
                round_ = getattr(getattr(item, "cross_section_type", None), "value", "") == "circle" \
                    or not isinstance(item, Container)
                key = resource.get_child_identifier(item) if isinstance(resource, ItemizedResource) else "A1"
                spots[key] = [round(spot["x"] - box["x"], 2), round(spot["y"] - box["y"], 2), spot["w"], spot["h"],
                              bool(round_)]
            first = items[0] if items else None
            labware[name] = {
                "label": name, "category": _category(resource), "model": getattr(resource, "model", None),
                "grid": _grid(resource), "site": site_of.get(id(resource.parent)),
                "max_volume_ul": getattr(first, "max_volume", None), **box, "spots": spots,
            }
        fixtures = []

        def walk(resource):
            for child in resource.children:
                if isinstance(child, (Carrier, Trash)):
                    fixtures.append({"name": child.name, **_box(child),
                                     "category": "trash" if isinstance(child, Trash) else "carrier"})
                if isinstance(child, (Carrier, ResourceHolder)):
                    walk(child)

        walk(deck)
        self._layout = {
            "deck": {"name": deck.name, "kind": type(deck).__name__,
                     "width": deck.get_absolute_size_x(), "depth": deck.get_absolute_size_y()},
            "labware": labware,
            "sites": [{"name": holder.name, "label": label, **_box(holder),
                       "holds": holder.children[0].name if holder.children else None}
                      for label, holder in sites.items()],
            "fixtures": fixtures,
        }
        return self._layout

    def __ivoryos_labware_state__(self) -> dict:
        out: Dict[str, Dict[str, dict]] = {}
        for name, resource in self._labware_map().items():
            spots: Dict[str, dict] = {}
            if isinstance(resource, TipRack):
                for spot in resource.get_all_items():
                    spots[resource.get_child_identifier(spot)] = {"tip": spot.has_tip()}
            else:
                items = resource.get_all_items() if isinstance(resource, ItemizedResource) else [resource]
                for item in items:
                    volume = item.tracker.get_used_volume() if isinstance(item, Container) else 0
                    if volume > 0:
                        key = resource.get_child_identifier(item) if isinstance(resource, ItemizedResource) else "A1"
                        liquids = self._contents.get((name, key)) or {UNKNOWN: volume}
                        spots[key] = {"volume_ul": round(volume, 3),
                                      "liquids": {k: round(v, 3) for k, v in liquids.items() if v > 1e-9}}
            out[name] = spots
        head = getattr(self._lh, "head", {}) or {}
        return {"labware": out, "channels": [bool(head[i].has_tip) for i in sorted(head)]}

    def __ivoryos_labware_events__(self, callback) -> None:
        """Call `callback(event)` as things happen on the worktable: {"action": "aspirate" |
        "dispense" | "pick_up_tips" | "drop_tips" | "move" | "load", "labware", "wells"}."""
        self._listeners.append(callback)

    async def _emit(self, action: str, labware: Optional[str] = None, wells: Optional[List[str]] = None) -> None:
        event = {"action": action, "labware": labware, "wells": wells or []}
        for listener in self._listeners:
            try:
                listener(event)
            except Exception as e:  # a view must never fail a transfer
                print(f"Labware listener failed: {e}")
        if self._delay:
            await asyncio.sleep(self._delay)

    # --- resolving names --------------------------------------------------------------------------

    def _resource(self, labware: str, kind: str = "labware"):
        found = self._labware_map()
        if labware not in found:
            raise ValueError(f"'{labware}' is not a {kind} on this worktable (it has: {', '.join(found) or 'nothing'})")
        return found[labware]

    def _targets(self, labware: str, wells: WellSelection) -> List[tuple]:
        """(labware, well, container) for each selected well, in visiting order."""
        resource = self._resource(labware)
        if isinstance(resource, TipRack):
            raise ValueError(f"'{labware}' is a tip rack, not something that holds liquid")
        try:
            names = expand_wells(wells, _grid(resource))
        except ValueError as e:
            raise ValueError(f"{e} on {labware}") from None
        if not names:
            raise ValueError(f"No wells were given for {labware}")
        if not isinstance(resource, ItemizedResource):
            return [(labware, "A1", resource) for _ in names]
        return [(labware, name, resource.get_item(name)) for name in names]

    @staticmethod
    def _per_well(value, count: int, what: str) -> List[float]:
        values = list(value) if isinstance(value, (list, tuple)) else [value]
        if len(values) == 1:
            values = values * count
        if len(values) != count:
            raise ValueError(f"{what} has {len(values)} values for {count} wells: give one, or one per well")
        try:
            return [float(v) for v in values]
        except (TypeError, ValueError):
            raise ValueError(f"{what} must be a number, or one number per well") from None

    # --- tips ---------------------------------------------------------------------------------------

    def _mounted(self) -> List[int]:
        head = getattr(self._lh, "head", {}) or {}
        return [i for i in sorted(head) if head[i].has_tip]

    async def _pick_up(self, tip_rack: str, count: int, tips: WellSelection = "next") -> List[str]:
        rack = self._resource(tip_rack, "tip rack")
        if not isinstance(rack, TipRack):
            raise ValueError(f"'{tip_rack}' is not a tip rack")
        if isinstance(tips, str) and tips.strip().lower() == "next":
            spots = [s for s in rack.get_all_items() if s.has_tip()][:count]
            if len(spots) < count:
                raise ValueError(f"{tip_rack} has {len(spots)} tips left and {count} are needed")
        else:
            spots = [rack.get_item(n) for n in expand_wells(tips, _grid(rack))]
        names = [rack.get_child_identifier(s) for s in spots]
        await self._lh.pick_up_tips(spots, use_channels=list(range(len(spots))))
        await self._emit("pick_up_tips", tip_rack, names)
        return names

    async def _drop(self, to: str = "trash") -> None:
        if not self._mounted():
            return
        if to == "rack":
            await self._lh.return_tips()
        else:
            await self._lh.discard_tips()
        self._in_tips.clear()
        await self._emit("drop_tips")

    # --- liquid -------------------------------------------------------------------------------------

    def _load(self, labware: str, wells: WellSelection, liquid: str, volume_ul) -> List[str]:
        targets = self._targets(labware, wells)
        volumes = self._per_well(volume_ul, len(targets), "volume_ul")
        for (name, well, container), volume in zip(targets, volumes):
            container.tracker.set_volume(container.tracker.get_used_volume() + volume)
            held = self._contents.setdefault((name, well), {})
            held[str(liquid)] = held.get(str(liquid), 0.0) + volume
        return [well for _, well, _ in targets]

    def _take(self, key: tuple, volume: float) -> Dict[str, float]:
        """What `volume` drawn from a well consists of, removed from the well's record."""
        held = self._contents.get(key) or {}
        total = sum(held.values())
        if total <= 1e-9:
            return {UNKNOWN: volume}
        share = min(1.0, volume / total)
        taken = {liquid: amount * share for liquid, amount in held.items()}
        for liquid, amount in taken.items():
            held[liquid] -= amount
        return taken

    @staticmethod
    def _fits(container) -> int:
        """How many channels reach into one container at once: one for a well, several for a trough."""
        return max(1, int(container.get_absolute_size_y() // CHANNEL_PITCH_MM) - 1)

    async def _liquid(self, action: str, targets: List[tuple], volumes: List[float], channels: List[int]) -> None:
        """One aspirate or dispense across `channels`. Channels sharing a container go in as many
        at a time as fit side by side in it; the rest go together."""
        operation = self._lh.aspirate if action == "aspirate" else self._lh.dispense
        groups: Dict[int, List[int]] = {}
        for i, (_, _, container) in enumerate(targets):
            groups.setdefault(id(container), []).append(i)
        batches = [[members[0] for members in groups.values() if len(members) == 1]]
        for members in groups.values():
            if len(members) > 1:
                fit = self._fits(targets[members[0]][2])
                batches += [members[i:i + fit] for i in range(0, len(members), fit)]
        for batch in batches:
            if not batch:
                continue
            await operation([targets[i][2] for i in batch], vols=[volumes[i] for i in batch],
                            use_channels=[channels[i] for i in batch])
            for i in batch:
                name, well, _ = targets[i]
                tip = self._in_tips.setdefault(channels[i], {})
                if action == "aspirate":
                    for liquid, amount in self._take((name, well), volumes[i]).items():
                        tip[liquid] = tip.get(liquid, 0.0) + amount
                    continue
                held = self._contents.setdefault((name, well), {})
                total = sum(tip.values())
                if total <= 1e-9:
                    held[UNKNOWN] = held.get(UNKNOWN, 0.0) + volumes[i]
                    continue
                share = min(1.0, volumes[i] / total)
                for liquid in list(tip):
                    moved = tip[liquid] * share
                    tip[liquid] -= moved
                    held[liquid] = held.get(liquid, 0.0) + moved
        by_labware: Dict[str, List[str]] = {}
        for name, well, _ in targets:
            by_labware.setdefault(name, []).append(well)
        for name, wells in by_labware.items():
            await self._emit(action, name, wells)

    # --- steps ----------------------------------------------------------------------------------------

    async def transfer(self,
                       source: Annotated[str, Labware(*LIQUID_CONTAINERS)],
                       source_wells: Annotated[WellSelection, Wells("source")],
                       dest: Annotated[str, Labware(*LIQUID_CONTAINERS)],
                       dest_wells: Annotated[WellSelection, Wells("dest")],
                       volume_ul: Annotated[Union[float, List[float]], PerWell("dest_wells")],
                       tips: Annotated[str, Labware("tip_rack")],
                       new_tip: Literal["always", "once", "never"] = "always") -> Dict[str, float]:
        """Move liquid from source wells to destination wells, as many at a time as the head has channels.

        One source well feeds every destination (a reservoir into a plate), or wells pair up one
        to one, or many pool into one. A volume is one number for all of them or one per
        destination; a well given 0 is skipped. Tips come from the next unused ones in `tips`:
        fresh for every group of wells ("always"), one set for the whole step ("once"), or the
        ones already on the head ("never"). Returns the volume delivered to each destination well.
        """
        await self._setup()
        sources, dests = self._targets(source, source_wells), self._targets(dest, dest_wells)
        count = max(len(sources), len(dests))
        if len(sources) not in (1, count) or len(dests) not in (1, count):
            raise ValueError(f"{len(sources)} source wells and {len(dests)} destination wells do not pair up: "
                             "use one to many, many to one, or the same number of each")
        sources, dests = sources * (count // len(sources)), dests * (count // len(dests))
        volumes = self._per_well(volume_ul, count, "volume_ul")
        pairs = [(s, d, v) for s, d, v in zip(sources, dests, volumes) if v > 0]
        delivered: Dict[str, float] = {}
        if new_tip == "never" and not self._mounted():
            raise ValueError("new_tip is 'never' but no tips are on the head: pick some up first")
        for start in range(0, len(pairs), self._channels):
            group = pairs[start:start + self._channels]
            if new_tip == "always" or (new_tip == "once" and not self._mounted()):
                await self._pick_up(tips, len(group) if new_tip == "always" else min(self._channels, len(pairs)))
            channels = self._channels_for(len(group))
            amounts = [v for _, _, v in group]
            await self._liquid("aspirate", [s for s, _, _ in group], amounts, channels)
            await self._liquid("dispense", [d for _, d, _ in group], amounts, channels)
            for (_, (_, well, _), volume) in group:
                delivered[well] = round(delivered.get(well, 0.0) + volume, 3)
            if new_tip == "always":
                await self._drop()
        if new_tip == "once":
            await self._drop()
        return delivered

    async def pick_up_tips(self, tip_rack: Annotated[str, Labware("tip_rack")],
                           tips: Annotated[WellSelection, Wells("tip_rack")] = "next",
                           count: int = 0) -> List[str]:
        """Put tips on the head: the positions given, or with "next" the next unused ones
        (`count` of them, or one per channel). Returns the positions taken."""
        await self._setup()
        return await self._pick_up(tip_rack, int(count) or self._channels, tips)

    async def drop_tips(self, to: Literal["trash", "rack"] = "trash") -> None:
        """Take the tips off the head: into the trash, or back where they came from."""
        await self._setup()
        await self._drop(to)

    async def aspirate(self, labware: Annotated[str, Labware(*LIQUID_CONTAINERS)],
                       wells: Annotated[WellSelection, Wells("labware")],
                       volume_ul: Annotated[Union[float, List[float]], PerWell("wells")]) -> None:
        """Draw liquid up with the tips on the head, one channel per well."""
        await self._setup()
        targets = self._targets(labware, wells)
        await self._liquid("aspirate", targets, self._per_well(volume_ul, len(targets), "volume_ul"),
                           self._channels_for(len(targets)))

    async def dispense(self, labware: Annotated[str, Labware(*LIQUID_CONTAINERS)],
                       wells: Annotated[WellSelection, Wells("labware")],
                       volume_ul: Annotated[Union[float, List[float]], PerWell("wells")]) -> None:
        """Dispense from the tips on the head, one channel per well."""
        await self._setup()
        targets = self._targets(labware, wells)
        await self._liquid("dispense", targets, self._per_well(volume_ul, len(targets), "volume_ul"),
                           self._channels_for(len(targets)))

    def _channels_for(self, count: int) -> List[int]:
        mounted = self._mounted()
        if count > len(mounted):
            raise ValueError(f"{count} wells need {count} tips on the head, and it has {len(mounted)}")
        return mounted[:count]

    async def mix(self, labware: Annotated[str, Labware(*LIQUID_CONTAINERS)],
                  wells: Annotated[WellSelection, Wells("labware")],
                  volume_ul: float, repetitions: int = 3) -> None:
        """Draw up and dispense in the same wells, `repetitions` times, with the tips on the head."""
        await self._setup()
        targets = self._targets(labware, wells)
        channels = self._channels_for(len(targets))
        amounts = [float(volume_ul)] * len(targets)
        for _ in range(max(1, int(repetitions))):
            await self._liquid("aspirate", targets, amounts, channels)
            await self._liquid("dispense", targets, amounts, channels)

    async def load_liquid(self, labware: Annotated[str, Labware(*LIQUID_CONTAINERS)],
                          wells: Annotated[WellSelection, Wells("labware")],
                          liquid: str,
                          volume_ul: Annotated[Union[float, List[float]], PerWell("wells")]) -> None:
        """Record what a person put on the worktable: this liquid, this much, in these wells.
        Nothing moves."""
        loaded = self._load(labware, wells, liquid, volume_ul)
        await self._emit("load", labware, loaded)

    async def read_volumes(self, labware: Annotated[str, Labware(*LIQUID_CONTAINERS)],
                           wells: Annotated[WellSelection, Wells("labware")] = ALL) -> Dict[str, float]:
        """The volume tracked in each well (µL): what was loaded, plus and minus every transfer."""
        return {well: round(container.tracker.get_used_volume(), 3)
                for _, well, container in self._targets(labware, wells)}

    async def tips_left(self, tip_rack: Annotated[str, Labware("tip_rack")]) -> int:
        """How many unused tips the rack still has."""
        rack = self._resource(tip_rack, "tip rack")
        return sum(1 for spot in rack.get_all_items() if spot.has_tip())

    async def move_plate(self, plate: Annotated[str, Labware("plate", "reservoir")],
                         to: Annotated[str, Site()]) -> None:
        """Carry a plate to another place on the worktable (needs a gripper on a real robot)."""
        await self._setup()
        sites = self._site_map()
        if str(to) not in sites:
            raise ValueError(f"'{to}' is not a place on this worktable (it has: {', '.join(sites)})")
        if sites[str(to)].children:
            raise ValueError(f"{to} already holds {sites[str(to)].children[0].name}")
        await self._lh.move_plate(self._resource(plate), sites[str(to)])
        self._layout = None
        await self._emit("move", plate)

    # --- for instruments that share this worktable (a plate reader reading in place) ---------------

    def _contents_of(self, labware: str, well: str) -> Dict[str, float]:
        return dict(self._contents.get((labware, well)) or {})

    def _volume_of(self, labware: str, well: str) -> float:
        return float(self._targets(labware, well)[0][2].tracker.get_used_volume())


__all__ = ["PLRLiquidHandler", "DECKS", "BACKENDS"]
