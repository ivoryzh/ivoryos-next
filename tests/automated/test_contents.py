"""What is in each vessel, and the calls that change it (ivoryos_edge/contents.py, via safety.py).

Two decks stand in for the two cases: one whose code tracks nothing, so this edge keeps the record
(`Bench`), and one that keeps its own, read in place the way a deck's own container objects are
(`TrackingDeck`). The same transfers, and the same arithmetic, serve both.
"""

import asyncio
import os

import pytest
from httpx import ASGITransport, AsyncClient

from ivoryos_edge import safety
from ivoryos_edge.contents import Plan, suggest_transfers
from ivoryos_edge.introspection import inspect_device_module
from ivoryos_edge.safety import Deck, empty_config, guard, validate
from ivoryos_edge.server import app, queue_manager


def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


class Bench:
    """A liquid handler whose code keeps no record of what is where."""

    def __init__(self):
        self.calls = []

    def charge(self, volume_ml: float, source_tray: str = None, source_index: str = None,
               destination_tray: str = None, destination_index: str = None) -> None:
        self.calls.append(("charge", volume_ml, destination_tray, destination_index))

    def sample(self, sample_volume_ul: float, source_tray: str, source_index: str = None,
               vial_index: str = None) -> None:
        self.calls.append(("sample", sample_volume_ul, source_tray, vial_index))

    def move(self, source_tray: str, source_index: str = None,
             destination_tray: str = None, destination_index: str = None) -> None:
        self.calls.append(("move", source_tray, source_index, destination_tray, destination_index))

    def prepare(self, vial: str, crude_tray: str = None, crude_index: str = None, crude_volume_ml: float = 3,
                water_tray: str = None, water_index: str = None, water_volume_ml: float = 2) -> None:
        self.calls.append(("prepare", vial))

    def spill(self, volume_ml: float, destination_tray: str = None, destination_index: str = None) -> None:
        raise RuntimeError("the needle hit the rim")


class Number:
    """A volume as some decks keep it: an uncertainty-carrying number (uncertainties.ufloat)."""

    def __init__(self, value):
        self.nominal_value = value


class Vial:
    def __init__(self, volume, capacity=14.5):
        self.total_volume = Number(volume)
        self.max_volume_ml = capacity
        self.contents = {"water": Number(volume)} if volume else {}


class Tray(dict):
    pass


class TrackingDeck:
    """A deck whose code keeps the record itself: deck.trays[tray][position] is a vial."""

    def __init__(self):
        self.trays = {"extraction": Tray(A1=Vial(13.0), A2=Vial(0.0)), "solvent": Tray()}
        self.reactor = None  # the vial in the reactor; the tray still lists it under its own slot
        self.calls = []

    def to_reactor(self, index: str) -> None:
        self.reactor = self.trays["extraction"][index]

    def from_reactor(self) -> None:
        self.reactor = None

    def charge_liquid(self, volume_ml: float, source_tray: str = None, source_index: str = None,
                      destination_tray: str = None, destination_index: str = None) -> None:
        vial = self.reactor if destination_tray == "reactor" else self.trays[destination_tray][destination_index]
        vial.total_volume = Number(vial.total_volume.nominal_value + volume_ml)
        self.calls.append(("charge_liquid", volume_ml))


@pytest.fixture(autouse=True)
def deck():
    """Each test starts with no configuration and nothing recorded, and with both decks loaded."""
    added = {"bench": Bench(), "tracker": TrackingDeck()}
    for name, obj in added.items():
        app.state.instruments[name] = obj
        app.state.instrument_schemas[name] = inspect_device_module(obj)

    def reset():
        for path in (guard.path, guard.state_path, guard.contents_path):
            if os.path.exists(path):
                os.remove(path)
        guard.load()
        guard.state.clear()
        guard.contents.clear()
        guard.blocked.clear()
        queue_manager.resume()
    reset()
    yield added
    reset()
    for name in added:
        app.state.instruments.pop(name)
        app.state.instrument_schemas.pop(name)


def tray(label, rows, columns, naming="A1", **contents):
    return {"label": label, "rows": rows, "columns": columns, "naming": naming, "order": "row", "blocked": [],
            **({"contents": contents} if contents else {})}


def side(tray_arg, position_arg=None):
    out = {"tray": {"arg": tray_arg}}
    if position_arg:
        out["position"] = {"arg": position_arg}
    return out


CHARGE = {"name": "Charge", "when": {"target": "bench", "method": "charge"}, "moves": "liquid",
          "amount": {"arg": "volume_ml"}, "unit": "mL",
          "from": side("source_tray", "source_index"), "to": side("destination_tray", "destination_index")}
SAMPLE = {"name": "Sample", "when": {"target": "bench", "method": "sample"}, "moves": "liquid",
          "amount": {"arg": "sample_volume_ul"}, "unit": "µL",
          "from": side("source_tray", "source_index"), "to": {"tray": {"value": "hplc"}, "position": {"arg": "vial_index"}}}
MOVE = {"name": "Move", "when": {"target": "bench", "method": "move"}, "moves": "vessel",
        "from": side("source_tray", "source_index"), "to": side("destination_tray", "destination_index")}
SPILL = {**CHARGE, "name": "Spill", "when": {"target": "bench", "method": "spill"}, "from": None}

BENCH_TRAYS = {
    "vials": tray("Vials", 1, 3, capacity=2, unit="mL", kept_by="ivoryos", check_draws=True),
    "hplc": tray("HPLC vials", 1, 2, capacity=1.5, unit="mL", kept_by="ivoryos"),
    "bottles": tray("Bottles", 1, 2, role="stock", kept_by="ivoryos", liquids={"A1": "water", "A2": "DCM"}),
    "reactor": tray("Reactor", 1, 1, naming="1", capacity=14.5, unit="mL", kept_by="ivoryos", empty="nothing",
                    aliases=["easymax"]),
}


async def save(ac, **config):
    response = await ac.put("/api/safety", json={**empty_config(), **config})
    assert response.status_code == 200, response.text
    return response.json()


async def call(ac, instrument, method, **args):
    """A call by hand, waited for: contents change when the call ends, not when it is sent."""
    started = await ac.post("/api/execute", json={"module": instrument, "method": method, "args": args})
    if started.status_code != 200:
        return started
    task_id = started.json()["task_id"]
    for _ in range(100):
        done = (await ac.get(f"/api/execute/{task_id}")).json()
        if done.get("status") in ("completed", "error"):
            return done
        await asyncio.sleep(0.02)
    return done


async def contents(ac):
    return (await ac.get("/api/safety/contents")).json()["trays"]


async def finished(ac, run_id):
    for _ in range(100):
        run = (await ac.get(f"/api/queue/runs/{run_id}")).json()
        if run["status"] in ("completed", "error", "cancelled"):
            return run
        await asyncio.sleep(0.05)
    return run


# --- Configuration ----------------------------------------------------------------------------------

def test_a_tray_says_what_it_holds_and_a_transfer_what_a_call_moves():
    config, problems = validate({**empty_config(), "trays": BENCH_TRAYS, "transfers": [CHARGE, MOVE]})
    assert [p for p in problems if p["level"] == "error"] == []
    assert config["trays"]["vials"]["contents"] == {"role": "vessels", "kept_by": "ivoryos", "unit": "mL",
                                                    "capacity": 2, "empty": "vessel", "check_draws": True}
    assert config["trays"]["reactor"]["contents"]["aliases"] == ["easymax"]
    assert [t["moves"] for t in config["transfers"]] == ["liquid", "vessel"]

    _, problems = validate({**empty_config(), "trays": {
        "a": tray("A", 1, 1, role="bucket"),
        "b": tray("B", 1, 1, unit="gallon"),
        "c": tray("C", 1, 1, kept_by="deck"),
    }, "transfers": [
        {**CHARGE, "amount": None},
        {**MOVE, "to": None},
        {**CHARGE, "when": {"target": "bench", "method": "*"}},
    ]})
    errors = " | ".join(p["message"] for p in problems if p["level"] == "error")
    assert "holds 'vessels' or a 'stock', not 'bucket'" in errors
    assert "volumes are in" in errors and "not 'gallon'" in errors
    assert "say where the deck keeps it" in errors
    assert "say how much it moves" in errors
    assert "carries a vessel from one place to another: give both" in errors
    assert "say which instrument's method moves it" in errors


def test_a_transfer_to_a_tray_with_no_contents_is_a_warning():
    _, problems = validate({**empty_config(), "trays": BENCH_TRAYS, "transfers": [
        {**CHARGE, "to": {"tray": {"value": "waste"}}}]}, guard.deck())
    assert any("moves to 'waste', a tray with no contents configured" in p["message"] for p in problems)


# --- This edge keeps the record ---------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_charge_is_recorded_and_one_that_would_overflow_is_refused(deck):
    async with client() as ac:
        await save(ac, trays=BENCH_TRAYS, transfers=[CHARGE])
        done = await call(ac, "bench", "charge", volume_ml=1.5, source_tray="bottles", source_index="A1",
                          destination_tray="vials", destination_index="A1")
        assert done["status"] == "completed"
        a1 = (await contents(ac))["vials"]["positions"]["A1"]
        assert a1["volume"] == 1.5 and a1["liquids"] == {"water": 1.5} and a1["by"] == "bench.charge"

        refused = await call(ac, "bench", "charge", volume_ml=1, source_tray="bottles", source_index="A2",
                             destination_tray="vials", destination_index="A1")
        assert refused.status_code == 409
        assert refused.json()["problems"] == [
            "bench.charge: Vials A1 would hold 2.5 mL, more than its 2 mL (it holds 1.5 mL now)."]
        assert len(deck["bench"].calls) == 1, "nothing reached the driver"

        # 0.5 mL still fits; the vial now holds two liquids, in proportion.
        await call(ac, "bench", "charge", volume_ml=0.5, source_tray="bottles", source_index="A2",
                   destination_tray="vials", destination_index="A1")
        assert (await contents(ac))["vials"]["positions"]["A1"]["liquids"] == {"water": 1.5, "DCM": 0.5}


@pytest.mark.asyncio
async def test_a_vessel_is_not_drawn_from_beyond_what_it_holds_and_a_mixture_goes_in_proportion():
    async with client() as ac:
        await save(ac, trays=BENCH_TRAYS, transfers=[CHARGE, SAMPLE])
        guard.set_contents_by_hand("vials", "A1", {"liquids": {"water": 0.6, "DCM": 0.2}})
        refused = await call(ac, "bench", "charge", volume_ml=1, source_tray="vials", source_index="A1",
                             destination_tray="vials", destination_index="A2")
        assert refused.json()["problems"] == ["bench.charge: Vials A1 holds 0.8 mL: 1 mL cannot be drawn from it."]

        # 400 µL into a vial counted in mL: the units are converted to be compared.
        await call(ac, "bench", "sample", sample_volume_ul=400, source_tray="vials", source_index="A1", vial_index="A1")
        now = await contents(ac)
        assert now["vials"]["positions"]["A1"]["volume"] == 0.4
        assert now["hplc"]["positions"]["A1"]["liquids"] == {"water": 0.3, "DCM": 0.1}


@pytest.mark.asyncio
async def test_drawing_too_much_is_refused_only_where_a_tray_asks_for_it():
    """Drawing air spoils a sample and spills nothing, and a vial filled at the bench is in no record."""
    async with client() as ac:
        await save(ac, trays=BENCH_TRAYS, transfers=[CHARGE])
        # The HPLC vials do not ask: an empty one may be drawn from (and the reactor slot, with no vial).
        assert (await call(ac, "bench", "charge", volume_ml=1, source_tray="hplc", source_index="A1",
                           destination_tray="vials", destination_index="A1"))["status"] == "completed"
        # What it was is not known: the HPLC vial's record was empty.
        assert (await contents(ac))["vials"]["positions"]["A1"]["liquids"] == {"liquid": 1.0}
        # Pouring is checked everywhere: 2 mL does not fit a 1.5 mL HPLC vial.
        over = await call(ac, "bench", "charge", volume_ml=2, source_tray="bottles", source_index="A1",
                          destination_tray="hplc", destination_index="A2")
        assert "HPLC vials A2 would hold 2 mL, more than its 1.5 mL" in over.json()["error"]


@pytest.mark.asyncio
async def test_liquid_from_or_to_a_tray_with_no_contents_is_not_checked():
    async with client() as ac:
        await save(ac, trays=BENCH_TRAYS, transfers=[CHARGE])
        done = await call(ac, "bench", "charge", volume_ml=1, source_tray="backend", source_index=None,
                          destination_tray="vials", destination_index="A3")
        assert done["status"] == "completed"
        assert (await contents(ac))["vials"]["positions"]["A3"]["liquids"] == {"backend": 1.0}
        # A stock is never drawn dry here, and a drain with no contents is not followed.
        assert (await call(ac, "bench", "charge", volume_ml=50, source_tray="bottles", source_index="A1",
                           destination_tray="drain"))["status"] == "completed"


@pytest.mark.asyncio
async def test_where_the_deck_chooses_the_position_this_edge_cannot_follow_it():
    async with client() as ac:
        await save(ac, trays=BENCH_TRAYS, transfers=[SAMPLE])
        guard.set_contents_by_hand("vials", "A1", {"liquids": {"water": 1}})
        refused = await call(ac, "bench", "sample", sample_volume_ul=100, source_tray="vials", source_index="A1")
        assert "No position on HPLC vials is given (the deck would choose one)" in refused.json()["error"]


@pytest.mark.asyncio
async def test_a_call_that_fails_leaves_what_it_touched_unknown_until_a_person_says():
    async with client() as ac:
        await save(ac, trays=BENCH_TRAYS, transfers=[SPILL, CHARGE])
        assert (await call(ac, "bench", "spill", volume_ml=1, destination_tray="vials",
                           destination_index="A2"))["status"] == "error"
        a2 = (await contents(ac))["vials"]["positions"]["A2"]
        assert a2["unknown"] == "bench.spill did not finish"

        blocked = await call(ac, "bench", "charge", volume_ml=0.1, source_tray="bottles", source_index="A1",
                             destination_tray="vials", destination_index="A2")
        assert "What Vials A2 holds is not known (bench.spill did not finish)" in blocked.json()["error"]

        said = await ac.post("/api/safety/contents", json={"tray": "vials", "position": "A2", "liquids": {"water": 1}})
        assert said.json()["trays"]["vials"]["positions"]["A2"]["by"] == "a person"
        assert (await call(ac, "bench", "charge", volume_ml=0.1, source_tray="bottles", source_index="A1",
                           destination_tray="vials", destination_index="A2"))["status"] == "completed"

        # Too much for the vial, or a tray the deck keeps, cannot be said by hand.
        too_much = await ac.post("/api/safety/contents", json={"tray": "vials", "position": "A1", "liquids": {"water": 3}})
        assert too_much.status_code == 400 and too_much.json()["error"] == "Vials A1 holds at most 2 mL."


@pytest.mark.asyncio
async def test_the_record_survives_a_restart():
    async with client() as ac:
        await save(ac, trays=BENCH_TRAYS, transfers=[CHARGE])
        await call(ac, "bench", "charge", volume_ml=1, source_tray="bottles", source_index="A1",
                   destination_tray="vials", destination_index="A1")
        restarted = safety.Guard(guard.path, guard.state_path, guard.contents_path)
        assert restarted.contents["vials"]["A1"]["liquids"] == {"water": 1.0}


@pytest.mark.asyncio
async def test_a_vessel_carries_its_contents_and_its_capacity_and_leaves_its_place_empty():
    async with client() as ac:
        await save(ac, trays=BENCH_TRAYS, transfers=[CHARGE, MOVE])
        # The reactor slot holds nothing until a vial is put there.
        no_vial = await call(ac, "bench", "charge", volume_ml=1, source_tray="bottles", source_index="A1",
                             destination_tray="reactor")
        assert no_vial.json()["problems"] == ["bench.charge: There is no vessel at Reactor to put 1 mL into."]

        guard.set_contents_by_hand("vials", "A1", {"liquids": {"water": 1.5}})
        assert (await call(ac, "bench", "move", source_tray="vials", source_index="A1",
                           destination_tray="easymax"))["status"] == "completed"
        now = await contents(ac)
        assert now["reactor"]["positions"]["1"]["volume"] == 1.5
        assert now["reactor"]["positions"]["1"]["capacity"] == 2, "a 2 mL vial in the reactor is still a 2 mL vial"
        assert now["vials"]["positions"]["A1"]["vacant"] is True

        over = await call(ac, "bench", "charge", volume_ml=1, source_tray="bottles", source_index="A1",
                          destination_tray="reactor")
        assert "Reactor would hold 2.5 mL, more than its 2 mL" in over.json()["error"]
        occupied = await call(ac, "bench", "move", source_tray="vials", source_index="A2", destination_tray="reactor")
        assert occupied.json()["problems"] == ["bench.move: Reactor already holds a vessel: move that one away first."]
        empty = await call(ac, "bench", "move", source_tray="vials", source_index="A1", destination_tray="vials",
                           destination_index="A3")
        assert empty.json()["problems"] == ["bench.move: There is no vessel at Vials A1 to move."]


@pytest.mark.asyncio
async def test_a_phase_whose_tray_is_left_empty_moves_nothing():
    prepare = [{"name": f"Prepare: {phase}", "when": {"target": "bench", "method": "prepare"}, "moves": "liquid",
                "amount": {"arg": f"{phase}_volume_ml"}, "unit": "mL",
                "from": side(f"{phase}_tray", f"{phase}_index"),
                "to": {"tray": {"value": "vials"}, "position": {"arg": "vial"}}} for phase in ("crude", "water")]
    async with client() as ac:
        await save(ac, trays=BENCH_TRAYS, transfers=prepare)
        # Only the water is given: 2 mL (its default), and no crude.
        await call(ac, "bench", "prepare", vial="A1", water_tray="bottles", water_index="A1")
        assert (await contents(ac))["vials"]["positions"]["A1"]["liquids"] == {"water": 2.0}
        # Both: 3 mL more would overflow the 2 mL vial.
        refused = await call(ac, "bench", "prepare", vial="A2", crude_tray="bottles", crude_index="A2",
                             water_tray="bottles", water_index="A1")
        assert refused.json()["problems"] == [
            "bench.prepare: Vials A2 would hold 3 mL, more than its 2 mL (it holds 0 mL now)."]


# --- The deck keeps the record -----------------------------------------------------------------------

DECK_TRAYS = {"extraction": tray("Extraction vials", 1, 2, kept_by="deck", unit="mL", read={
    "from": "tracker.trays.extraction", "volume": "total_volume", "capacity": "max_volume_ml", "liquids": "contents"})}
DECK_CHARGE = {**CHARGE, "when": {"target": "tracker", "method": "charge_liquid"}}


@pytest.mark.asyncio
async def test_a_deck_that_keeps_its_own_record_is_read_in_place_and_never_written(deck):
    async with client() as ac:
        await save(ac, trays=DECK_TRAYS, transfers=[DECK_CHARGE])
        now = (await contents(ac))["extraction"]
        assert now["kept_by"] == "deck" and now["positions"]["A1"] == {
            "vacant": False, "volume": 13.0, "liquids": {"water": 13.0}, "capacity": 14.5}

        refused = await call(ac, "tracker", "charge_liquid", volume_ml=2, source_tray="backend",
                             destination_tray="extraction", destination_index="A1")
        assert refused.json()["problems"] == [
            "tracker.charge_liquid: Extraction vials A1 would hold 15 mL, more than its 14.5 mL (it holds 13 mL now)."]
        # The deck's own number moves when its own code runs; nothing is kept here.
        assert (await call(ac, "tracker", "charge_liquid", volume_ml=1.5, source_tray="backend",
                           destination_tray="extraction", destination_index="A1"))["status"] == "completed"
        assert (await contents(ac))["extraction"]["positions"]["A1"]["volume"] == 14.5
        assert guard.contents == {}

        set_here = await ac.post("/api/safety/contents", json={"tray": "extraction", "position": "A1", "liquids": {}})
        assert set_here.status_code == 400 and "kept by the deck" in set_here.json()["error"]


TO_REACTOR = {"name": "Into the reactor", "when": {"target": "tracker", "method": "to_reactor"}, "moves": "vessel",
              "from": {"tray": {"value": "extraction"}, "position": {"arg": "index"}}, "to": {"tray": {"value": "reactor"}}}
FROM_REACTOR = {"name": "Out of the reactor", "when": {"target": "tracker", "method": "from_reactor"}, "moves": "vessel",
                "from": {"tray": {"value": "reactor"}}, "to": {"tray": {"value": "extraction"}}}
REACTOR = tray("Reactor", 1, 1, naming="1", kept_by="deck", unit="mL", empty="nothing", read={
    "from": "tracker.reactor", "volume": "total_volume", "capacity": "max_volume_ml"})


@pytest.mark.asyncio
async def test_where_a_vessel_is_is_kept_here_when_the_deck_keeps_only_what_it_holds(deck):
    """The deck's tray still lists a vial after it is carried into the reactor; a charge into its slot
    would read a vial over an empty slot. The move marks the slot empty, and the move back with no
    position returns the vial to where it came from."""
    async with client() as ac:
        await save(ac, trays={**DECK_TRAYS, "reactor": REACTOR}, transfers=[DECK_CHARGE, TO_REACTOR, FROM_REACTOR])
        assert (await call(ac, "tracker", "to_reactor", index="A2"))["status"] == "completed"
        now = await contents(ac)
        assert now["extraction"]["positions"]["A2"]["vacant"] is True
        assert now["reactor"]["positions"]["1"]["from"] == "Extraction vials A2"
        refused = await call(ac, "tracker", "charge_liquid", volume_ml=1, source_tray="backend",
                             destination_tray="extraction", destination_index="A2")
        assert refused.json()["problems"] == [
            "tracker.charge_liquid: There is no vessel at Extraction vials A2 to put 1 mL into."]
        # Into the reactor it goes, and the deck's own number for that vial is what is checked.
        assert (await call(ac, "tracker", "charge_liquid", volume_ml=1, source_tray="backend",
                           destination_tray="reactor"))["status"] == "completed"

        assert (await call(ac, "tracker", "from_reactor"))["status"] == "completed"
        now = await contents(ac)
        assert now["extraction"]["positions"]["A2"]["vacant"] is False
        assert now["reactor"]["positions"]["1"]["vacant"] is True
        assert guard.contents == {}, "nothing is left to remember once every vial is in its place"

        # A person can say a vial was taken away by hand, and that it is back.
        said = await ac.post("/api/safety/contents", json={"tray": "extraction", "position": "A1", "vacant": True})
        assert said.json()["trays"]["extraction"]["positions"]["A1"]["vacant"] is True
        back = await ac.post("/api/safety/contents", json={"tray": "extraction", "position": "A1", "present": True})
        assert back.json()["trays"]["extraction"]["positions"]["A1"]["volume"] == 13.0


@pytest.mark.asyncio
async def test_a_run_that_pours_into_a_slot_it_emptied_is_refused_before_it_starts(deck):
    """A run that carries a vial into the reactor and then charges the slot it left."""
    async with client() as ac:
        await save(ac, trays={**DECK_TRAYS, "reactor": REACTOR}, transfers=[DECK_CHARGE, TO_REACTOR, FROM_REACTOR])
        charge = {"instrument": "tracker", "method": "charge_liquid", "params": {
            "volume_ml": 1, "source_tray": "backend", "destination_tray": "extraction", "destination_index": "A2"}}
        response = await ac.post("/api/queue/runs", json={"name": "Into nothing", "sequence": [
            {"instrument": "tracker", "method": "to_reactor", "params": {"index": "A2"}}, charge]})
        assert response.status_code == 400
        assert "Step 2, tracker.charge_liquid: There is no vessel at Extraction vials A2 to put 1 mL into." \
            in response.json()["error"]
        assert deck["tracker"].reactor is None and deck["tracker"].calls == []


@pytest.mark.asyncio
async def test_a_deck_record_that_cannot_be_read_blocks(deck):
    async with client() as ac:
        await save(ac, trays={"extraction": {**DECK_TRAYS["extraction"], "contents": {
            **DECK_TRAYS["extraction"]["contents"], "read": {**DECK_TRAYS["extraction"]["contents"]["read"],
                                                             "volume": "volume_renamed"}}}},
                   transfers=[DECK_CHARGE])
        blocked = await call(ac, "tracker", "charge_liquid", volume_ml=0.1, source_tray="backend",
                             destination_tray="extraction", destination_index="A2")
        assert blocked.status_code == 409
        assert "the deck's record could not be read" in blocked.json()["error"]


# --- A whole run, before it starts -------------------------------------------------------------------

def charge_step(volume, position, row=None):
    params = {"volume_ml": volume, "source_tray": "bottles", "source_index": "A1",
              "destination_tray": "vials", "destination_index": position}
    if row is not None:
        params["_row"] = row
    return {"instrument": "bench", "method": "charge", "params": params}


@pytest.mark.asyncio
async def test_a_run_that_would_overflow_a_vessel_is_refused_before_anything_moves(deck):
    async with client() as ac:
        await save(ac, trays=BENCH_TRAYS, transfers=[CHARGE])
        guard.set_contents_by_hand("vials", "A2", {"liquids": {"water": 1}})
        over = await ac.post("/api/queue/runs", json={"name": "Overfill", "sequence": [
            charge_step(1.0, "A1", 0), charge_step(1.5, "A2", 1), charge_step(1.5, "A1", 0)]})
        assert over.status_code == 400
        message = over.json()["error"]
        assert "Step 2 (row 2), bench.charge: Vials A2 would hold 2.5 mL, more than its 2 mL (it holds 1 mL now)." in message
        assert "Step 3 (row 1), bench.charge: Vials A1 would hold 2.5 mL" in message
        assert message.endswith("Nothing was run.") and deck["bench"].calls == []


@pytest.mark.asyncio
async def test_a_run_that_fits_runs_and_an_amount_learned_on_the_way_is_not_followed(deck):
    async with client() as ac:
        await save(ac, trays=BENCH_TRAYS, transfers=[CHARGE])
        run = await ac.post("/api/queue/runs", json={"name": "Fits", "sequence": [
            charge_step(1.0, "A1"), charge_step(1.0, "A1")]})
        assert run.status_code == 200, run.text
        assert (await finished(ac, run.json()["run_id"]))["status"] == "completed"
        assert (await contents(ac))["vials"]["positions"]["A1"]["volume"] == 2.0

        # Learned on the way: not refused up front (the step itself is checked as it is sent).
        guard.set_contents_by_hand("vials", None, {"reset": "empty"})
        plan_only = guard.check_run({}, [], [charge_step("#how_much", "A2"), charge_step(1.5, "A2")], [])
        assert plan_only == []


# --- Suggestions --------------------------------------------------------------------------------------

def test_a_method_with_a_volume_a_source_and_a_destination_suggests_a_transfer():
    deck = Deck(app.state.instruments, app.state.instrument_schemas)
    found = {(s["when"]["target"], s["when"]["method"]): s for s in suggest_transfers(deck, empty_config())}
    charge = found[("bench", "charge")]
    assert charge["moves"] == "liquid" and charge["amount"] == {"arg": "volume_ml"} and charge["unit"] == "mL"
    assert charge["from"] == {"tray": {"arg": "source_tray"}, "position": {"arg": "source_index"}}
    assert charge["to"] == {"tray": {"arg": "destination_tray"}, "position": {"arg": "destination_index"}}
    assert found[("bench", "move")]["moves"] == "vessel"
    assert found[("tracker", "charge_liquid")]["moves"] == "liquid"
    # Not offered again once a transfer covers it.
    covered = {**empty_config(), "transfers": [CHARGE]}
    assert ("bench", "charge") not in {(s["when"]["target"], s["when"]["method"])
                                       for s in suggest_transfers(deck, covered)}


def test_the_plan_is_one_arithmetic_for_a_call_and_a_run():
    config, _ = validate({**empty_config(), "trays": BENCH_TRAYS, "transfers": [CHARGE]})
    plan = Plan(config, {}, Deck(app.state.instruments, app.state.instrument_schemas))
    transfer = config["transfers"][0]
    args = {"volume_ml": 1.2, "source_tray": "bottles", "source_index": "A2",
            "destination_tray": "vials", "destination_index": "A1"}
    assert plan.apply(transfer, args, {}) == []
    assert plan.apply(transfer, args, {}) == [
        "Vials A1 would hold 2.4 mL, more than its 2 mL (it holds 1.2 mL now)."]
    assert plan.writes() == {"vials": {"A1": {"liquids": {"DCM": 1.2}}}}
