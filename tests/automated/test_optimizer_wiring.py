import pytest
import asyncio
from httpx import AsyncClient, ASGITransport
from ivoryos_edge.server import app
from ivoryos_edge.optimizer.base_optimizer import OptimizerBase
from ivoryos_edge.optimizer.registry import OPTIMIZER_REGISTRY


class MockOptimizer(OptimizerBase):
    """Records exactly what the live queue passed to the optimizer constructor,
    so the test can verify _execute_optimization_run wires real config through
    instead of the old hardcoded optimizer_config={}.
    """
    init_calls = []
    suggest_calls = 0       # count of suggest() calls made (one per round, not per trial)
    suggest_n_values = []   # the `n` actually requested on each of those calls, in order
    observe_calls = []
    append_existing_data_calls = []
    _counter = 0

    def __init__(self, experiment_name, parameter_space, objective_config, optimizer_config,
                 parameter_constraints=None, datapath=None, additional_params=None):
        super().__init__(experiment_name, parameter_space, objective_config, optimizer_config,
                          parameter_constraints, datapath, additional_params)
        MockOptimizer.init_calls.append({
            "optimizer_config": optimizer_config,
            "datapath": datapath,
            "parameter_space": parameter_space,
            "objective_config": objective_config,
        })

    def suggest(self, n=1):
        MockOptimizer.suggest_calls += 1
        MockOptimizer.suggest_n_values.append(n)
        suggestions = []
        for _ in range(n):
            MockOptimizer._counter += 1
            suggestions.append({"x": MockOptimizer._counter * 0.1})
        return suggestions

    def observe(self, results):
        MockOptimizer.observe_calls.append(results)

    def append_existing_data(self, existing_data, file_path=None):
        MockOptimizer.append_existing_data_calls.append(existing_data)

    def get_plots(self, plot_type):
        return {"plot_type_seen": plot_type, "Trace": "<div>fake plot</div>"}

    @staticmethod
    def get_schema():
        return {
            "parameter_types": ["range"],
            "multiple_objectives": False,
            "optimizer_config": {"step_1": {"model": ["TestModel"], "num_samples": 2}},
            "additional_field": {}
        }


@pytest.fixture(autouse=True)
def register_mock_optimizer():
    OPTIMIZER_REGISTRY["mock"] = MockOptimizer
    MockOptimizer.init_calls = []
    MockOptimizer.suggest_calls = 0
    MockOptimizer.suggest_n_values = []
    MockOptimizer.observe_calls = []
    MockOptimizer.append_existing_data_calls = []
    MockOptimizer._counter = 0
    yield
    del OPTIMIZER_REGISTRY["mock"]


@pytest.mark.asyncio
async def test_optimization_run_passes_real_config_to_optimizer():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Test Optimizer Wiring",
            "parameters": {
                "type": "Optimization",
                "optimizer": "mock",
                "budget": 2,
                "optimizer_config": {"step_1": {"model": "TestModel", "num_samples": 2}},
                "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                "objective_config": [{"name": "y", "minimize": True}],
                "sequence_template": [
                    {"instrument": "dummy", "method": "test_method", "params": {"duration": 0}, "returnVar": "y"}
                ]
            }
        }

        response = await ac.post("/api/queue/runs", json=payload)
        assert response.status_code == 200, response.text
        run_id = response.json()["run_id"]

        status = "pending"
        for _ in range(50):
            resp = await ac.get("/api/queue/runs")
            runs = resp.json()["runs"]
            run = next((r for r in runs if r["id"] == run_id), None)
            if run:
                status = run["status"]
                if status in ["completed", "error", "cancelled"]:
                    break
            await asyncio.sleep(0.05)

        assert status == "completed", f"Expected 'completed', got {status}; steps={run.get('steps')}"

        # The core bug: optimizer_config used to be silently discarded as {}.
        assert len(MockOptimizer.init_calls) == 1
        call = MockOptimizer.init_calls[0]
        assert call["optimizer_config"] == {"step_1": {"model": "TestModel", "num_samples": 2}}
        assert call["datapath"], "datapath must be a real path, not None (NIMO needs it to create its data dir)"
        assert call["parameter_space"] == payload["parameters"]["parameter_space"]
        assert call["objective_config"] == payload["parameters"]["objective_config"]

        assert MockOptimizer.suggest_calls == 2  # budget=2
        assert len(MockOptimizer.observe_calls) == 2
        # observe() must receive a list of per-trial result dicts (matching suggest(n)'s batch
        # shape), not a bare dict — passing a bare dict here previously broke every backend's
        # real observe() with "'str' object has no attribute 'items'".
        for call in MockOptimizer.observe_calls:
            assert isinstance(call, list) and len(call) == 1 and isinstance(call[0], dict)

        # The optimizer instance stays reachable for plots after the run finishes.
        plots_resp = await ac.get(f"/api/queue/runs/{run_id}/plots?plot_type=trace")
        assert plots_resp.status_code == 200, plots_resp.text
        assert plots_resp.json() == {"plot_type_seen": "trace", "Trace": "<div>fake plot</div>"}

        # A run_id that never had an optimizer attached should be rejected, not silently
        # return the last run's plots.
        no_plots_resp = await ac.get("/api/queue/runs/999999/plots")
        assert no_plots_resp.status_code == 400


@pytest.mark.asyncio
async def test_optimization_run_batches_suggestions_per_round():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Test Batch Size",
            "parameters": {
                "type": "Optimization",
                "optimizer": "mock",
                "budget": 4,
                "batch_size": 2,
                "optimizer_config": {"step_1": {"model": "TestModel", "num_samples": 2}},
                "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                "objective_config": [{"name": "y", "minimize": True}],
                "sequence_template": [
                    {"instrument": "dummy", "method": "echo_method", "params": {"value": "0"}, "returnVar": "y"}
                ]
            }
        }
        response = await ac.post("/api/queue/runs", json=payload)
        run_id = response.json()["run_id"]

        status = "pending"
        run = None
        for _ in range(50):
            resp = await ac.get("/api/queue/runs")
            runs = resp.json()["runs"]
            run = next((r for r in runs if r["id"] == run_id), None)
            if run and run["status"] in ["completed", "error", "cancelled"]:
                status = run["status"]
                break
            await asyncio.sleep(0.05)

        assert status == "completed", f"Expected 'completed', got {status}; steps={run and run.get('steps')}"
        # budget=4, batch_size=2 -> exactly 2 rounds of 2 trials each, not 4 rounds of 1.
        assert MockOptimizer.suggest_n_values == [2, 2]
        # Each round's observe() call carries both trials' results together, not one call per trial.
        assert len(MockOptimizer.observe_calls) == 2
        for call in MockOptimizer.observe_calls:
            assert isinstance(call, list) and len(call) == 2
        # Still 4 real steps executed overall (1 templated step x 4 trials).
        assert len(run["steps"]) == 4


@pytest.mark.asyncio
async def test_optimization_run_appends_existing_data_before_first_suggestion():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        seed_rows = [{"x": 0.2, "y": 1.5}, {"x": 0.7, "y": 3.1}]
        payload = {
            "name": "Test Existing Data",
            "parameters": {
                "type": "Optimization",
                "optimizer": "mock",
                "budget": 1,
                "optimizer_config": {"step_1": {"model": "TestModel", "num_samples": 2}},
                "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                "objective_config": [{"name": "y", "minimize": True}],
                "existing_data": seed_rows,
                "sequence_template": [
                    {"instrument": "dummy", "method": "echo_method", "params": {"value": "0"}, "returnVar": "y"}
                ]
            }
        }
        response = await ac.post("/api/queue/runs", json=payload)
        run_id = response.json()["run_id"]

        status = "pending"
        for _ in range(50):
            resp = await ac.get("/api/queue/runs")
            runs = resp.json()["runs"]
            run = next((r for r in runs if r["id"] == run_id), None)
            if run and run["status"] in ["completed", "error", "cancelled"]:
                status = run["status"]
                break
            await asyncio.sleep(0.05)

        assert status == "completed", f"Expected 'completed', got {status}"
        assert len(MockOptimizer.append_existing_data_calls) == 1
        seeded_df = MockOptimizer.append_existing_data_calls[0]
        assert seeded_df.to_dict(orient="records") == seed_rows


@pytest.mark.asyncio
async def test_optimization_run_executes_cleanup_template_once():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Test Optimizer Cleanup",
            "parameters": {
                "type": "Optimization",
                "optimizer": "mock",
                "budget": 2,
                "optimizer_config": {"step_1": {"model": "TestModel", "num_samples": 2}},
                "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                "objective_config": [{"name": "y", "minimize": True}],
                "sequence_template": [
                    {"instrument": "dummy", "method": "test_method", "params": {"duration": 0}, "returnVar": "y"}
                ]
            },
            # Matches the real payload shape from optimize/page.tsx — the server reads this
            # top-level 'cleanup' field into parameters['cleanup_template'] itself.
            # Previously never executed at all for Optimization runs — silently ignored even
            # though the Optimize page already lets you configure one.
            "cleanup": [
                {"instrument": "dummy", "method": "test_method", "params": {"duration": 0}}
            ]
        }

        response = await ac.post("/api/queue/runs", json=payload)
        run_id = response.json()["run_id"]

        status = "pending"
        run = None
        for _ in range(50):
            resp = await ac.get("/api/queue/runs")
            runs = resp.json()["runs"]
            run = next((r for r in runs if r["id"] == run_id), None)
            if run and run["status"] in ["completed", "error", "cancelled"]:
                status = run["status"]
                break
            await asyncio.sleep(0.05)

        assert status == "completed", f"Expected 'completed', got {status}; steps={run and run.get('steps')}"
        # 2 budget iterations x 1 templated step each, plus exactly 1 cleanup step.
        assert len(run["steps"]) == 3
        assert run["steps"][-1]["status"] == "completed"


@pytest.mark.asyncio
async def test_optimization_run_stops_early_when_objective_reaches_target():
    from ivoryos_edge.server import app as fastapi_app
    fastapi_app.state.instruments["dummy"].counter = 0

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Test Early Stop",
            "parameters": {
                "type": "Optimization",
                "optimizer": "mock",
                "budget": 10,  # would run all 10 iterations without early_stop
                "optimizer_config": {"step_1": {"model": "TestModel", "num_samples": 2}},
                "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                "objective_config": [{"name": "y", "minimize": False}],
                "early_stop": {"mode": "any", "criteria": [{"metric": "y", "threshold": 3}]},
                "sequence_template": [
                    {"instrument": "dummy", "method": "counting_method", "params": {}, "returnVar": "y"}
                ]
            }
        }

        response = await ac.post("/api/queue/runs", json=payload)
        run_id = response.json()["run_id"]

        status = "pending"
        run = None
        for _ in range(50):
            resp = await ac.get("/api/queue/runs")
            runs = resp.json()["runs"]
            run = next((r for r in runs if r["id"] == run_id), None)
            if run and run["status"] in ["completed", "error", "cancelled"]:
                status = run["status"]
                break
            await asyncio.sleep(0.05)

        assert status == "completed", f"Expected 'completed', got {status}; steps={run and run.get('steps')}"
        # counting_method returns 1, 2, 3, ... — with threshold 3 and minimize=False, the loop
        # must stop right after the 3rd iteration's objective reaches 3, not run all 10.
        assert len(run["steps"]) == 3


@pytest.mark.asyncio
async def test_optimization_run_all_mode_waits_for_every_criterion():
    from ivoryos_edge.server import app as fastapi_app
    fastapi_app.state.instruments["dummy"].counter = 0
    fastapi_app.state.instruments["dummy"].counter_b = 0.0

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Test Early Stop All Mode",
            "parameters": {
                "type": "Optimization",
                "optimizer": "mock",
                "budget": 10,
                "optimizer_config": {"step_1": {"model": "TestModel", "num_samples": 2}},
                "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                "objective_config": [{"name": "y", "minimize": False}, {"name": "z", "minimize": False}],
                # y (counting_method) hits 3 after iteration 3; z (counting_method_b, half rate)
                # only hits 3 after iteration 6. "all" mode must wait for the slower one.
                "early_stop": {"mode": "all", "criteria": [{"metric": "y", "threshold": 3}, {"metric": "z", "threshold": 3}]},
                "sequence_template": [
                    {"instrument": "dummy", "method": "counting_method", "params": {}, "returnVar": "y"},
                    {"instrument": "dummy", "method": "counting_method_b", "params": {}, "returnVar": "z"}
                ]
            }
        }

        response = await ac.post("/api/queue/runs", json=payload)
        run_id = response.json()["run_id"]

        status = "pending"
        run = None
        for _ in range(100):
            resp = await ac.get("/api/queue/runs")
            runs = resp.json()["runs"]
            run = next((r for r in runs if r["id"] == run_id), None)
            if run and run["status"] in ["completed", "error", "cancelled"]:
                status = run["status"]
                break
            await asyncio.sleep(0.05)

        assert status == "completed", f"Expected 'completed', got {status}; steps={run and run.get('steps')}"
        # 6 iterations x 2 templated steps each — stopped once z (the slower criterion) also
        # reached 3, not at iteration 3 when only y had reached it.
        assert len(run["steps"]) == 12


@pytest.mark.asyncio
async def test_optimization_run_uses_per_iteration_values_for_excluded_var():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Test Per-Iteration Values",
            "parameters": {
                "type": "Optimization",
                "optimizer": "mock",
                "budget": 3,
                "optimizer_config": {"step_1": {"model": "TestModel", "num_samples": 2}},
                # 'vial_index' is deliberately NOT in parameter_space — it's excluded from the
                # search space and given its own value per iteration instead of one fixed value.
                "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                "objective_config": [{"name": "y", "minimize": True}],
                "iteration_values": {"vial_index": ["1", "2", "3"]},
                "sequence_template": [
                    {"instrument": "dummy", "method": "echo_method", "params": {"value": "#vial_index"}, "returnVar": "y"}
                ]
            }
        }

        response = await ac.post("/api/queue/runs", json=payload)
        run_id = response.json()["run_id"]

        status = "pending"
        run = None
        for _ in range(50):
            resp = await ac.get("/api/queue/runs")
            runs = resp.json()["runs"]
            run = next((r for r in runs if r["id"] == run_id), None)
            if run and run["status"] in ["completed", "error", "cancelled"]:
                status = run["status"]
                break
            await asyncio.sleep(0.05)

        assert status == "completed", f"Expected 'completed', got {status}; steps={run and run.get('steps')}"
        vial_indices = [s["parameters"].get("value") for s in run["steps"]]
        assert vial_indices == ["1", "2", "3"]


@pytest.mark.asyncio
async def test_optimizers_endpoint_lists_registered_schemas():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/optimizers")
        assert resp.status_code == 200
        data = resp.json()
        assert "mock" in data
        assert data["mock"]["optimizer_config"]["step_1"]["model"] == ["TestModel"]


@pytest.mark.asyncio
async def test_cloud_optimization_reports_running_and_finished(monkeypatch):
    """A Cloud-dispatched optimization has to tell Cloud it started and finished.

    The optimization path returned before the plain path's reporting code, so it never did: Cloud
    left the task 'queued' forever, and -- since Cloud holds a device's next task until the current
    one is done -- every later Cloud task for that device waited behind it.
    """
    from ivoryos_edge import server

    published = []

    class Broker:
        client_id = "test-device"

        def publish(self, topic, payload, retain=False, qos=0):
            published.append((topic, payload))

    monkeypatch.setattr(server, "global_broker", Broker())
    monkeypatch.setattr(server, "global_topic_prefix", "ivoryos/edge")

    await server.handle_cloud_task({
        "runId": "cloud_opt", "nodeId": "node_opt",
        "run": {
            "name": "Cloud optimization report",
            "parameters": {
                "type": "Optimization", "optimizer": "mock", "budget": 1,
                "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                "objective_config": [{"name": "y", "minimize": True}],
                "sequence_template": [
                    {"instrument": "dummy", "method": "test_method", "params": {"duration": 0}, "returnVar": "y"}
                ],
            },
        },
    })
    statuses = []
    for _ in range(80):
        # Status changes only; progress updates also say "running".
        statuses = [p["status"] for t, p in published if t.endswith("/task-status") and "progress" not in p]
        if "completed" in statuses or "error" in statuses:
            break
        await asyncio.sleep(0.05)

    assert statuses == ["running", "completed"], statuses


def test_an_installed_optimizer_that_will_not_import_says_why(monkeypatch, capsys):
    """A backend whose package is installed but whose import fails (two backends wanting different
    versions of a shared dependency, say) used to vanish exactly as if it were not installed."""
    import importlib
    import importlib.util
    import ivoryos_edge.optimizer.registry as registry

    saved = registry.OPTIMIZER_REGISTRY, registry.OPTIMIZER_ERRORS
    real_find, real_import = importlib.util.find_spec, importlib.import_module

    def find(name, *a):
        return object() if name == "baybe" else real_find(name, *a)

    def load(name, *a):
        if name == "ivoryos_edge.optimizer.baybe_optimizer":
            raise ImportError("cannot import name 'Kernel' from 'botorch.models'")
        return real_import(name, *a)

    monkeypatch.setattr(importlib.util, "find_spec", find)
    monkeypatch.setattr(importlib, "import_module", load)
    try:
        importlib.reload(registry)
        assert "baybe" not in registry.OPTIMIZER_REGISTRY
        assert registry.OPTIMIZER_ERRORS["baybe"].startswith("ImportError: cannot import name 'Kernel'")
        assert "[optimizer] baybe is installed but could not be loaded" in capsys.readouterr().err
    finally:
        # Other tests hold the original dicts (imported by name), so put those objects back.
        registry.OPTIMIZER_REGISTRY, registry.OPTIMIZER_ERRORS = saved


@pytest.mark.asyncio
async def test_observe_gets_every_suggested_trial_in_order_with_its_parameters():
    """observe() is told about each suggested trial, in order, with the values it ran with and
    its objectives. A failed step waits for a person (here: skip it), and the trial it belonged
    to arrives without an objective, so the adapter can mark it failed rather than misread it.
    Ax and NIMO pair results with trials by position; BayBE needs the parameter values."""
    from ivoryos_edge.server import app as fastapi_app, queue_manager
    # The autouse fixture registers the mock and resets its records.
    async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as ac:
        payload = {
            "name": "Failed trial in a round",
            "parameters": {
                "type": "Optimization", "optimizer": "mock", "budget": 2, "batch_size": 2,
                "optimizer_config": {},
                "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                "objective_config": [{"name": "result", "minimize": False}],
                "sequence_template": [
                    # The first trial's step fails, the second's succeeds.
                    {"instrument": "dummy", "method": "fail_first_call", "params": {}, "returnVar": "result"},
                ],
            },
        }
        fastapi_app.state.instruments["dummy"].calls_seen = 0
        resp = await ac.post("/api/queue/runs", json=payload)
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["run_id"]
        # Nothing is skipped on its own: the run waits for a decision.
        for _ in range(80):
            if queue_manager.awaiting_decision == run_id:
                break
            await asyncio.sleep(0.05)
        assert queue_manager.awaiting_decision == run_id
        assert queue_manager.paused is True
        assert (await ac.post(f"/api/queue/runs/{run_id}/resolve", json={"action": "skip"})).status_code == 200
        # While it waits the run reads "error"; wait for it to have finished, not for a status.
        for _ in range(80):
            await asyncio.sleep(0.05)
            if queue_manager.active_run_id != run_id:
                break
        run = (await ac.get(f"/api/queue/runs/{run_id}")).json()
        assert run["status"] == "completed", [(s["method"], s["status"], (s.get("error") or "")[:200]) for s in run["steps"]]
        assert len(MockOptimizer.observe_calls) == 1
        failed, ok = MockOptimizer.observe_calls[0]
        assert "x" in failed and "result" not in failed       # its step was skipped: no objective
        assert "x" in ok and ok["result"] == 2.0              # the second trial's own result


@pytest.mark.asyncio
async def test_flow_control_runs_inside_an_optimization():
    """Sleep, Comment, If/Else/End_If and While/End_While run in an optimization's prep and
    trials as in a normal run (_flow_control_step). The optimization loop used to treat every
    step as an instrument and stopped at the first one: "Instrument Flow_Control not found"."""
    from ivoryos_edge.server import app as fastapi_app
    fastapi_app.state.instruments["dummy"].counter = 0
    fc = lambda method, **params: {"instrument": "Flow_Control", "method": method, "params": params}
    async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as ac:
        payload = {
            "name": "Flow control in an optimization",
            "parameters": {
                "type": "Optimization", "optimizer": "mock", "budget": 2, "optimizer_config": {},
                "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                "objective_config": [{"name": "echoed", "minimize": False}],
                "sequence_template": [
                    {"instrument": "dummy", "method": "assay_method", "params": {}, "returnVar": "y",
                     "returnBindings": [{"path": "yield_pct", "var": "y"}]},
                    fc("Sleep", duration_seconds=0),
                    fc("If", condition="y > 0"),
                    {"instrument": "dummy", "method": "echo_method", "params": {"value": "#y"}, "returnVar": "echoed"},
                    fc("Else"),
                    {"instrument": "dummy", "method": "fail_method", "params": {}},
                    fc("End_If"),
                    {"instrument": "Flow Control", "method": "Comment", "params": {"message": "prep counted to #c"}},
                ],
            },
            # Top level, as the Optimize page sends it: start_run makes it the run's prep_template.
            "prep": [
                {"instrument": "dummy", "method": "counting_method", "params": {}, "returnVar": "c"},
                fc("While", condition="c < 3"),
                {"instrument": "dummy", "method": "counting_method", "params": {}, "returnVar": "c"},
                fc("End_While"),
            ],
        }
        resp = await ac.post("/api/queue/runs", json=payload)
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["run_id"]
        for _ in range(80):
            run = (await ac.get(f"/api/queue/runs/{run_id}")).json()
            if run.get("status") in ["completed", "error", "cancelled"]:
                break
            await asyncio.sleep(0.05)
        assert run["status"] == "completed", [(s["method"], s["status"], (s.get("error") or "")[:80]) for s in run["steps"]]

        steps = run["steps"]
        # Two counting steps in prep, the second inside the loop: it is one row in the record, run
        # again on each pass (End_While resets it). The Comment below shows the loop reached 3.
        assert sum(1 for s in steps if s["method"] == "counting_method") == 2
        # Each trial took the If's true branch; the Else branch never ran.
        assert [s["status"] for s in steps if s["method"] == "fail_method"] == ["skipped", "skipped"]
        assert [s["outputs"]["message"] for s in steps if s["method"] == "Comment"] == ["prep counted to 3"] * 2
        observed = [row for call in MockOptimizer.observe_calls for row in call]
        assert len(observed) == 2 and all(float(row["echoed"]) > 0 for row in observed), observed


@pytest.mark.asyncio
async def test_optimizing_a_linked_workflow_runs_its_prep_and_cleanup_once():
    """An optimization over a linked workflow runs that workflow's prep once, its main block per
    trial, and its cleanup once. The Optimize page splits the link three ways with `phases`
    (shared-ui splitRepeatedLinks); sent whole, every trial ran the workflow's setup again (a
    colour-match campaign set its target and asked for confirmation before every trial)."""
    from ivoryos_edge.server import app as fastapi_app
    fastapi_app.state.instruments["dummy"].counter = 0
    async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as ac:
        saved = await ac.post("/api/workflows/Setup then measure", json={"description": "",
            "prep": [{"id": 1, "uuid": 1, "instrument": "dummy", "action": "echo_method", "args": {"value": "setup"}, "arg_types": {}}],
            "script": [{"id": 2, "uuid": 2, "instrument": "dummy", "action": "assay_method", "args": {}, "arg_types": {},
                        "return": "y", "return_bindings": [{"path": "yield_pct", "var": "y"}]}],
            "cleanup": [{"id": 3, "uuid": 3, "instrument": "dummy", "action": "echo_method", "args": {"value": "teardown"}, "arg_types": {}}],
        })
        assert saved.status_code == 200, saved.text
        link = lambda phase: {"instrument": "Library Workflows", "method": "Setup then measure", "params": {}, "phases": [phase]}
        payload = {
            "name": "Linked, split",
            "parameters": {
                "type": "Optimization", "optimizer": "mock", "budget": 3, "optimizer_config": {},
                "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                "objective_config": [{"name": "y", "minimize": False}],
                "sequence_template": [link("script")],
            },
            "prep": [link("prep")],
            "cleanup": [link("cleanup")],
        }
        resp = await ac.post("/api/queue/runs", json=payload)
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["run_id"]
        for _ in range(80):
            run = (await ac.get(f"/api/queue/runs/{run_id}")).json()
            if run.get("status") in ["completed", "error", "cancelled"]:
                break
            await asyncio.sleep(0.05)
        assert run["status"] == "completed", [(s["method"], s["status"], (s.get("error") or "")[:200]) for s in run["steps"]]
        order = [(s["method"], (s.get("outputs") or {}).get("result")) for s in run["steps"]]
        assert order[0] == ("echo_method", "setup") and order[-1] == ("echo_method", "teardown"), order
        assert sum(1 for m, r in order if r == "setup") == 1
        assert sum(1 for m, r in order if r == "teardown") == 1
        assert sum(1 for m, _ in order if m == "assay_method") == 3
        assert len([row for call in MockOptimizer.observe_calls for row in call]) == 3


def test_no_improvement_counts_only_after_the_random_start_and_restarts_on_improvement():
    from ivoryos_edge.queue import NoImprovement

    rule = NoImprovement([{"name": "y", "minimize": False}], patience=2, random_start=2)
    assert [rule.add(1, {"y": 5}), rule.add(2, {"y": 1})] == [False, False]  # random start: not counted
    assert rule.add(3, {"y": 4}) is False
    assert rule.add(4, {"y": 6}) is False  # improved: the count starts again
    assert rule.add(5, {"y": 1}) is False
    assert rule.add(6, {"y": 2}) is True

    # Several objectives: any one improving is an improvement. Existing data sets the bar.
    both = NoImprovement([{"name": "a", "minimize": True}, {"name": "b"}], patience=1, existing=[{"a": 1, "b": 1}])
    assert both.add(1, {"a": 0.5, "b": 0}) is False
    assert both.add(2, {"a": 2, "b": 0.5}) is True
    assert NoImprovement([{"name": "y"}], patience=0).add(9, {"y": 0}) is False  # off


@pytest.mark.asyncio
async def test_optimization_run_stops_when_nothing_improves():
    from ivoryos_edge.server import app as fastapi_app
    fastapi_app.state.instruments["dummy"].counter = 0

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            "name": "Test No Improvement",
            "parameters": {
                "type": "Optimization",
                "optimizer": "mock",
                "budget": 10,
                "optimizer_config": {"step_1": {"model": "TestModel", "num_samples": 2}},
                "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}],
                # counting_method returns 1, 2, 3, ...: minimized, only the first is ever an improvement.
                "objective_config": [{"name": "y", "minimize": True}],
                "stop_after_no_improvement": 3,
                "sequence_template": [
                    {"instrument": "dummy", "method": "counting_method", "params": {}, "returnVar": "y"}
                ]
            }
        }
        run_id = (await ac.post("/api/queue/runs", json=payload)).json()["run_id"]
        run = None
        for _ in range(200):  # up to 10 s: slower where Ax and BayBE are installed beside the edge
            runs = (await ac.get("/api/queue/runs")).json()["runs"]
            run = next((r for r in runs if r["id"] == run_id), None)
            if run and run["status"] in ["completed", "error", "cancelled"]:
                break
            await asyncio.sleep(0.05)
        assert run["status"] == "completed"
        # Trial 2 is in the random start; trials 3, 4 and 5 do not improve: stop after 5, not 10.
        assert len(run["steps"]) == 5


@pytest.mark.asyncio
async def test_constraints_an_optimizer_cannot_keep_are_refused_before_the_run_is_queued():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        space = [{"name": "x", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}]
        checked = (await ac.post("/api/optimizers/mock/constraints",
                                 json={"constraints": ["x <= 0.5", "", "x * x <= 1"], "parameter_space": space})).json()
        errors = [r["error"] for r in checked["results"]]
        assert "does not take constraints" in errors[0]
        assert errors[1] is None  # a blank row: nothing to say
        assert "multiplies two parameters" in errors[2]

        response = await ac.post("/api/queue/runs", json={"name": "refused", "parameters": {
            "type": "Optimization", "optimizer": "mock", "budget": 2, "parameter_space": space,
            "objective_config": [{"name": "y"}], "parameter_constraints": ["x <= 0.5"],
            "sequence_template": [{"instrument": "dummy", "method": "counting_method", "params": {}, "returnVar": "y"}],
        }})
        assert response.status_code == 400
        assert "does not take constraints" in response.json()["error"]
