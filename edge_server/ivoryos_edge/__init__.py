"""IvoryOS edge server.

`ivoryos_edge.run(__name__)` is resolved lazily (PEP 562) rather than imported here. Importing the
server fixes every data path (see paths.py) and creates the database engine, and the command-line
entry point has to set `IVORYOS_DATA_DIR` before that happens -- which it cannot do if merely
importing the package has already imported the server.
"""

__all__ = ["run", "Unit"]


def __getattr__(name):
    if name == "run":
        from .server import run
        return run
    if name == "Unit":
        # `from ivoryos_edge import Unit`, for a driver's annotations (units.py). Lazy like `run`,
        # for the opposite reason: units.py imports nothing, and a driver module importing it
        # must not drag the server in.
        from .units import Unit
        return Unit
    raise AttributeError(f"module 'ivoryos_edge' has no attribute {name!r}")
