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
    suggest_calls = 0
    observe_calls = []

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
        return [{"x": 0.5}]

    def observe(self, results):
        MockOptimizer.observe_calls.append(results)

    def append_existing_data(self, existing_data, file_path=None):
        pass

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
    MockOptimizer.observe_calls = []
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
async def test_optimizers_endpoint_lists_registered_schemas():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/optimizers")
        assert resp.status_code == 200
        data = resp.json()
        assert "mock" in data
        assert data["mock"]["optimizer_config"]["step_1"]["model"] == ["TestModel"]
