"""Stand-in drivers for a continuous-flow setup: a pump system and a fraction collector.

They mirror a real rig run on the legacy platform, where the pumps step their rates down every
minute while the collector takes a fraction every three -- two instruments on two different
timelines. Here each one is its own edge (see pump_edge.py and collector_edge.py), so Cloud can
trigger each sequence on its own interval instead of interleaving both into one long script.

Method names and arguments match the legacy steps (`pump_controller.run_set_pump_rates`,
`fraction_collector.collect_fraction`), and every method returns one number, so any step can be
saved as a variable and used as an optimizer objective.

In the desktop launcher the same two edges are two deck profiles, pump.deck.json and
collector.deck.json, using the same instrument names and state folders (.edges/pump,
.edges/collector) as the scripts. Run one or the other for each edge, not both: they would share a
database and a Cloud pairing.

Nothing here talks to hardware. Time is real by default -- a 180 s collection takes 180 s -- and
FLOW_LAB_TIME_SCALE shortens it for trying things out (0.05 makes that 9 s).
"""

import os
import random
import time

TIME_SCALE = float(os.getenv("FLOW_LAB_TIME_SCALE", "1.0"))
CHANNELS = ("fusion1", "fusion2", "nesp", "kds")


class PumpController:
    """Four syringe/HPLC pump channels feeding one flow line."""

    def __init__(self, max_rate_ml_min: float = 5.0):
        self.max_rate_ml_min = max_rate_ml_min
        self.rates = {c: 0.0 for c in CHANNELS}

    def run_set_pump_rates(self, fusion1_rate: float, fusion2_rate: float, nesp_rate: float, kds_rate: float) -> float:
        """Set all four channel flow rates (mL/min) at once. Returns the total flow rate, mL/min."""
        requested = dict(zip(CHANNELS, (fusion1_rate, fusion2_rate, nesp_rate, kds_rate)))
        for channel, rate in requested.items():
            if rate < 0 or rate > self.max_rate_ml_min:
                raise ValueError(f"{channel}_rate {rate} is outside 0-{self.max_rate_ml_min} mL/min")
        self.rates = {c: float(r) for c, r in requested.items()}
        time.sleep(0.2 * TIME_SCALE)  # a real controller acknowledges each channel
        return round(sum(self.rates.values()), 4)

    def read_total_flow(self) -> float:
        """The total flow rate the pumps are currently set to, mL/min."""
        return round(sum(self.rates.values()), 4)

    def read_pressure(self) -> float:
        """Line back-pressure, bar: rises with flow, with a little sensor noise."""
        return round(1.2 + 2.5 * sum(self.rates.values()) + random.gauss(0, 0.05), 3)

    def stop_all(self) -> float:
        """Stop every channel. Returns the total flow rate afterwards (0.0)."""
        self.rates = {c: 0.0 for c in CHANNELS}
        return 0.0


class FractionCollector:
    """Collects the line's output into numbered vials, one fraction per call."""

    def __init__(self, rack_size: int = 96, nominal_flow_ml_min: float = 3.0):
        self.rack_size = rack_size
        # The collector cannot see the pumps (they are a separate edge), so the collected volume
        # is simulated from a nominal line flow rather than the pumps' actual setting.
        self.nominal_flow_ml_min = nominal_flow_ml_min
        self.vial = 0

    def collect_fraction(self, collection_seconds: float = 180.0) -> float:
        """Collect one fraction into the next vial for `collection_seconds`. Returns the collected volume, mL."""
        if collection_seconds <= 0:
            raise ValueError("collection_seconds must be positive")
        if self.vial >= self.rack_size:
            raise RuntimeError(f"Rack is full ({self.rack_size} vials); replace it and call reset_rack")
        self.vial += 1
        time.sleep(collection_seconds * TIME_SCALE)
        volume = self.nominal_flow_ml_min * collection_seconds / 60.0
        return round(volume * random.uniform(0.97, 1.03), 3)

    def current_vial(self) -> float:
        """The number of the last vial filled (0 before the first fraction)."""
        return float(self.vial)

    def reset_rack(self) -> float:
        """Start again from vial 1 after replacing the rack. Returns the new vial count (0.0)."""
        self.vial = 0
        return 0.0
