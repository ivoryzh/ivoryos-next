"""What the edge tells Cloud, and when (docs/edge_cloud_sync.md).

The edge used to publish a status heartbeat every 5 seconds forever. Presence now rests on the
broker (keep-alive and the Last Will), and the edge speaks when something changes. These pin the
rules that replaced the heartbeat, each of which fails silently when wrong: a device that never
says it is free again, a workflow that reaches Cloud after its owner chose to keep it local, a
report from run 2 of a repeated step taken for run 3's.
"""

import asyncio

import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge import server
from ivoryos_edge.server import app


class Sent:
    def wait_for_publish(self, timeout=None):
        return True

    def is_published(self):
        return True


class FakeClient:
    def __init__(self):
        self.raw = []

    def is_connected(self):
        return True

    def publish(self, topic, payload=None, qos=0, retain=False):
        self.raw.append((topic, payload, retain))
        return Sent()


class FakeBroker:
    client_id = "my-deck-7k4m2q"

    def __init__(self):
        self.client = FakeClient()
        self.published = []
        self._connects = 1

    def publish(self, topic, payload, retain=False, qos=0):
        self.published.append({"topic": topic, "payload": payload, "retain": retain, "qos": qos})
        return Sent()

    def on(self, suffix):
        return [m for m in self.published if m["topic"].endswith(suffix)]

    def sequences(self):
        return sorted(m["topic"].rsplit("/", 1)[-1] for m in self.published if "/sequences/" in m["topic"])


@pytest.fixture
def edge(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("CLOUD_TOKEN=tok\nCLOUD_DEVICE_ID=my-deck-7k4m2q\n")
    workflows = tmp_path / "workflows"
    workflows.mkdir()
    monkeypatch.setattr(server, "ENV_PATH", str(env))
    monkeypatch.setattr(server, "WORKFLOWS_DIR", str(workflows))
    monkeypatch.setattr(server, "CLOUD_TOKEN", "tok")
    monkeypatch.setattr(server, "CLOUD_PAUSED", False)
    monkeypatch.setattr(server, "CLOUD_SYNC_WORKFLOWS", "always")
    monkeypatch.setattr(server, "cloud_last_workflow_sync", None)
    monkeypatch.setattr(server, "global_topic_prefix", "ivoryos/edge")
    monkeypatch.setattr(server, "global_client_id", "my-deck-7k4m2q")
    monkeypatch.setattr(server, "global_session", "abc12345")
    monkeypatch.setattr(server, "cloud_connection_state", "connected")
    monkeypatch.setattr(server, "cloud_pairing_session", None)
    # As after Cloud's ping; the handshake itself has its own tests below.
    monkeypatch.setattr(server, "cloud_quiet", True)
    broker = FakeBroker()
    monkeypatch.setattr(server, "global_broker", broker)
    return broker, env


def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


BODY = {"script": [{"instrument": "dummy", "action": "test_method", "args": {"duration": 0}}]}


# --- presence -------------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_status_says_how_often_it_comes_and_must_arrive(edge):
    """`interval` is how Cloud knows how much silence is normal; QoS 1 because nothing repeats it."""
    broker, _ = edge
    await server.publish_status()
    [status] = broker.on("/status")
    assert status["retain"] is True and status["qos"] == 1
    assert status["payload"]["online"] is True
    # Whatever the shared test database holds; what matters is that it is said.
    assert isinstance(status["payload"]["busy"], bool)
    assert status["payload"]["session"] == "abc12345"
    assert status["payload"]["interval"] == server.STATUS_INTERVAL_S >= 30
    assert status["payload"]["quiet"] is True


@pytest.mark.asyncio
async def test_the_heartbeat_stays_until_cloud_asks_for_quiet(edge, monkeypatch):
    """An older Cloud calls a device offline after 15s of silence and never pings. Until this
    Cloud pings, the edge keeps the 5-second heartbeat, so it can be updated before Cloud is."""
    broker, _ = edge
    monkeypatch.setattr(server, "cloud_quiet", False)
    ticks = {"n": 0}
    real_sleep = asyncio.sleep

    async def fast_sleep(seconds):
        assert seconds == server.LEGACY_HEARTBEAT_S == 5
        ticks["n"] += 1
        if ticks["n"] == 40:
            # Cloud pings: the answer is immediate and says the edge is quiet from now on.
            await server.handle_broker_message("ivoryos/edge/my-deck-7k4m2q/ping", {"ts": 1})
        if ticks["n"] >= 80:
            monkeypatch.setattr(server, "global_broker", None)
        await real_sleep(0)

    monkeypatch.setattr(server.asyncio, "sleep", fast_sleep)
    await server.status_loop(broker, "ivoryos/edge", "my-deck-7k4m2q")
    monkeypatch.setattr(server.asyncio, "sleep", real_sleep)

    statuses = [m["payload"] for m in broker.on("/status")]
    legacy = [s for s in statuses if s["quiet"] is False]
    quiet = [s for s in statuses if s["quiet"] is True]
    assert len(legacy) == 40, "one per tick while Cloud has not asked"
    assert all("interval" not in s for s in legacy), "judged as the 5s heartbeat it is"
    assert len(quiet) == 1 and quiet[0]["interval"] == server.STATUS_INTERVAL_S, "then only the answer to the ping"


@pytest.mark.asyncio
async def test_cloud_asking_are_you_there_gets_a_status(edge):
    """After Cloud restarts all it has is the retained status, which a dead device also leaves."""
    broker, _ = edge
    await server.handle_broker_message("ivoryos/edge/my-deck-7k4m2q/ping", {"ts": 1, "nonce": "k3x9"})
    [answer] = broker.on("/status")
    assert answer["payload"]["pong"] == "k3x9", "the nonce is Cloud's proof the answer is live"
    assert not broker.on("/task-status"), "a ping is not a task"
    await server.publish_status()
    assert "pong" not in broker.on("/status")[-1]["payload"], "only the answer carries it"


@pytest.mark.asyncio
async def test_the_status_loop_settles_and_then_goes_quiet(edge, monkeypatch):
    """Status at connect and on the settling schedule (ticks 1,2,4,8,16,32), then nothing until
    the backstop interval: no more message every 5 seconds forever."""
    broker, _ = edge
    ticks = {"n": 0}
    real_sleep = asyncio.sleep

    async def fast_sleep(_seconds):
        ticks["n"] += 1
        if ticks["n"] >= 80:  # 400 "seconds" in
            monkeypatch.setattr(server, "global_broker", None)
        await real_sleep(0)

    monkeypatch.setattr(server.asyncio, "sleep", fast_sleep)
    await server.status_loop(broker, "ivoryos/edge", "my-deck-7k4m2q")
    monkeypatch.setattr(server.asyncio, "sleep", real_sleep)

    assert len(broker.on("/status")) == 7, "connect + six settling repeats, not 80"
    assert len(broker.on("/schema")) == 6
    assert all(m["payload"]["online"] for m in broker.on("/status"))


@pytest.mark.asyncio
async def test_a_reconnect_starts_the_settling_schedule_again(edge, monkeypatch):
    """The broker announced "offline" for us when the old connection died; schema and status
    have to be said again after every reconnect, not only the first connect."""
    broker, _ = edge
    ticks = {"n": 0}
    real_sleep = asyncio.sleep

    async def fast_sleep(_seconds):
        ticks["n"] += 1
        if ticks["n"] == 50:
            broker._connects += 1  # paho reconnected
        if ticks["n"] >= 100:
            monkeypatch.setattr(server, "global_broker", None)
        await real_sleep(0)

    monkeypatch.setattr(server.asyncio, "sleep", fast_sleep)
    await server.status_loop(broker, "ivoryos/edge", "my-deck-7k4m2q")
    monkeypatch.setattr(server.asyncio, "sleep", real_sleep)

    assert len(broker.on("/status")) == 14
    assert len(broker.on("/schema")) == 12

    # And the hook the broker calls on reconnect says "online" at once, before the loop's tick.
    monkeypatch.setattr(server, "global_broker", broker)
    before = len(broker.on("/status"))
    await server._on_reconnected(broker)
    assert len(broker.on("/status")) == before + 1


@pytest.mark.asyncio
async def test_stopping_on_purpose_says_offline(edge):
    """A clean disconnect sends no Last Will, so the edge has to say it."""
    broker, _ = edge
    broker.disconnect = lambda: setattr(broker, "closed", True)
    await server.shutdown_event()
    [status] = broker.on("/status")
    assert status["payload"]["online"] is False and status["retain"] is True
    assert broker.closed is True
    assert server.global_broker is None, "detached, so no 'online' can follow"


# --- workflows: a choice -------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_automatic_sync_sends_a_save_at_once(edge):
    broker, _ = edge
    async with client() as ac:
        assert (await ac.post("/api/workflows/Wash", json=BODY)).status_code == 200
        settings = (await ac.get("/api/cloud-settings")).json()
    assert broker.sequences() == ["Wash"]
    assert settings["sync_workflows"] == "always"
    assert settings["workflow_count"] == 1


@pytest.mark.asyncio
async def test_manual_sync_sends_nothing_until_asked(edge):
    broker, env = edge
    async with client() as ac:
        resp = await ac.post("/api/cloud-settings/sync-mode", json={"mode": "manual"})
        assert resp.json()["sync_workflows"] == "manual"
        assert "CLOUD_SYNC_WORKFLOWS=manual" in env.read_text(), "survives a restart"

        await ac.post("/api/workflows/Wash", json=BODY)
        await ac.post("/api/workflows/Prime", json=BODY)
        assert broker.sequences() == [], "a save stays here"
        assert server.publish_sequences(broker, "ivoryos/edge", "my-deck-7k4m2q") == 0, "and so does a reconnect"
        assert broker.sequences() == []
        assert len(broker.on("/schema")) == 0

        resp = await ac.post("/api/cloud-settings/sync-now")
        assert resp.json()["sent"] == 2
        assert resp.json()["last_workflow_sync"] is not None
    assert broker.sequences() == ["Prime", "Wash"]


@pytest.mark.asyncio
async def test_manual_sync_still_acknowledges_a_push_and_clears_a_delete(edge, monkeypatch):
    """A workflow Cloud sent is echoed (the echo is its acknowledgement), and a delete clears the
    retained copy: neither sends anything Cloud does not already hold."""
    broker, _ = edge
    monkeypatch.setattr(server, "CLOUD_SYNC_WORKFLOWS", "manual")
    await server.handle_broker_message(
        "ivoryos/edge/my-deck-7k4m2q/sequences-push", {"name": "FromCloud", "body": BODY})
    assert broker.sequences() == ["FromCloud"]

    async with client() as ac:
        assert (await ac.delete("/api/workflows/FromCloud")).status_code == 200
    assert [(t, p, r) for t, p, r in broker.client.raw if t.endswith("/sequences/FromCloud")] == [
        ("ivoryos/edge/my-deck-7k4m2q/sequences/FromCloud", b"", True)]


@pytest.mark.asyncio
async def test_switching_to_automatic_sends_what_is_here(edge, monkeypatch):
    broker, _ = edge
    monkeypatch.setattr(server, "CLOUD_SYNC_WORKFLOWS", "manual")
    async with client() as ac:
        await ac.post("/api/workflows/Wash", json=BODY)
        assert broker.sequences() == []
        assert (await ac.post("/api/cloud-settings/sync-mode", json={"mode": "sometimes"})).status_code == 400
        await ac.post("/api/cloud-settings/sync-mode", json={"mode": "always"})
    assert broker.sequences() == ["Wash"]


@pytest.mark.asyncio
async def test_sync_now_needs_a_connection(edge, monkeypatch):
    monkeypatch.setattr(server, "global_broker", None)
    async with client() as ac:
        assert (await ac.post("/api/cloud-settings/sync-now")).status_code == 409


# --- a repeated step: one run at a time, each numbered -----------------------------------------

async def wait_for_statuses(broker, node_id, wanted, timeout_s=5.0):
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        seen = [m["payload"] for m in broker.on("/task-status")
                if m["payload"].get("nodeId") == node_id and "progress" not in m["payload"]]
        if [p["status"] for p in seen][-1:] == [wanted]:
            return seen
        await asyncio.sleep(0.05)
    raise AssertionError(f"never saw '{wanted}' for {node_id}")


@pytest.mark.asyncio
async def test_each_run_of_a_repeated_step_reports_its_number_and_its_own_clock(edge):
    """Cloud sends run 3 of 20 on its own; every report about it says "3", so a redelivered
    report from run 2 cannot finish run 3. `ts` is this device's clock, not arrival time."""
    broker, _ = edge
    block = {"instrument": "dummy", "method": "test_method", "params": {"duration": 0}}
    async with client() as ac:
        await server.handle_cloud_task({
            "runId": "cloud_rep", "nodeId": "n1", "block": block,
            "name": "Screen · dummy.test_method · run 3 of 20", "occurrence": {"index": 3, "total": 20},
        })
        seen = await wait_for_statuses(broker, "n1", "completed")
        assert [p["status"] for p in seen] == ["running", "completed"]
        assert all(p["occurrence"] == 3 for p in seen)
        assert all(isinstance(p["ts"], float) for p in seen)

        runs = (await ac.get("/api/queue/runs")).json()["runs"]
        run = next(r for r in runs if r["name"].endswith("run 3 of 20"))
        assert run["parameters"]["cloud_occurrence"] == {"index": 3, "total": 20}

        [result] = [m["payload"] for m in broker.on("/task-result") if m["payload"]["nodeId"] == "n1"]
        assert result["occurrence"] == 3
        assert result["result"]["parameters"]["cloud_occurrence"]["index"] == 3

        # The next run of the same step is numbered afresh; a step that is not repeated has none.
        await server.handle_cloud_task({"runId": "cloud_rep", "nodeId": "n1", "block": block,
                                        "occurrence": {"index": 4, "total": 20}})
        await asyncio.sleep(0.05)
        seen = await wait_for_statuses(broker, "n1", "completed")
        assert seen[-1]["occurrence"] == 4
        await server.handle_cloud_task({"runId": "cloud_once", "nodeId": "n2", "block": block})
        once = await wait_for_statuses(broker, "n2", "completed")
        assert all("occurrence" not in p for p in once)
