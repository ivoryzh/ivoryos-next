"""BayBE's first phase (Random/FPS) lasts as long as step_1's `num_samples` says.

The adapter built its two-phase recommender without it, so BayBE's own default applied: the model
took over after the first measurement whatever the Optimize page had been given, while the Ax
adapter honoured the same setting.

BayBE is an optional backend and the edge's own environment does not carry it, so these skip
without it. tests/manual/optimizer_smoke.py says how to install one beside the edge.
"""
import pytest


def _optimizer(step_1):
    from ivoryos_edge.optimizer.baybe_optimizer import BaybeOptimizer

    return BaybeOptimizer(
        experiment_name="initial samples",
        parameter_space=[{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
        objective_config=[{"name": "y", "minimize": False}],
        optimizer_config={"step_1": step_1, "step_2": {"model": "BOTorch"}},
    )


def test_baybe_switches_to_its_model_after_num_samples_measurements():
    pytest.importorskip("baybe")
    from baybe.recommenders import BotorchRecommender, RandomRecommender

    opt = _optimizer({"model": "Random", "num_samples": 4})
    recommender = opt.experiment.recommender
    assert recommender.switch_after == 4

    def chosen():
        return recommender.select_recommender(measurements=opt.experiment.measurements)

    # Driven as the queue drives it. BayBE counts the measurements on record, so the first
    # phase holds for four trials and the model has the fifth.
    for on_record in range(4):
        assert len(opt.experiment.measurements) == on_record
        assert isinstance(chosen(), RandomRecommender)
        (trial,) = opt.suggest(1)
        opt.observe([{**trial, "y": trial["x"]}])
    assert isinstance(chosen(), BotorchRecommender)


@pytest.mark.parametrize("step_1, switch_after", [
    ({"model": "Random", "num_samples": 0}, 1),    # what the Optimize page sends for an emptied field
    ({"model": "Random", "num_samples": -2}, 1),
    ({"model": "Random", "num_samples": None}, 1),
    ({"model": "Random"}, 1),                      # not named: BayBE's own default
    ({"model": "Random", "num_samples": "6"}, 6),  # BayBE refuses anything but a real int
    ({"model": "Random", "num_samples": 6.0}, 6),
])
def test_baybe_initial_samples_are_a_whole_number_of_at_least_one(step_1, switch_after):
    pytest.importorskip("baybe")
    recommender = _optimizer(step_1).experiment.recommender
    assert recommender.switch_after == switch_after
    assert type(recommender.switch_after) is int
