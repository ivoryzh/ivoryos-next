"""Ax gives a round the number of trials it asked for, across the change from one node to the next.

`GenerationStrategy.gen` caps a batch by the trial limit of the node it is leaving, read once
before generating, so `get_next_trials(3)` with Sobol at 4 of 5 trials returned 1, and the first
model batch was cut the same way. `AxOptimizer.suggest` asks again for the rest.

Ax is an optional backend and the edge's own environment does not carry it, so these skip
without it. tests/manual/optimizer_smoke.py says how to install one beside the edge.
"""
import logging

import pytest

SPACE = [
    {"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"},
    {"name": "n", "type": "range", "bounds": [0, 5], "value_type": "int"},
]
OBJECTIVE = [{"name": "y", "minimize": False}]


def _measure(trial):
    return 1 - (trial["x"] - 0.6) ** 2 - 0.05 * (trial["n"] - 3) ** 2


def _nodes_used(opt):
    trials = opt.client._experiment.trials
    return [trials[i].generator_run._generation_node_name for i in opt.trial_index_list]


@pytest.mark.parametrize("optimizer_config", [
    pytest.param(None, id="default strategy"),
    pytest.param({"step_1": {"model": "Sobol", "num_samples": 5}, "step_2": {"model": "BoTorch"}}, id="Sobol x5 then BoTorch"),
])
def test_ax_fills_the_batch_across_a_node_change(optimizer_config):
    pytest.importorskip("ax")
    logging.disable(logging.CRITICAL)  # Ax logs every trial it generates
    from ivoryos_edge.optimizer.ax_optimizer import AxOptimizer

    opt = AxOptimizer("batches", SPACE, OBJECTIVE, optimizer_config)
    rounds = []
    for _ in range(3):
        trials = opt.suggest(3)
        rounds.append(_nodes_used(opt))
        assert len(trials) == 3, rounds
        opt.observe([{**t, "y": _measure(t)} for t in trials])

    # Nine trials over three rounds: five from the random start (plus the centre point the
    # default strategy begins with), the rest from the model, with no round cut short.
    used = [node for nodes in rounds for node in nodes]
    assert len(used) == 9
    assert len(set(used)) > 1, "the model never took over"
    assert used[-1] == used[-2] == used[-3], "the last round should be the model's alone"
