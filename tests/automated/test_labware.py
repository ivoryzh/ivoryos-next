"""Labware: wells as arguments, labware as driver-declared trays, and a batch step that acts on
every row of its group in one call (labware.py, plr.py, queue.spread_over_rows).

The first half uses a small driver with no robot library behind it, because none of the edge's
side depends on one. The second half runs the PyLabRobot adapter on its simulator and is skipped
where PyLabRobot is not installed.
"""

import asyncio
from typing import Annotated, Dict, List, Union

import pytest
from httpx import ASGITransport, AsyncClient

from ivoryos_edge.introspection import inspect_device_module
from ivoryos_edge.labware import (Labware, PerWell, Site, WellSelection, Wells, compact_wells, declared_trays,
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

    def dispense(self, plate: Annotated[str, Labware("plate")],
                 wells: Annotated[WellSelection, Wells("plate")],
                 volume_ul: Annotated[Union[float, List[float]], PerWell("wells")] = 10.0,
                 tips: Annotated[str, Labware("tip_rack")] = "tips") -> None:
        self.calls.append((plate, wells, volume_ul))

    def read(self, plate: Annotated[str, Labware("plate")],
             wells: Annotated[WellSelection, Wells("plate")]) -> Dict[str, float]:
        """One number per well: its position in the plate, so a test can tell them apart."""
        order = [name for row in GRID for name in row]
        return {name: float(order.index(name)) for name in expand_wells(wells, GRID)}

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


# --- what the schema says ----------------------------------------------------------------------

def test_markers_reach_the_schema_and_labware_arguments_list_the_worktable(bench):
    schema = app.state.instrument_schemas["bench"]
    params = schema["dispense"]["parameters"]
    assert params["plate"]["options"] == ["plate_1"], "only labware of the category asked for"
    assert params["tips"]["options"] == ["tips"]
    assert params["wells"]["type"] == "wells" and params["wells"]["wells"] == {"on": "plate"}
    assert params["volume_ul"]["per_well"] == "wells" and params["volume_ul"]["numeric"] is True
    assert params["volume_ul"]["default"] == 10.0 and params["volume_ul"]["required"] is False
    move = schema["move"]["parameters"]
    assert move["plate"]["options"] == ["plate_1", "tips"] and move["to"]["options"] == ["1", "2"]
    assert "__ivoryos_labware__" not in schema


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
    def check(wells, plate="plate_1"):
        return guard.check_params("bench", "dispense", {"plate": plate, "wells": wells})

    assert check("A1:B2") == [] and check(["A1", "B3"]) == [] and check("all") == []
    assert check("#well") == [] and check("A1", plate="#plate") == [], "checked once the run fills them in"
    problems = check("A1:B4")
    assert len(problems) == 1 and "'B4' is not a position" in problems[0] and "Plate 1 (2 x 3, A1 to B3)" in problems[0]
    assert "'C1'" in check(["A1", "C1"])[0]
    # A labware that is not there is the labware argument's own error (its choices), said once.
    unknown = check("A1", plate="plate_9")
    assert len(unknown) == 1 and "plate_9" in unknown[0]


@pytest.mark.asyncio
async def test_a_run_naming_a_well_the_plate_does_not_have_never_starts(bench):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/queue/runs", json={"name": "Off the plate", "sequence": [
            {"instrument": "bench", "method": "dispense", "params": {"plate": "plate_1", "wells": "A1:A4"}},
        ]})
        assert resp.status_code >= 400 and "'A4' is not a position" in resp.text
    assert bench.calls == []


# --- one call for a group of rows ---------------------------------------------------------------

def test_a_result_keyed_by_well_goes_to_each_row_by_its_own_well():
    step = {"_rows": [4, 5, 6], "_per_row": ["wells", "volume_ul"], "wells": ["A1", "B1", "A2"], "volume_ul": [1, 2, 3]}
    shares = spread_over_rows(step, {"absorbance": {"A1": 0.1, "B1": 0.2, "A2": 0.3, "B2": 9}, "note": "ok"})
    assert shares == {4: {"absorbance": 0.1}, 5: {"absorbance": 0.2}, 6: {"absorbance": 0.3}}


def test_a_list_as_long_as_the_group_goes_by_position_and_anything_else_stays_whole():
    step = {"_rows": [0, 1], "_per_row": ["wells"], "wells": ["A1", "B1"]}
    assert spread_over_rows(step, {"mass": [1.5, 2.5]}) == {0: {"mass": 1.5}, 1: {"mass": 2.5}}
    assert spread_over_rows(step, {"mass": [1.5, 2.5, 3.5]}) == {}
    assert spread_over_rows(step, {"total": 4.0, "by_other_key": {"x": 1, "y": 2}}) == {}
    assert spread_over_rows({"wells": ["A1"]}, {"mass": [1.5]}) == {}, "an ordinary step is not spread"


@pytest.mark.asyncio
async def test_a_batch_step_over_three_rows_is_one_call_and_each_row_reads_its_own_result(bench):
    wells = ["A1", "B1", "B3"]
    sequence = [
        # What the Iterate page sends for a batch step whose wells and volumes are columns.
        {"instrument": "bench", "method": "dispense",
         "params": {"plate": "plate_1", "wells": wells, "volume_ul": [10, 20, 30],
                    "_row": 0, "_block": 0, "_rows": [0, 1, 2], "_per_row": ["wells", "volume_ul"]}},
        {"instrument": "bench", "method": "read", "returnVar": "reading",
         "params": {"plate": "plate_1", "wells": wells,
                    "_row": 0, "_block": 1, "_rows": [0, 1, 2], "_per_row": ["wells"]}},
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
    assert bench.calls == [("plate_1", wells, [10, 20, 30])], "one call, carrying every row's value"

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


# --- the PyLabRobot adapter, on its simulator ----------------------------------------------------

OT2 = [
    {"slot": 1, "labware": "opentrons_96_tiprack_300ul", "name": "tips_300"},
    {"slot": 2, "labware": "nest_12_troughplate_15000uL_Vb", "name": "reservoir"},
    {"slot": 5, "labware": "cor_96_wellplate_360uL_Fb", "name": "assay_plate"},
]
LIQUIDS = [{"labware": "reservoir", "wells": "A1", "liquid": "buffer", "volume_ul": 10000},
           {"labware": "reservoir", "wells": "A2", "liquid": "dye", "volume_ul": 5000}]


@pytest.fixture
def handler(capsys):
    pytest.importorskip("pylabrobot")
    from ivoryos_edge.plr import PLRLiquidHandler
    return PLRLiquidHandler(deck="ot2", channels=8, layout=OT2, liquids=LIQUIDS)


def test_the_adapter_reports_its_worktable_and_its_steps_name_what_is_on_it(handler):
    schema = inspect_device_module(handler)
    transfer = schema["transfer"]["parameters"]
    assert transfer["source"]["options"] == ["reservoir", "assay_plate"], "the trash is not a place to pipette"
    assert transfer["tips"]["options"] == ["tips_300"]
    assert transfer["dest_wells"]["wells"] == {"on": "dest"} and transfer["volume_ul"]["per_well"] == "dest_wells"
    assert schema["move_plate"]["parameters"]["to"]["options"][:3] == ["1", "2", "3"]
    assert schema["transfer"]["is_coroutine"] is True

    layout = handler.__ivoryos_labware__()
    plate = layout["labware"]["assay_plate"]
    assert plate["category"] == "plate" and plate["site"] == "5" and plate["max_volume_ul"] == 360
    assert len(plate["grid"]) == 8 and plate["grid"][7][11] == "H12" and len(plate["spots"]) == 96
    assert layout["labware"]["reservoir"]["category"] == "reservoir" and len(layout["labware"]["reservoir"]["grid"][0]) == 12
    assert layout["deck"]["kind"] == "OTDeck" and len(layout["sites"]) == 12
    assert [f["category"] for f in layout["fixtures"]] == ["trash"]
    assert set(declared_trays({"lh": handler})) == {"lh:tips_300", "lh:reservoir", "lh:assay_plate"}


@pytest.mark.asyncio
async def test_a_reservoir_feeds_three_columns_eight_channels_at_a_time(handler):
    events = []
    handler.__ivoryos_labware_events__(events.append)
    delivered = await handler.transfer(source="reservoir", source_wells="A1", dest="assay_plate",
                                       dest_wells="A1:H3", volume_ul=100, tips="tips_300")
    assert len(delivered) == 24 and set(delivered.values()) == {100.0}
    assert await handler.tips_left("tips_300") == 96 - 24
    assert await handler.read_volumes("reservoir", "A1") == {"A1": 10000 - 2400}
    # Three groups of eight: tips, aspirate, dispense, drop, each once per group.
    assert [e["action"] for e in events] == ["pick_up_tips", "aspirate", "dispense", "drop_tips"] * 3
    assert events[2]["labware"] == "assay_plate" and events[2]["wells"] == expand_wells("A1:H1", PLATE96)

    # One volume per well, a well given nothing skipped, and what each well holds remembered.
    second = await handler.transfer(source="reservoir", source_wells="A2", dest="assay_plate",
                                    dest_wells=["A1", "B1", "C1"], volume_ul=[10, 0, 30], tips="tips_300",
                                    new_tip="once")
    assert second == {"A1": 10.0, "C1": 30.0}
    state = handler.__ivoryos_labware_state__()
    assert state["labware"]["assay_plate"]["A1"] == {"volume_ul": 110.0, "liquids": {"buffer": 100.0, "dye": 10.0}}
    assert state["labware"]["assay_plate"]["B1"]["liquids"] == {"buffer": 100.0}
    assert state["labware"]["tips_300"]["A1"] == {"tip": False} and state["labware"]["tips_300"]["A12"] == {"tip": True}
    assert state["channels"] == [False] * 8


@pytest.mark.asyncio
async def test_what_cannot_be_done_is_said_before_anything_moves(handler):
    async def refused(**changes):
        call = {"source": "reservoir", "source_wells": "A1", "dest": "assay_plate", "dest_wells": "A1",
                "volume_ul": 10, "tips": "tips_300", **changes}
        with pytest.raises(ValueError) as error:
            await handler.transfer(**call)
        return str(error.value)

    assert "'A13' is not a position on assay_plate" in await refused(dest_wells="A13")
    assert "not a labware on this worktable" in await refused(dest="plate_9")
    assert "do not pair up" in await refused(source_wells="A1:A3", dest_wells="A1:B1")
    assert "2 values for 3 wells" in await refused(dest_wells="A1:C1", volume_ul=[1, 2])
    assert "no tips are on the head" in await refused(new_tip="never")
    assert await handler.tips_left("tips_300") == 96


@pytest.mark.asyncio
async def test_moving_a_plate_changes_where_the_worktable_says_it_is(handler):
    await handler.move_plate("assay_plate", "6")
    layout = handler.__ivoryos_labware__()
    assert layout["labware"]["assay_plate"]["site"] == "6"
    assert next(s for s in layout["sites"] if s["label"] == "5")["holds"] is None
    with pytest.raises(ValueError, match="already holds reservoir"):
        await handler.move_plate("assay_plate", "2")


def test_a_hamilton_worktable_puts_labware_on_carriers(capsys):
    pytest.importorskip("pylabrobot")
    from ivoryos_edge.plr import PLRLiquidHandler
    star = PLRLiquidHandler(deck="starlet", layout=[
        {"rails": 3, "carrier": "TIP_CAR_480_A00", "name": "tip_carrier",
         "sites": {"0": {"labware": "hamilton_96_tiprack_300uL_filter", "name": "tips"}}},
        {"rails": 15, "carrier": "PLT_CAR_L5AC_A00", "name": "plates",
         "sites": {"1": {"labware": "cor_96_wellplate_360uL_Fb", "name": "assay_plate"}}},
    ])
    layout = star.__ivoryos_labware__()
    assert layout["deck"]["kind"] == "HamiltonSTARDeck"
    assert layout["labware"]["assay_plate"]["site"] == "plates-1" and layout["labware"]["tips"]["site"] == "tip_carrier-0"
    assert {f["name"] for f in layout["fixtures"] if f["category"] == "carrier"} == {"tip_carrier", "plates"}
    assert sum(1 for s in layout["sites"] if s["name"].startswith("plates-")) == 5
    with pytest.raises(ValueError, match="Did you mean"):
        PLRLiquidHandler(deck="ot2", layout=[{"slot": 1, "labware": "cor_96_wellplate_360ul", "name": "p"}])


@pytest.mark.asyncio
async def test_the_labware_view_serves_the_worktable_and_follows_it(handler, monkeypatch):
    from ivoryos_edge import labware_view

    class Reader:  # shares the handler's worktable; must not be drawn as a second one
        def __ivoryos_labware__(self):
            return {"labware": handler.__ivoryos_labware__()["labware"]}

    published = []
    monkeypatch.setattr(labware_view.plugin, "instruments", {"lh": handler, "reader": Reader(), "other": object()})
    monkeypatch.setattr(labware_view.plugin, "publish", published.append)
    assert list(labware_view.layout()["worktables"]) == ["lh"]
    assert labware_view.state()["worktables"]["lh"]["labware"]["reservoir"]["A2"]["liquids"] == {"dye": 5000.0}

    labware_view._start(labware_view.plugin.instruments)
    await handler.load_liquid("assay_plate", "A1:B1", "sample", 50)
    assert published[-1]["worktable"] == "lh" and published[-1]["event"]["action"] == "load"
    assert published[-1]["state"]["labware"]["assay_plate"]["B1"]["volume_ul"] == 50.0 and not published[-1]["relayout"]
    await handler.move_plate("assay_plate", "9")
    assert published[-1]["relayout"] is True


def test_a_worktable_is_rearranged_as_data_and_the_saved_layout_is_used_next_time(tmp_path, capsys):
    pytest.importorskip("pylabrobot")
    from ivoryos_edge.plr import PLRLiquidHandler, catalog

    kinds = {entry["definition"]: entry["category"] for entry in catalog()}
    assert kinds["cor_96_wellplate_360uL_Fb"] == "plate" and kinds["opentrons_96_tiprack_300ul"] == "tip_rack"
    assert kinds["nest_12_troughplate_15000uL_Vb"] == "reservoir"
    assert "Cor_96_wellplate_360ul_Fb" not in kinds, "an old spelling kept as an alias is not offered twice"

    saved = str(tmp_path / "worktable.json")
    first = PLRLiquidHandler(deck="ot2", layout=OT2, liquids=LIQUIDS, layout_file=saved)
    seen = []
    first.__ivoryos_labware_events__(seen.append)
    first.__ivoryos_labware_edit__("place", site="6", definition="cor_96_wellplate_360uL_Fb", name="plate_2")
    assert first.__ivoryos_labware__()["labware"]["plate_2"]["site"] == "6" and seen[-1]["action"] == "layout"
    for change, why in [
        ({"site": "6", "definition": "cor_96_wellplate_360uL_Fb", "name": "plate_3"}, "already holds plate_2"),
        ({"site": "7", "definition": "cor_96_wellplate_360uL_Fb", "name": "plate_2"}, "already called 'plate_2'"),
        ({"site": "7", "definition": "cor_96_wellplate_360uL_Fb", "name": "my plate"}, "starts with a letter"),
        ({"site": "7", "definition": "no_such_plate", "name": "plate_3"}, "not a labware definition"),
        ({"site": "99", "definition": "cor_96_wellplate_360uL_Fb", "name": "plate_3"}, "not a place"),
    ]:
        with pytest.raises(ValueError, match=why):
            first.__ivoryos_labware_edit__("place", **change)
    first.__ivoryos_labware_edit__("remove", name="reservoir")
    assert "reservoir" not in first.__ivoryos_labware__()["labware"]

    # The next start builds the worktable that was saved, not the one written in the script, and
    # a liquid meant for a labware that is gone is left out rather than failing the deck.
    again = PLRLiquidHandler(deck="ot2", layout=OT2, liquids=LIQUIDS, layout_file=saved)
    assert set(again.__ivoryos_labware__()["labware"]) == {"tips_300", "assay_plate", "plate_2"}
    assert inspect_device_module(again)["transfer"]["parameters"]["dest"]["options"] == ["assay_plate", "plate_2"]
    # A layout saved for another kind of deck is not this one's.
    other = PLRLiquidHandler(deck="starlet", layout=[], layout_file=saved)
    assert "plate_2" not in other.__ivoryos_labware__()["labware"]


def test_a_carrier_position_is_filled_and_emptied_the_same_way(tmp_path, capsys):
    pytest.importorskip("pylabrobot")
    from ivoryos_edge.plr import PLRLiquidHandler
    saved = str(tmp_path / "worktable.json")
    layout = [{"rails": 15, "carrier": "PLT_CAR_L5AC_A00", "name": "plates", "sites": {}}]
    star = PLRLiquidHandler(deck="starlet", layout=layout, layout_file=saved)
    star.__ivoryos_labware_edit__("place", site="plates-2", definition="cor_96_wellplate_360uL_Fb", name="assay_plate")
    again = PLRLiquidHandler(deck="starlet", layout=layout, layout_file=saved)
    assert again.__ivoryos_labware__()["labware"]["assay_plate"]["site"] == "plates-2"
    again.__ivoryos_labware_edit__("remove", name="assay_plate")
    # Only what the deck itself comes with is left (a STARlet has a rack of teaching needles).
    left = PLRLiquidHandler(deck="starlet", layout=layout, layout_file=saved).__ivoryos_labware__()["labware"]
    assert set(left) == {"teaching_tip_rack"}


def test_a_worktable_built_in_a_script_is_not_rearranged_from_the_view(handler):
    from ivoryos_edge.plr import PLRLiquidHandler
    wrapped = PLRLiquidHandler(handler=handler._lh)
    assert wrapped.__ivoryos_labware_catalog__() == []
    with pytest.raises(ValueError, match="built in a script"):
        wrapped.__ivoryos_labware_edit__("remove", name="assay_plate")
