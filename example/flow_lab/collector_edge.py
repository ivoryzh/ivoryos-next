"""Edge for the flow rig's fraction collector (port 8082). See flow_drivers.py.

    python example/flow_lab/collector_edge.py

Its own state folder (example/flow_lab/.edges/collector/) for the same reason as pump_edge.py.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("IVORYOS_EDGE_HOME", os.path.join(HERE, ".edges", "collector"))
sys.path.insert(0, os.path.join(HERE, "..", "..", "edge_server"))

from flow_drivers import FractionCollector  # noqa: E402
import ivoryos_edge  # noqa: E402

fraction_collector = FractionCollector()

ivoryos_edge.run(__name__, port=int(os.getenv("PORT", "8082")))
