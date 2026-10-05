"""Labware: wells as arguments, labware as driver-declared trays, and a batch step that acts on
every row of its group in one call (labware.py, queue.spread_over_rows).

The first half uses a small driver with no robot library behind it, because none of the edge's
side depends on one. The second half reads plr-ivoryos's PyLabRobot liquid handler on its
simulator and is skipped where that package (0.2) is not installed. Its Labware view plugin is
tested in the plr-ivoryos repository.
"""

import asyncio
from typing import Annotated, Dict, List, Union

import pytest
from httpx import ASGITransport, AsyncClient

from ivoryos_edge.introspection import inspect_device_module
from ivoryos_edge.labware import (Labware, PerWell, Site, WellSelection, Wells, compact_wells, declared_trays,
                                  expand_references, parse_references,
                                  expand_wells)
from ivoryos_edge.queue import spread_over_rows
from ivoryos_edge.safety import guard
from ivoryos_edge.server import app

GRID = [["A1", "A2", "A3"], ["B1", "B2", "B3"]]
PLATE96 = [[f"{chr(65 + r)}{c + 1}" for c in range(12)] for r in range(8)]


class Bench:
    """A driver with a worktable: one plate and one tip rack, 2 x 3 each."""

    def __init__(self):
        self.calls = []

    def __ivoryos_labware__(self) -> dict:
        return {
            "deck": {"name": "bench", "kind": "Bench", "width": 100, "depth": 100},
            "labware": {"plate_1": {"label": "Plate 1", "category": "plate", "grid": GRID},
                        "tips": {"label": "Tips", "category": "tip_rack", "grid": GRID}},
            "sites": [{"name": "site_1", "label": "1"}, {"name": "site_2", "label": "2"}],
            "fixtures": [],
        }

    def dispense(self, wells: Annotated[WellSelection, Wells("plate")],
                 volume_ul: Annotated[Union[float, List[float]], PerWell("wells")] = 10.0,
                 tips: Annotated[str, Labware("tip_rack")] = "tips") -> None:
        self.calls.append((wells, volume_ul))

    def read(self, wells: Annotated[WellSelection, Wells("plate")]) -> Dict[str, float]:
        """One number per well (its position in the plate, so a test can tell them apart), keyed
        by the well alone, the way most readers key a plate."""
        order = [name for row in GRID for name in row]
        return {well: float(order.index(well)) for _, well in expand_references(wells, {"plate_1": GRID})}

    def move(self, plate: Annotated[str, Labware()], to: Annotated[str, Site()]) -> None:
        pass


@pytest.fixture
def bench():
    instrument = Bench()
    app.state.instruments["bench"] = instrument
    app.state.instrument_schemas["bench"] = inspect_device_module(instrument)
    guard.app = app
    yield instrument
    app.state.instruments.pop("bench")
    app.state.instrument_schemas.pop("bench")


async def _finish(ac, run_id):
    run = {}
    for _ in range(100):
        run = (await ac.get(f"/api/queue/runs/{run_id}")).json()
        if run.get("status") in ["completed", "error", "cancelled"]:
            break
        await asyncio.sleep(0.05)
    return run


# --- well selections ---------------------------------------------------------------------------

def test_a_range_runs_down_a_column_along_a_row_or_over_a_rectangle():
    assert expand_wells("A1:H1", PLATE96) == ["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1"]
    assert expand_wells("A1:A4", PLATE96) == ["A1", "A2", "A3", "A4"]
    # Column by column: the order a multichannel head visits a plate in.
    assert expand_wells("A1:B2", PLATE96) == ["A1", "B1", "A2", "B2"]
    assert expand_wells("A1:H1, A3 B3", PLATE96)[-3:] == ["H1", "A3", "B3"]
    assert expand_wells(["A1", "C2:D2"], PLATE96) == ["A1", "C2", "D2"]
    assert len(expand_wells("all", PLATE96)) == 96 and expand_wells("all", PLATE96)[:2] == ["A1", "B1"]


def test_a_position_the_labware_does_not_have_is_an_error_not_a_smaller_selection():
    for bad in ("A13", "A1:H13", "a1", ["A1", "Z9"]):
        with pytest.raises(ValueError, match="is not a position"):
            expand_wells(bad, PLATE96)


@pytest.mark.parametrize("selection", [
    "A1:H1", "A1:H3", "A1:A12", "A1, C3, D4", "A1:H1, A3:H3", "A1:A12, B1:B12", "B2", "A1:D1, A2",
])
def test_compacting_a_selection_gives_text_that_expands_back_to_it(selection):
    positions = expand_wells(selection, PLATE96)
    assert expand_wells(compact_wells(positions, PLATE96), PLATE96) == positions
    assert compact_wells(positions, PLATE96) == selection


def test_wells_are_written_with_their_labware_as_pylabrobot_writes_them():
    assert parse_references("assay_plate[A1:H1]") == [("assay_plate", "A1:H1")]
    assert parse_references("p1[A1, B2], p2[C3]; p3") == [("p1", "A1, B2"), ("p2", "C3"), ("p3", None)]
    assert parse_references(["p1[A1]", "p1[B1]"]) == [("p1", "A1"), ("p1", "B1")]
    grids, kinds = {"p1": PLATE96, "tips": PLATE96}, {"p1": "plate", "tips": "tip_rack"}
    assert expand_references("p1[A1:B1], p1[H12]", grids) == [("p1", "A1"), ("p1", "B1"), ("p1", "H12")]
    assert len(expand_references("p1", grids)) == 96, "a bare name is every well"
    for bad, why in [("A1", "write wells with their labware"), ("p9[A1]", "not on this worktable"),
                     ("p1[A13]", "'A13' is not a position on p1"), ("p1[A1", "labware\\[wells\\]")]:
        with pytest.raises(ValueError, match=why):
            expand_references(bad, grids)
    with pytest.raises(ValueError, match="is a tip rack, not a plate"):
        expand_references("tips[A1]", grids, kinds, ("plate",))


# --- what the schema says ----------------------------------------------------------------------

def test_markers_reach_the_schema_and_labware_arguments_list_the_worktable(bench):
    schema = app.state.instrument_schemas["bench"]
    params = schema["dispense"]["parameters"]
    assert params["tips"]["options"] == ["tips"], "only labware of the category asked for"
    assert params["wells"]["type"] == "wells" and params["wells"]["wells"] == {"labware": ["plate"]}
    assert "options" not in params["wells"], "wells are picked on a plate, not chosen from a list"
    assert params["volume_ul"]["per_well"] == "wells" and params["volume_ul"]["numeric"] is True
    assert params["volume_ul"]["default"] == 10.0 and params["volume_ul"]["required"] is False
    move = schema["move"]["parameters"]
    assert move["plate"]["options"] == ["plate_1", "tips"] and move["to"]["options"] == ["1", "2"]
    assert "__ivoryos_labware__" not in schema


def test_the_hubs_class_level_schema_carries_the_same_markers(bench):
    """schema_worker describes a class without building it (the Hub stores what it says), so it
    has no worktable to list: the markers match the edge's, the options are the deck's."""
    import importlib.util
    import os
    path = os.path.join(os.path.dirname(__file__), "..", "..", "schema_worker", "introspection.py")
    spec = importlib.util.spec_from_file_location("schema_worker_introspection", path)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    hub = worker.inspect_class(Bench)
    edge = app.state.instrument_schemas["bench"]
    for method in ("dispense", "read", "move"):
        for name, entry in edge[method]["parameters"].items():
            assert {k: v for k, v in entry.items() if k != "options"} == hub[method]["parameters"][name], (method, name)
    assert "options" not in hub["dispense"]["parameters"]["tips"]


def test_a_driver_without_a_worktable_is_untouched():
    schema = app.state.instrument_schemas["dummy"]
    assert all("labware" not in p and "wells" not in p
               for method in schema.values() for p in method["parameters"].values())


# --- the guard: labware is a tray the driver declared ---------------------------------------------

def test_every_labware_is_offered_to_the_pages_as_a_tray(bench):
    trays = guard.view()["trays"]
    assert trays["bench:plate_1"]["grid"] == GRID
    assert (trays["bench:plate_1"]["rows"], trays["bench:plate_1"]["columns"]) == (2, 3)
    assert trays["bench:plate_1"]["blocked"] == [] and trays["bench:plate_1"]["label"] == "Plate 1"
    assert list(declared_trays({"dummy": app.state.instruments["dummy"]})) == []


def test_wells_off_the_plate_are_refused_with_nothing_configured(bench):
    def check(wells):
        return guard.check_params("bench", "dispense", {"wells": wells})

    assert check("plate_1[A1:B2]") == [] and check(["plate_1[A1]", "plate_1[B3]"]) == [] and check("plate_1") == []
    assert check("#well") == [] and check(["#well"]) == [], "checked once the run fills them in"
    problems = check("plate_1[A1:B4]")
    assert len(problems) == 1 and "'B4' is not a position on plate_1" in problems[0]
    assert "'C1'" in check(["plate_1[A1]", "plate_1[C1]"])[0]
    assert "'plate_9' is not on this worktable" in check("plate_9[A1]")[0]
    assert "write wells with their labware" in check("A1")[0]
    assert "is a tip rack, not a plate" in check("tips[A1]")[0]


@pytest.mark.asyncio
async def test_a_run_naming_a_well_the_plate_does_not_have_never_starts(bench):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/queue/runs", json={"name": "Off the plate", "sequence": [
            {"instrument": "bench", "method": "dispense", "params": {"wells": "plate_1[A1:A4]"}},
        ]})
        assert resp.status_code >= 400 and "'A4' is not a position" in resp.text
    assert bench.calls == []


# --- one call for a group of rows ---------------------------------------------------------------

def test_a_result_keyed_by_well_goes_to_each_row_by_its_own_well():
    step = {"_rows": [4, 5, 6], "_per_row": ["wells", "volume_ul"],
            "wells": ["p[A1]", "p[B1]", "p[A2]"], "volume_ul": [1, 2, 3]}
    # Keyed the way the step was given its wells, or by the well alone (most readers).
    for result in ({"p[A1]": 0.1, "p[B1]": 0.2, "p[A2]": 0.3, "p[B2]": 9}, {"A1": 0.1, "B1": 0.2, "A2": 0.3, "B2": 9}):
        shares = spread_over_rows(step, {"absorbance": result, "note": "ok"})
        assert shares == {4: {"absorbance": 0.1}, 5: {"absorbance": 0.2}, 6: {"absorbance": 0.3}}


def test_a_list_as_long_as_the_group_goes_by_position_and_anything_else_stays_whole():
    step = {"_rows": [0, 1], "_per_row": ["wells"], "wells": ["A1", "B1"]}
    assert spread_over_rows(step, {"mass": [1.5, 2.5]}) == {0: {"mass": 1.5}, 1: {"mass": 2.5}}
    assert spread_over_rows(step, {"mass": [1.5, 2.5, 3.5]}) == {}
    assert spread_over_rows(step, {"total": 4.0, "by_other_key": {"x": 1, "y": 2}}) == {}
    assert spread_over_rows({"wells": ["A1"]}, {"mass": [1.5]}) == {}, "an ordinary step is not spread"


@pytest.mark.asyncio
async def test_a_batch_step_over_three_rows_is_one_call_and_each_row_reads_its_own_result(bench):
    wells = ["plate_1[A1]", "plate_1[B1]", "plate_1[B3]"]
    sequence = [
        # What the Iterate page sends for a batch step whose wells and volumes are columns.
        {"instrument": "bench", "method": "dispense",
         "params": {"wells": wells, "volume_ul": [10, 20, 30],
                    "_row": 0, "_block": 0, "_rows": [0, 1, 2], "_per_row": ["wells", "volume_ul"]}},
        {"instrument": "bench", "method": "read", "returnVar": "reading",
         "params": {"wells": wells, "_row": 0, "_block": 1, "_rows": [0, 1, 2], "_per_row": ["wells"]}},
    ]
    for row in range(3):
        sequence += [
            {"instrument": "Flow_Control", "method": "If", "params": {"condition": "reading >= 3", "_row": row, "_block": 2}},
            {"instrument": "dummy", "method": "echo_method", "params": {"value": "#reading", "_row": row, "_block": 3}},
            {"instrument": "Flow_Control", "method": "End_If", "params": {"_row": row, "_block": 4}},
        ]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/queue/runs", json={
            "name": "One call per group", "sequence": sequence,
            "parameters": {"type": "Spreadsheet", "variables": ["well"], "batch_size": 3,
                           "rows": [{"well": w} for w in wells]},
        })
        assert resp.status_code == 200, resp.text
        run = await _finish(ac, resp.json()["run_id"])
    assert run["status"] == "completed", run
    assert bench.calls == [(wells, [10, 20, 30])], "one call, carrying every row's value"

    read = next(s for s in run["steps"] if s["method"] == "read")
    assert read["outputs"]["result"] == {"A1": 0.0, "B1": 3.0, "B3": 5.0}
    assert read["outputs"]["by_row"] == {"0": {"reading": 0.0}, "1": {"reading": 3.0}, "2": {"reading": 5.0}}
    # Each row's If decided on its own well's reading, not on the plate.
    ifs = [s for s in run["steps"] if s["method"] == "If"]
    assert [s["outputs"]["result"] for s in ifs] == [False, True, True]
    echoes = [s for s in run["steps"] if s["method"] == "echo_method"]
    assert [s["status"] for s in echoes] == ["skipped", "completed", "completed"]
    # echo_method takes a str, so each row's own number arrives as text.
    assert [s["outputs"]["result"] for s in echoes[1:]] == ["3.0", "5.0"]


# --- a PyLabRobot liquid handler (plr-ivoryos), as the edge reads it ----------------------------------
# The adapter's own behaviour is tested in the plr-ivoryos repository. What is checked here is the
# meeting point: the edge reads that package's markers and worktable by duck typing, with nothing
# imported either way. Skipped where plr-ivoryos 0.2 is not installed:
#     uv run --extra test --with-editable ../IvoryOS-PyLabRobot-Integration pytest ...

WORKTABLE = {"deck_type": "OTDeck", "resources": [
    {"name": "tips_300", "type": "opentrons_96_tiprack_300ul", "slot": 1},
    {"name": "reservoir", "type": "nest_12_troughplate_15000uL_Vb", "slot": 2},
    {"name": "assay_plate", "type": "cor_96_wellplate_360uL_Fb", "slot": 5},
], "liquids": [{"labware": "reservoir", "wells": "A2", "liquid": "dye", "volume_ul": 5000}]}


@pytest.fixture
def handler(tmp_path, capsys):
    plr_ivoryos = pytest.importorskip("plr_ivoryos")
    if not hasattr(plr_ivoryos, "worktable"):
        pytest.skip("plr-ivoryos older than 0.2")
    import json
    path = tmp_path / "worktable.json"
    path.write_text(json.dumps(WORKTABLE))
    return plr_ivoryos.LiquidHandler(simulated=True, deck_json=str(path))


def test_the_edge_reads_a_plr_liquid_handler_with_nothing_shared_but_names(handler):
    schema = inspect_device_module(handler)
    transfer = schema["transfer"]["parameters"]
    assert transfer["targets"]["wells"] == {"labware": ["plate", "reservoir", "tube_rack"]}
    assert transfer["tip_rack"]["options"] == ["tips_300"]
    assert transfer["target_vols"]["per_well"] == "targets"
    assert schema["move_plate"]["parameters"]["to"]["options"][:3] == ["1", "2", "3"]
    assert schema["transfer"]["is_coroutine"] is False, "synchronous, on the package's own loop"
    assert not any(name.startswith("__ivoryos") for name in schema)
    assert set(declared_trays({"lh": handler})) == {"lh:tips_300", "lh:reservoir", "lh:assay_plate"}


def test_a_plr_step_with_wells_off_the_plate_is_refused_by_the_guard(handler):
    app.state.instruments["lh"] = handler
    app.state.instrument_schemas["lh"] = inspect_device_module(handler)
    try:
        call = {"source": "reservoir[A1]", "target_vols": 10, "tip_rack": "tips_300"}
        assert guard.check_params("lh", "transfer", {**call, "targets": "assay_plate[A1:H12]"}) == []
        problems = guard.check_params("lh", "transfer", {**call, "targets": "assay_plate[A1:A13]"})
        assert len(problems) == 1 and "'A13' is not a position" in problems[0]
        assert "'plate_9' is not on this worktable" in guard.check_params("lh", "transfer", {**call, "targets": "plate_9[A1]"})[0]
        assert "is a tip rack" in guard.check_params("lh", "transfer", {**call, "targets": "tips_300[A1]"})[0]
    finally:
        app.state.instruments.pop("lh")
        app.state.instrument_schemas.pop("lh")
