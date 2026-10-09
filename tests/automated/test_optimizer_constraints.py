"""Constraints between search-space parameters: one text form, read once, kept by Ax and BayBE.

`ivoryos_edge/optimizer/constraints.py` reads `a + 2*b <= 10`; each adapter says what it can keep
(`check_constraints`) and builds it. Ax takes only inequalities, so an equality is solved for one
parameter (`AxOptimizer._plan_constraints`); BayBE keeps equalities itself but constrains plain
ranges and stepped/choice parameters separately.

Ax and BayBE are optional backends that the edge's own environment does not carry, so their tests
skip without them. tests/manual/optimizer_smoke.py says how to install them beside the edge.
"""
import pytest

from ivoryos_edge.optimizer.constraints import ConstraintError, parse, parse_all

NAMES = ["a", "b", "c", "temp"]


# --- reading ------------------------------------------------------------------------------------

@pytest.mark.parametrize("text, coefficients, operator, rhs", [
    ("a + b <= 10", {"a": 1, "b": 1}, "<=", 10),
    ("2*a - b >= 3", {"a": 2, "b": -1}, ">=", 3),
    ("a >= b", {"a": 1, "b": -1}, ">=", 0),
    ("a + b + c = 1", {"a": 1, "b": 1, "c": 1}, "=", 1),
    ("a + b + c == 1", {"a": 1, "b": 1, "c": 1}, "=", 1),
    ("2*(a + b) <= temp/2 + 4", {"a": 2, "b": 2, "temp": -0.5}, "<=", 4),
    ("a * 3 < 9", {"a": 3}, "<=", 9),
    ("-a - b > -1.5", {"a": -1, "b": -1}, ">=", -1.5),
    ("10 >= a + b", {"a": -1, "b": -1}, ">=", -10),
])
def test_linear_constraints_are_read_into_coefficients(text, coefficients, operator, rhs):
    con = parse(text, NAMES)
    assert con.coefficients == pytest.approx(coefficients)
    assert con.operator == operator
    assert con.rhs == pytest.approx(rhs)


@pytest.mark.parametrize("text, says", [
    ("", "empty"),
    ("a + b", "one comparison"),
    ("a <= b <= c", "one comparison"),
    ("a * b <= 3", "multiplies two parameters"),
    ("a / b <= 3", "divides by a parameter"),
    ("a / 0 <= 3", "divides by zero"),
    ("sqrt(a) <= 3", "not something a constraint can contain"),
    ("a + x <= 3", "x, which is not in the search space"),
    ("a - a <= 3", "does not depend on any parameter"),
    ("a != 3", "other than <=, >= or ="),
    ("a +* b <= 3", "could not be read"),
])
def test_what_cannot_be_used_says_why(text, says):
    with pytest.raises(ConstraintError, match=says):
        parse(text, NAMES)


def test_blank_rows_are_skipped_and_every_bad_one_is_named():
    assert [c.text for c in parse_all(["a <= 1", "  ", None], NAMES)] == ["a <= 1"]
    with pytest.raises(ConstraintError) as e:
        parse_all(["a * b <= 1", "q >= 2"], NAMES)
    assert "multiplies" in str(e.value) and "q" in str(e.value)


def test_written_back_as_text_it_reads_the_same():
    for text in ["a + 2*b <= 10", "-a + 0.5*b >= -3", "a - b - c = 1"]:
        con = parse(text, NAMES)
        again = parse(con.as_text(), NAMES)
        assert again.coefficients == pytest.approx(con.coefficients)
        assert (again.operator, again.rhs) == (con.operator, pytest.approx(con.rhs))


def test_holds_allows_floating_point_rounding_on_an_equality():
    con = parse("a + b + c = 0.6", NAMES)
    assert con.holds({"a": 0.1, "b": 0.2, "c": 0.3})  # 0.6000000000000001
    assert not con.holds({"a": 0.1, "b": 0.2, "c": 0.4})


# --- Ax ------------------------------------------------------------------------------------------

def _range(name, low=0.0, high=1.0, value_type="float"):
    return {"name": name, "type": "range", "bounds": [low, high], "value_type": value_type}


def _ax(space, constraints, n=6):
    from ivoryos_edge.optimizer.ax_optimizer import AxOptimizer
    opt = AxOptimizer(
        experiment_name="constraints", parameter_space=space,
        objective_config=[{"name": "y", "minimize": False}],
        optimizer_config={"step_1": {"model": "Sobol", "num_samples": n}, "step_2": {"model": "BoTorch"}},
        parameter_constraints=constraints,
    )
    return opt, opt.suggest(n)


def test_ax_keeps_an_inequality():
    pytest.importorskip("ax")
    _, points = _ax([_range("a"), _range("b")], ["a + 2*b <= 1"])
    assert len(points) == 6
    assert all(p["a"] + 2 * p["b"] <= 1 + 1e-9 for p in points)


def test_ax_keeps_an_equality_by_working_one_parameter_out():
    pytest.importorskip("ax")
    opt, points = _ax([_range("a"), _range("b"), _range("c")], ["a + b + c = 1"])
    assert list(opt._solved) == ["c"]  # the last decimal range is the one worked out
    for p in points:
        assert p["a"] + p["b"] + p["c"] == pytest.approx(1)
        assert 0 <= p["c"] <= 1


def test_ax_equality_and_inequality_together():
    pytest.importorskip("ax")
    _, points = _ax([_range("a"), _range("b"), _range("c")], ["a + b + c = 1", "a >= c"])
    for p in points:
        assert p["a"] + p["b"] + p["c"] == pytest.approx(1)
        assert p["a"] >= p["c"] - 1e-9


def test_ax_says_what_it_cannot_keep():
    pytest.importorskip("ax")
    from ivoryos_edge.optimizer.ax_optimizer import AxOptimizer
    space = [_range("a"), _range("n", 0, 10, "int"), _range("m", 0, 10, "int"),
             {"name": "s", "type": "range", "bounds": [0, 1, 0.25], "value_type": "float"}]
    cons = parse_all(["a + s <= 1", "n + m = 4", "a + n <= 5", "a = 3"], [p["name"] for p in space])
    problems = AxOptimizer.check_constraints(cons, space)
    assert "s is a stepped range" in problems[0]
    assert "decimal range" in problems[1]  # nothing to work out: both whole numbers
    assert problems[2] is None
    assert "outside its range" in problems[3]
    with pytest.raises(ConstraintError):
        _ax(space, ["a + s <= 1"])


def test_ax_stepped_whole_numbers_stay_whole():
    pytest.importorskip("ax")
    _, points = _ax([{"name": "n", "type": "range", "bounds": [2, 10, 2], "value_type": "int"}], [], n=3)
    assert all(isinstance(p["n"], int) and p["n"] in (2, 4, 6, 8, 10) for p in points)


# --- BayBE ---------------------------------------------------------------------------------------

def _baybe(space, constraints):
    from ivoryos_edge.optimizer.baybe_optimizer import BaybeOptimizer
    return BaybeOptimizer(
        experiment_name="constraints", parameter_space=space,
        objective_config=[{"name": "y", "minimize": False}],
        optimizer_config={"step_1": {"model": "Random", "num_samples": 10}, "step_2": {"model": "BOTorch"}},
        parameter_constraints=constraints,
    )


def test_baybe_keeps_continuous_equalities_and_inequalities():
    pytest.importorskip("baybe")
    opt = _baybe([_range("a"), _range("b"), _range("c")], ["a + b + c = 1", "a <= 0.5", "b >= c"])
    for p in opt.suggest(6):
        assert p["a"] + p["b"] + p["c"] == pytest.approx(1, abs=1e-6)
        assert p["a"] <= 0.5 + 1e-6 and p["b"] >= p["c"] - 1e-6


def test_baybe_filters_stepped_and_choice_combinations():
    pytest.importorskip("baybe")
    space = [{"name": "n", "type": "range", "bounds": [1, 4, 1], "value_type": "int"},
             {"name": "m", "type": "choice", "bounds": [1, 2, 3, 4], "value_type": "int"}]
    opt = _baybe(space, ["n + 2*m <= 6"])
    assert len(opt.experiment.searchspace.discrete.exp_rep) == 6
    assert all(p["n"] + 2 * p["m"] <= 6 for p in opt.suggest(6))


def test_baybe_says_what_it_cannot_keep():
    pytest.importorskip("baybe")
    from ivoryos_edge.optimizer.baybe_optimizer import BaybeOptimizer
    space = [_range("a"), {"name": "n", "type": "range", "bounds": [1, 4, 1], "value_type": "int"},
             {"name": "solvent", "type": "choice", "bounds": ["water", "ethanol"], "value_type": "str"}]
    cons = parse_all(["a + n <= 3", "solvent <= 1", "n >= 2"], [p["name"] for p in space])
    problems = BaybeOptimizer.check_constraints(cons, space)
    assert "mixes a (a range) with n (a stepped range)" in problems[0]
    assert "solvent is a choice of names" in problems[1]
    assert problems[2] is None
    with pytest.raises(ConstraintError, match="No combination"):
        _baybe([{"name": "n", "type": "range", "bounds": [1, 4, 1], "value_type": "int"}], ["n >= 9"])


def test_baybe_leaves_pending_suggestions_out():
    pytest.importorskip("baybe")
    opt = _baybe([{"name": "n", "type": "choice", "bounds": [1, 2, 3], "value_type": "int"}], [])
    opt.add_pending([{"n": 1}, {"n": 2}])
    assert [p["n"] for p in opt.suggest(1)] == [3]


def test_baybe_substances_are_chosen_by_name():
    pytest.importorskip("baybe")
    from ivoryos_edge.optimizer.baybe_optimizer import chemistry_available
    if not chemistry_available():
        pytest.skip("BayBE's chemistry extras (baybe[chem]) are not installed")
    space = [{"name": "solvent", "type": "substance", "encoding": "ECFP",
              "bounds": {"water": "O", "methanol": "CO", "ethanol": "CCO", "toluene": "Cc1ccccc1"}},
             _range("t", 20, 80)]
    opt = _baybe(space, [])
    points = opt.suggest(3)
    assert all(p["solvent"] in {"water", "methanol", "ethanol", "toluene"} for p in points)
    opt.observe([{**p, "y": float(i)} for i, p in enumerate(points)])
    assert len(opt.experiment.measurements) == 3


def test_baybe_refuses_a_substance_without_a_real_smiles():
    pytest.importorskip("baybe")
    from ivoryos_edge.optimizer.baybe_optimizer import chemistry_available
    if not chemistry_available():
        pytest.skip("BayBE's chemistry extras (baybe[chem]) are not installed")
    with pytest.raises(ValueError, match="solvent"):
        _baybe([{"name": "solvent", "type": "substance", "bounds": {"water": "O", "mystery": "not-a-smiles"}}], [])
