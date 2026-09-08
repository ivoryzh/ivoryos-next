import pytest
import asyncio
from httpx import AsyncClient, ASGITransport
from ivoryos_edge.server import app
from ivoryos_edge.queue import interpolate_message


async def _poll_run(ac, run_id, want_statuses, timeout_s=3.0):
    status = None
    steps = []
    elapsed = 0.0
    while elapsed < timeout_s:
        resp = await ac.get("/api/queue/runs")
        assert resp.status_code == 200
        runs = resp.json()["runs"]
        run = next((r for r in runs if r["id"] == run_id), None)
        if run:
            status = run["status"]
            steps = run["steps"]
            if status in want_statuses:
                return status, steps
        await asyncio.sleep(0.05)
        elapsed += 0.05
    return status, steps


@pytest.mark.asyncio
async def test_user_input_pauses_and_resumes_with_value():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Test User Input",
            "sequence": [
                {"instrument": "Flow_Control", "method": "User_Input",
                 "params": {"prompt": "Enter a duration", "variable_name": "wait_time"}},
                {"instrument": "dummy", "method": "test_method", "params": {"duration": "#wait_time"}},
            ],
        }

        response = await ac.post("/api/queue/runs", json=payload)
        assert response.status_code == 200, response.text
        run_id = response.json()["run_id"]

        # The run should pause on the User_Input step and expose the prompt.
        status, steps = await _poll_run(ac, run_id, {"waiting_input"})
        assert status == "waiting_input", f"Expected 'waiting_input', got {status}"
        waiting_step = next(s for s in steps if s["status"] == "waiting_input")
        assert waiting_step["outputs"]["prompt"] == "Enter a duration"

        # Submitting the value should let the run resume and finish, with the
        # value substituted into the following step's '#wait_time' parameter.
        input_resp = await ac.post(f"/api/queue/runs/{run_id}/input", json={"value": 0})
        assert input_resp.status_code == 200, input_resp.text

        status, steps = await _poll_run(ac, run_id, {"completed", "error", "cancelled"})
        assert status == "completed", f"Expected 'completed', got {status}; steps={steps}"


@pytest.mark.asyncio
async def test_comment_step_logs_and_completes_immediately():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Test Comment",
            "sequence": [
                {"instrument": "Flow_Control", "method": "Comment", "params": {"message": "checkpoint reached"}},
            ],
        }

        response = await ac.post("/api/queue/runs", json=payload)
        assert response.status_code == 200, response.text
        run_id = response.json()["run_id"]

        status, steps = await _poll_run(ac, run_id, {"completed", "error", "cancelled"})
        assert status == "completed", f"Expected 'completed', got {status}"
        assert steps[0]["outputs"]["message"] == "checkpoint reached"


def test_interpolate_message_substitutes_embedded_vars():
    context = {"flow_rate": 5.32, "sample_id": "S-042"}
    assert interpolate_message("The flow rate is #flow_rate today", context) == "The flow rate is 5.32 today"
    assert interpolate_message("#sample_id: #flow_rate mL/min", context) == "S-042: 5.32 mL/min"
    # A '#name' with no matching variable is left as literal text rather than raising.
    assert interpolate_message("Unrelated #nope here", context) == "Unrelated #nope here"
    # No '#' at all is a no-op.
    assert interpolate_message("Just a plain message", context) == "Just a plain message"


@pytest.mark.asyncio
async def test_comment_interpolates_embedded_variable_from_user_input():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Test Comment Interpolation",
            "sequence": [
                {"instrument": "Flow_Control", "method": "User_Input",
                 "params": {"prompt": "Enter flow rate", "variable_name": "flow_rate"}},
                {"instrument": "Flow_Control", "method": "Comment",
                 "params": {"message": "The flow rate is #flow_rate mL/min"}},
            ],
        }

        response = await ac.post("/api/queue/runs", json=payload)
        run_id = response.json()["run_id"]

        await _poll_run(ac, run_id, {"waiting_input"})
        await ac.post(f"/api/queue/runs/{run_id}/input", json={"value": "5.32"})

        status, steps = await _poll_run(ac, run_id, {"completed", "error", "cancelled"})
        assert status == "completed", f"Expected 'completed', got {status}; steps={steps}"
        comment_step = next(s for s in steps if s["method"] == "Comment")
        assert comment_step["outputs"]["message"] == "The flow rate is 5.32 mL/min"
