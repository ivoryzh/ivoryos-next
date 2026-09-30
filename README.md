# IvoryOS NextGen

This repository contains the IvoryOS next-generation architecture, including the Edge Server for hardware interfacing and a Next.js Frontend for the user interface.

## Quick Start

### 1. Edge Server (Python)

The edge server manages instruments and provides an API/Socket.IO interface.

**Requirements**: Python 3.10+

**Installation**:
It is recommended to use a virtual environment.
```bash
# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate  # On Windows, use `.venv\Scripts\activate`

# Install the edge server package in editable mode
pip install -e ./edge_server
```

**Running the Demo**:
We provide a demo script that starts the edge server with a simulated self-driving lab.
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

**Reaching it from other computers**: open it by this machine's IP address, its computer name, or a
`.local` name. The edge answers only to names that are its own, so another website cannot trick a
browser into driving it. If you reach it through any other DNS name (a lab hostname, a reverse
proxy), list that name first:
```bash
IVORYOS_ALLOWED_HOSTS=edge.mylab.example python example/demo.py
```

### 2. Frontend (Next.js)

The frontend is a web application that connects to the edge server.

**Requirements**: Node.js 18+

**Installation**:
```bash
cd frontend
npm install
```

**Running the Frontend**:
```bash
npm run dev
```
The application will be available at [http://localhost:3000](http://localhost:3000).

### 3. Cloud Hub (Next.js + daemon)

The Cloud Hub orchestrates workflows across several edge servers. It runs in **local (LAN) mode**
by default — a SQLite file and a built-in MQTT broker, with no accounts, keys, cloud services or
internet. A fresh clone runs with nothing configured.

It is two processes. Run both, from the repo root:

```bash
npm --prefix cloud_frontend run daemon
```

```bash
npm --prefix cloud_frontend run dev
```

The daemon holds the MQTT connection and, in LAN mode, **is** the broker: it starts one in-process
on port 1883, so there is nothing to install. If you already run a mosquitto (or anything else) on
that port, the daemon detects it, defers to it, and says so at startup. `IVORYOS_EMBEDDED_BROKER=0`
forces it off; `MQTT_BROKER_URL` pointed at another machine also disables it, since that is a
deployment stating where its broker lives.

Cloud mode (Supabase + AWS IoT Core) is inferred from `SUPABASE_URL` being set. See
`cloud_frontend/.env.local.example`, which documents every variable.

#### Connecting an edge server

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

#### When something is wrong

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

## Example Drivers

`example/lab_drivers.py` is the demo deck described above, and a reasonable template for
writing your own drivers.

`example/dummy_driver.py` is the synthetic test deck: it exercises introspection and
execution edge cases rather than modelling anything. It is kept out of the demo deck so
the UI stays readable, and is loaded alongside it on request:

```bash
IVORYOS_DEMO_TEST_DRIVERS=1 python example/demo.py
```

It contains:
- Standard synchronous methods (`PumpDriver`)
- Pure asynchronous methods (`AsyncPumpDriver.async_start_pump`)
- Synchronous methods that spin up a thread to run an async event loop (`AsyncPumpDriver.sync_to_async_thread_test`)
- Enum, `Literal` and nested-dataclass parameters, deliberately long names, and a method that raises

## License

| Part | License |
|---|---|
| Everything except `cloud_frontend/` (edge server, desktop app, frontends, `packages/`, plugin template) | [Apache-2.0](LICENSE) |
| `cloud_frontend/` (IvoryOS Cloud) | [FSL-1.1-ALv2](cloud_frontend/LICENSE.md): use, modify and self-host it; don't offer it as a competing service. Each release becomes Apache-2.0 two years after it is published. |

The IvoryOS name and logo are covered by [TRADEMARKS.md](TRADEMARKS.md), not by the code licenses.
