"""Linear constraints between search-space parameters, written the way people write them.

One text form for every optimizer: `flow + 2*temp <= 100`, `a >= b`, `x1 + x2 + x3 = 1`. Ax takes
inequalities as text of its own, BayBE takes objects (parameters, coefficients, an operator and a
right-hand side), and neither says much when a constraint is wrong. Reading the text once, here,
gives both adapters the same structured constraint and lets the Optimize page check each one as
it is typed (`POST /api/optimizers/{name}/constraints`), with the same message the run would give.

What is accepted: sums and differences of parameters, each times or divided by a number, with
numbers anywhere and brackets, compared with one of `<=`, `>=` or `=` (`<`, `>` and `==` are read
as those three: for a measured quantity "less than" and "at most" are the same). Anything that is
not linear (two parameters multiplied, a parameter in a denominator, a function) is refused with
the part at fault named. The text is parsed with Python's own parser and never evaluated.

What each optimizer can then do with a constraint is the adapter's to say (`check_constraints` on
each adapter class): Ax keeps an equality exactly by solving it for one parameter and searching the
others (`AxOptimizer`), and BayBE takes continuous and stepped/choice parameters in separate kinds
of constraint, so one constraint cannot mix the two.
"""
import ast
import math
import re
from dataclasses import dataclass
from typing import Dict, Iterable, List, Mapping, Optional

_OPERATORS = {ast.LtE: "<=", ast.Lt: "<=", ast.GtE: ">=", ast.Gt: ">=", ast.Eq: "="}
_CONSTANT = ""  # the key a linear form keeps its constant term under

EXAMPLE = "a + 2*b <= 10"


class ConstraintError(ValueError):
    """A constraint that cannot be used, said for the person who wrote it."""


@dataclass(frozen=True)
class LinearConstraint:
    """`sum(coefficients[p] * p) <operator> rhs`, with every coefficient non-zero."""
    text: str
    coefficients: Dict[str, float]
    operator: str  # '<=', '>=' or '='
    rhs: float

    @property
    def names(self) -> List[str]:
        return list(self.coefficients)

    def value(self, point: Mapping[str, float]) -> float:
        return sum(c * float(point[name]) for name, c in self.coefficients.items())

    def holds(self, point: Mapping[str, float], tolerance: float = 1e-6) -> bool:
        lhs, slack = self.value(point), tolerance * max(1.0, abs(self.rhs))
        if self.operator == "<=":
            return lhs <= self.rhs + slack
        if self.operator == ">=":
            return lhs >= self.rhs - slack
        return abs(lhs - self.rhs) <= slack

    def as_text(self) -> str:
        """Written back out, for a library that reads text (Ax): `2.0*a - b <= 10.0`."""
        terms = []
        for name, c in self.coefficients.items():
            sign = "-" if c < 0 else "+"
            magnitude = abs(c)
            term = name if magnitude == 1 else f"{_number(magnitude)}*{name}"
            terms.append((sign, term))
        first_sign, first = terms[0]
        out = ("-" if first_sign == "-" else "") + first
        for sign, term in terms[1:]:
            out += f" {sign} {term}"
        return f"{out} {self.operator} {_number(self.rhs)}"


def _number(x: float) -> str:
    return repr(int(x)) if float(x).is_integer() and abs(x) < 1e15 else repr(float(x))


def parse(text: str, names: Iterable[str]) -> LinearConstraint:
    """Read one constraint. `names` are the parameters it may use (the search space's)."""
    known = list(names)
    source = (text or "").strip()
    if not source:
        raise ConstraintError(f"The constraint is empty. Write it like  {EXAMPLE}")
    # A single '=' is how people write equality; Python's parser needs '=='.
    python = re.sub(r"(?<![<>=!])=(?!=)", "==", source)
    try:
        tree = ast.parse(python, mode="eval").body
    except SyntaxError:
        raise ConstraintError(f"'{source}' could not be read. Write it like  {EXAMPLE}") from None
    if not isinstance(tree, ast.Compare) or len(tree.ops) != 1:
        raise ConstraintError(f"'{source}' needs exactly one comparison: <=, >= or =.")
    operator = _OPERATORS.get(type(tree.ops[0]))
    if operator is None:
        raise ConstraintError(f"'{source}' compares with something other than <=, >= or =.")

    left = _linear(tree.left, python)
    right = _linear(tree.comparators[0], python)
    combined = dict(left)
    for key, c in right.items():
        combined[key] = combined.get(key, 0.0) - c
    constant = combined.pop(_CONSTANT, 0.0)
    coefficients = {name: c for name, c in combined.items() if abs(c) > 1e-12}

    unknown = [name for name in combined if name not in known]
    if unknown:
        listed = ", ".join(known) if known else "none yet"
        raise ConstraintError(
            f"'{source}' names {', '.join(unknown)}, which {'is' if len(unknown) == 1 else 'are'} not "
            f"in the search space (parameters: {listed})."
        )
    if not coefficients:
        raise ConstraintError(f"'{source}' does not depend on any parameter once simplified.")
    return LinearConstraint(text=source, coefficients=coefficients, operator=operator, rhs=-constant)


def parse_all(texts: Optional[Iterable[str]], names: Iterable[str]) -> List[LinearConstraint]:
    """Every non-blank constraint, or one ConstraintError naming every one that cannot be read."""
    known = list(names)
    out, problems = [], []
    for text in texts or []:
        if not str(text or "").strip():
            continue
        try:
            out.append(parse(str(text), known))
        except ConstraintError as e:
            problems.append(str(e))
    if problems:
        raise ConstraintError(" ".join(problems))
    return out


def _linear(node: ast.AST, source: str) -> Dict[str, float]:
    """A linear form {parameter: coefficient, '': constant} for one side of the comparison."""
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return {_CONSTANT: float(node.value)}
    if isinstance(node, ast.Name):
        return {node.id: 1.0}
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        inner = _linear(node.operand, source)
        return {k: (-v if isinstance(node.op, ast.USub) else v) for k, v in inner.items()}
    if isinstance(node, ast.BinOp):
        left, right = _linear(node.left, source), _linear(node.right, source)
        if isinstance(node.op, (ast.Add, ast.Sub)):
            sign = 1.0 if isinstance(node.op, ast.Add) else -1.0
            out = dict(left)
            for key, c in right.items():
                out[key] = out.get(key, 0.0) + sign * c
            return out
        if isinstance(node.op, ast.Mult):
            if _is_constant(left):
                return {k: v * left.get(_CONSTANT, 0.0) for k, v in right.items()}
            if _is_constant(right):
                return {k: v * right.get(_CONSTANT, 0.0) for k, v in left.items()}
            raise ConstraintError(
                f"'{_segment(source, node)}' multiplies two parameters. A constraint can only add "
                "parameters, each times a number."
            )
        if isinstance(node.op, ast.Div):
            if not _is_constant(right):
                raise ConstraintError(f"'{_segment(source, node)}' divides by a parameter; only division by a number works.")
            divisor = right.get(_CONSTANT, 0.0)
            if divisor == 0:
                raise ConstraintError(f"'{_segment(source, node)}' divides by zero.")
            return {k: v / divisor for k, v in left.items()}
    raise ConstraintError(
        f"'{_segment(source, node)}' is not something a constraint can contain: use parameters, "
        "numbers, + - * / and brackets."
    )


def _is_constant(form: Dict[str, float]) -> bool:
    return all(key == _CONSTANT or abs(c) < 1e-12 for key, c in form.items())


def _segment(source: str, node: ast.AST) -> str:
    return (ast.get_source_segment(source, node) or "").replace("==", "=") or "part of it"


# --- what a parameter is, for an adapter deciding what it can constrain ------------------------

def is_stepped(param: Mapping) -> bool:
    return param.get("type") == "range" and len(param.get("bounds") or []) == 3


def is_numeric(param: Mapping) -> bool:
    """A number (a range, or a choice of numbers), as opposed to names or substances."""
    if param.get("type") == "range":
        return True
    if param.get("type") == "choice":
        values = param.get("bounds") or []
        return bool(values) and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in values)
    return False


def describe(param: Mapping) -> str:
    """How a parameter reads in a message: 'a range', 'a stepped range', 'a choice'."""
    if param.get("type") == "substance":
        return "a substance"
    if param.get("type") == "choice":
        return "a choice of numbers" if is_numeric(param) else "a choice of names"
    if is_stepped(param):
        return "a stepped range"
    return "a whole-number range" if param.get("value_type") == "int" else "a range"


def finite_bounds(param: Mapping):
    """(low, high) of a range, or None when it has none worth checking against."""
    bounds = param.get("bounds") or []
    if param.get("type") != "range" or len(bounds) < 2:
        return None
    low, high = float(bounds[0]), float(bounds[1])
    return (low, high) if math.isfinite(low) and math.isfinite(high) else None
