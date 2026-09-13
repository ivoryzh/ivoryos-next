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
