"""A failed experiment reaches observe() with an objective absent, None or NaN (nothing there to
measure, e.g. a top layer to sample when the mixture never separated). Ax records the trial as
failed and carries on; BayBE has no failed status, so it records the round's other trials and leaves
that one out (test_baybe_failed_trials.py covers the message).

Before: Ax handled only an absent objective (None stopped the run in complete_trial, and NaN was
recorded as a completed result), and BayBE treated NaN as a measurement.

The backends are optional, so these skip without them; tests/manual/optimizer_smoke.py says how to
install them beside the edge.
"""
import math

import pytest

SPACE = [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}]
OBJECTIVES = [{"name": "y", "minimize": False}]


@pytest.mark.parametrize("failed", [{}, {"y": None}, {"y": math.nan}], ids=["absent", "None", "NaN"])
def test_ax_marks_a_trial_without_its_result_failed(failed):
    pytest.importorskip("ax")
    from ax.core.base_trial import TrialStatus
    from ivoryos_edge.optimizer.ax_optimizer import AxOptimizer

    opt = AxOptimizer("failed trial", SPACE, OBJECTIVES,
                      {"step_1": {"model": "Sobol", "num_samples": 3}, "step_2": {"model": "BoTorch"}})
    ok, bad = opt.suggest(2)
    opt.observe([{**ok, "y": 0.4}, {**bad, **failed}])
    trials = opt.client._experiment.trials
    assert trials[0].status == TrialStatus.COMPLETED
    assert trials[1].status == TrialStatus.FAILED
    assert len(opt.suggest(1)) == 1  # and the run carries on


@pytest.mark.parametrize("failed", [{}, {"y": None}, {"y": math.nan}], ids=["absent", "None", "NaN"])
def test_baybe_leaves_out_a_trial_without_its_result(failed):
    pytest.importorskip("baybe")
    from ivoryos_edge.optimizer.baybe_optimizer import BaybeOptimizer

    opt = BaybeOptimizer("failed trial", SPACE, OBJECTIVES,
                         {"step_1": {"model": "Random", "num_samples": 2}, "step_2": {"model": "BOTorch"}})
    ok, bad = opt.suggest(2)
    opt.observe([{**ok, "y": 0.4}, {**bad, **failed}])
    assert len(opt.experiment.measurements) == 1  # the good trial only
