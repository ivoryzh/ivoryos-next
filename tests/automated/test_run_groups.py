"""A design run in stages: one experiment, queued as several runs (POST /api/queue/groups).

Each stage keeps its own settings and stays editable until it starts, which is the reason they are
separate runs at all. What makes them one experiment is checked here: they are accepted or
refused together, they run in order, and a stage that fails or is stopped ends the ones after it.
"""

import asyncio

import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge.server import app, queue_manager


def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture(autouse=True)
def queue_going():
    queue_manager.resume()
    yield
    queue_manager.resume()


def step(method, **params):
    return {"instrument": "dummy", "method": method, "params": params}


def stage(name, *steps, **parameters):
    return {"name": name, "parameters": parameters, "prep": [], "sequence": list(steps), "cleanup": []}


async def run_of(ac, run_id):
    return (await ac.get(f"/api/queue/runs/{run_id}")).json()


async def until(predicate, tries=120, delay=0.05):
    for _ in range(tries):
        if await predicate() if asyncio.iscoroutinefunction(predicate) else predicate():
            return True
        await asyncio.sleep(delay)
    return False


async def finished(ac, run_id):
    for _ in range(120):
        run = await run_of(ac, run_id)
        if run["status"] in ("completed", "error", "cancelled"):
            return run
        await asyncio.sleep(0.05)
    return run


@pytest.mark.asyncio
async def test_stages_are_queued_together_in_order_and_know_their_set():
    async with client() as ac:
        made = await ac.post("/api/queue/groups", json={"prefix": "Sample prep", "stages": [
            stage("Solids", step("echo_method", value="a"), type="Spreadsheet", variables=["v"], rows=[{"v": "a"}]),
            stage("Tare", step("counting_method")),
            stage("Solvents", step("echo_method", value="b")),
        ]})
        assert made.status_code == 200, made.text
        group, ids = made.json()["group"], made.json()["run_ids"]
        assert len(ids) == 3 and ids == sorted(ids)

        runs = [await finished(ac, run_id) for run_id in ids]
        assert [r["status"] for r in runs] == ["completed"] * 3
        assert [r["name"] for r in runs] == [f"{group['name']} · {p}" for p in ("Solids", "Tare", "Solvents")]
        assert [r["parameters"]["group"]["index"] for r in runs] == [1, 2, 3]
        assert all(r["parameters"]["group"]["id"] == group["id"] and r["parameters"]["group"]["total"] == 3 for r in runs)
        # They ran one after another, in the order given.
        assert runs[0]["end_time"] <= runs[1]["end_time"] <= runs[2]["end_time"]

        # Data History finds the whole set by its id, and each summary says which stage it is.
        history = (await ac.get("/api/queue/history", params={"q": group["id"], "sort": "oldest"})).json()
        assert [r["group"]["stage"] for r in history["runs"]] == ["Solids", "Tare", "Solvents"]


@pytest.mark.asyncio
async def test_a_set_is_named_by_counting_sets_not_runs():
    async with client() as ac:
        names = []
        for _ in range(2):
            made = (await ac.post("/api/queue/groups", json={"prefix": "Counted prep", "stages": [
                stage("One", step("echo_method", value="a")), stage("Two", step("echo_method", value="b")),
            ]})).json()
            names.append(made["group"]["name"])
            for run_id in made["run_ids"]:
                await finished(ac, run_id)
        assert names == ["Counted prep #1", "Counted prep #2"]
        typed = (await ac.post("/api/queue/groups", json={"prefix": "Counted prep", "name": "Plate 7", "stages": [
            stage("One", step("echo_method", value="a"))]})).json()
        assert typed["group"]["name"] == "Plate 7"
        await finished(ac, typed["run_ids"][0])


@pytest.mark.asyncio
async def test_one_stage_that_cannot_run_refuses_the_whole_set():
    async with client() as ac:
        instrument = app.state.instruments["dummy"]
        before = instrument.counter
        refused = await ac.post("/api/queue/groups", json={"prefix": "Refused", "stages": [
            stage("First", step("counting_method")),
            # Reads a value nothing before it saves: start_run refuses this for a single run too.
            stage("Second", step("echo_method", value="#never_saved")),
        ]})
        assert refused.status_code == 400
        assert refused.json()["stage"] == 1 and refused.json()["error"].startswith("Second: ")
        await asyncio.sleep(0.3)
        assert instrument.counter == before, "the first stage must not have started"
        assert (await ac.get("/api/queue/history", params={"q": "Refused"})).json()["total"] == 0


@pytest.mark.asyncio
async def test_a_stage_that_is_stopped_ends_the_stages_after_it():
    async with client() as ac:
        ids = (await ac.post("/api/queue/groups", json={"prefix": "Stops", "stages": [
            stage("Fails", step("fail_method")),
            stage("Never", step("echo_method", value="x"), step("echo_method", value="y")),
            stage("Never either", step("echo_method", value="z")),
        ]})).json()["run_ids"]
        # A bystander queued behind the set is not part of it.
        other = (await ac.post("/api/queue/runs", json={"name": "Bystander", "sequence": [step("echo_method", value="q")]})).json()["run_id"]

        assert await until(lambda: queue_manager.awaiting_decision == ids[0])
        await ac.post(f"/api/queue/runs/{ids[0]}/resolve", json={"action": "stop"})
        assert await until(lambda: queue_manager.active_run_id is None)

        assert (await run_of(ac, ids[0]))["status"] == "error"
        for run_id in ids[1:]:
            left = await run_of(ac, run_id)
            assert left["status"] == "cancelled"
            assert left["parameters"]["_issues"] == {"not_started": 1}
            assert {s["status"] for s in left["steps"]} == {"skipped"}, "its steps read as not run, not as waiting"
        # The queue is held, as after any stop; the bystander still waits for Resume.
        assert (await run_of(ac, other))["status"] == "pending"
        await ac.post("/api/queue/resume")
        assert (await finished(ac, other))["status"] == "completed"


@pytest.mark.asyncio
async def test_a_stage_that_has_not_started_can_be_changed_and_stays_in_its_set():
    async with client() as ac:
        made = (await ac.post("/api/queue/groups", json={"prefix": "Editable", "stages": [
            stage("Slow", step("test_method", duration=1)),
            stage("Later", step("echo_method", value="before")),
        ]})).json()
        slow, later = made["run_ids"]
        assert await until(lambda: queue_manager.active_run_id == slow)

        changed = await ac.put(f"/api/queue/runs/{later}", json={
            "parameters": {"type": "Simple"}, "prep": [], "cleanup": [],
            "sequence": [step("echo_method", value="after")],
        })
        assert changed.status_code == 200, changed.text
        run = await finished(ac, later)
        assert run["status"] == "completed"
        assert run["steps"][0]["outputs"]["result"] == "after"
        assert run["parameters"]["group"]["id"] == made["group"]["id"], "an edited stage is still a stage"
        assert run["name"].endswith("· Later")
