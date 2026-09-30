"""Deciding from Cloud about a Cloud-dispatched run that has stopped for a person.

A run on the edge stops for a person in two ways: a User_Input step asks a question, or a step
fails and the queue waits for retry / skip / stop. The bench has always had both prompts; a run
started from Cloud used to stop just the same, while Cloud showed only an amber progress bar with
no way to answer. These pin the round trip:

  * the progress sent to Cloud says what the run stopped for (the prompt and its type, or the
    error) and names that stop with a `pause` id;
  * a decision sent back on `task-control` is applied only while that pause is current, so a
    re-sent or late decision can never land on a later question or error;
  * stopping from Cloud ends the run without leaving the queue paused behind it -- a device
    paused with nobody at the bench to resume it would hold every later Cloud task forever.
"""

import asyncio

import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge import server
from ivoryos_edge import queue as queue_module
from ivoryos_edge.server import app

from test_cloud_dispatch import RecordingBroker, latest_run


async def wait_for_run(ac, run_id, timeout_s=5.0):
    """Until the run has ended. Not just a terminal-looking status: a run stopped on an error
    already reads 'error' while it waits for someone to decide, and only has an end_time after."""
    deadline = asyncio.get_event_loop().time() + timeout_s
    run = None
    while asyncio.get_event_loop().time() < deadline:
        run = (await ac.get(f"/api/queue/runs/{run_id}")).json()
        if run.get("end_time") and run["status"] in ("completed", "error", "cancelled"):
            return run
        await asyncio.sleep(0.05)
    return run


@pytest.fixture
def broker(monkeypatch):
    b = RecordingBroker()
    monkeypatch.setattr(server, "global_broker", b)
    monkeypatch.setattr(server, "global_topic_prefix", "ivoryos/edge")
    monkeypatch.setattr(queue_module, "PROGRESS_MIN_INTERVAL_S", 0.0)
    return b


async def wait_for_pause(broker, node_id, kind, timeout_s=5.0):
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        paused = [p for p in broker.progress_for(node_id) if str(p.get("pause", "")).startswith(f"{kind}:")]
        if paused:
            return paused[-1]
        await asyncio.sleep(0.05)
    raise AssertionError(f"{node_id} never reported a {kind} pause: {broker.progress_for(node_id)}")


def control(run_id, node_id, pause, action, value=None):
    return server.handle_broker_message(
        "ivoryos/edge/test-device/task-control",
        {"runId": run_id, "nodeId": node_id, "pause": pause, "action": action, "value": value},
    )


async def dispatch(run_id, node_id, name, sequence):
    await server.handle_cloud_task({"runId": run_id, "nodeId": node_id, "run": {"name": name, "sequence": sequence}})


ASK = {"instrument": "Flow_Control", "method": "User_Input",
       "params": {"variable_name": "amount", "prompt": "How many vials?", "input_type": "int"}}


@pytest.mark.asyncio
async def test_a_question_reaches_cloud_and_its_answer_comes_back(broker):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await dispatch("c_in", "n_in", "Cloud Question", [
            ASK, {"instrument": "dummy", "method": "echo_method", "params": {"value": "#amount"}},
        ])
        paused = await wait_for_pause(broker, "n_in", "input")
        assert paused["prompt"] == "How many vials?"
        assert paused["input_type"] == "int"
        assert paused["state"] == "waiting_input"

        # A decision about some other stop is dropped, and the current state is sent again.
        before = len(broker.progress_for("n_in"))
        await control("c_in", "n_in", "input:0:stale", "input", "9")
        assert len(broker.progress_for("n_in")) > before
        await control("c_other", "n_in", paused["pause"], "input", "9")

        await control("c_in", "n_in", paused["pause"], "input", "5")
        run = await latest_run(ac, "Cloud Question")
        finished = await wait_for_run(ac, run["id"])
        assert finished["status"] == "completed", finished
        detail = (await ac.get(f"/api/queue/runs/{run['id']}")).json()
        # Cast to the step's declared type, exactly as an answer typed at the bench is, and bound
        # for the step after it.
        assert detail["steps"][0]["outputs"]["result"] == 5
        assert detail["steps"][1]["outputs"]["result"] == "5"

    # A reported pause goes at QoS 1: until someone answers, nothing later replaces it.
    assert broker.statuses_for("n_in") == ["running", "completed"]


@pytest.mark.asyncio
async def test_a_failed_step_can_be_skipped_from_cloud(broker):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await dispatch("c_err", "n_err", "Cloud Failure", [
            {"instrument": "dummy", "method": "fail_method", "params": {}},
            {"instrument": "dummy", "method": "echo_method", "params": {"value": "after"}},
        ])
        paused = await wait_for_pause(broker, "n_err", "error")
        assert paused["error"] == "This is a simulated failure", "the message, not the traceback"

        # An input answer is not a decision about an error.
        await control("c_err", "n_err", paused["pause"], "input", "x")
        await asyncio.sleep(0.3)
        assert server.queue_manager.error_action is None

        await control("c_err", "n_err", paused["pause"], "skip")
        run = await latest_run(ac, "Cloud Failure")
        finished = await wait_for_run(ac, run["id"])
        assert finished["status"] == "completed", finished
        detail = (await ac.get(f"/api/queue/runs/{run['id']}")).json()
        assert [s["status"] for s in detail["steps"]] == ["skipped", "completed"]


@pytest.mark.asyncio
async def test_stopping_on_an_error_from_cloud_leaves_the_queue_running(broker):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await dispatch("c_stop", "n_stop", "Cloud Stop", [
            {"instrument": "dummy", "method": "fail_method", "params": {}},
            {"instrument": "dummy", "method": "echo_method", "params": {"value": "never"}},
        ])
        paused = await wait_for_pause(broker, "n_stop", "error")
        await control("c_stop", "n_stop", paused["pause"], "stop")
        run = await latest_run(ac, "Cloud Stop")
        finished = await wait_for_run(ac, run["id"])
        assert finished["status"] == "error", finished
        assert broker.statuses_for("n_stop")[-1] == "error"

        # The next Cloud task runs: the stop did not leave the queue paused behind it.
        await dispatch("c_next", "n_next", "Cloud After Stop", [
            {"instrument": "dummy", "method": "echo_method", "params": {"value": "ok"}},
        ])
        nxt = await latest_run(ac, "Cloud After Stop")
        assert (await wait_for_run(ac, nxt["id"]))["status"] == "completed"
        assert server.queue_manager.paused is False


@pytest.mark.asyncio
async def test_stopping_instead_of_answering_cancels_the_run(broker):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await dispatch("c_cx", "n_cx", "Cloud Cancel", [
            ASK, {"instrument": "dummy", "method": "echo_method", "params": {"value": "#amount"}},
        ])
        paused = await wait_for_pause(broker, "n_cx", "input")
        await control("c_cx", "n_cx", paused["pause"], "stop")
        run = await latest_run(ac, "Cloud Cancel")
        finished = await wait_for_run(ac, run["id"])
        assert finished["status"] == "cancelled", finished
        assert broker.statuses_for("n_cx")[-1] == "cancelled"


@pytest.mark.asyncio
async def test_retries_and_skips_are_recorded_not_forgotten(broker, monkeypatch):
    """A run that only finished because someone retried or skipped a failure says so.

    Retrying used to clear the step's error and skipping left a plain "completed" run behind, so a
    step that failed three times read exactly like one that never failed.
    """
    calls = {"n": 0}
    dummy = app.state.instruments["dummy"]

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError(f"jammed ({calls['n']})")
        return "ok"

    monkeypatch.setattr(dummy, "flaky_method", flaky, raising=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await dispatch("c_rec", "n_rec", "Cloud Recovered", [
            {"instrument": "dummy", "method": "flaky_method", "params": {}},
            {"instrument": "dummy", "method": "fail_method", "params": {}},
            {"instrument": "dummy", "method": "echo_method", "params": {"value": "end"}},
        ])
        seen = set()
        # Two failures of the flaky step are retried; the step that always fails is skipped.
        for action in ("retry", "retry", "skip"):
            deadline = asyncio.get_event_loop().time() + 5
            while True:
                pauses = [p for p in broker.progress_for("n_rec")
                          if str(p.get("pause", "")).startswith("error:") and p["pause"] not in seen]
                if pauses:
                    break
                assert asyncio.get_event_loop().time() < deadline, broker.progress_for("n_rec")
                await asyncio.sleep(0.05)
            seen.add(pauses[-1]["pause"])
            await control("c_rec", "n_rec", pauses[-1]["pause"], action)

        run = await latest_run(ac, "Cloud Recovered")
        finished = await wait_for_run(ac, run["id"])
        assert finished["status"] == "completed", finished
        assert finished["parameters"]["_issues"] == {"retried": 2, "skipped": 1}

        steps = finished["steps"]
        flaky_step, failing_step = steps[0], steps[1]
        assert flaky_step["status"] == "completed"
        assert flaky_step["outputs"]["result"] == "ok"
        assert [(a["error"], a["resolution"]) for a in flaky_step["outputs"]["attempts"]] == [
            ("jammed (1)", "retry"), ("jammed (2)", "retry"),
        ]
        assert failing_step["status"] == "skipped"
        assert [a["resolution"] for a in failing_step["outputs"]["attempts"]] == ["skip"]

        # The history list shows it, and so does what Cloud is told.
        page = (await ac.get("/api/queue/history", params={"q": "Cloud Recovered"})).json()
        assert page["runs"][0]["issues"] == {"retried": 2, "skipped": 1}
    final = [p for t, p in broker.published if t.endswith("/task-status") and p.get("nodeId") == "n_rec" and "progress" not in p]
    assert final[-1]["status"] == "completed" and final[-1]["issues"] == {"retried": 2, "skipped": 1}


@pytest.mark.asyncio
async def test_a_clean_run_carries_no_issues(broker):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await dispatch("c_ok", "n_ok", "Cloud Clean", [
            {"instrument": "dummy", "method": "echo_method", "params": {"value": "x"}},
        ])
        run = await latest_run(ac, "Cloud Clean")
        finished = await wait_for_run(ac, run["id"])
        assert finished["status"] == "completed"
        assert "_issues" not in finished["parameters"]
        assert "attempts" not in finished["steps"][0]["outputs"]
