"""Python plugins: a page plus an API that runs inside the edge, with the deck's live instruments.

    from ivoryos_edge.plugins import Plugin

    plugin = Plugin("Barista visual", placement="panel-left", page="static")

    @plugin.router.get("/api/state")
    def state():
        machine = plugin.instrument("coffee_machine")   # the object the deck built, not a copy
        return {"level": machine.level}

A plugin is handed the instrument objects the deck already constructed. It must never construct
or import them itself: a driver's constructor opens its serial port or socket, so a second copy
either fails ("port busy") or, worse, succeeds and fights the first one for the hardware. That is
the whole reason this module exists -- the legacy Flask blueprints had no way to receive the deck,
so each plugin found its own route to the objects (patching a class's __init__, importing the
deck script), and the second of those re-runs the script.

Where a plugin's pieces are served, for a plugin with id "barista_visual":
    /plugins/barista_visual/              its page (index.html in `page`)
    /plugins/barista_visual/<route>       its router, e.g. /plugins/barista_visual/api/state
    /plugins/barista_visual/events        a websocket carrying whatever it publish()es

A page therefore reaches its own API with a relative URL (fetch("api/state")) and needs to know
nothing about the host or port it is served from.
"""

from __future__ import annotations

import asyncio
import functools
import importlib
import inspect
import os
import re
import threading
import time
import traceback
from typing import Any, Callable, Iterable

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

PLACEMENTS = ("tab", "panel-left", "panel-right")


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "plugin"


class Plugin:
    """One plugin. Create it at module level and point the deck (or `run(plugins=[...])`) at it.

    name       shown in the sidebar
    id         URL segment; defaults to a slug of the name. Keep it stable: it is the address.
    page       folder holding index.html (and its assets). Relative paths are resolved against
               the file that creates the Plugin, so `page="static"` means "beside this file".
    placement  "tab" (a full page, the default), "panel-left" or "panel-right" (a side panel
               beside every page, for live visualization).
    icon       an optional lucide icon name for the sidebar.
    """

    def __init__(self, name: str, *, id: str | None = None, page: str | None = None,
                 placement: str = "tab", icon: str | None = None):
        if placement not in PLACEMENTS:
            raise ValueError(f"placement must be one of {PLACEMENTS}, not {placement!r}")
        self.name = name
        self.id = id or _slug(name)
        self.placement = placement
        self.icon = icon
        if page is not None and not os.path.isabs(page):
            caller = inspect.stack()[1].filename
            page = os.path.join(os.path.dirname(os.path.abspath(caller)), page)
        self.page = page
        self.router = APIRouter()
        # The deck's own mapping, assigned by the edge before anything runs (see attach). Not a
        # copy: an instrument added to or replaced in the deck is the same object seen here.
        self.instruments: dict[str, Any] = {}
        self._on_start: list[Callable] = []
        self._sockets: set[WebSocket] = set()
        self._last: Any = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()
        self.router.add_api_websocket_route("/events", self._events)

    # --- the deck -----------------------------------------------------------------------------------

    def instrument(self, name: str) -> Any:
        """The live instrument called `name`, as the deck built it."""
        try:
            return self.instruments[name]
        except KeyError:
            loaded = ", ".join(sorted(self.instruments)) or "none"
            raise KeyError(f"Plugin '{self.id}' asked for instrument '{name}', which this deck does not have "
                           f"(loaded: {loaded}). It may have failed to load; see the Instruments page.") from None

    def on_start(self, fn: Callable) -> Callable:
        """Decorator: run `fn(instruments)` once, after the deck is built and before the edge
        serves anything, so wrapping (observe) is in place before the schema is read."""
        self._on_start.append(fn)
        return fn

    def observe(self, instrument: str | Any, callback: Callable[[dict], None],
                methods: Iterable[str] | None = None, *, starts: bool = False) -> None:
        """Call `callback(event)` after every call of the instrument's methods (or just `methods`),
        and, with `starts=True`, also as each call begins.

        This replaces patching a driver class: it wraps methods on this one live object, keeping
        each method's name, signature and docstring (functools.wraps), so the Designer shows
        the same parameters and the queue awaits async methods as before. Wrapping happens on the
        instance, so the class and any other instance are untouched.

        The event: {"phase": "end", "instrument", "method", "args", "result" | "error", "started",
        "finished"}. With `starts=True` a {"phase": "start", "instrument", "method", "args",
        "started"} event comes first: that is what lets an animation show a step *while* it runs
        (a pour during a 30-second dispense) rather than only once it has finished.
        A sync method's callback runs on the worker thread that ran the method; keep it quick
        and let publish() carry anything to the page.
        """
        name = instrument if isinstance(instrument, str) else next(
            (k for k, v in self.instruments.items() if v is instrument), type(instrument).__name__)
        obj = self.instrument(instrument) if isinstance(instrument, str) else instrument
        chosen = list(methods) if methods is not None else [
            m for m in dir(type(obj))
            if not m.startswith("_") and inspect.isfunction(inspect.getattr_static(type(obj), m, None))
        ]
        for method_name in chosen:
            original = getattr(obj, method_name)
            setattr(obj, method_name, _observed(original, name, method_name, callback, self.id, starts))

    # --- pushing to the page ----------------------------------------------------------------------

    def publish(self, message: Any) -> None:
        """Send `message` (anything JSON-serializable) to every open page of this plugin.

        Safe from any thread, including an observe() callback on a worker thread. The last
        message is kept and sent to each page as it connects, so a page opened mid-run starts
        from the current state instead of waiting for the next change.
        """
        with self._lock:
            self._last = message
            sockets = list(self._sockets)
            loop = self._loop
        if not sockets or loop is None or loop.is_closed():
            return
        for ws in sockets:
            coro = self._send(ws, message)
            try:
                running = asyncio.get_running_loop()
            except RuntimeError:
                running = None
            if running is loop:
                loop.create_task(coro)
            else:
                asyncio.run_coroutine_threadsafe(coro, loop)

    async def _send(self, ws: WebSocket, message: Any) -> None:
        try:
            await ws.send_json(message)
        except Exception:
            with self._lock:
                self._sockets.discard(ws)

    async def _events(self, ws: WebSocket) -> None:
        await ws.accept()
        with self._lock:
            self._loop = asyncio.get_running_loop()
            self._sockets.add(ws)
            last = self._last
        try:
            if last is not None:
                await ws.send_json(last)
            while True:
                await ws.receive_text()  # pages only listen; this just notices the close
        except WebSocketDisconnect:
            pass
        finally:
            with self._lock:
                self._sockets.discard(ws)

    def describe(self) -> dict:
        return {"id": self.id, "name": self.name, "url": f"/plugins/{self.id}/", "placement": self.placement,
                "icon": self.icon, "kind": "python"}


def _observed(original: Callable, instrument: str, method: str, callback: Callable, plugin_id: str,
              starts: bool = False) -> Callable:
    def report(started, phase="end", **outcome):
        try:
            event = {"phase": phase, "instrument": instrument, "method": method, "started": started, **outcome}
            if phase == "end":
                event["finished"] = time.time()
            callback(event)
        except Exception:
            # A broken visualization must never fail the step that moved the hardware.
            print(f"Plugin '{plugin_id}': observe callback failed for {instrument}.{method}:\n{traceback.format_exc()}")

    if inspect.iscoroutinefunction(original):
        @functools.wraps(original)
        async def wrapper(*args, **kwargs):
            started = time.time()
            if starts:
                report(started, phase="start", args=kwargs)
            try:
                result = await original(*args, **kwargs)
            except Exception as e:
                report(started, args=kwargs, error=str(e))
                raise
            report(started, args=kwargs, result=result)
            return result
    else:
        @functools.wraps(original)
        def wrapper(*args, **kwargs):
            started = time.time()
            if starts:
                report(started, phase="start", args=kwargs)
            try:
                result = original(*args, **kwargs)
            except Exception as e:
                report(started, args=kwargs, error=str(e))
                raise
            report(started, args=kwargs, result=result)
            return result
    return wrapper


class PluginFiles:
    """A plugin's page files, served so the browser always rechecks them (`no-cache`).

    Without a caching header the browser guesses how long a file stays fresh, and reuses a
    plugin's old JavaScript after it was edited: the person reloads, sees no change, and cannot
    tell why. `no-cache` still lets an unchanged file come back as a cheap 304.
    """

    def __new__(cls, directory: str):
        from fastapi.staticfiles import StaticFiles

        class _NoCache(StaticFiles):
            def file_response(self, *args, **kwargs):
                response = super().file_response(*args, **kwargs)
                response.headers["Cache-Control"] = "no-cache"
                return response

        return _NoCache(directory=directory, html=True)


def _is_flask_blueprint(obj) -> bool:
    """By class, without importing flask (which a v2 deck need not have installed)."""
    return any(c.__name__ == "Blueprint" and c.__module__.startswith("flask") for c in type(obj).__mro__)


def load_plugin_refs(refs: Iterable[str]) -> tuple[list[Plugin], list[dict]]:
    """Import the plugins a deck file lists, as "package.module:attribute" (attribute defaults
    to `plugin`). One that fails is reported, never fatal, the same rule as instruments."""
    plugins, errors = [], []
    for ref in refs or []:
        module_name, _, attr = str(ref).partition(":")
        try:
            obj = getattr(importlib.import_module(module_name), attr or "plugin")
            if not isinstance(obj, Plugin):
                if _is_flask_blueprint(obj):
                    # A v1 plugin: the original IvoryOS's plugin form, which this edge cannot run.
                    # Say what it is and where the port is described, not just the type name.
                    raise TypeError(
                        f"{ref} is a v1 plugin (a Flask Blueprint for the original IvoryOS). This IvoryOS "
                        "runs only v2 plugins (ivoryos_edge.plugins.Plugin); see 'Moving a Flask blueprint "
                        "plugin over' in docs/plugins.md")
                raise TypeError(f"{ref} is a {type(obj).__name__}, not an ivoryos_edge.plugins.Plugin")
            plugins.append(obj)
        except Exception as e:
            errors.append({"plugin": str(ref), "stage": "import", "error": f"{type(e).__name__}: {e}",
                           "detail": traceback.format_exc()})
    return plugins, errors


def start_plugin(app, plugin: Plugin, instruments: dict) -> dict | None:
    """Give `plugin` the deck, run its on_start hooks, and serve it. Returns an error entry if a
    hook failed; the plugin is still served, so its page can say what is wrong."""
    plugin.instruments = instruments
    error = None
    for hook in plugin._on_start:
        try:
            hook(instruments)
        except Exception as e:
            error = {"plugin": plugin.id, "stage": "on_start", "error": f"{type(e).__name__}: {e}",
                     "detail": traceback.format_exc()}
            print(f"Plugin '{plugin.id}' on_start failed: {e}")
            break
    # Routes before the page: a mount at the same prefix would otherwise swallow them.
    app.include_router(plugin.router, prefix=f"/plugins/{plugin.id}")
    if plugin.page:
        if os.path.isdir(plugin.page):
            app.mount(f"/plugins/{plugin.id}", PluginFiles(plugin.page), name=f"plugin_{plugin.id}")
        else:
            error = error or {"plugin": plugin.id, "stage": "page", "error": f"page folder not found: {plugin.page}"}
    return error
