# optimizers/registry.py
import importlib.util

OPTIMIZER_REGISTRY = {}

if importlib.util.find_spec("ax") is not None:
    try:
        from ivoryos_edge.optimizer.ax_optimizer import AxOptimizer
        OPTIMIZER_REGISTRY["ax"] = AxOptimizer
    except Exception:
        pass

if importlib.util.find_spec("baybe") is not None:
    try:
        from ivoryos_edge.optimizer.baybe_optimizer import BaybeOptimizer
        OPTIMIZER_REGISTRY["baybe"] = BaybeOptimizer
    except Exception:
        pass

if importlib.util.find_spec("nimo") is not None:
    try:
        from ivoryos_edge.optimizer.nimo_optimizer import NIMOOptimizer
        OPTIMIZER_REGISTRY["nimo"] = NIMOOptimizer
    except Exception:
        pass
