"""My Plugin: a live side panel for an IvoryOS deck.

Rename `my_plugin` / "My Plugin" / INSTRUMENT, then grow `state()` and the page.
Served at /plugins/my_plugin/ (page), /plugins/my_plugin/api/state, /plugins/my_plugin/events.
"""
import threading

from ivoryos_edge.plugins import Plugin

plugin = Plugin("My Plugin", id="my_plugin", page="page", placement="panel-right")

# The deck's name for the instrument this plugin watches: what the Instruments page shows.
INSTRUMENT = "pump"

_lock = threading.Lock()
_calls = []  # the last few calls, newest last


def state() -> dict:
    """Everything the page draws. Keep it JSON-serializable."""
    with _lock:
        return {"instrument": INSTRUMENT, "calls": list(_calls)}


def _on_call(event: dict) -> None:
    # Runs on the worker thread that ran the step: keep it quick. `args`/`result` can be any
    # Python object, so copy out only what is JSON-safe.
    with _lock:
        _calls.append({
            "phase": event["phase"],
            "method": event["method"],
            "error": str(event["error"]) if "error" in event else None,
        })
        del _calls[:-20]
    plugin.publish(state())


@plugin.on_start
def _start(instruments):
    # The deck is built by now. Never construct or import an instrument here: use the deck's own.
    if INSTRUMENT in instruments:
        plugin.observe(INSTRUMENT, _on_call, starts=True)
    plugin.publish(state())


@plugin.router.get("/api/state")
def get_state():
    return state()
