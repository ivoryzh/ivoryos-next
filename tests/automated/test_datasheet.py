"""The edge reads a run record as the same datasheet Data History does.

`ivoryos_edge/datasheet.py` is a Python port of `packages/shared-ui/src/runRecord.ts`, for the
assistant to read history without a browser. Both are checked against the expected datasheets in
`tests/fixtures/run_datasheets.json`, which the TypeScript produced, so a change to either reading
that the other does not follow fails here or in `packages/shared-ui` (`npm test`).
"""

import json
from pathlib import Path

import pytest

from ivoryos_edge.datasheet import format_run, read_named_output, resolve_result_path, MISSING

FIXTURES = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "run_datasheets.json").read_text())


def _comparable(run):
    """The fields the fixtures hold, as JSON would carry them."""
    return json.loads(json.dumps({
        "type": run["type"], "variables": run["variables"],
        "rows": [{"row": r["row"], "status": r["status"], "values": r["values"]} for r in run["rows"]],
        "deck_version": run["deck_version"], "batch_size": run["batch_size"],
        "prep": run["prep"], "cleanup": run["cleanup"],
    }))


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=[c["name"] for c in FIXTURES["cases"]])
def test_the_edge_reads_a_run_as_data_history_does(case):
    assert "expected" in case, "run node packages/shared-ui/test/write-datasheet-fixtures.mjs"
    assert _comparable(format_run(case["record"])) == case["expected"]


def test_an_absent_value_and_a_recorded_none_stay_different():
    # A step that returned nothing saved None; a name nothing saved reads ''.
    template = [{"returnVar": "last"}, {"returnVar": "other"}]
    assert read_named_output("last", template, [{"outputs": {"result": None}}]) is None
    assert read_named_output("other", template, [{"outputs": {"result": None}}]) == ""
    assert resolve_result_path([1, 2], "-1") is MISSING   # not Python's last item
    assert resolve_result_path({"a": [5, 6]}, "a.1") == 6
