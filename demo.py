import sys
import os

# Add edge_server to path so we can import ivoryos_edge
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "edge_server"))

from dummy_driver import PumpDriver, DummyMathDriver
import ivoryos_edge

# Initialize instruments in global scope
my_pump = PumpDriver()
another_pump = PumpDriver()
math_driver = DummyMathDriver()

# Run edge server
ivoryos_edge.run(__name__)
