"""Check optimizer releases against IvoryOS's adapters before offering them in the launcher.

desktop/src/optimizers.js lists the Ax, BayBE and NIMO versions a deck can pick; a version goes
there only after this passes for it. Install the candidates together in a fresh environment, the
way the launcher installs them (Python 3.11, CPU-only PyTorch, one resolution), then run this:

    uv venv --python 3.11 /tmp/opt-check
    uv pip install --python /tmp/opt-check/bin/python --torch-backend cpu -e edge_server \
        "ax-platform==1.3.1" "baybe==0.15.0" "nimo==2.1.5"
    /tmp/opt-check/bin/python tests/manual/optimizer_smoke.py

Each backend is driven as the queue drives it (queue.py's optimization loop): seeded with
existing data (not NIMO, which seeds from a file), then suggest/observe rounds through the random
start into the model, each result carrying its trial's parameters. Prints JSON: versions, any
backend that would not import, and ok/error per backend.
"""
import json
import sys
import tempfile
import traceback
import importlib.metadata as md

import pandas as pd

from ivoryos_edge.optimizer.registry import OPTIMIZER_REGISTRY, OPTIMIZER_ERRORS


def f(p):
    x = float(p.get("x", 0.5))
    n = float(p.get("n", 2))
    return round(1.0 - (x - 0.6) ** 2 - 0.05 * (n - 3) ** 2 + (0.1 if p.get("c") == "b" else 0.0), 4)


def run(name, cls):
    schema = cls.get_schema()
    discrete = schema.get("supports_continuous") is False
    space = [
        {"name": "x", "type": "range", "bounds": [0.0, 1.0, 0.1] if discrete else [0.0, 1.0], "value_type": "float"},
        {"name": "n", "type": "range", "bounds": [0, 5, 1] if discrete else [0, 5], "value_type": "int"},
    ] + ([] if discrete else [{"name": "c", "type": "choice", "bounds": ["a", "b"], "value_type": "str"}])
    cfg = schema["optimizer_config"]
    first = lambda v: v[0] if isinstance(v, list) else v
    opt_config = {"step_1": {"model": first(cfg["step_1"]["model"]), "num_samples": 2},
                  "step_2": {"model": first(cfg["step_2"]["model"])}}
    opt = cls(experiment_name=f"smoke_{name}", parameter_space=space,
              objective_config=[{"name": "y", "minimize": False, "weight": 1}],
              optimizer_config=opt_config, datapath=tempfile.mkdtemp())
    if name != "nimo":  # NIMO seeds from a file, not a DataFrame (AGENTS.md section 6)
        seed = pd.DataFrame([{"x": 0.1, "n": 1, "c": "a"}, {"x": 0.9, "n": 4, "c": "b"}, {"x": 0.5, "n": 3, "c": "a"}])
        seed["y"] = [f(r) for r in seed.to_dict("records")]
        opt.append_existing_data(seed)
    seen = []
    for _ in range(4):
        trials = opt.suggest(n=2)
        # A model may return fewer than asked (Ax, when the model step cannot generate yet).
        assert isinstance(trials, list) and 1 <= len(trials) <= 2, trials
        # As the queue sends them: each trial's parameters with its objective.
        opt.observe([{**t, "y": f(t)} for t in trials])
        seen += trials
    return {"models": opt_config, "last": {k: (v.item() if hasattr(v, "item") else v) for k, v in seen[-1].items()}}


out = {"python": sys.version.split()[0], "errors": OPTIMIZER_ERRORS}
for pkg in ("ax-platform", "baybe", "nimo", "botorch", "torch", "gpytorch", "physbo", "numpy", "pandas"):
    try:
        out.setdefault("versions", {})[pkg] = md.version(pkg)
    except md.PackageNotFoundError:
        pass
for name, cls in OPTIMIZER_REGISTRY.items():
    try:
        out[name] = {"ok": True, **run(name, cls)}
    except Exception as e:
        out[name] = {"ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]}
print(json.dumps(out, indent=1, default=str))
