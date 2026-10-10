"""The assistant reads history and drafts safety, and still decides nothing.

* Runs are found, read as the datasheet Data History shows, and compared with the numbers
  computed here (count, min, max, mean, the best run by an objective's own direction).
* Safety additions are filed as proposals, refused when they do not validate, laid over the
  configuration in force when a person looks, and enforced only once accepted.
* The chat's `ask` mode answers from lookups it asks for and files nothing; its `safety` mode
  files a proposal and enforces nothing.
"""

import asyncio
import json
import os
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from ivoryos_edge.agent.history import compare_tables, run_table
from ivoryos_edge.safety import guard
from ivoryos_edge.server import app, queue_manager

FIXTURES = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "run_datasheets.json").read_text())


def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture(autouse=True)
def fresh_guard():
    def reset():
        for path in (guard.path, guard.state_path):
            if os.path.exists(path):
                os.remove(path)
        guard.load()
        guard.state.clear()
        queue_manager.resume()
    reset()
    yield
    reset()


class ScriptedModel:
    name = "scripted"
    model = "scripted-1"

    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    async def complete(self, system, messages, json_mode=False):
        self.calls.append(messages)
        return self.replies.pop(0)


async def run_and_wait(ac, name, value):
    resp = await ac.post("/api/queue/runs", json={
        "name": name, "parameters": {"type": "Sequence"}, "prep": [], "cleanup": [],
        "sequence": [
            {"instrument": "dummy", "method": "echo_method", "params": {"value": value}, "returnVar": "reading"},
            {"instrument": "dummy", "method": "counting_method", "params": {}, "returnVar": "count"},
        ],
    })
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["run_id"]
    for _ in range(200):
        status = (await ac.get(f"/api/queue/runs/{run_id}")).json()["status"]
        if status in ("completed", "error", "cancelled"):
            break
        await asyncio.sleep(0.05)
    assert status == "completed"
    return run_id


# --- history ----------------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_runs_are_found_read_and_compared():
    async with client() as ac:
        first = await run_and_wait(ac, "Historian alpha", "7")
        second = await run_and_wait(ac, "Historian beta", "8")

        found = (await ac.get("/api/agent/runs", params={"q": "historian"})).json()
        assert {r["id"] for r in found["runs"]} >= {first, second}

        table = (await ac.get(f"/api/agent/runs/{first}")).json()
        assert table["columns"] == ["reading", "count"]
        assert table["rows"][0]["values"][0] == "7" and table["rows"][0]["status"] == "completed"
        assert "count" in table["stats"] and "reading" not in table["stats"]   # only numbers have numbers
        assert table["duration_s"] is not None and table["rows_by_status"] == {"completed": 1}

        compared = (await ac.post("/api/agent/runs/compare", json={"run_ids": [first, second, 99999], "columns": ["count", "nope"]})).json()
        assert [e["run"] for e in compared["columns"]["count"]["runs"]] == [first, second]
        assert compared["not_found"] == [99999] and compared["missing"] == ["nope"]

        assert (await ac.get("/api/agent/runs/99999")).status_code == 404
        assert (await ac.post("/api/agent/runs/compare", json={})).status_code == 400


def test_the_best_is_judged_by_the_objectives_own_direction():
    record = next(c["record"] for c in FIXTURES["cases"] if c["record"]["parameters"].get("type") == "Optimization")
    table = run_table(record)
    stats = table["stats"]["yield (objective)"]
    assert stats == {"n": 1, "min": 40.5, "max": 40.5, "mean": 40.5, "goal": "maximize", "best_row": 1}
    assert table["rows_by_status"] == {"completed": 1, "failed": 1, "pending": 1}

    better = json.loads(json.dumps(record))
    better["id"] = 40
    better["steps"][2]["outputs"]["result"]["yield_percent"] = 88.0
    compared = compare_tables([table, run_table(better)])
    assert compared["columns"]["yield (objective)"]["best_run"] == 40
    assert compared["columns"]["temp"].get("best_run") is None   # an input has no direction


# --- safety proposals -------------------------------------------------------------------------

LIMIT = {"target": "dummy", "method": "test_method", "param": "duration", "max": 5}
DOOR = {"label": "Door", "values": ["open", "closed"], "set_by": [
    {"target": "dummy", "method": "echo_method", "value": {"arg": "value"}}]}
RULE = {"name": "Door open first", "message": "Open the door first.",
        "when": {"target": "dummy", "method": "test_method"},
        "require": [{"left": {"state": "door"}, "op": "==", "right": {"value": "open"}}]}


@pytest.mark.asyncio
async def test_safety_additions_wait_for_a_person():
    async with client() as ac:
        context = (await ac.get("/api/agent/safety")).json()
        assert "test_method" in context["deck"]["dummy"]["methods"]

        refused = await ac.post("/api/agent/propose-safety", json={"add": {"rules": [RULE]}, "summary": "door"})
        assert refused.status_code == 422 and refused.json()["filed"] is False
        assert "door" in refused.json()["error"]

        filed = await ac.post("/api/agent/propose-safety", json={"add": {"limits": [LIMIT]}, "summary": "Short tests only."})
        assert filed.status_code == 200, filed.text
        proposal = filed.json()
        assert proposal["kind"] == "safety" and proposal["status"] == "pending"
        assert proposal["name"] == "Safety: dummy.test_method.duration"
        assert guard.config["limits"] == []                                 # nothing enforced yet

        draft = (await ac.get(f"/api/agent/proposals/{proposal['id']}/safety-draft")).json()
        assert [l["param"] for l in draft["config"]["limits"]] == ["duration"]
        assert guard.config["limits"] == []                                 # a draft is a draft

        accepted = await ac.post(f"/api/agent/proposals/{proposal['id']}/accept", json={})
        assert accepted.status_code == 200, accepted.text
        assert [l["max"] for l in guard.config["limits"]] == [5]
        again = await ac.post(f"/api/agent/proposals/{proposal['id']}/accept", json={})
        assert again.status_code == 409


@pytest.mark.asyncio
async def test_a_proposal_the_safety_page_saved_itself_is_only_recorded():
    async with client() as ac:
        proposal = (await ac.post("/api/agent/propose-safety", json={"add": {"limits": [LIMIT]}, "summary": "x"})).json()
        done = await ac.post(f"/api/agent/proposals/{proposal['id']}/accept", json={"save": False})
        assert done.json() == {"ok": True, "kind": "safety", "saved": False}
        assert guard.config["limits"] == []
        assert (await ac.get(f"/api/agent/proposals/{proposal['id']}")).json()["status"] == "accepted"


# --- chat modes -------------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ask_answers_from_the_lookups_it_asked_for(monkeypatch, api_workflows_dir):
    from ivoryos_edge.agent import routes
    async with client() as ac:
        run_id = await run_and_wait(ac, "Asked about", "3")
        model = ScriptedModel([
            json.dumps({"tool": "run_table", "args": {"run_id": run_id}}),
            json.dumps({"answer": f"Asked about (#{run_id}) counted once.", "runs": [run_id]}),
        ])
        monkeypatch.setattr(routes, "build_provider", lambda settings: model)
        before = len((await ac.get("/api/agent/proposals", params={"status": "all"})).json()["proposals"])

        reply = await ac.post("/api/agent/chat", json={"mode": "ask", "message": "How did my last run go?",
                                                       "page_context": f"Data History, run #{run_id} selected"})
        assert reply.status_code == 200, reply.text
        body = reply.json()
        assert body["mode"] == "ask" and body["ok"] is True and body["runs"] == [run_id]
        assert body["lookups"] == [{"tool": "run_table", "args": {"run_id": run_id}}]
        # The recent runs and the page went in first; the looked-up table came back to the model.
        assert "Asked about" in model.calls[0][0]["content"] and f"run #{run_id} selected" in model.calls[0][0]["content"]
        assert "Result of run_table" in model.calls[1][-1]["content"] and '"count"' in model.calls[1][-1]["content"]
        after = len((await ac.get("/api/agent/proposals", params={"status": "all"})).json()["proposals"])
        assert after == before                                              # asking files nothing

        bad = await ac.post("/api/agent/chat", json={"mode": "dance", "message": "hi"})
        assert bad.status_code == 400


@pytest.mark.asyncio
async def test_safety_mode_files_a_proposal_and_enforces_nothing(monkeypatch, api_workflows_dir):
    from ivoryos_edge.agent import routes
    model = ScriptedModel([json.dumps({"summary": "Blocks test_method unless the door is open.",
                                       "add": {"states": {"door": DOOR}, "rules": [RULE]}})])
    monkeypatch.setattr(routes, "build_provider", lambda settings: model)
    async with client() as ac:
        reply = await ac.post("/api/agent/chat", json={"mode": "safety", "message": "test_method only with the door open"})
        assert reply.status_code == 200, reply.text
        body = reply.json()
        assert body["ok"] is True and body["proposal"]["kind"] == "safety"
        assert body["proposal"]["source"] == "panel:scripted/scripted-1"
        assert guard.config["rules"] == []
        await ac.post(f"/api/agent/proposals/{body['proposal']['id']}/accept", json={})
        assert [r["name"] for r in guard.config["rules"]] == ["Door open first"]
