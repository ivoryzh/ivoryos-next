"""Demo deck for the IvoryOS edge server.

Starts the edge server with a simulated self-driving lab: three syringe pumps charge a
vial, a heater-stirrer holds it at temperature, and a UV-Vis probe and HPLC read out how
much product formed. The instruments share one reaction model (see lab_drivers.py), so a
workflow built in the UI actually does chemistry -- and an optimization run over
temperature, catalyst loading and reaction time converges on a real optimum.

    python example/demo.py

The synthetic test drivers (enums, dataclasses, deliberately long names, failing
methods, async variants) are kept out of the deck so screenshots stay clean. Load them
alongside the lab deck with:

    IVORYOS_DEMO_TEST_DRIVERS=1 python example/demo.py
"""

import os
import sys

# Add edge_server to path so we can import ivoryos_edge
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "edge_server"))

from lab_drivers import (
    AnalyticalBalance,
    HeaterStirrer,
    HPLC,
    SyringePump,
    UVVisSpectrometer,
)
import ivoryos_edge

# --- Reagent delivery -------------------------------------------------------------
# The `role` is what the reaction model keys off; the variable name is what the UI shows.
pump_1 = SyringePump(
    reagent="4-bromoanisole, 0.50 M in dioxane",
    role="substrate",
    concentration_m=0.50,
)
pump_2 = SyringePump(
    reagent="phenylboronic acid, 0.50 M in dioxane",
    role="boronic_acid",
    concentration_m=0.50,
)
pump_3 = SyringePump(
    reagent="Pd(dppf)Cl2, 10 mM in dioxane",
    role="catalyst",
    concentration_m=0.010,
)

# --- Reaction ---------------------------------------------------------------------
reactor = HeaterStirrer(max_temperature_c=150.0)

# --- Analytics --------------------------------------------------------------------
balance = AnalyticalBalance()
uv_vis = UVVisSpectrometer(path_length_cm=1.0)
hplc = HPLC()

# --- Sample handling (commented out to keep the deck short) -----------------------
# Uncomment these to get the vial-transfer and wash steps back. `VialHandler` and
# `ReactionVialWasher` also need adding to the `lab_drivers` import above, and the
# "Suzuki coupling screen" workflow has the matching steps commented out of it too.
#
# vial_handler = VialHandler()
# vial_washer = ReactionVialWasher(solvent="acetone")

# --- Synthetic test drivers (opt-in) ----------------------------------------------
if os.getenv("IVORYOS_DEMO_TEST_DRIVERS"):
    from dummy_driver import AsyncPumpDriver, DummyMathDriver, PumpDriver

    test_pump = PumpDriver()
    test_async_pump = AsyncPumpDriver()
    test_math_driver = DummyMathDriver()

# Run edge server
ivoryos_edge.run(__name__)
