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
We provide a demo script that starts the edge server with some simulated ("dummy") drivers.
```bash
python example/demo.py
```
This will start the edge server with standard `PumpDriver` as well as test async implementations like `AsyncPumpDriver`.

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

If you are developing new drivers or testing async implementations, take a look at `example/dummy_driver.py` which contains:
- Standard synchronous methods (`PumpDriver`)
- Pure asynchronous methods (`AsyncPumpDriver.async_start_pump`)
- Synchronous methods that spin up a thread to run an async event loop (`AsyncPumpDriver.sync_to_async_thread_test`)
