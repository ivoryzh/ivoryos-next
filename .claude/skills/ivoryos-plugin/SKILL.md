---
name: ivoryos-plugin
description: Create, port or publish an IvoryOS NextGen plugin, meaning a page (full tab or live side panel) plus an optional Python API that runs inside the edge beside a lab deck. Use when asked to write a new plugin, to convert a legacy Flask-blueprint (v1) IvoryOS plugin, or to register a plugin on the Automation Hub so the desktop launcher can install it.
---

# IvoryOS plugin

A plugin is a Python package holding one `ivoryos_edge.plugins.Plugin` object and a `page/`
folder. The edge serves it at `/plugins/<id>/`. It either fills a sidebar tab or sits in a
side panel beside every page, and it works with the deck's **live** instrument objects.

`template/` in this folder is a complete, tested minimum: a package, a page that updates live,
a test and a `pyproject.toml`. Start from it. The full reference is `docs/plugins.md` in the
ivoryos-next repo.

## Steps

1. **Copy `template/`** into the plugin's repo, then rename `my_plugin` everywhere (folder,
   `pyproject.toml`, `id=`, the test import) and set the display name. Keep the `id` stable
   once it is published, because it is the plugin's URL.
2. **Point it at the deck.** Set `INSTRUMENT` (or read `plugin.instruments`) to the names the
   deck gives its instruments, as shown on the Instruments page. Ask for the deck (a script or
   `deck.json`) if you don't have it. Never guess a name.
3. **Write `state()` and the page.** `state()` returns JSON-safe data. The page fetches
   `api/state` once, then follows the `events` websocket. Add routes with
   `@plugin.router.get/post`.
4. **Choose `placement`**: `"tab"` for a full page (a calculator, a data viewer), or
   `"panel-left"` / `"panel-right"` for something watched during runs. A panel is 280–600 px
   wide, so keep the key state near the top.
5. **Test.** Run `pytest` (with `ivoryos_edge` importable: `pip install -e <ivoryos-next>/edge_server`).
   Then run it on a real deck: add `"plugins": ["<package>.plugin:plugin"]` to a deck file
   (see `template/deck.example.json`), start it, and confirm `GET /api/plugins` lists it with
   nothing under `errors`.
6. **Publish** (next section) if the launcher should be able to install it.

## Rules (check every one before finishing)

- **Never construct, import or patch an instrument.** Use `plugin.instrument("name")` or
  `plugin.instruments`. A driver's constructor opens a port, so a second copy fails, or worse,
  succeeds and fights the first one. Don't import the deck script: that re-runs it. Don't
  wrap methods on a class: use `plugin.observe(name, callback)` inside `@plugin.on_start`.
- **Relative URLs in the page**: `fetch("api/state")`, `src="app.js"`, never `/plugins/...`.
  A Vite build needs `base: './'`. `/api/...` is fine for the edge's own API.
- **Don't move hardware from a plugin route.** Call `POST /api/execute` or queue a run, so the
  busy checks apply. Reading state directly is fine.
- **`observe` callbacks run on worker threads.** Keep them quick, guard shared state with a
  `Lock`, and let `plugin.publish(...)` carry data to the page. Events carry `"error"` instead
  of `"result"` when a call failed, and `args`/`result` may not be JSON-serializable.
- **No Flask, no Socket.IO, no threads or servers of your own.** The edge owns the process.
  Use `def` routes for anything slow (`async def` routes block the event loop).
- **Ship the page**: keep the `package-data` entry in `pyproject.toml`, then build a wheel and
  confirm `page/index.html` is inside it. A missing page is the most common "works from my
  checkout, 404 once installed" bug.
- **Don't declare `ivoryos_edge` as a dependency.** The edge that loads the plugin provides it.

Ask the person rather than guess when the plugin needs something that isn't a deck instrument
(module-level simulator state, files, another process), or when it's unclear which instrument
an old plugin was patching.

## Porting a legacy Flask (v1) plugin

Use the mapping table and checklist in `docs/plugins.md` sections 4 and 7. In short:
`Blueprint` becomes `Plugin(page="page", placement=...)`, `@bp.route` becomes
`@plugin.router.get/post`, `render_template` becomes a static page plus a JSON route,
`socketio.emit` becomes `plugin.publish`, and class patching becomes `plugin.observe`
plus `plugin.instrument`. Keep the v1 plugin working if people still use the original IvoryOS:
add a new module beside it (for example `next_plugin.py`) rather than replacing it.

## Publishing to the Automation Hub

The launcher installs a plugin from its Hub row. It pip-installs `pip_name`, then adds
`"<import_path>:<module_name>"` to the deck's `plugins`.

1. Release the package so `pip install <pip_name>` works on another computer: PyPI, or a
   `git+https://...` URL (a tag or commit, never a moving branch, for anything shared).
2. Register it on the Hub (Contribute → Plugin) with:

   | Field | Value |
   |---|---|
   | `pip_name` | the requirement, with a minimum version when the plugin needs a newer release, e.g. `my-plugin>=0.1.0` |
   | `import_path` | the module holding the object, e.g. `my_plugin.plugin` |
   | `module_name` | the **attribute** name, e.g. `plugin` (not a class name) |
   | `plugin_api` | `v2` (the launcher refuses `v1`, which means a Flask blueprint) |
   | `is_agnostic` / `platform_ids` | agnostic if it works on any deck; otherwise the Hub platforms it was made for, so adding that platform offers it |
   | `visibility` | `private` while testing (only you see it), then `public` |

   If the contribute form has no plugin-API field yet, it saves `v1`. Set `plugin_api = 'v2'`
   on the row afterwards.
3. In the launcher, add the platform (or the plugin) to a deck. Confirm the panel appears and
   the deck's log shows no plugin error.
