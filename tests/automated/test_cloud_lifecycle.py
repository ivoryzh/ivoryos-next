"""An edge's life with Cloud: a lasting identity, pause, resume, and removing it for good.

Pause keeps the pairing and tells Cloud (so it shows "paused", not "offline"); resume reconnects
with no pairing. Remove tells Cloud the device is leaving, clears what it left retained on the
broker, and forgets the credentials here, but keeps the device's id: that is its identity, so
pairing again later reattaches the same device instead of meeting a stranger with its name.
"""
import asyncio
import json

import pytest

from ivoryos_edge import cloud_pairing, server


def run(coro):
    return asyncio.run(coro)


class Sent:
    def __init__(self):
        self.published = True

    def wait_for_publish(self, timeout=None):
        return True

    def is_published(self):
        return self.published


class FakeClient:
    def __init__(self, connected=True):
        self.connected = connected

    def is_connected(self):
        return self.connected


class FakeBroker:
    def __init__(self, connected=True):
        self.client = FakeClient(connected)
        self.published, self.cleared, self.disconnected = [], [], False

    def publish(self, topic, payload, retain=False, qos=0):
        self.published.append((topic, payload, retain))
        return Sent()

    def clear_retained(self, topic):
        self.cleared.append(topic)
        return Sent()

    def disconnect(self):
        self.disconnected = True


@pytest.fixture
def edge(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("IVORYOS_PORT=8081\nCLOUD_TOKEN=tok\nCLOUD_DEVICE_ID=my-deck-7k4m2q\n")
    certs = tmp_path / ".certs"
    certs.mkdir()
    (certs / "device.private.key").write_text("-----BEGIN RSA PRIVATE KEY-----")
    monkeypatch.setattr(server, "ENV_PATH", str(env))
    monkeypatch.setattr(server, "CERTS_DIR", str(certs))
    monkeypatch.setattr(server, "CLOUD_TOKEN", "tok")
    monkeypatch.setattr(server, "CLOUD_PAUSED", False)
    monkeypatch.setattr(server, "global_topic_prefix", "ivoryos/edge")
    monkeypatch.setattr(server, "global_client_id", "my-deck-7k4m2q")
    monkeypatch.setattr(server, "cloud_connection_state", "connected")
    monkeypatch.setattr(server, "cloud_pairing_session", None)
    monkeypatch.setattr(server.wf, "list_workflow_names", lambda _dir: ["Screen", "Calibrate"])
    broker = FakeBroker()
    monkeypatch.setattr(server, "global_broker", broker)
    return {"env": env, "certs": certs, "broker": broker}


def env_of(edge):
    return cloud_pairing.read_env(str(edge["env"]))


def test_a_device_keeps_one_id(tmp_path):
    env = str(tmp_path / ".env")
    first = cloud_pairing.ensure_device_id(env, "My deck")
    assert first.startswith("my-deck-") and len(first) == len("my-deck-") + 6
    assert cloud_pairing.ensure_device_id(env, "Renamed deck") == first, "a new name is not a new device"
    assert cloud_pairing.new_device_id("My deck") != first, "two 'My deck's are two devices"


def test_a_device_paired_before_ids_keeps_its_cloud_identity(tmp_path):
    import base64
    env = str(tmp_path / ".env")
    token = base64.b64encode(json.dumps({"protocol": "mqtt", "client_id": "E2E Rig"}).encode()).decode()
    cloud_pairing.save_token(env, token)
    assert cloud_pairing.ensure_device_id(env, "anything") == "E2E Rig"


def test_pause_tells_cloud_and_keeps_the_pairing(edge):
    settings = run(server.pause_cloud())
    broker = edge["broker"]
    topic, payload, retain = broker.published[-1]
    assert topic == "ivoryos/edge/my-deck-7k4m2q/status" and retain
    assert payload["online"] is False and payload["paused"] is True
    assert broker.disconnected and server.global_broker is None, "the heartbeat stops with the connection"
    assert settings["connection_state"] == "paused" and settings["paused"] and settings["paired"]
    assert env_of(edge)["CLOUD_PAUSED"] == "1" and env_of(edge)["CLOUD_TOKEN"] == "tok"


def test_a_paused_edge_stays_off_cloud_after_a_restart(edge, monkeypatch):
    monkeypatch.setattr(server, "global_broker", None)
    monkeypatch.setattr(server, "CLOUD_PAUSED", True)
    monkeypatch.setattr(server, "_broker_from_token", lambda t: pytest.fail("a paused edge must not connect"))
    run(server.setup_broker())
    assert server.cloud_connection_state == "paused"


def test_resume_reconnects_without_pairing(edge, monkeypatch):
    run(server.pause_cloud())
    connected = []

    async def fake_setup():
        connected.append(server.CLOUD_PAUSED)
        server.cloud_connection_state = "connected"

    monkeypatch.setattr(server, "setup_broker", fake_setup)
    settings = run(server.resume_cloud())
    assert connected == [False], "connects with the pause lifted"
    assert settings["connection_state"] == "connected" and not settings["paused"]
    assert "CLOUD_PAUSED" not in env_of(edge) and env_of(edge)["CLOUD_TOKEN"] == "tok"


def test_remove_tells_cloud_clears_what_it_left_and_forgets_the_pairing(edge):
    result = run(server.remove_from_cloud())
    broker = edge["broker"]
    base = "ivoryos/edge/my-deck-7k4m2q"
    assert set(broker.cleared) == {f"{base}/status", f"{base}/schema", f"{base}/presence",
                                   f"{base}/sequences/Screen", f"{base}/sequences/Calibrate"}
    assert broker.published[-1][0] == f"{base}/leave", "leave goes last, after the retained state is cleared"
    assert result["told_cloud"] is True and not result["paired"]
    # Closed, not just detached: a live one left behind keeps this device's id and fights every
    # later connection for it.
    assert broker.disconnected and server.global_broker is None
    env = env_of(edge)
    assert "CLOUD_TOKEN" not in env and "CLOUD_PAUSED" not in env
    assert env["CLOUD_DEVICE_ID"] == "my-deck-7k4m2q", "the identity stays; pairing again reattaches it"
    assert env["IVORYOS_PORT"] == "8081", "other settings are untouched"
    assert not (edge["certs"] / "device.private.key").exists(), "the private key is gone"


def test_remove_while_paused_connects_just_to_say_goodbye(edge, monkeypatch):
    run(server.pause_cloud())
    goodbye = FakeBroker(connected=False)

    def connect():
        goodbye.client.connected = True

    goodbye.connect = connect
    monkeypatch.setattr(server, "_broker_from_token", lambda t: (goodbye, "ivoryos/edge", "my-deck-7k4m2q", "mqtt://x"))
    result = run(server.remove_from_cloud())
    assert result["told_cloud"] is True
    assert goodbye.published[-1][0] == "ivoryos/edge/my-deck-7k4m2q/leave" and goodbye.disconnected


def test_remove_forgets_here_even_when_cloud_cannot_be_reached(edge, monkeypatch):
    monkeypatch.setattr(server, "global_broker", None)

    def unreachable(_token):
        raise ConnectionRefusedError("no route to Cloud")

    monkeypatch.setattr(server, "_broker_from_token", unreachable)
    result = run(server.remove_from_cloud())
    assert result["told_cloud"] is False, "the page says Cloud was not told, so it can be removed there"
    assert not result["paired"] and "CLOUD_TOKEN" not in env_of(edge)


def test_cloud_removing_the_device_makes_it_forget_its_pairing(edge):
    run(server.handle_broker_message("ivoryos/edge/my-deck-7k4m2q/removed", {"ts": 1}))
    assert not server.CLOUD_TOKEN and edge["broker"].disconnected
    assert "CLOUD_TOKEN" not in env_of(edge) and env_of(edge)["CLOUD_DEVICE_ID"] == "my-deck-7k4m2q"
    assert "removed" in server.cloud_connection_error


def test_pausing_without_a_pairing_is_refused(edge, monkeypatch):
    monkeypatch.setattr(server, "CLOUD_TOKEN", "")
    assert run(server.pause_cloud()).status_code == 409
    assert run(server.resume_cloud()).status_code == 409
