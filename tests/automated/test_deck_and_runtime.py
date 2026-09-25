"""Deck versions and workflow run times.

Two records the edge keeps about itself so that what happened can be explained later:

  * which shape the deck (every instrument's introspected schema) had -- a new version only when
    it actually changed -- and which version each run and each saved workflow belongs to;
  * how long each saved workflow typically takes, from its own completed runs, which is what
    Cloud shows beside a workflow and uses to spell out a repeat cadence.
"""

import asyncio

import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from ivoryos_edge import deck, runtime, server
from ivoryos_edge import workflows as wf
from ivoryos_edge.models import Base
from ivoryos_edge.server import app


@pytest.fixture
def isolated_deck(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite+pysqlite:///{tmp_path / 'deck.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    monkeypatch.setattr(deck, "sync_session", sessionmaker(bind=engine, expire_on_commit=False))
    monkeypatch.setitem(deck._current, "version", None)
    yield
    engine.dispose()


def _schema(**params):
    return {"pump": {"dispense": {"parameters": params or {"volume_ml": {"type": "float", "required": True}},
                                  "return_type": "None"}}}


def test_a_restart_on_the_same_drivers_is_the_same_deck(isolated_deck):
    assert deck.record(_schema(), {}, "fp-a") == 1
    assert deck.record(_schema(), {}, "fp-a") == 1, "same fingerprint, same version"
    assert deck.current_version() == 1


def test_a_driver_change_is_a_new_version_even_back_to_an_old_shape(isolated_deck):
    assert deck.record(_schema(), {}, "fp-a") == 1
    assert deck.record(_schema(volume={"type": "float", "required": True}), {}, "fp-b") == 2
    # Rolling the driver back is a change too: the history is a timeline, not a set of shapes.
    assert deck.record(_schema(), {}, "fp-a") == 3
    assert [v["version"] for v in deck.list_versions()] == [3, 2, 1]
    assert deck.get_version(2)["schema"]["pump"]["dispense"]["parameters"] == {
        "volume": {"type": "float", "required": True}
    }


def test_the_diff_names_what_a_workflow_would_trip_over():
    old = {
        "pump": {"dispense": {"parameters": {"volume_ml": {"type": "float", "required": True},
                                             "rate": {"type": "float"}}, "return_type": "None"},
                 "prime": {"parameters": {}, "return_type": "None"}},
    }
    new = {
        "pump": {"dispense": {"parameters": {"volume": {"type": "float", "required": True},
                                             "rate": {"type": "int"}}, "return_type": "dict"}},
        "balance": {"weigh": {"parameters": {}}},
    }
    changes = {(c["change"], c.get("method"), c.get("param")) for c in deck.diff(old, new)}
    assert changes == {
        ("instrument_added", None, None),
        ("method_removed", "prime", None),
        ("param_removed", "dispense", "volume_ml"),
        ("param_added", "dispense", "volume"),
        ("param_changed", "dispense", "rate"),
        ("returns_changed", "dispense", None),
    }


def test_a_description_change_is_not_a_breaking_change():
    old = {"pump": {"dispense": {"parameters": {"v": {"type": "float", "description": "old"}}}}}
    new = {"pump": {"dispense": {"parameters": {"v": {"type": "float", "description": "new"}}}}}
    assert deck.diff(old, new) == []


def test_saved_versions_record_their_deck_without_a_resave_burning_a_version(monkeypatch, tmp_path):
    body = {"description": "", "prep": [], "cleanup": [],
            "script": [{"instrument": "dummy", "action": "echo_method", "args": {"value": "x"}}]}
    monkeypatch.setitem(deck._current, "version", 4)
    saved, version, created = wf.save_version(str(tmp_path), "stamped", body)
    assert (version, created, saved["deck_version"]) == (1, True, 4)

    monkeypatch.setitem(deck._current, "version", 5)
    again, version, created = wf.save_version(str(tmp_path), "stamped", body)
    assert (version, created) == (1, False), "same content on a newer deck is not an edit"
    assert again["deck_version"] == 4, "it still says which deck it was written for"


class _Broker:
    client_id = "test-device"

    def __init__(self):
        self.published = []

    def publish(self, topic, payload, retain=False, qos=0):
        self.published.append((topic, payload))


async def _wait(ac, name, until=("completed", "error", "cancelled")):
    run = None
    for _ in range(100):
        runs = (await ac.get("/api/queue/runs")).json()["runs"]
        run = max((r for r in runs if r["name"] == name), key=lambda r: r["id"], default=None)
        if run and run["status"] in until:
            return run
        await asyncio.sleep(0.05)
    return run


@pytest.mark.asyncio
async def test_runs_record_their_deck(monkeypatch, api_workflows_dir):
    monkeypatch.setitem(deck._current, "version", 9)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/queue/runs", json={
            "name": "Deck-stamped run",
            "sequence": [{"instrument": "dummy", "method": "echo_method", "params": {"value": "x"}}],
        })
        run = await _wait(ac, "Deck-stamped run")
    assert run["parameters"]["deck_version"] == 9


@pytest.mark.asyncio
async def test_a_workflow_is_timed_by_phase_from_its_own_runs(monkeypatch, api_workflows_dir):
    """Prep, one pass of the body, and cleanup are timed separately -- the body once per row --
    and the result travels to Cloud on the workflow's own retained message."""
    monkeypatch.setattr(server, "global_broker", _Broker())
    monkeypatch.setattr(server, "global_topic_prefix", "ivoryos/edge")
    runtime.forget()

    wf.save_version(api_workflows_dir, "timed protocol", {
        "description": "",
        "prep": [{"instrument": "dummy", "action": "echo_method", "args": {"value": "setup"}}],
        "script": [{"instrument": "dummy", "action": "echo_method", "args": {"value": "#label"}},
                   {"instrument": "dummy", "action": "echo_method", "args": {"value": "second"}}],
        "cleanup": [{"instrument": "dummy", "action": "echo_method", "args": {"value": "teardown"}}],
    })

    def link(phase, args):
        return {"instrument": "Library Workflows", "method": "timed protocol", "params": args, "phases": [phase]}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/queue/runs", json={
            "name": "Timed screen",
            "parameters": {"type": "Spreadsheet", "variables": ["label"], "rows": [{"label": "a"}, {"label": "b"}]},
            "prep": [link("prep", {"label": "a"})],
            "sequence": [link("script", {"label": "a", "_row": 0, "_block": 0}),
                         link("script", {"label": "b", "_row": 1, "_block": 0})],
            "cleanup": [link("cleanup", {"label": "a"})],
        })
        assert (await _wait(ac, "Timed screen"))["status"] == "completed"

        timing = runtime.workflow_runtimes()["timed protocol"]
        assert timing["runs"] >= 1
        assert set(timing) >= {"prep_s", "iteration_s", "cleanup_s", "typical_s", "last_at"}
        assert timing["typical_s"] == pytest.approx(
            timing["prep_s"] + timing["iteration_s"] + timing["cleanup_s"], abs=0.2
        )

        listed = (await ac.get("/api/workflows")).json()["workflows"]
        assert next(w for w in listed if w["name"] == "timed protocol")["runtime"]["runs"] >= 1

    message = server.published_sequence("timed protocol", wf.read_head(api_workflows_dir, "timed protocol"))
    assert message["runtime"]["runs"] >= 1


@pytest.mark.asyncio
async def test_an_unfinished_run_does_not_count(api_workflows_dir):
    runtime.forget()
    wf.save_version(api_workflows_dir, "always fails", {
        "description": "", "prep": [], "cleanup": [],
        "script": [{"instrument": "dummy", "action": "fail_method", "args": {}}],
    })
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/queue/runs", json={
            "name": "Failing timed run",
            "sequence": [{"instrument": "Library Workflows", "method": "always fails", "params": {}}],
        })
        run = await _wait(ac, "Failing timed run", until=("error",))
        # An errored step parks the run waiting for an operator; cancel it so the queue moves on.
        await ac.post(f"/api/queue/runs/{run['id']}/cancel")
        await _wait(ac, "Failing timed run", until=("cancelled", "error"))
    assert "always fails" not in runtime.workflow_runtimes()
