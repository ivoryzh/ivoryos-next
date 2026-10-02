# Developing IvoryOS

For working on IvoryOS itself, or running it from a source checkout. To use IvoryOS, start with the
[README](../README.md) and the desktop app. Architecture notes and the reasons behind each design
decision are in [AGENTS.md](../AGENTS.md).

## Repository layout

| Folder | What it is |
|---|---|
| `edge_server/` | The edge server: the Python package `ivoryos_edge` (FastAPI) that reads instrument drivers, runs workflows and stores runs |
| `frontend/` | The edge's web interface (Next.js, static export served by the edge), and the desktop app's launcher page |
| `desktop/` | The desktop app (Electron): manages decks, Python and updates. See [desktop/README.md](../desktop/README.md) |
| `cloud_frontend/` | IvoryOS Cloud: web app plus a daemon that talks to edges over MQTT |
| `packages/shared-ui/` | React code shared by the edge interface and Cloud |
| `example/` | The demo deck and example drivers |
| `schema_worker/` | Prototype service that extracts a driver's schema in a sandbox |
| `tests/` | `automated/` (pytest) and `manual/` checks |
| `deploy/cloud/` | Docker Compose for running Cloud. See [deploy/cloud/README.md](../deploy/cloud/README.md) |
| `docs/` | Guides and design notes |

**Requirements**: Python 3.10+, Node.js 22, and [uv](https://docs.astral.sh/uv/) (recommended).

## 1. Edge server (Python)

The edge server manages instruments and serves the API and the web interface.

```bash
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -e ./edge_server
```

**Running the demo**: a simulated self-driving lab.
```bash
python example/demo.py
```
The deck (`example/lab_drivers.py`) is a Suzuki-Miyaura coupling screen: three syringe
pumps charge a vial, a heater-stirrer holds it at temperature, and a UV-Vis probe and
HPLC read out how much product formed. The instruments share one reaction model that
integrates A --k1--> P --k2--> D with Arrhenius rate constants, so yield responds to
temperature, catalyst loading, reaction time and stoichiometry the way a real screen
would -- there is a genuine interior optimum (~65 C, ~2.5 mol% Pd) for an optimization
run to find. Simulated time is compressed, so a two-hour hold takes a couple of seconds.

A ready-made `Suzuki coupling screen` workflow ships in the workflow library with
`temperature_c`, `catalyst_ml` and `reaction_time_min` exposed as parameters.

The demo serves the built interface from `frontend/out` at http://localhost:8080, so build it
once first (section 2). The server runs without auto-reload: restart it after a Python change.

**Reaching it from other computers**: open it by this machine's IP address, its computer name, or a
`.local` name. The edge answers only to names that are its own, so another website cannot trick a
browser into driving it. If you reach it through any other DNS name (a lab hostname, a reverse
proxy), list that name first:
```bash
IVORYOS_ALLOWED_HOSTS=edge.mylab.example python example/demo.py
```

**Running a deck file** instead of a script: `ivoryos-edge --deck example/deck.json`. A deck file
lists the packages to install and the instruments to build (format `ivoryos-deck/1`).

## 2. Edge web interface (Next.js)

Install the workspace packages once, from the repository root:
```bash
npm install
```

Develop with hot reload (http://localhost:3000, talking to the edge on port 8080):
```bash
npm --prefix frontend run dev
```

Build the static export the edge serves (`frontend/out`); do this after any interface change:
```bash
npm --prefix frontend run build
```

## 3. Desktop app (Electron)

The launcher page comes from the interface build, so build `frontend/` first (section 2).

```bash
cd desktop
npm install
npm start
```

- `IVORYOS_DESKTOP_HOME=/some/folder npm start` runs with a separate set of decks and settings,
  beside your normal ones.
- A packaged app shows Cloud as "coming soon" with an early-access sign-up. Set
  `IVORYOS_CLOUD_COMING_SOON=1` to see that in development, or `IVORYOS_ENABLE_CLOUD=1` to turn
  Cloud back on in a packaged build.
- `npm run dist:dir` packages the app for this computer into `desktop/dist/`, and `npm run smoke`
  starts it, runs the first deck and checks the launcher loads.

More in [desktop/README.md](../desktop/README.md) and the
[desktop app guide](desktop_launcher_guide.md).

## 4. IvoryOS Cloud (Next.js + daemon)

Cloud orchestrates workflows across several edge servers. It runs in **local (LAN) mode** by
default: a SQLite file and a built-in MQTT broker, with no accounts, keys, cloud services or
internet. A fresh clone runs with nothing configured.

It is two processes, the web app and the daemon, started together:

```bash
npm --prefix cloud_frontend run dev:all
```

The daemon holds the MQTT connection and, in LAN mode, **is** the broker: it starts one in-process
on port 1883, so there is nothing to install. If you already run a mosquitto (or anything else) on
that port, the daemon detects it, defers to it, and says so at startup. `IVORYOS_EMBEDDED_BROKER=0`
forces it off; `MQTT_BROKER_URL` pointed at another machine also disables it, since that is a
deployment stating where its broker lives.

Cloud mode (Supabase + AWS IoT Core) is inferred from `SUPABASE_URL` being set. See
`cloud_frontend/.env.local.example`, which documents every variable. With AWS settings in
`.env.local`, every running daemon and every paired edge uses AWS IoT; set
`IVORYOS_CLOUD_MODE=local` to develop against the built-in broker instead.

### Connecting an edge server

The edge shows a short code and you approve it on Cloud, the way you sign in a TV. Nothing
sensitive goes on a clipboard, and nothing typed on Cloud is ever sent to a device.

1. Start pairing on the edge: its **Cloud Connect** page (**Get a pairing code**), **Connect** in
   the desktop app, or `ivoryos-edge pair` in a terminal. It shows a code and a link.
2. On Cloud, open **Pair a device** (or follow the link), enter the code, check the device's
   instruments, choose its name and workspace, and **Approve**. The edge connects on its own.
3. On a LAN, give the edge Cloud's address when you start. **Use your machine's LAN IP, not
   `localhost`**: `http://10.0.0.42:3002`, say. `localhost` on the edge machine means the edge
   machine. A hosted Cloud needs no address: the edge ships with `IVORYOS_CLOUD_URL`.

Signed in, the desktop app does steps 1 and 2 in one click, approving with the app's own sign-in.

The edge collects its credentials and the broker address over HTTP with a secret only it holds,
and everything afterwards runs over MQTT. You never type the broker address: on a LAN it is derived
from the address the device used to reach Cloud, which is by construction one that resolves from
where the device is.

Each edge has a lasting device id (like `my-deck-7k4m2q`), made at its first pairing and kept in
its data folder. The name is only a label, so two decks can both be called "My deck", and pairing
the same deck again reconnects it with its history instead of creating a second device.

To step away from Cloud, the edge (and the desktop app) offers two things:

- **Pause**: stay paired but stop connecting; Cloud shows the device as paused. **Resume**
  reconnects at once, no pairing needed.
- **Remove from Cloud**: leave for good. Cloud forgets the device (on AWS its certificate is
  revoked), and the edge forgets its credentials, free to pair with any Cloud. Past runs stay.

Cloud's Devices page can remove a device too; if it is still running, it is told to forget its
pairing.

### When something is wrong

`GET /api/health` reports each link separately — store, daemon, broker, devices — rather than
leaving you to infer a failure from an empty device list:

```bash
curl http://localhost:3002/api/health
```

The failure worth recognising is a device that **pairs but never appears**. Pairing is HTTP on
3002 while everything after it is MQTT on 1883, so when only the first half works the device
registers and then goes silent. Health names this explicitly ("paired but never connected"), and
with the built-in broker it should not happen at all — the usual cause was an external mosquitto
bound to loopback, or its port closed in the firewall.

## 5. Example drivers

`example/lab_drivers.py` is the demo deck described above, and a reasonable template for
writing your own drivers.

`example/dummy_driver.py` and `example/variadic_driver.py` are synthetic test decks: they exercise
introspection and execution edge cases rather than modelling anything. They are kept out of the
demo deck so the interface stays readable, and are loaded alongside it on request:

```bash
IVORYOS_DEMO_TEST_DRIVERS=1 python example/demo.py
```

They contain:
- Standard synchronous methods (`PumpDriver`)
- Pure asynchronous methods (`AsyncPumpDriver.async_start_pump`)
- Synchronous methods that spin up a thread to run an async event loop (`AsyncPumpDriver.sync_to_async_thread_test`)
- Enum, `Literal` and nested-dataclass parameters, deliberately long names, and a method that raises
- Every parameter shape Python allows: `*args`, `**kwargs`, keyword-only, positional-only, and
  methods hidden behind a decorator (`VariadicProbe`, `VendorBridge`)

## 6. Tests and checks

```bash
cd edge_server && uv run --extra test pytest ../tests/automated/ -q
```
```bash
npm --prefix cloud_frontend test
```
```bash
npm --prefix desktop test
```

Type-check whichever TypeScript package you touched, then build the interface:
```bash
npx tsc --noEmit -p frontend
```
```bash
npm --prefix frontend run build
```

GitHub Actions runs the edge tests on pushes and pull requests to `main`
(`.github/workflows/test.yml`), and builds and
smoke-tests the desktop app on Windows, macOS and Linux for every push that touches it
(`desktop.yml`).

## 7. Releasing the desktop app

Every push that touches the desktop app attaches installers to its Actions run (the run's
**Artifacts**, which need a GitHub login). A tag publishes them as a GitHub release:

```bash
git tag desktop-v0.2.0
```
```bash
git push origin desktop-v0.2.0
```

- `desktop-v0.2.0` is a release. Installed apps on Windows and Linux update to it themselves;
  on macOS the app links to it.
- `desktop-v0.2.0-test.1` (anything after a hyphen) is a pre-release: downloadable, never offered
  as an update. Use it for internal test builds.

Builds are unsigned for now, so Windows SmartScreen and macOS Gatekeeper warn on first open.

## Further reading

- [Desktop app guide](desktop_launcher_guide.md): processes, ports, profiles and logs, explained
- [Edge and Cloud sync](edge_cloud_sync.md): topics, workflow sync, dispatch and failure handling
- [Workflow reuse and versioning](workflow_reuse_and_versioning.md)
- [Plugins](plugins.md)
- [Agent in the loop](agent_in_the_loop.md): the MCP server and proposals
- [Communication flow](communication_flow.md)
