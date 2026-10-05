"""A simulated absorbance plate reader that reads a plate where it sits on the liquid handler.

It stands in for a real reader (PyLabRobot has backends for BioTek, BMG, Molecular Devices and
others) so the example has a measurement that depends on what was pipetted: absorbance through
the bottom of a well grows with the amount of dye in it, whatever it was diluted in.

It shares the plr-ivoryos LiquidHandler's worktable rather than owning one: its wells are picked
on the handler's plates, written as `assay_plate[A1]` (`__ivoryos_labware__` below), and the
Labware view draws the worktable once, for the handler.
"""

import asyncio
import random
from typing import Annotated, Dict, Optional

from ivoryos_edge.labware import Wells, WellSelection


class SimulatedPlateReader:
    def __init__(self, handler, absorbance_per_ul: Optional[Dict[str, float]] = None,
                 blank: float = 0.04, noise: float = 0.004, read_time_s: float = 0.6):
        self._handler = handler
        # Absorbance units per microlitre of each liquid in the well. Anything not listed is clear.
        self._per_ul = absorbance_per_ul or {"dye": 0.025}
        self._blank = blank
        self._noise = noise
        self._read_time = read_time_s

    def __ivoryos_labware__(self) -> dict:
        shared = self._handler.__ivoryos_labware__()
        return {"labware": {name: entry for name, entry in shared["labware"].items() if entry["category"] == "plate"}}

    async def read_absorbance(self, resources: Annotated[WellSelection, Wells("plate")],
                              wavelength_nm: int = 520) -> Dict[str, float]:
        """Absorbance of each well, by `plate[well]`."""
        await asyncio.sleep(self._read_time)
        readings = {}
        for plate, well, _ in self._handler._wells(resources, ("plate",)):
            contents = self._handler._contents_of(plate, well)
            signal = sum(self._per_ul.get(liquid, 0.0) * volume for liquid, volume in contents.items())
            readings[f"{plate}[{well}]"] = round(self._blank + signal + random.gauss(0, self._noise), 3)
        return readings
