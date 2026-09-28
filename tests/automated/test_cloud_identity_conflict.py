"""Two edges sharing one Cloud identity (MQTT client id) evict each other about once a second.

MQTT 3.1.1 gives no reason code for a takeover, so the edge recognises the pattern instead:
several drops it did not ask for, close together (broker.LocalMQTTBroker.link_health), and
/api/cloud-settings reports "conflict" rather than the "connected" it recorded at first connect.
"""
import ivoryos_edge.broker as broker_mod
from ivoryos_edge import server
from ivoryos_edge.broker import LocalMQTTBroker


def drop(b, times=1):
    for _ in range(times):
        b._on_disconnect(b.client, None)


def test_three_unrequested_drops_close_together_is_flapping():
    b = LocalMQTTBroker("dup", "127.0.0.1", 1883)
    drop(b, 2)
    assert not b.link_health()["flapping"]
    drop(b)
    health = b.link_health()
    assert health["flapping"] and health["recent_drops"] == 3


def test_disconnecting_on_purpose_is_not_a_drop():
    b = LocalMQTTBroker("solo", "127.0.0.1", 1883)
    b.disconnect()
    drop(b, 5)  # paho reports our own disconnect through the same callback
    assert b.link_health()["recent_drops"] == 0


def test_old_drops_age_out(monkeypatch):
    b = LocalMQTTBroker("dup", "127.0.0.1", 1883)
    now = [1000.0]
    monkeypatch.setattr(broker_mod.time, "time", lambda: now[0])
    drop(b, 3)
    assert b.link_health()["flapping"]
    now[0] += LocalMQTTBroker.FLAP_WINDOW_S + 1
    assert not b.link_health()["flapping"]


class FakeBroker:
    def __init__(self, **health):
        self.health = {"connected": True, "recent_drops": 0, "flapping": False, **health}

    def link_health(self):
        return self.health


def test_cloud_settings_reports_the_conflict_and_never_the_token(monkeypatch):
    monkeypatch.setattr(server, "CLOUD_TOKEN", "secret-token-value")
    monkeypatch.setattr(server, "global_client_id", "edge-device-01")
    monkeypatch.setattr(server, "cloud_connection_state", "connected")
    monkeypatch.setattr(server, "cloud_connection_error", None)

    monkeypatch.setattr(server, "global_broker", FakeBroker(connected=False, recent_drops=4, flapping=True))
    s = server.get_cloud_settings()
    assert s["connection_state"] == "conflict"
    assert "edge-device-01" in s["connection_error"]
    assert s["pairing_file"].endswith(".env")
    assert "secret-token-value" not in repr(s)

    monkeypatch.setattr(server, "global_broker", FakeBroker(connected=False))
    assert server.get_cloud_settings()["connection_state"] == "reconnecting"

    monkeypatch.setattr(server, "global_broker", FakeBroker())
    assert server.get_cloud_settings()["connection_state"] == "connected"


class Msg:
    def __init__(self, topic, payload, retain=False):
        self.topic, self.retain = topic, retain
        self.payload = payload if isinstance(payload, bytes) else __import__("json").dumps(payload).encode()


def presence_broker(monkeypatch):
    b = LocalMQTTBroker("dup", "127.0.0.1", 1883)
    sent = []
    monkeypatch.setattr(b.client, "subscribe", lambda topic, *a, **k: sent.append(("sub", topic)))
    monkeypatch.setattr(b.client, "publish", lambda topic, payload=None, **k: sent.append(("pub", topic, payload, k.get("retain"))))
    return b, sent


def test_another_session_announcing_itself_is_a_conflict(monkeypatch):
    b, sent = presence_broker(monkeypatch)
    b.watch_identity("p/dup/presence", "mine")
    assert ("sub", "p/dup/presence") in sent
    assert any(s[0] == "pub" and s[3] is True and '"mine"' in s[2] for s in sent), "announces itself, retained"

    b._on_message(b.client, None, Msg("p/dup/presence", {"session": "mine", "ts": 9e12}))
    assert b.link_health()["other_session"] is None, "our own announcement echoed back"

    b._on_message(b.client, None, Msg("p/dup/presence", {"session": "theirs", "ts": 9e12}, retain=True))
    assert b.link_health()["other_session"] == "theirs"


def test_a_retained_announcement_from_before_we_started_is_our_previous_run(monkeypatch):
    b, _ = presence_broker(monkeypatch)
    b.watch_identity("p/dup/presence", "mine")
    b._on_message(b.client, None, Msg("p/dup/presence", {"session": "lastrun", "ts": 1.0}, retain=True))
    assert b.link_health()["other_session"] is None


def test_presence_messages_never_reach_the_app(monkeypatch):
    b, _ = presence_broker(monkeypatch)
    seen = []
    b.on_message_callback = lambda topic, payload: seen.append(topic)
    b.loop = object()
    b.watch_identity("p/dup/presence", "mine")
    b._on_message(b.client, None, Msg("p/dup/presence", {"session": "theirs", "ts": 9e12}))
    assert seen == []


def test_every_reconnect_restores_the_subscriptions(monkeypatch):
    # A clean MQTT session forgets subscriptions on disconnect and paho does not restore them;
    # without this an edge came back online deaf to Cloud tasks until restarted.
    b, sent = presence_broker(monkeypatch)
    b.subscribe("p/dup/execute")
    b.subscribe("p/dup/sequences-push")
    sent.clear()
    b._on_connect(b.client, None, {}, 0)
    assert [s[1] for s in sent if s[0] == "sub"] == ["p/dup/execute", "p/dup/sequences-push"]
