"""A trial that gave no result is left out of BayBE's model, and the adapter says so.

BayBE has no failed status: a measurement with a target missing is refused as incomplete. The
queue sends such a trial as its parameters alone (AGENTS.md section 6), and the adapter records
the round's other trials, so one failed experiment neither stops the run nor goes unmentioned.

BayBE is an optional backend and the edge's own environment does not carry it, so this skips
without it.
"""
import pytest


def test_baybe_records_the_round_without_the_failed_trial(capsys):
    pytest.importorskip("baybe")
    from ivoryos_edge.optimizer.baybe_optimizer import BaybeOptimizer

    opt = BaybeOptimizer(
        experiment_name="failed trials",
        parameter_space=[{"name": "x", "type": "range", "bounds": [1, 4], "value_type": "int"}],
        objective_config=[{"name": "y", "minimize": False}],
        optimizer_config={"step_1": {"model": "Random", "num_samples": 2}, "step_2": {"model": "BOTorch"}},
    )
    trials = opt.suggest(3)
    assert len(trials) == 3
    failed, *fine = trials
    opt.observe([{**failed}] + [{**t, "y": float(t["x"])} for t in fine])  # the first gave no result

    recorded = opt.experiment.measurements
    assert len(recorded) == 2
    assert sorted(recorded["x"].tolist()) == sorted(t["x"] for t in fine)
    assert f"trial {{'x': {failed['x']}}} gave no result" in capsys.readouterr().out

    # A round of nothing but failures is a no-op, not an error.
    opt.observe([{**t} for t in opt.suggest(1)])
    assert len(opt.experiment.measurements) == 2
