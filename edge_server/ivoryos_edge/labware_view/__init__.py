"""The Labware view: every worktable on the deck, seen from above, as it is right now.

    ivoryos_edge.run(__name__, plugins=[ivoryos_edge.labware_view.plugin])
    "plugins": ["ivoryos_edge.labware_view:plugin"]            in a deck file

It draws whatever an instrument reports through `__ivoryos_labware__` (labware.py): the
PyLabRobot adapter does, and any other driver that implements the two methods is drawn the same
way. Nothing here knows about a robot. Wells show what they hold, tip racks which tips are left,
and the wells a step is working on light up while it runs.

Served at /plugins/labware/ (page), /plugins/labware/api/layout, /plugins/labware/api/state and
/plugins/labware/events.
"""

from fastapi.responses import JSONResponse

from ..labware import CATALOG_METHOD, EDIT_METHOD, EVENTS_METHOD, layout_of, state_of
from ..plugins import Plugin

plugin = Plugin("Labware", id="labware", page="page", placement="panel-right", icon="grid-3x3")


def _worktables() -> dict:
    """Instruments that own a worktable. One that only shares another's (a plate reader that
    reads in place) reports labware without a `deck`, and is not drawn twice."""
    found = {}
    for name, instrument in plugin.instruments.items():
        layout = layout_of(instrument)
        if layout and layout.get("deck"):
            found[name] = (instrument, layout)
    return found


def layout() -> dict:
    return {"worktables": {name: found for name, (_, found) in _worktables().items()}}


def state() -> dict:
    return {"worktables": {name: state_of(instrument) or {} for name, (instrument, _) in _worktables().items()}}


@plugin.on_start
def _start(instruments):
    for name, instrument in instruments.items():
        subscribe = getattr(instrument, EVENTS_METHOD, None)
        if not callable(subscribe):
            continue

        def on_event(event, name=name, instrument=instrument):
            # A move changes where things are, so the page asks for the layout again.
            plugin.publish({"worktable": name, "event": event, "state": state_of(instrument) or {},
                            "relayout": event.get("action") in ("move", "layout")})

        subscribe(on_event)


@plugin.router.get("/api/layout")
def get_layout():
    return layout()


@plugin.router.get("/api/state")
def get_state():
    return state()


@plugin.router.get("/api/catalog")
def get_catalog():
    """Per worktable, what can be put on it and which robots it can become (labware.py
    CATALOG_METHOD). Empty lists for one that cannot be rearranged here."""
    out = {}
    for name, (instrument, _) in _worktables().items():
        catalog = getattr(instrument, CATALOG_METHOD, None)
        found = catalog() if callable(catalog) else None
        out[name] = found if isinstance(found, dict) else {"labware": [], "decks": [], "deck": None}
    return {"worktables": out}


@plugin.router.post("/api/edit")
def edit(change: dict):
    """Change a worktable: {"worktable", "action": "place", "site", "definition", "name"},
    {"action": "remove", "name"}, or {"action": "deck", "deck"} (start over on another robot's
    worktable; the simulator only). This records what a person put on the worktable; nothing
    moves. Steps offer the new labware after the deck restarts, since the edge reads those names
    into its schema at startup."""
    found = _worktables().get(str(change.get("worktable")))
    apply = getattr(found[0], EDIT_METHOD, None) if found else None
    if not callable(apply):  # a driver that reports a worktable but cannot change it
        return JSONResponse(status_code=400, content={"error": "This worktable cannot be rearranged from here."})
    try:
        apply(str(change.get("action")), **{k: v for k, v in change.items() if k not in ("worktable", "action")})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    return {"layout": layout(), "catalog": get_catalog()["worktables"], "restart_needed": True}
