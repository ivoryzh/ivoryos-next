# Plugins: writing one, and moving a legacy Flask plugin over

A plugin adds a page to IvoryOS: a full-page **tab** (a calculator, a data viewer, a robot
position helper) or a **side panel** that stays beside every page (a live animation of the
bench, a camera view, a running plot). It may bring a small Python API that runs inside the
edge and works with the deck's instruments.

This guide is written for two readers: a person moving their own plugin over, and an AI agent
asked to do it. Section 7 is the agent's checklist.

---

## 1. The one rule: never make a second copy of an instrument

A driver's constructor usually opens something: a serial port, a socket, a USB handle. The
deck builds each instrument **once**. A plugin must use *those* objects, never construct its own
and never import the deck script to reach them.

A second copy either fails ("port is busy") or, worse, succeeds and two objects fight over one
instrument. Importing the deck script is the same mistake in disguise: a script started as
`python demo.py` runs as the module `__main__`, so `import demo` executes the file **again** and
constructs every instrument a second time.

The plugin API hands you the deck's own objects:

```python
shaker = plugin.instrument("shaker")   # the object the deck built; the Instruments page name
```

`tests/automated/test_plugins.py` proves this against a real edge: the plugin reads the object
the edge executes steps on, and the driver's constructor runs exactly once, for a deck file and
for a script. (The edge also registers a running script under its own file name, so a leftover
`import demo` inside a route returns the running module instead of re-running it. That is a
safety net for old code, not something to rely on.)

---

## 2. What a plugin is

```text
my_plugin/
├── __init__.py        # empty, or `from .plugin import plugin`
├── plugin.py          # the Plugin object and its API routes (optional: a page-only plugin needs none)
└── page/
    ├── index.html     # the page; any HTML/JS/CSS, or a Vite/React build output
    └── app.js
```

```python
# my_plugin/plugin.py
from ivoryos_edge.plugins import Plugin

plugin = Plugin(
    "Shaker view",            # shown in the sidebar
    page="page",              # folder with index.html, relative to this file
    placement="panel-right",  # "tab" (default), or "panel-left"/"panel-right": opens in a window over the pages
    icon="activity",          # optional lucide icon name
)

@plugin.router.get("/api/state")
def state():
    shaker = plugin.instrument("shaker")
    return {"rpm": shaker.rpm}
```

The edge serves it at:

| Address | What |
|---|---|
| `/plugins/shaker_view/` | the page (`page/index.html`) |
| `/plugins/shaker_view/api/state` | a route on `plugin.router` |
| `/plugins/shaker_view/events` | a websocket carrying whatever the plugin `publish()`es |

The id (`shaker_view`) is the name in lower case with underscores; pass `id=` to choose it. Keep
it stable: it is the plugin's address.

Because the page and its API share a prefix, **the page reaches its API with relative URLs**
(`fetch("api/state")`) and never needs to know the host or port.

### The API in full

| | |
|---|---|
| `Plugin(name, *, id=None, page=None, placement="tab", icon=None)` | create one, at module level |
| `plugin.router` | a FastAPI `APIRouter`: `@plugin.router.get(...)`, `.post`, `.websocket` |
| `plugin.instrument(name)` | the live instrument; a clear error listing what *is* loaded if the name is wrong |
| `plugin.instruments` | the deck's whole `{name: object}` mapping (the deck's own dict, not a copy) |
| `@plugin.on_start` | `fn(instruments)`, run once after the deck is built and before the edge serves anything |
| `plugin.observe(name, callback, methods=None)` | call `callback(event)` after each call of that instrument's methods |
| `plugin.publish(message)` | send JSON to every open page of this plugin, from any thread |

`observe` events look like
`{"instrument", "method", "args", "result"` or `"error", "started", "finished"}`.
It wraps methods on that one live object (not the class), keeps each method's signature (so the
Designer shows the same parameters) and keeps async methods async. A callback that raises is
logged and never fails the step.

`publish` keeps the last message and sends it to each page as it connects, so a panel opened
mid-run starts from the current state.

### Registering it

**Script deck** (`demo.py`): pass it to `run`.

```python
import ivoryos_edge
from my_plugin import plugin

shaker = Shaker(port="COM3")

if __name__ == "__main__":
    ivoryos_edge.run(__name__, plugins=[plugin])
```

**Deck file** (the desktop launcher's decks): list it. Put a local plugin's folder in `paths`;
a pip-installed plugin goes in `packages`.

```json
{
  "format": "ivoryos-deck/1",
  "packages": ["my-lab-plugins==0.3.0"],
  "paths": ["plugins_src"],
  "plugins": ["my_plugin.plugin:plugin"],
  "instruments": [ ... ]
}
```

A plugin that fails to import, or whose `on_start` raises, is listed under `errors` in
`GET /api/plugins` and the rest of the edge starts normally, the same rule as instruments.

**Page only, no Python**: a folder with an `index.html` inside `plugins/` beside the script or
deck file still works exactly as before.

---

## 3. Writing the page

- **Relative URLs everywhere**: `fetch("api/state")`, `<script src="app.js">`. A Vite build needs
  `base: './'`, and any hard-coded `fetch('/file.json')` in its source must become
  `` `${import.meta.env.BASE_URL}file.json` ``.
- **Live updates from the plugin**: open the events websocket.

  ```js
  const url = new URL("events", location.href);
  url.protocol = url.protocol.replace("http", "ws");
  const ws = new WebSocket(url);
  ws.onmessage = (e) => render(JSON.parse(e.data));
  ws.onclose = () => setTimeout(() => location.reload(), 2000); // the edge restarted
  ```

  Polling a route (`setInterval(() => fetch("api/state")...)`) is also fine for slow-changing
  state and survives restarts on its own.
- **Push, don't poll, for anything watched during a run.** Measured with the barista page: its
  poll backed off to every 5 s when idle, so a 4-step workflow that finished in 0.9 s appeared
  on screen at 3.3 s, all four steps in one frame. Pushed over `events` (with
  `observe(..., starts=True)` so a step is announced as it *begins*), the first step showed 50 ms
  after the run started and every step appeared in order. Play pushed events through a small
  queue that holds each one briefly (the barista page holds 600 ms, 250 ms when more are
  waiting), or a burst of fast steps still collapses into one frame.
- **Following runs without any Python**: the edge's own websocket `/api/ws/queue` sends
  `{runs, status}` after every step: each live run with its steps, their status and outputs.
  Many visualizations need nothing more.
- **Moving hardware from a page**: call the edge, not the driver. `POST /api/execute` with
  `{module, method, args}` (or queue a run with `POST /api/queue/runs`) goes through the same
  casting and busy checks as the Instruments page. A route of your own that calls
  `plugin.instrument("pump").dispense(...)` bypasses the queue and can move hardware in the middle
  of someone's run. Reading state directly is fine; moving things directly needs a good reason.
- The page runs in an iframe with scripts, forms, popups and downloads allowed.
- Plugin files are served with `Cache-Control: no-cache`, so an edited page is picked up on the
  next reload (unchanged files come back as a cheap 304). Before that, browsers kept running a
  plugin's old JavaScript after it was edited.
- A side panel starts 420 px wide and people resize it (280 px up to most of the window) or float
  it: design for 300–600 px wide and any height, and let it scroll. Minimized, the page is laid
  out at 440 px and shown at about 70%, so keep the essential state in the top ~300 px.
- A panel is meant to be watched during runs. Prefer the `events` websocket (`plugin.publish`)
  over polling for anything that changes step by step: a poll every second misses steps that take
  less than that.

---

## 4. Moving a Flask blueprint plugin over

### Mapping

| Legacy (Flask blueprint) | New |
|---|---|
| `bp = Blueprint("name", __name__, template_folder=..., static_folder=...)` | `plugin = Plugin("Name", page="page")` |
| `bp.plugin_type = "left_panel"` | `placement="panel-left"` (no type meant `"tab"`) |
| `@bp.route("/x")` | `@plugin.router.get("/x")` |
| `@bp.route("/x", methods=["POST"])` | `@plugin.router.post("/x")` |
| `request.args.get("since", "0")` then `int(...)` | a parameter: `def state(since: int = 0)` |
| `request.json` / `request.get_json()` | a parameter: `def event(data: dict = Body(...))`, or a pydantic model |
| `request.form[...]` | `Form(...)` parameters (needs `python-multipart`); prefer sending JSON |
| `return jsonify(x)` | `return x` |
| `return jsonify(error=...), 400` | `raise HTTPException(400, "...")` |
| `render_template("page.html", code=code)` | a static `index.html` that fetches `api/...` for its data (below) |
| `url_for("bp.static", filename="css/a.css")` | `css/a.css` (move `static/` contents into `page/`) |
| `url_for("bp.state")` | `api/state` |
| `{% if base_exists %}{% extends "base.html" %}` | delete: the page is always standalone |
| `current_app`, `app.register_blueprint` | not needed |
| `init_socketio(socketio)` + `socketio.emit("x", data)` | `plugin.publish({"type": "x", **data})` |
| `@socketio.on("request_sync_state")` | not needed: the last `publish` is sent on connect |
| client `io()` / `socket.on("x", ...)` | a `WebSocket` on `events` (section 3) |
| wrapping a driver **class's** `__init__` to catch the instance | `plugin.instrument("name")` |
| wrapping a driver **class's** methods to see calls | `plugin.observe("name", callback)` in `on_start` |
| `import demo` / `from my_deck import pump` | `plugin.instrument("pump")` |
| `ivoryos.run(__name__, blueprint_plugins=[bp])` | `ivoryos_edge.run(__name__, plugins=[plugin])` |

**Templates.** A Jinja page that only fills in data (`{{ code }}`) is simplest as static HTML
plus one JSON route: the template's variables become the route's return value, and a few lines of
JS put them on the page. If a template is large and worth keeping, add `jinja2` to the deck's
`packages` and use `fastapi.templating.Jinja2Templates`; remember `url_for` and `base.html` still
have to go.

### Example 1: a tab plugin that renders a template

Before (`demo_code_plugin`):

```python
source_code = Blueprint("About", __name__, template_folder=os.path.join(os.path.dirname(__file__), "templates"))

@source_code.route('/')
def main():
    base_exists = "base.html" in current_app.jinja_loader.list_templates()
    with open(os.path.join(os.path.dirname(__file__), 'demo_code.py')) as f:
        code = f.read()
    return render_template('example.html', base_exists=base_exists, code=code)
```

After:

```python
# demo_code_plugin/plugin.py
import os
from ivoryos_edge.plugins import Plugin

plugin = Plugin("About", page="page")

@plugin.router.get("/api/code")
def code():
    with open(os.path.join(os.path.dirname(__file__), "demo_code.py"), encoding="utf-8") as f:
        return {"code": f.read()}
```

```html
<!-- demo_code_plugin/page/index.html -->
<pre id="code">Loading…</pre>
<script>
  fetch("api/code").then(r => r.json()).then(d => { document.getElementById("code").textContent = d.code; });
</script>
```

### Example 2: a live side panel (the barista visual)

Before: `runtime.py` patched `CoffeeMachine.__init__` and `ScoringCustomer.__init__` to find the
instances, patched the class methods to record events, and the page polled `api/state`.

After: no patching of classes. The deck's objects are handed over, `observe` records the
calls, and the existing page keeps polling `api/state` unchanged. This is the version that was
run against the real `barista_demo` package (steps executed through the edge, the page showing
the result live):

```python
# barista_visual_plugin/plugin.py
import time
from collections import deque
from threading import Lock

from ivoryos_edge.plugins import Plugin

plugin = Plugin("Barista visual", page="page", placement="panel-left")
_lock = Lock()
_events: deque = deque(maxlen=100)
_seq = 0
_last_score = None


def snapshot() -> dict:
    machine = plugin.instrument("coffee_machine")
    s = machine.state
    return {
        "bean_grams": round(s.bean_grams, 2), "sugar_grams": round(s.sugar_grams, 2),
        "milk_ml": round(s.milk_ml, 2), "water_ml": round(s.water_ml, 2),
        "cup_size_ml": round(machine.cup_size_ml, 2),
        "score": None if _last_score is None else round(_last_score, 2),
    }


def record(event: dict) -> None:
    """Called by observe() on the worker thread running each step: once as the step starts,
    once as it ends. Every call is pushed to the page straight away (publish)."""
    global _seq, _last_score
    if event["phase"] == "start":
        # Not part of the history the page replays on reconnect: it says what is happening now.
        plugin.publish({"phase": "start", "type": event["method"], "timestamp": event["started"]})
        return
    if "error" in event:
        plugin.publish({"phase": "failed", "type": event["method"], "timestamp": time.time()})
        return  # nothing changed in the cup
    with _lock:
        if event["method"] == "taste":
            _last_score = event["result"]
        _seq += 1
        entry = {"phase": "end", "seq": _seq, "type": event["method"], "timestamp": time.time(), "snapshot": snapshot()}
        _events.append(entry)
    plugin.publish(entry)


@plugin.on_start
def setup(instruments):
    # The old runtime patched ScoringCustomer.__init__ so a customer built without a machine
    # tasted the deck's machine. Do that link once, explicitly.
    customer = plugin.instrument("customer")
    customer.machine = plugin.instrument("coffee_machine")
    plugin.observe("coffee_machine", record, methods=["add_beans", "add_sugar", "add_milk", "top_up_with_hot_water"], starts=True)
    plugin.observe("customer", record, methods=["taste"], starts=True)


@plugin.router.get("/api/state")
def state(since: int = 0):
    with _lock:
        return {"snapshot": snapshot(), "events": [e for e in _events if e["seq"] > since]}


@plugin.router.get("/api/preference")
def preference():
    customer = plugin.instrument("customer")
    p = customer.preference
    return {"preference": {
        "bean_grams": round(p.bean_grams, 2), "sugar_grams": round(p.sugar_grams, 2), "milk_ml": round(p.milk_ml, 2),
        "water_ml": round(customer.machine.cup_size_ml - p.milk_ml, 2),
    }}
```

Three things this port surfaced, which apply to most panel plugins:

- **Links the old code made by patching have to be made explicitly.** `ScoringCustomer()`
  creates its own `CoffeeMachine`; the legacy runtime silently rewired every customer to the most
  recent machine by patching `__init__`. Here `on_start` does it once, in the open. (A deck file
  cannot yet pass one instrument into another's constructor, so `on_start` is also where such a
  link goes for a deck-file deck.)
- **Observed calls include nested ones.** `taste()` calls `top_up_with_hot_water()`, so both are
  recorded, exactly as with the old class patch.
- **Failed calls are observed too** (with `"error"` instead of `"result"`): skip them, or show
  them, but do not treat them as a change of state.

The page moved from `templates/barista_visual.html` + `static/` into `page/`: the template became
`page/index.html` by replacing each `url_for(...)` with its relative path
(`css/barista_visual.css`, `api/state`) and deleting the `{% block %}` lines; nothing else in the
page changed. Switching it from polling to the `events` websocket is optional.

Use the names the deck gives the instruments (`coffee_machine`, `customer` above: whatever the
Instruments page shows), not the variable names you remember from an old script.

### Steps

1. Create `page/` and move the blueprint's `static/` files into it. Turn the main template into
   `page/index.html`: drop `{% extends %}`/`{% block %}`, replace each `url_for(...)` with a
   relative path, and replace `{{ values }}` with data fetched from a route.
2. Create `plugin.py` with `plugin = Plugin(...)`, carrying over the name and `plugin_type`
   (as `placement`).
3. Convert each `@bp.route` to `@plugin.router.get/post` with the mapping table. Delete `/` and
   `/widget` routes that only rendered the page: the page is served automatically.
4. Find every way the old code reached an instrument (class patching, `import` of the deck,
   module globals) and replace it with `plugin.instrument("name")`, `plugin.observe(...)` and
   `@plugin.on_start`.
5. Replace Socket.IO with `plugin.publish(...)` and a `WebSocket` on `events`.
6. Register it (section 2), start the deck, open it from the sidebar, and check the
   Instruments page loaded every instrument the plugin needs.
7. Add a test (section 6).

---

## 5. Threads, and keeping it maintainable

- Sync driver methods run on worker threads, so `observe` callbacks can run on several threads.
  Guard shared state with a `Lock`, keep callbacks short, and let `publish` carry data out.
- Routes defined with `def` run on a thread pool; `async def` routes run on the event loop, so
  never call a slow driver method from an `async def` route.
- Never `import flask`, and never start your own server, thread loop or `asyncio.run` inside
  a plugin: the edge owns the process.
- Keep state the page needs in the plugin module (a dict, a `deque`), not on the driver object.
- Plugin names in `plugin.instrument(...)` are configuration. If a deck may call them something
  else, read the name from an environment variable with a default.

---

## 6. Testing a plugin

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient
from ivoryos_edge.plugins import start_plugin
from barista_visual_plugin.plugin import plugin
from barista_demo import CoffeeMachine, ScoringCustomer

def test_state_reflects_the_machine():
    machine, customer = CoffeeMachine(), ScoringCustomer()
    app = FastAPI()
    start_plugin(app, plugin, {"coffee_machine": machine, "customer": customer})
    assert customer.machine is machine
    machine.add_beans(12)
    customer.taste()
    client = TestClient(app)
    body = client.get("/plugins/barista_visual/api/state").json()
    assert body["snapshot"]["bean_grams"] == 12
    assert [e["type"] for e in body["events"]] == ["add_beans", "top_up_with_hot_water", "taste"]  # taste() tops up first
    assert body["snapshot"]["score"] is not None
    assert "bean_grams" in client.get("/plugins/barista_visual/api/preference").json()["preference"]
    page = client.get("/plugins/barista_visual/")
    assert page.status_code == 200 and 'data-state-url="api/state"' in page.text
    assert client.get("/plugins/barista_visual/css/barista_visual.css").status_code == 200
```

`start_plugin` is exactly what the edge does at startup: hand over the instruments, run
`on_start`, mount the routes and page.

---

## 7. For an AI agent doing the conversion

Give the agent this document, the old plugin's folder, and the deck (script or deck file) it
runs with. Instructions to include:

> Convert the Flask blueprint plugin in `<folder>` to an IvoryOS NextGen plugin following
> `docs/plugins.md`. Keep its behaviour and page appearance the same. Use the deck in
> `<deck>` to learn the instrument names.

**Must be true when done** (check each one):

- [ ] No `flask`, `flask_socketio`, `Blueprint`, `render_template`, `url_for`, `jsonify`,
      `current_app` or `request.` remain (`grep -rnE "flask|Blueprint|render_template|url_for|jsonify|current_app|request\\." <folder>`).
- [ ] No driver class is constructed anywhere in the plugin (no `SomeDriver(` calls), and no
      driver class is patched (`setattr(SomeClass, ...)`, `SomeClass.method = ...`).
- [ ] The deck script is not imported (`import demo`, `from demo import`, `import __main__`).
- [ ] Every instrument is reached through `plugin.instrument("<name>")` or
      `plugin.instruments`, with names that exist in the deck.
- [ ] Watching calls uses `plugin.observe` inside `@plugin.on_start`, not wrappers written by
      hand, and the callback ignores events carrying `"error"` unless it means to show failures.
- [ ] Anything the old code wired up by patching a constructor (one object pointing at another,
      as the barista customer and machine) is now done explicitly in `on_start`.
- [ ] Every URL in the page is relative (no leading `/` for the plugin's own files or routes).
      `/api/...` for the edge's own API is fine.
- [ ] `placement` matches the old `plugin_type` (`left_panel` becomes `panel-left`, none becomes `tab`).
- [ ] A test like section 6 passes, and the plugin loads with no entry under `errors` in
      `GET /api/plugins`.
- [ ] Routes that move hardware either call the edge (`/api/execute`, a queued run) or are
      explicitly called out in a comment explaining why they bypass the queue.

**Ask the person rather than guess** when the old plugin reaches something that is not a deck
instrument (a module-level simulation state, a file on disk, another process), or when it is
unclear which deck instrument a patched class corresponds to.

---

## 8. Status

- Python plugins (`Plugin`, `observe`, `publish`, deck-file and script registration) are in
  the edge and tested.
- Panels are drawn (`frontend/src/components/PluginPanel.tsx`): a `panel-left`/`panel-right`
  plugin opens in a window over the pages (on that side the first time it is placed), which can be
  dragged and resized, or switched to full size over the page area with the nav still in sight
  (Esc or the same button for the window again). Neither size moves the page underneath. Clicking
  the plugin in the nav opens or closes it; right-clicking any plugin there offers the window, full
  size or a page of its own, so a tab plugin can be kept in the window too ("Open in a window" on
  its page does the same). The choice is remembered per browser. The panel sits in the root
  layout, around the pages, and is one element in both sizes, so neither moving between pages nor
  changing size ever reloads it: it keeps receiving updates the whole time.
- Legacy Flask blueprints are not run by the edge; they are converted as above.
