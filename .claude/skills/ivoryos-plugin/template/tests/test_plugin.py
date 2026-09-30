"""Loads the plugin the way the edge does (start_plugin), against a stand-in instrument."""
from fastapi import FastAPI
from fastapi.testclient import TestClient
from ivoryos_edge.plugins import start_plugin

from my_plugin import plugin
from my_plugin.plugin import INSTRUMENT


class FakeInstrument:
    """Replace with the real driver class if it can be built without hardware."""

    def dispense(self, volume_ml: float) -> float:
        return volume_ml


def test_page_state_and_live_updates():
    instrument = FakeInstrument()
    app = FastAPI()
    start_plugin(app, plugin, {INSTRUMENT: instrument})
    client = TestClient(app)

    assert client.get(f"/plugins/{plugin.id}/").status_code == 200

    instrument.dispense(volume_ml=1.5)  # observed: the plugin sees the deck's own object
    calls = client.get(f"/plugins/{plugin.id}/api/state").json()["calls"]
    assert [(c["phase"], c["method"]) for c in calls][-2:] == [("start", "dispense"), ("end", "dispense")]

    with client.websocket_connect(f"/plugins/{plugin.id}/events") as ws:
        assert ws.receive_json()["calls"] == calls  # the last publish is replayed on connect
