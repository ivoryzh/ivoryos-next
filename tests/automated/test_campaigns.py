"""Suggest-only campaigns: the optimizer suggests, people run the experiments and type results in.

campaigns.py keeps no optimizer between requests: each "suggest more" builds it again from the
campaign's results (as data) and its suggestions still waiting for one (as pending). These tests
check what each rebuild is given, with a stand-in optimizer, then drive BayBE and Ax for real when
they are installed (tests/manual/optimizer_smoke.py says how).
"""
import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge.server import app
from ivoryos_edge.optimizer.base_optimizer import OptimizerBase
from ivoryos_edge.optimizer.registry import OPTIMIZER_REGISTRY


class Recording(OptimizerBase):
    """Records what each rebuild is given; suggests 1.0, 2.0, ... across the whole test."""
    built = []
    counter = 0

    def __init__(self, experiment_name, parameter_space, objective_config, optimizer_config,
                 parameter_constraints=None, datapath=None, additional_params=None):
        super().__init__(experiment_name, parameter_space, objective_config, optimizer_config,
                         parameter_constraints, datapath, additional_params)
        self.data, self.pending = [], []
        Recording.built.append(self)

    def suggest(self, n=1):
        out = []
        for _ in range(n):
            Recording.counter += 1
            out.append({"x": float(Recording.counter)})
        return out

    def observe(self, results):
        pass

    def append_existing_data(self, existing_data, file_path=None):
        self.data = existing_data.to_dict(orient="records")

    def add_pending(self, points):
        self.pending = list(points)

    def get_plots(self, plot_type):
        return {}

    @staticmethod
    def get_schema():
        return {"parameter_types": ["range"], "supports_suggest_only": True,
                "optimizer_config": {"step_1": {"model": ["Random"], "num_samples": 3}}}


@pytest.fixture(autouse=True)
def recording_optimizer():
    OPTIMIZER_REGISTRY["recording"] = Recording
    Recording.built, Recording.counter = [], 0
    yield
    del OPTIMIZER_REGISTRY["recording"]


def _parameters(optimizer="recording", **extra):
    return {
        "optimizer": optimizer,
        "parameter_space": [{"name": "x", "type": "range", "bounds": [0.0, 10.0], "value_type": "float"}],
        "objective_config": [{"name": "y", "minimize": False}],
        "optimizer_config": {"step_1": {"model": "Random", "num_samples": 3}, "step_2": {"model": "Model"}},
        "batch_size": 2,
        **extra,
    }


def _client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_a_campaign_starts_with_its_first_batch_waiting_for_results():
    async with _client() as ac:
        created = await ac.post("/api/campaigns", json={"name": "Bench screen", "parameters": _parameters()})
        assert created.status_code == 200, created.text
        campaign = created.json()
        assert campaign["name"] == "Bench screen"
        assert [(r["id"], r["batch"], r["values"], r["results"]) for r in campaign["rows"]] == [
            (1, 1, {"x": 1.0}, None), (2, 1, {"x": 2.0}, None)]
        assert (campaign["done"], campaign["waiting"]) == (0, 2)
        listed = (await ac.get("/api/campaigns")).json()["campaigns"]
        assert any(c["id"] == campaign["id"] for c in listed)
        await ac.delete(f"/api/campaigns/{campaign['id']}")


@pytest.mark.asyncio
async def test_each_rebuild_gets_the_results_as_data_and_the_rest_as_pending():
    async with _client() as ac:
        campaign = (await ac.post("/api/campaigns", json={"parameters": _parameters(existing_data=[{"x": 9.0, "y": 0.5}])})).json()
        cid = campaign["id"]
        await ac.put(f"/api/campaigns/{cid}/rows/1", json={"results": {"y": "3.5"}, "note": "slightly cloudy"})
        await ac.put(f"/api/campaigns/{cid}/rows/2", json={"discarded": True})

        more = (await ac.post(f"/api/campaigns/{cid}/suggest", json={"n": 3})).json()
        rebuilt = Recording.built[-1]
        assert rebuilt.data == [{"x": 9.0, "y": 0.5}, {"x": 1.0, "y": 3.5}]  # existing data, then results
        assert rebuilt.pending == []  # the set-aside suggestion is neither data nor pending
        # One suggestion stands (the other was set aside, never run): one of three random ones spent.
        assert rebuilt.optimizer_config["step_1"]["num_samples"] == 2
        assert [r["batch"] for r in more["rows"]] == [1, 1, 2, 2, 2]
        assert more["rows"][0]["note"] == "slightly cloudy"
        assert (more["done"], more["waiting"]) == (1, 3)

        await ac.post(f"/api/campaigns/{cid}/suggest", json={"n": 1})
        assert Recording.built[-1].pending == [{"x": 3.0}, {"x": 4.0}, {"x": 5.0}]
        await ac.delete(f"/api/campaigns/{cid}")


@pytest.mark.asyncio
async def test_with_no_result_yet_the_random_start_carries_on():
    async with _client() as ac:
        cid = (await ac.post("/api/campaigns", json={"parameters": _parameters(batch_size=3)})).json()["id"]
        await ac.post(f"/api/campaigns/{cid}/suggest", json={"n": 2})
        # Three given out, none measured: a model would have nothing to fit, so stay random.
        assert Recording.built[-1].optimizer_config["step_1"]["num_samples"] == 2
        await ac.delete(f"/api/campaigns/{cid}")


@pytest.mark.asyncio
async def test_results_are_checked_and_a_blank_clears_one():
    async with _client() as ac:
        cid = (await ac.post("/api/campaigns", json={"parameters": _parameters()})).json()["id"]
        bad = await ac.put(f"/api/campaigns/{cid}/rows/1", json={"results": {"y": "high"}})
        assert bad.status_code == 400 and "not a number" in bad.json()["error"]
        unknown = await ac.put(f"/api/campaigns/{cid}/rows/1", json={"results": {"purity": 1}})
        assert unknown.status_code == 400 and "not an objective" in unknown.json()["error"]
        await ac.put(f"/api/campaigns/{cid}/rows/1", json={"results": {"y": 2}})
        cleared = (await ac.put(f"/api/campaigns/{cid}/rows/1", json={"results": {"y": ""}})).json()
        assert cleared["rows"][0]["results"] is None and cleared["waiting"] == 2
        await ac.delete(f"/api/campaigns/{cid}")


@pytest.mark.asyncio
async def test_what_cannot_be_a_campaign_is_refused_in_words():
    from ivoryos_edge.optimizer.registry import OPTIMIZER_REGISTRY as registry

    class RunsOnly(Recording):
        @staticmethod
        def get_schema():
            return {"parameter_types": ["range"], "optimizer_config": {}}

    registry["runs_only"] = RunsOnly
    try:
        async with _client() as ac:
            refused = await ac.post("/api/campaigns", json={"parameters": _parameters("runs_only")})
            assert refused.status_code == 400 and "cannot suggest" in refused.json()["error"]
            missing = await ac.post("/api/campaigns", json={"parameters": _parameters("not_installed")})
            assert "not installed" in missing.json()["error"]
            empty = await ac.post("/api/campaigns", json={"parameters": {**_parameters(), "objective_config": []}})
            assert "objective" in empty.json()["error"]
            gone = await ac.get("/api/campaigns/999999")
            assert gone.status_code == 404
    finally:
        del registry["runs_only"]


# --- the real optimizers -------------------------------------------------------------------------

async def _drive(optimizer, space, objective, rounds=3, batch=2, constraints=None):
    """Create a campaign, then answer every suggestion and ask for more, `rounds` times."""
    async with _client() as ac:
        params = {
            "optimizer": optimizer, "parameter_space": space, "batch_size": batch,
            "objective_config": [{"name": "y", "minimize": False}],
            "optimizer_config": ({"step_1": {"model": "Sobol", "num_samples": 2}, "step_2": {"model": "BoTorch"}}
                                 if optimizer == "ax" else
                                 {"step_1": {"model": "Random", "num_samples": 2}, "step_2": {"model": "BOTorch"}}),
            "parameter_constraints": constraints or [],
        }
        created = await ac.post("/api/campaigns", json={"parameters": params})
        assert created.status_code == 200, created.text
        campaign = created.json()
        for _ in range(rounds):
            for row in campaign["rows"]:
                if row["results"] is None:
                    await ac.put(f"/api/campaigns/{campaign['id']}/rows/{row['id']}",
                                 json={"results": {"y": objective(row["values"])}})
            more = await ac.post(f"/api/campaigns/{campaign['id']}/suggest", json={"n": batch})
            assert more.status_code == 200, more.text
            campaign = more.json()
        await ac.delete(f"/api/campaigns/{campaign['id']}")
        return campaign["rows"]


@pytest.mark.asyncio
async def test_baybe_campaign_never_suggests_a_point_twice():
    pytest.importorskip("baybe")
    rows = await _drive("baybe", [{"name": "n", "type": "choice", "bounds": [1, 2, 3, 4, 5, 6, 7, 8], "value_type": "int"}],
                        lambda v: -(v["n"] - 5) ** 2, rounds=3)
    values = [r["values"]["n"] for r in rows]
    assert len(values) == 8 and len(set(values)) == 8


@pytest.mark.asyncio
async def test_ax_campaign_reaches_its_model_and_keeps_constraints():
    pytest.importorskip("ax")
    space = [{"name": "a", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"},
             {"name": "b", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"}]
    rows = await _drive("ax", space, lambda v: v["a"] - v["b"], rounds=3, constraints=["a + b <= 1"])
    assert len(rows) == 8
    assert all(r["values"]["a"] + r["values"]["b"] <= 1 + 1e-9 for r in rows)
