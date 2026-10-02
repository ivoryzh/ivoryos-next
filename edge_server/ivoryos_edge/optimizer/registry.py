# optimizers/registry.py
"""Which optimizer backends this edge offers.

A backend is offered when its package is installed *and* its adapter imports. One that is
installed but will not import (a version conflict between two backends' shared dependencies, a
missing compiled library) used to vanish without a word, which looked exactly like "not
installed". It is now kept in OPTIMIZER_ERRORS and printed once at startup, so the deck's log,
and a "Send to IvoryOS" report built from it, says why.
"""
import importlib
import importlib.util
import sys

OPTIMIZER_REGISTRY = {}
OPTIMIZER_ERRORS = {}

# name: (import name that says the package is installed, adapter module, adapter class)
_BACKENDS = {
    "ax": ("ax", "ivoryos_edge.optimizer.ax_optimizer", "AxOptimizer"),
    "baybe": ("baybe", "ivoryos_edge.optimizer.baybe_optimizer", "BaybeOptimizer"),
    "nimo": ("nimo", "ivoryos_edge.optimizer.nimo_optimizer", "NIMOOptimizer"),
}

for _name, (_package, _module, _cls) in _BACKENDS.items():
    try:
        if importlib.util.find_spec(_package) is None:
            continue
        OPTIMIZER_REGISTRY[_name] = getattr(importlib.import_module(_module), _cls)
    except Exception as e:
        OPTIMIZER_ERRORS[_name] = f"{type(e).__name__}: {e}"
        print(f"[optimizer] {_name} is installed but could not be loaded: {OPTIMIZER_ERRORS[_name]}", file=sys.stderr)
