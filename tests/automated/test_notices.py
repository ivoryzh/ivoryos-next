"""A run that ends becomes a one-off notice in the queue status (`status.notices`), which the
desktop app turns into a "Run finished" notification, filtered by each person's choices.

* A completed run is "finished", with any issues named; Stop or an error is "stopped".
* A stage of a set is announced only when it is the last one, with the set's name and duration.
* Notices are kept for a while and carry their age, so a listener that reconnects still hears of
  one, and one that connects later does not announce old news.
"""

import asyncio
import time

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from ivoryos_edge.queue import duration_text, finished_notice
from ivoryos_edge.server import app, queue_manager


def test_duration_reads_like_a_person_would_say_it():
    assert duration_text(42.4) == "42 s"
    assert duration_text(12 * 60 + 5) == "12 min"
    assert duration_text(3600) == "1 h"
    assert duration_text(3600 + 5 * 60) == "1 h 5 min"


def test_a_completed_run_is_finished_and_names_its_issues():
    plain = finished_notice(7, "Screen", "completed", {"type": "Sequence"}, 754)
    assert plain == {"key": "finished:7", "kind": "finished", "status": "completed", "run_id": 7,
                     "run_name": "Screen", "title": "Run finished", "body": "Completed in 12 min",
                     "duration_s": 754}
    rough = finished_notice(8, "Screen", "completed", {"_issues": {"skipped": 2, "retried": 1}}, 90)
    assert rough["title"] == "Run finished with issues"
    assert rough["body"] == "Completed in 1 min (2 failed steps skipped, 1 retry)"
    early = finished_notice(9, None, "completed", {"_issues": {"stopped_early": 1}}, 30)
    assert early["run_name"] == "Run 9" and early["body"] == "Completed in 30 s (stopped early)"


def test_stop_and_errors_are_stopped():
    assert finished_notice(7, "Screen", "cancelled", {}, 61)["title"] == "Run stopped"
    failed = finished_notice(7, "Screen", "error", {}, 61)
    assert failed["kind"] == "stopped" and failed["title"] == "Run ended with an error"
    assert finished_notice(7, "Screen", "running", {}, 1) is None


def test_a_set_is_announced_once_by_its_last_stage():
    stage = lambda index: {"group": {"id": "g1", "name": "Plate #3", "index": index, "total": 3, "stage": "Solids"}}
    assert finished_notice(1, "Plate #3 · Solids", "completed", stage(1), 60) is None
    assert finished_notice(2, "Plate #3 · Solvent", "completed", stage(2), 60) is None
    last = finished_notice(3, "Plate #3 · Read", "completed", stage(3), 60, set_duration_s=4000)
    assert last["run_name"] == "Plate #3" and last["title"] == "Stages finished"
    assert last["body"] == "All 3 stages completed in 1 h 6 min" and last["duration_s"] == 4000
    # A stage stopped early on is the end of the set: said once, and what it means.
    stopped = finished_notice(1, "Plate #3 · Solids", "cancelled", stage(1), 60)
    assert stopped["kind"] == "stopped" and "stages after it will not run" in stopped["body"]


async def until(check, tries=120, every=0.05):
    for _ in range(tries):
        if check():
            return True
        await asyncio.sleep(every)
    return False


@pytest.mark.asyncio
async def test_a_run_that_ends_is_in_the_queue_status_with_its_age():
    queue_manager.resume()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/queue/runs", json={
            "name": "Noticed", "parameters": {"type": "Sequence"}, "prep": [], "cleanup": [],
            "sequence": [{"instrument": "dummy", "method": "echo_method", "params": {"value": "hi"}}],
        })
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["run_id"]
        key = f"finished:{run_id}"
        assert await until(lambda: any(n["key"] == key for n in queue_manager.recent_notices()))
    notice = next(n for n in queue_manager.recent_notices() if n["key"] == key)
    assert notice["kind"] == "finished" and notice["run_name"] == "Noticed"
    assert 0 <= notice["age_s"] < 60 and "_t" not in notice
    # Old news is dropped from the status rather than sent forever.
    for n in queue_manager.notices:
        n["_t"] -= queue_manager.NOTICE_KEEP_S
    assert queue_manager.recent_notices() == []


def test_the_queue_socket_carries_the_notices():
    """What the desktop app reads (desktop/src/attention.js): `status.notices` on /api/ws/queue."""
    queue_manager.notices = [{**finished_notice(41, "Socket run", "completed", {}, 400), "_t": time.monotonic()}]
    with TestClient(app).websocket_connect("/api/ws/queue") as ws:
        status = ws.receive_json()["status"]
    assert [n["key"] for n in status["notices"]] == ["finished:41"]
    assert status["notices"][0]["age_s"] >= 0
