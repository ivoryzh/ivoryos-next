"""The Cloud -> Edge dispatch contract.

Cloud publishes to `{prefix}/{device}/execute` and the edge turns that into a run. Until now that
topic could only carry one bare block, which meant a spreadsheet or optimization campaign authored
in Cloud had no way to reach a device at all. These tests pin the two things that makes possible:

  * the full-run shape (`run`) starts exactly the run `POST /api/queue/runs` would have, so the
    two doors into the edge cannot come to mean different things;
  * the original single-block shape still works, because a plain instrument step still dispatches
    that way and an older Cloud deployment must not break against a newer edge.

They also pin the failure report: a task the edge refuses has to say so on `task-status`, or Cloud
leaves it 'queued' forever with nothing distinguishing a rejected dispatch from a slow one.
"""

import asyncio

import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge import server
from ivoryos_edge.server import app


async def wait_for_run(ac, run_id, timeout_s=5.0):
    """Poll until the run reaches a terminal status; returns the run's last-seen state."""
    deadline = asyncio.get_event_loop().time() + timeout_s
    run = None
    while asyncio.get_event_loop().time() < deadline:
        resp = await ac.get("/api/queue/runs")
        runs = resp.json()["runs"]
        run = next((r for r in runs if r["id"] == run_id), None)
        if run and run["status"] in ("completed", "error", "cancelled"):
            return run
        await asyncio.sleep(0.05)
    return run


async def latest_run(ac, name_contains):
    resp = await ac.get("/api/queue/runs")
    matching = [r for r in resp.json()["runs"] if name_contains in r["name"]]
    assert matching, f"no run whose name contains {name_contains!r}"
    return max(matching, key=lambda r: r["id"])


class RecordingBroker:
    """Stands in for the MQTT client so a test can read what the edge reported back."""

    client_id = "test-device"

    def __init__(self):
        self.published = []

    def publish(self, topic, payload, retain=False, qos=0):
        self.published.append((topic, payload))

    def statuses_for(self, node_id):
        """Status *changes* only; progress updates (which also say "running") are progress_for."""
        return [
            p["status"]
            for topic, p in self.published
            if topic.endswith("/task-status") and p.get("nodeId") == node_id and "progress" not in p
        ]

    def progress_for(self, node_id):
        return [
            p["progress"]
            for topic, p in self.published
            if topic.endswith("/task-status") and p.get("nodeId") == node_id and "progress" in p
        ]


@pytest.fixture
def recording_broker(monkeypatch):
    broker = RecordingBroker()
    monkeypatch.setattr(server, "global_broker", broker)
    monkeypatch.setattr(server, "global_topic_prefix", "ivoryos/edge")
    return broker


@pytest.mark.asyncio
async def test_cloud_task_accepts_a_whole_run(recording_broker):
    """The `run` shape carries parameters and prep/cleanup, not just one step."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await server.handle_cloud_task({
            "runId": "cloud_run_1",
            "nodeId": "node_a",
            "run": {
                "name": "Cloud Spreadsheet",
                "parameters": {
                    "type": "Spreadsheet",
                    "variables": ["value"],
                    "rows": [{"value": "first"}, {"value": "second"}],
                },
                "prep": [{"instrument": "dummy", "method": "test_method", "params": {"duration": 0}}],
                "sequence": [
                    {"instrument": "dummy", "method": "echo_method", "params": {"value": "first"}},
                    {"instrument": "dummy", "method": "echo_method", "params": {"value": "second"}},
                ],
                "cleanup": [{"instrument": "dummy", "method": "test_method", "params": {"duration": 0}}],
            },
        })

        run = await latest_run(ac, "Cloud Spreadsheet")
        finished = await wait_for_run(ac, run["id"])
        assert finished["status"] == "completed", finished

        # Prep + both rows + cleanup, flattened into one sequence exactly as the HTTP route does.
        detail = (await ac.get(f"/api/queue/runs/{run['id']}")).json()
        assert len(detail["steps"]) == 4
        assert [s["method"] for s in detail["steps"]] == [
            "test_method", "echo_method", "echo_method", "test_method",
        ]

        # The run's own parameters survive the trip, and carry the correlation ids back.
        assert finished["parameters"]["type"] == "Spreadsheet"
        assert finished["parameters"]["variables"] == ["value"]
        assert finished["parameters"]["cloud_run_id"] == "cloud_run_1"
        assert finished["parameters"]["cloud_node_id"] == "node_a"

        assert recording_broker.statuses_for("node_a") == ["running", "completed"]


@pytest.mark.asyncio
async def test_cloud_task_still_accepts_a_bare_block(recording_broker):
    """The pre-existing single-block shape keeps working unchanged."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await server.handle_cloud_task({
            "runId": "cloud_run_2",
            "nodeId": "node_b",
            "block": {"instrument": "dummy", "method": "echo_method", "params": {"value": "solo"}},
        })

        # Named after what it runs, never after Cloud's internal ids.
        run = await latest_run(ac, "dummy.echo_method (from Cloud)")
        assert "node_b" not in run["name"] and "cloud_run_2" not in run["name"]
        finished = await wait_for_run(ac, run["id"])
        assert finished["status"] == "completed", finished

        detail = (await ac.get(f"/api/queue/runs/{run['id']}")).json()
        assert [s["method"] for s in detail["steps"]] == ["echo_method"]
        assert recording_broker.statuses_for("node_b") == ["running", "completed"]


@pytest.mark.asyncio
async def test_bare_block_uses_the_name_cloud_sends(recording_broker):
    """Cloud's daemon now names a single step after the run it belongs to."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await server.handle_cloud_task({
            "runId": "cloud_run_named", "nodeId": "node_n",
            "name": "Morning screen · dummy.echo_method",
            "block": {"instrument": "dummy", "method": "echo_method", "params": {"value": "x"}},
        })
        run = await latest_run(ac, "Morning screen · dummy.echo_method")
        assert (await wait_for_run(ac, run["id"]))["status"] == "completed"


@pytest.mark.asyncio
async def test_refused_cloud_task_reports_an_error_back(recording_broker, api_workflows_dir):
    """A node referencing a workflow this device does not have must not hang Cloud's run.

    Before this, the edge printed the refusal and returned: Cloud's task stayed 'queued'
    indefinitely, indistinguishable from a device that was simply slow.
    """
    await server.handle_cloud_task({
        "runId": "cloud_run_3",
        "nodeId": "node_c",
        "run": {
            "name": "Missing Link",
            "sequence": [{"instrument": "Library Workflows", "method": "no_such_workflow", "params": {}}],
        },
    })

    assert recording_broker.statuses_for("node_c") == ["error"]
    errored = next(
        p for topic, p in recording_broker.published
        if topic.endswith("/task-status") and p.get("nodeId") == "node_c"
    )
    assert "no_such_workflow" in errored["error"]


@pytest.mark.asyncio
async def test_cloud_task_without_ids_is_ignored(recording_broker):
    """No correlation ids means nothing could be reported back, so nothing is started either."""
    await server.handle_cloud_task({"block": {"instrument": "dummy", "method": "echo_method"}})
    assert recording_broker.published == []


# --- The record a spreadsheet run leaves behind -------------------------------------------------
# A run that executes perfectly but records the wrong thing is worse than one that fails: every
# step reads "completed" while the data history attributes one sample's measurements to another.
# Both defects pinned below shipped and were found by looking at a real run's history.

def _workflow_body(script):
    return {"description": "", "prep": [], "script": script, "cleanup": []}


def _lib_step(name, args, row, block=0):
    """A Library Workflows reference as Cloud dispatches one: one per spreadsheet row."""
    return {
        "instrument": "Library Workflows",
        "method": name,
        "params": {**args, "_row": row, "_block": block},
    }


@pytest.mark.asyncio
async def test_spreadsheet_template_describes_the_expanded_row(recording_broker, api_workflows_dir):
    """`sequence_template` must describe what a row actually runs, not what was authored.

    Cloud sends ONE `Library Workflows` block per row; the device expands each into the whole
    body. A template built by the submitter therefore claimed one step per row, and Data History —
    which slices the flat step list into chunks of that length — showed a single step per row and
    silently dropped the rest. Observed on a real 2-row run: 30 steps executed, 2 displayed.
    """
    from ivoryos_edge import workflows as wf

    wf.save_version(api_workflows_dir, "two step", _workflow_body([
        {"instrument": "dummy", "action": "echo_method", "args": {"value": "#label"}, "return": ""},
        {"instrument": "dummy", "action": "counting_method", "args": {}, "return": "count"},
    ]))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await server.handle_cloud_task({
            "runId": "cloud_run_tmpl", "nodeId": "node_t",
            "run": {
                "name": "Two row screen",
                "parameters": {
                    "type": "Spreadsheet",
                    "variables": ["label"],
                    "rows": [{"label": "a"}, {"label": "b"}],
                    # What the submitter could see: one block, because a link is one block there.
                    "sequence_template": [
                        {"instrument": "Library Workflows", "method": "two step",
                         "returnVar": None, "returnBindings": None},
                    ],
                },
                "sequence": [_lib_step("two step", {"label": "a"}, 0),
                             _lib_step("two step", {"label": "b"}, 1)],
            },
        })

        run = await latest_run(ac, "Two row screen")
        finished = await wait_for_run(ac, run["id"])
        assert finished["status"] == "completed", finished

        template = finished["parameters"]["sequence_template"]
        assert [t["method"] for t in template] == ["echo_method", "counting_method"], template
        # The named output only becomes a Data History column because the template now reaches it.
        assert any(t["returnVar"] == "count" for t in template)

        detail = (await ac.get(f"/api/queue/runs/{run['id']}")).json()
        assert len(detail["steps"]) == 4, "two rows x two steps"


@pytest.mark.asyncio
async def test_row_identity_survives_link_expansion(recording_broker, api_workflows_dir):
    """Every step a link expands into must say which spreadsheet row it belongs to.

    Position cannot answer this: within a batch group the flattening is block-major, and a link
    expands into however many steps its body holds. Without `_row` on each expanded step there is
    nothing to group a row's steps by.
    """
    from ivoryos_edge import workflows as wf

    wf.save_version(api_workflows_dir, "pair", _workflow_body([
        {"instrument": "dummy", "action": "echo_method", "args": {"value": "#label"}, "return": ""},
        {"instrument": "dummy", "action": "echo_method", "args": {"value": "tail"}, "return": ""},
    ]))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await server.handle_cloud_task({
            "runId": "cloud_run_rows", "nodeId": "node_r",
            "run": {
                "name": "Row tagging",
                "parameters": {"type": "Spreadsheet", "variables": ["label"],
                               "rows": [{"label": "first"}, {"label": "second"}]},
                "sequence": [_lib_step("pair", {"label": "first"}, 0),
                             _lib_step("pair", {"label": "second"}, 1)],
            },
        })

        run = await latest_run(ac, "Row tagging")
        assert (await wait_for_run(ac, run["id"]))["status"] == "completed"

        steps = (await ac.get(f"/api/queue/runs/{run['id']}")).json()["steps"]
        by_row = {}
        for s in steps:
            by_row.setdefault(s["parameters"].get("_row"), []).append(s)

        assert set(by_row) == {0, 1}, "every expanded step carries its row"
        assert len(by_row[0]) == 2 and len(by_row[1]) == 2
        # Each row's steps carry that row's value — the thing mis-slicing got wrong.
        assert by_row[0][0]["parameters"]["value"] == "first"
        assert by_row[1][0]["parameters"]["value"] == "second"


@pytest.mark.asyncio
async def test_iterated_link_runs_setup_and_teardown_once(recording_broker, api_workflows_dir):
    """Prep once, the body once per row, cleanup once -- and the record says so.

    Cloud used to send one whole-workflow link per row, so a two-row screen tared the balance and
    cooled the reactor down twice each. It now sends the link three times narrowed by `phases`
    (see `phaseLink` in cloud_frontend/src/lib/runPayload.ts); prep and cleanup carry no `_row`,
    so Data History files them under their phase instead of under sample 1.
    """
    from ivoryos_edge import workflows as wf

    wf.save_version(api_workflows_dir, "phased", {
        "description": "",
        "prep": [{"instrument": "dummy", "action": "echo_method", "args": {"value": "setup"}, "return": ""}],
        "script": [{"instrument": "dummy", "action": "echo_method", "args": {"value": "#label"}, "return": ""}],
        "cleanup": [{"instrument": "dummy", "action": "echo_method", "args": {"value": "teardown"}, "return": ""}],
    })

    def narrowed(phase, args, **extra):
        return {"instrument": "Library Workflows", "method": "phased",
                "params": args, "phases": [phase], **extra}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await server.handle_cloud_task({
            "runId": "cloud_run_phases", "nodeId": "node_p",
            "run": {
                "name": "Phased screen",
                "parameters": {"type": "Spreadsheet", "variables": ["label"],
                               "rows": [{"label": "a"}, {"label": "b"}]},
                "prep": [narrowed("prep", {"label": "a"})],
                "sequence": [narrowed("script", {"label": "a", "_row": 0, "_block": 0}),
                             narrowed("script", {"label": "b", "_row": 1, "_block": 0})],
                "cleanup": [narrowed("cleanup", {"label": "a"})],
            },
        })

        run = await latest_run(ac, "Phased screen")
        finished = await wait_for_run(ac, run["id"])
        assert finished["status"] == "completed", finished

        steps = (await ac.get(f"/api/queue/runs/{run['id']}")).json()["steps"]
        record = [(s["parameters"].get("_phase"), s["parameters"].get("_row"),
                   s["parameters"]["value"]) for s in steps]
        assert record == [
            ("prep", None, "setup"),
            ("main", 0, "a"),
            ("main", 1, "b"),
            ("cleanup", None, "teardown"),
        ], record
        # Only the body is a row's template, so the export's columns come from it alone.
        assert [t["method"] for t in finished["parameters"]["sequence_template"]] == ["echo_method"]


@pytest.mark.asyncio
async def test_template_untouched_when_steps_carry_no_row(recording_broker):
    """A payload from before `_row` existed keeps the template it sent."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        sent = [{"instrument": "dummy", "method": "echo_method", "returnVar": "out",
                 "returnBindings": None}]
        await server.handle_cloud_task({
            "runId": "cloud_run_legacy", "nodeId": "node_l",
            "run": {
                "name": "Legacy shape",
                "parameters": {"type": "Spreadsheet", "variables": ["v"], "rows": [{"v": "1"}],
                               "sequence_template": sent},
                "sequence": [{"instrument": "dummy", "method": "echo_method", "params": {"value": "1"}}],
            },
        })

        run = await latest_run(ac, "Legacy shape")
        finished = await wait_for_run(ac, run["id"])
        assert finished["parameters"]["sequence_template"] == sent



@pytest.mark.asyncio
async def test_heartbeat_says_whether_the_device_is_busy(recording_broker, monkeypatch):
    """Cloud holds a ready task until the device is free, and only the device knows about runs
    started at the bench -- so the heartbeat carries it, and it reflects the queue."""
    monkeypatch.setattr(server, "global_client_id", "test-device")

    async def busy():
        return True

    monkeypatch.setattr(server, "device_busy", busy)
    await server.publish_status()
    topic, payload = recording_broker.published[-1]
    assert topic == "ivoryos/edge/test-device/status"
    assert payload["online"] is True and payload["busy"] is True and "ts" in payload


def test_progress_summary_is_small_and_says_where_the_run_is():
    from ivoryos_edge.queue import run_progress_summary
    import json

    def step(i, status, row=None, phase="main", method="echo_method"):
        params = {"_phase": phase, **({"_row": row} if row is not None else {})}
        return {"id": i, "sequence_index": i, "instrument": "dummy", "method": method,
                "parameters": params, "status": status}

    run = {
        "status": "running",
        "parameters": {"type": "Spreadsheet", "cloud_run_id": "c"},
        "steps": [
            step(0, "completed", phase="prep"),
            step(1, "completed", row=0), step(2, "completed", row=0),
            step(3, "running", row=1), step(4, "pending", row=1),
            step(5, "pending", phase="cleanup"),
        ],
    }
    summary = run_progress_summary(run)
    assert summary == {
        "done": 3, "total": 6, "state": "running", "phase": "main",
        "step": "dummy.echo_method", "row": 2, "rows_total": 2, "rows_done": 1,
    }
    assert len(json.dumps(summary)) < 300, "one AWS IoT 5KB unit carries it many times over"

    optimization = {
        "status": "running",
        "parameters": {"type": "Optimization", "budget": 5, "sequence_template": [{}, {}]},
        "steps": [step(0, "completed"), step(1, "completed"), step(2, "running")],
    }
    summary = run_progress_summary(optimization)
    assert (summary["iteration"], summary["budget"], summary["total"]) == (2, 5, 10)


@pytest.mark.asyncio
async def test_cloud_run_reports_progress_while_it_runs(recording_broker, monkeypatch):
    """Progress goes out during the run, throttled, and never after the final status."""
    from ivoryos_edge import queue as queue_module
    monkeypatch.setattr(queue_module, "PROGRESS_MIN_INTERVAL_S", 0.0)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await server.handle_cloud_task({
            "runId": "cloud_run_progress",
            "nodeId": "node_p",
            "run": {
                "name": "Cloud Progress",
                "parameters": {"type": "Spreadsheet", "variables": ["value"], "rows": [{"value": "a"}, {"value": "b"}]},
                "sequence": [
                    {"instrument": "dummy", "method": "echo_method", "params": {"value": "a", "_row": 0}},
                    {"instrument": "dummy", "method": "echo_method", "params": {"value": "b", "_row": 1}},
                ],
            },
        })
        run = await latest_run(ac, "Cloud Progress")
        finished = await wait_for_run(ac, run["id"])
        assert finished["status"] == "completed", finished

    progress = recording_broker.progress_for("node_p")
    assert progress, "no progress was reported"
    assert all(p["total"] == 2 for p in progress)
    assert [p["done"] for p in progress] == sorted(p["done"] for p in progress), "never goes backwards"
    assert recording_broker.statuses_for("node_p") == ["running", "completed"]
    # Nothing after the final status.
    task_msgs = [p for t, p in recording_broker.published if t.endswith("/task-status") and p.get("nodeId") == "node_p"]
    assert task_msgs[-1].get("status") == "completed" and "progress" not in task_msgs[-1]


@pytest.mark.asyncio
async def test_progress_is_throttled_with_a_trailing_send(recording_broker, monkeypatch):
    """Changes inside the interval collapse into one later send, so the latest state still arrives."""
    from ivoryos_edge import queue as queue_module
    monkeypatch.setattr(queue_module, "PROGRESS_MIN_INTERVAL_S", 0.3)
    qm = server.queue_manager
    state = {"done": 0}

    async def fake_status(run_id):
        return {"id": run_id, "status": "running", "end_time": None,
                "parameters": {"cloud_run_id": "c9", "cloud_node_id": "n9"},
                "steps": [{"id": i, "sequence_index": i, "instrument": "d", "method": "m",
                           "parameters": {}, "status": "completed" if i < state["done"] else "pending"}
                          for i in range(5)]}

    monkeypatch.setattr(qm, "get_run_status", fake_status)
    for done in range(1, 5):
        state["done"] = done
        await qm.report_cloud_progress(99001)
    assert [p["done"] for p in recording_broker.progress_for("n9")] == [1], "the rest wait out the interval"
    await asyncio.sleep(0.45)
    assert [p["done"] for p in recording_broker.progress_for("n9")] == [1, 4], "the trailing send carries the latest"


@pytest.mark.asyncio
async def test_finished_cloud_run_sends_its_record_before_the_final_status(recording_broker):
    """Cloud keeps a copy of what a task it dispatched produced, in the shape Data History reads,
    and has it by the time the task reads 'completed'."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await server.handle_cloud_task({
            "runId": "cloud_run_result",
            "nodeId": "node_r",
            "run": {
                "name": "Cloud Result",
                "parameters": {"type": "Spreadsheet", "variables": ["value"], "rows": [{"value": "x"}]},
                "sequence": [{"instrument": "dummy", "method": "echo_method",
                              "params": {"value": "x", "_row": 0}, "returnVar": "echoed"}],
            },
        })
        run = await latest_run(ac, "Cloud Result")
        assert (await wait_for_run(ac, run["id"]))["status"] == "completed"

    messages = [(t.rsplit("/", 1)[-1], p) for t, p in recording_broker.published if p.get("nodeId") == "node_r"]
    kinds = [k if k != "task-status" or "progress" in p else p["status"] for k, p in messages]
    kinds = [k for k in kinds if k != "task-status"]  # drop progress updates
    assert kinds[-2:] == ["task-result", "completed"], kinds

    record = next(p["result"] for k, p in messages if k == "task-result")
    assert record["edgeRunId"] == run["id"] and record["status"] == "completed"
    assert "cloud_run_id" not in record["parameters"], "Cloud's own ids are not echoed back"
    step = record["steps"][0]
    assert step["outputs"] == {"result": "x"}
    assert step["parameters"]["_return_var"] == "echoed", "enough to name the output column"


def test_an_oversized_result_degrades_instead_of_failing():
    from ivoryos_edge import queue as queue_module
    big = "y" * 2000
    run = {"id": 1, "name": "big", "status": "completed", "parameters": {},
           "steps": [{"id": i, "instrument": "d", "method": "m", "parameters": {}, "outputs": {"result": big},
                      "status": "completed", "error": None} for i in range(80)]}
    record = queue_module.build_cloud_result(run)
    assert record.get("truncated") is True and record["steps"] == []
    small = queue_module.build_cloud_result({**run, "steps": run["steps"][:3]})
    assert "truncated" not in small and len(small["steps"]) == 3


@pytest.mark.asyncio
async def test_cloud_queue_summary_reaches_the_queue_page():
    """What Cloud holds for this device is shown, not acted on."""
    summary = {"waiting": 2, "ready": 1, "items": [{"label": "Screen · Suzuki", "status": "ready"}], "nextSchedule": None}
    try:
        await server.handle_broker_message("ivoryos/edge/test-device/cloud-queue", summary)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            status = (await ac.get("/api/status")).json()
        assert status["cloud_queue"] == summary
    finally:
        server.queue_manager.cloud_queue = None
