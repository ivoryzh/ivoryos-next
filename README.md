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

Pairing is a short-lived code, not a copied token — nothing sensitive goes on a clipboard.

1. In the Hub, open **Cloud Settings**, name the device, and **Generate Code**.
2. On the machine running the edge server, open its **Cloud Connect** page and enter the code.
3. On a LAN, also give it the Hub's address. **Use your machine's LAN IP, not `localhost`** —
   `http://10.0.0.42:3002`, say. `localhost` on the edge machine means the edge machine. (A hosted
   deployment needs no URL: the edge ships with `IVORYOS_CLOUD_URL`, so the code is the only
   input.)

The edge redeems the code over HTTP, receives its credentials and the broker address, and
everything afterwards runs over MQTT. You never type the broker address: it is derived from the
address the device used to reach the Hub, which is by construction one that resolves from where
the device is.

A device name **is** its MQTT client id, so names must be unique — two clients sharing one id
disconnect each other in a loop. Re-pairing an already-registered name returns a 409; remove it
first with `DELETE /api/devices/{name}`.

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
