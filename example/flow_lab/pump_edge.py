"""Edge for the flow rig's pump system (port 8081). See flow_drivers.py.

    python example/flow_lab/pump_edge.py

Runs beside the collector edge (collector_edge.py) and the main demo deck (port 8080) on the same
machine. Its database, saved workflows and Cloud pairing live in example/flow_lab/.edges/pump/,
separate from every other edge's -- two edges sharing a pairing would evict each other from the
broker, since a device's name is its MQTT client id.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Before ivoryos_edge is imported: it reads the state folder at import time.
os.environ.setdefault("IVORYOS_EDGE_HOME", os.path.join(HERE, ".edges", "pump"))
sys.path.insert(0, os.path.join(HERE, "..", "..", "edge_server"))

from flow_drivers import PumpController  # noqa: E402
import ivoryos_edge  # noqa: E402

pump_controller = PumpController()

ivoryos_edge.run(__name__, port=int(os.getenv("PORT", "8081")))
