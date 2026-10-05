"""A simulated liquid handler on the IvoryOS edge, driven through PyLabRobot.

    pip install pylabrobot            (or: uv run --project edge_server --extra plr ...)
    python example/liquid_handler/demo.py

An Opentrons OT-2 worktable with a tip rack, a reagent reservoir and two 96-well plates, on
PyLabRobot's simulator backend: tips and volumes are tracked, nothing is connected. A simulated
plate reader measures what was pipetted. Open the Labware panel to watch the worktable.

    IVORYOS_LH_DECK=starlet python example/liquid_handler/demo.py

shows the same steps on a Hamilton STARlet, where labware sits on carriers along the rails.
Runs beside the main demo deck (port 8080); its database, saved workflows and worktable live in
example/liquid_handler/.edge/<deck>/.
"""

import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
deck = os.environ.get("IVORYOS_LH_DECK", "ot2")
# Before ivoryos_edge is imported: it reads the state folder at import time. One per deck, so the
# two worktables keep their own saved layouts and runs.
os.environ.setdefault("IVORYOS_EDGE_HOME", os.path.join(HERE, ".edge", deck))
sys.path.insert(0, os.path.join(HERE, "..", "..", "edge_server"))

import ivoryos_edge  # noqa: E402
from ivoryos_edge.labware_view import plugin as labware_view  # noqa: E402
from ivoryos_edge.paths import WORKFLOWS_DIR  # noqa: E402
from ivoryos_edge.plr import PLRLiquidHandler  # noqa: E402
from plate_reader import SimulatedPlateReader  # noqa: E402

PLATE = "cor_96_wellplate_360uL_Fb"
RESERVOIR = "nest_12_troughplate_15000uL_Vb"

# The worktable is data: where each labware sits, and which PyLabRobot definition it is.
OT2 = [
    {"slot": 1, "labware": "opentrons_96_tiprack_300ul", "name": "tips_300"},
    {"slot": 4, "labware": "opentrons_96_tiprack_300ul", "name": "tips_300_b"},
    {"slot": 2, "labware": RESERVOIR, "name": "reservoir"},
    {"slot": 5, "labware": PLATE, "name": "assay_plate"},
    {"slot": 6, "labware": PLATE, "name": "sample_plate"},
]
STARLET = [
    {"rails": 3, "carrier": "TIP_CAR_480_A00", "name": "tip_carrier", "sites": {
        "0": {"labware": "hamilton_96_tiprack_300uL_filter", "name": "tips_300"},
        "1": {"labware": "hamilton_96_tiprack_300uL_filter", "name": "tips_300_b"},
    }},
    {"rails": 15, "carrier": "PLT_CAR_L5AC_A00", "name": "plate_carrier", "sites": {
        "0": {"labware": RESERVOIR, "name": "reservoir"},
        "1": {"labware": PLATE, "name": "assay_plate"},
        "2": {"labware": PLATE, "name": "sample_plate"},
    }},
]
# What a person put on the worktable before the run.
LIQUIDS = [
    {"labware": "reservoir", "wells": "A1", "liquid": "buffer", "volume_ul": 14000},
    {"labware": "reservoir", "wells": "A2", "liquid": "dye", "volume_ul": 9000},
]

liquid_handler = PLRLiquidHandler(
    deck=deck, backend="simulator", channels=8,
    layout=STARLET if deck in ("starlet", "star") else OT2, liquids=LIQUIDS,
    # Labware placed or removed in the Labware view is saved here and used from the next start.
    layout_file="worktable.json",
    # The simulator answers at once; a short pause per move makes a run watchable.
    step_delay_s=float(os.environ.get("IVORYOS_LH_STEP_DELAY", 0.35)),
)
plate_reader = SimulatedPlateReader(liquid_handler)

# Ready-made workflows for this worktable, copied in once.
os.makedirs(WORKFLOWS_DIR, exist_ok=True)
for _file in os.listdir(os.path.join(HERE, "workflows")):
    if _file.endswith(".json") and not os.path.exists(os.path.join(WORKFLOWS_DIR, _file)):
        shutil.copy(os.path.join(HERE, "workflows", _file), os.path.join(WORKFLOWS_DIR, _file))

ivoryos_edge.run(__name__, port=int(os.environ.get("IVORYOS_PORT", 8083)), plugins=[labware_view])
