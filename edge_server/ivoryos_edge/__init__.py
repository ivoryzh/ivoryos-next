"""IvoryOS edge server.

`ivoryos_edge.run(__name__)` is resolved lazily (PEP 562) rather than imported here. Importing the
server fixes every data path (see paths.py) and creates the database engine, and the command-line
entry point has to set `IVORYOS_DATA_DIR` before that happens -- which it cannot do if merely
importing the package has already imported the server.
"""

__all__ = ["run"]


def __getattr__(name):
    if name == "run":
        from .server import run
        return run
    raise AttributeError(f"module 'ivoryos_edge' has no attribute {name!r}")
