# Frontend & Backend Communication Protocol

IvoryOS consists of a **Next.js (React) Frontend** and a **Python FastAPI Edge Server**. The two systems communicate during physical execution using a hybrid approach of standard REST API calls and real-time WebSockets.

## 1. Initiating Execution (REST API)

When you queue a run from the **Designer** or **Optimize/Execution** pages, the frontend does not directly execute any physical hardware commands. Instead, it compiles the execution plan and sends it to the Edge Server.

### The Flow
1. **Compilation**: The frontend compiles your blocks, sequence repetitions, spreadsheets, or optimization parameters into a structured JSON payload.
2. **Submission**: The frontend sends an HTTP `POST` request to `/api/queue/submit` (or `/api/optimize/submit` for optimization runs).
3. **Queueing**: The FastAPI backend receives the payload, inserts the run into its SQLite database (`WorkflowRun`), inserts all constituent steps (`WorkflowStep`), and places the run into the global queue.
4. **Response**: The server immediately responds with the newly assigned `run_id`, allowing the frontend to navigate to the Queue or Data History page.

## 2. Real-Time Tracking (WebSockets)

Because physical execution is long-running and stateful, the frontend uses WebSockets to "listen" to the backend for real-time progress.

### The Global Queue Socket (`/api/ws/queue`)
- **Purpose**: Tracks the status of the entire queue (which run is active, pending, or completed).
- **Behavior**: The `GlobalQueueBar` on the frontend maintains a persistent connection to this socket. Whenever the backend shifts from one run to the next, it broadcasts the updated queue list to all connected clients.

### The Execution Run Socket (`/api/ws/run/{run_id}`)
- **Purpose**: Provides high-frequency, granular updates about a specific execution run.
- **Behavior**: When you click on an active run in the Queue page, the frontend establishes a WebSocket connection to that specific run ID. 
- **Broadcasts**: As the Python `ExecutionQueue` steps through the workflow (e.g., executing `pump.dispense()`), it awaits the physical command to finish. Immediately upon completion, it updates the database and broadcasts a JSON message containing the updated step statuses, timestamps, and outputs over the socket. The frontend receives this and instantly updates the UI (turning the step green/red and populating the output).

## 3. The Execution Loop (Backend Internal)

The physical execution itself happens *entirely on the Edge Server*. The frontend is fundamentally decoupled from the hardware.

1. **Introspection matching**: The backend reads the step's `instrument` and `method` fields, finds the loaded hardware driver class (e.g., `IsmatecPump`), and looks up the Python function.
2. **Execution**: The backend calls the Python function using `asyncio` or an executor thread (so the hardware I/O doesn't freeze the web server).
3. **Data Serialization**: When the hardware function returns a result (e.g., a Dataclass, Pydantic model, or raw number), the Edge Server serializes it into a raw dictionary, unpacks it into the Workflow Context, and commits it to the database's `step.outputs` column.
4. **State Ping**: The backend broadcasts the newly serialized state over the `run/{run_id}` WebSocket back to the waiting frontend.

## Summary

The communication relies on **REST POSTs** to initiate workloads and **WebSockets** for unidirectional event-streaming back to the client during physical execution. At no point does the frontend talk directly to the hardware; it acts as a remote control and monitor for the autonomous Edge Server.
