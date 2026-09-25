"""A saved workflow is a promise about a deck that may have moved on.

Steps are stored as instrument/method/arguments and resolved only when they run, which is what
makes the library reusable and what lets it rot in silence: rename a driver's parameter and every
workflow using it still looks fine, until someone queues one and a reaction fails four steps in.
These tests pin the three things that make surfacing it on the Library page worth having — it
catches the breakage, it stays quiet about workflows that are merely *open*, and it does not
re-run the check when nothing has changed.
"""

import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge import compatibility
from ivoryos_edge.compatibility import check, schema_fingerprint
from ivoryos_edge.server import app


@pytest.fixture(autouse=True)
def clear_cache():
    compatibility.forget()
    yield
    compatibility.forget()


def _schema(**overrides):
    schema = {
        "pump": {
            "dispense": {
                "description": "",
                "parameters": {
                    "volume_ml": {"type": "float", "required": True},
                    "flow_rate_ml_min": {"type": "float", "required": False, "default": 2.0},
                },
                "return_type": "None", "return_paths": [],
            }
        }
    }
    schema.update(overrides)
    return schema


def _body(steps, body_hash="h1"):
    return {"prep": [], "script": steps, "cleanup": [], "body_hash": body_hash}


def _step(instrument, method, args):
    return {"instrument": instrument, "action": method, "args": args}


def test_a_workflow_that_still_fits_the_deck_is_quiet():
    body = _body([_step("pump", "dispense", {"volume_ml": 1.0})])
    assert check("ok", body, _schema(), "fp1")["status"] == "ok"


def test_a_renamed_parameter_is_what_this_is_for():
    """The change that used to be invisible: the driver still has the method, the workflow still
    has a value for it, and the name no longer matches."""
    body = _body([_step("pump", "dispense", {"volume_millilitres": 1.0})])
    verdict = check("renamed", body, _schema(), "fp1")
    assert verdict["status"] == "broken"
    assert any("has no parameter 'volume_millilitres'" in e["message"] for e in verdict["errors"])
    # And the hint carries what the parameters are now, which is the next question anyone asks.
    assert any("volume_ml" in (e.get("hint") or "") for e in verdict["errors"])


def test_a_removed_method_and_a_removed_instrument_are_both_caught():
    gone_method = _body([_step("pump", "purge", {})])
    assert check("m", gone_method, _schema(), "fp1")["status"] == "broken"

    gone_instrument = _body([_step("reactor", "hold", {})])
    assert check("i", gone_instrument, _schema(), "fp1")["status"] == "broken"


def test_open_variables_are_not_breakage():
    """The noise case, and the reason this counts errors only. A reusable workflow is *supposed*
    to leave values open — the Configure page fills them from a spreadsheet and an optimization
    run fills them per trial — and validate_body says so with a warning. Counting warnings would
    mark most of a working library as broken and teach everyone to ignore the badge."""
    body = _body([_step("pump", "dispense", {"volume_ml": "#volume"})])
    assert check("open", body, _schema(), "fp1") == {"status": "ok", "error_count": 0, "errors": []}


def test_an_empty_workflow_is_not_reported_as_a_deck_problem():
    """It cannot run either, but "no longer compatible with this deck" would be a lie about the
    cause — and a draft someone started yesterday is not a rotted workflow."""
    assert check("empty", _body([]), _schema(), "fp1")["status"] == "ok"


def test_the_verdict_is_reused_until_the_workflow_or_the_deck_changes(monkeypatch):
    """The whole design of the cache: `instrument_schemas` is built once at startup and never
    written again, so the answer can only change when the body changes (its hash) or the server
    restarts against different drivers (the fingerprint). Anything else is a re-check that could
    not possibly come out differently."""
    calls = []
    real = compatibility.validate_body

    def counting(body, schema, known=(), resolve=None):
        calls.append(body)
        return real(body, schema, known, resolve)

    monkeypatch.setattr(compatibility, "validate_body", counting)

    body = _body([_step("pump", "dispense", {"volume_ml": 1.0})], body_hash="h1")
    check("w", body, _schema(), "fp1")
    check("w", body, _schema(), "fp1")
    check("w", body, _schema(), "fp1")
    assert len(calls) == 1, "a listing refresh must not re-validate an unchanged workflow"

    # Edited workflow: new body_hash, so the verdict is recomputed.
    edited = _body([_step("pump", "dispense", {"volume_ml": 1.0})], body_hash="h2")
    check("w", edited, _schema(), "fp1")
    assert len(calls) == 2

    # Restarted against different drivers: new fingerprint, recomputed for every workflow.
    check("w", edited, _schema(), "fp2")
    assert len(calls) == 3


def test_the_fingerprint_notices_a_parameter_change_not_just_a_missing_method():
    """A rename inside a method's parameters breaks saved workflows exactly as thoroughly as a
    deleted method, so a fingerprint over method *names* would miss the case this exists for."""
    before = _schema()
    after = _schema()
    after["pump"]["dispense"]["parameters"]["volume_litres"] = \
        after["pump"]["dispense"]["parameters"].pop("volume_ml")
    assert schema_fingerprint(before) != schema_fingerprint(after)


def test_a_body_with_no_stored_hash_is_still_cached_and_still_checked():
    """Bodies written before versioning — or synced down from Cloud — carry an empty body_hash,
    and falling back to hashing the body keeps them from being re-validated on every listing."""
    body = {"prep": [], "script": [_step("pump", "dispense", {"volume_ml": 1.0})], "cleanup": []}
    assert check("legacy", body, _schema(), "fp1")["status"] == "ok"
    assert compatibility._cache["legacy"][0], "a body without a stored hash still needs a cache key"


# --------------------------------------------------------------------------------------
# Through the listing the Library page actually reads
# --------------------------------------------------------------------------------------

def _api_body(steps):
    return {"prep": [], "script": steps, "cleanup": []}


def _api_step(instrument, action, args=None):
    return {"id": 1, "uuid": 123456, "instrument": instrument, "action": action,
            "args": args or {}, "arg_types": {}, "return": "", "batch_action": False}


@pytest.mark.asyncio
async def test_the_listing_says_which_saved_workflows_no_longer_fit_the_deck(api_workflows_dir):
    """The Library page gets this for free: the listing already loads every body to work out
    `linked_by`, so the verdict rides along with the row rather than costing a second request."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/workflows/still_good", json=_api_body(
            [_api_step("dummy", "test_method", {"duration": 0})]))
        await ac.post("/api/workflows/driver_moved_on", json=_api_body(
            [_api_step("dummy", "method_that_was_removed", {})]))

        rows = {w["name"]: w for w in (await ac.get("/api/workflows")).json()["workflows"]}

    assert rows["still_good"]["compatibility"]["status"] == "ok"

    broken = rows["driver_moved_on"]["compatibility"]
    assert broken["status"] == "broken"
    assert "method_that_was_removed" in broken["errors"][0]["message"]
    # The hint names what the instrument does have, which is the next thing anyone asks.
    assert "test_method" in broken["errors"][0]["hint"]


def test_the_verdict_travels_with_the_body_cloud_mirrors(monkeypatch, api_workflows_dir):
    """Cloud has no HTTP path to a device, so its Library can only flag a broken workflow if the
    verdict rides along on the retained `sequences/{name}` message it already mirrors."""
    from ivoryos_edge import server

    monkeypatch.setattr(app.state, "instrument_schemas", _schema(), raising=False)
    monkeypatch.setattr(app.state, "schema_fingerprint", "fp-publish", raising=False)

    body = _body([_step("pump", "dispense", {"volume_millilitres": 1.0})], body_hash="pub1")
    message = server.published_sequence("renamed", body)

    assert message["compatibility"]["status"] == "broken"
    assert message["script"] == body["script"], "the body itself goes out unchanged"
    assert "compatibility" not in body, "the saved body is not modified"
