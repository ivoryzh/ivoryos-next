"""A simulated liquid handler on the IvoryOS edge, driven through PyLabRobot (plr-ivoryos).

    pip install -e ../IvoryOS-PyLabRobot-Integration      (plr-ivoryos 0.2, not on PyPI yet)
    python example/liquid_handler/demo.py

PyLabRobot's simulator with a tip rack, a reagent reservoir and two 96-well plates: tips and
volumes are tracked, nothing is connected. A simulated plate reader measures what was pipetted.
Open the Labware panel to watch the worktable.

Which robot it is lives in the worktable file, not in this script: in the Labware panel (part of
plr-ivoryos), Edit layout -> Robot switches the simulator between an Opentrons OT-2, a Hamilton
STARlet or STAR and a Tecan EVO, each keeping its own worktable, saved for the next start. Labware
is dragged on and moved there, and wells are filled with the liquids a run starts from. A real robot is the same line with its backend
(`LiquidHandler(backend=OpentronsOT2Backend(host=...), deck_json=...)`), which is what a Hub
install writes.

Runs beside the main demo deck (port 8080); its database, saved workflows and worktable file live
in example/liquid_handler/.edge/.
"""

import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Before ivoryos_edge is imported: it reads the state folder at import time.
os.environ.setdefault("IVORYOS_EDGE_HOME", os.path.join(HERE, ".edge"))
sys.path.insert(0, os.path.join(HERE, "..", "..", "edge_server"))

import ivoryos_edge  # noqa: E402
from ivoryos_edge.paths import DATA_DIR, WORKFLOWS_DIR  # noqa: E402
from plr_ivoryos import LiquidHandler  # noqa: E402
from plr_ivoryos.labware_view import plugin as labware_view  # noqa: E402
from plate_reader import SimulatedPlateReader  # noqa: E402

# The worktable this deck uses, kept in its data folder so the Labware view can change it. The
# first start copies the example's (an OT-2) there.
WORKTABLE = os.path.join(DATA_DIR, "worktable.json")
if not os.path.exists(WORKTABLE):
    shutil.copy(os.path.join(HERE, "worktable.json"), WORKTABLE)

liquid_handler = LiquidHandler(
    simulated=True, deck_json=WORKTABLE,
    # The simulator answers at once; a short pause per move makes a run watchable.
    step_delay_s=0.35,
)
plate_reader = SimulatedPlateReader(liquid_handler)

# Ready-made workflows for this worktable, copied in once.
os.makedirs(WORKFLOWS_DIR, exist_ok=True)
for _file in os.listdir(os.path.join(HERE, "workflows")):
    if _file.endswith(".json") and not os.path.exists(os.path.join(WORKFLOWS_DIR, _file)):
        shutil.copy(os.path.join(HERE, "workflows", _file), os.path.join(WORKFLOWS_DIR, _file))

ivoryos_edge.run(__name__, port=int(os.environ.get("IVORYOS_PORT", 8083)), plugins=[labware_view])
