# IvoryOS NextGen - Agent Guidelines

## 1. Overall System Architecture

This repository contains a distributed edge-to-cloud architecture consisting of three primary components:

### 1. `edge_server/` (The Python Backend)
- **Role:** The core execution engine running locally on edge devices (e.g., lab instruments or local controllers).
- **Tech Stack:** Python (`ivoryos_edge` package).
- **Persistence:** Uses a local SQLite database (`ivoryos_edge.db`).
- **Functionality:** Executes workflows, manages hardware connections, and exposes a local API for the frontends to communicate with.

### 2. `frontend/` (The Edge Server Frontend)
- **Role:** The local user interface for a specific edge device. It allows users to design, optimize, and execute sequences directly on the machine.
- **Tech Stack:** Next.js (App Router), pure Tailwind CSS (v4).
- **Design System:** Standard Tailwind utility classes (`bg-gray-900`, etc.). Uses `Geist` and `Inter` via `next/font`.

### 3. `cloud_frontend/` (The Cloud Hub Frontend)
- **Role:** A central orchestration dashboard meant to run in the cloud. It monitors, connects to, and dispatches workflows to multiple edge devices.
- **Tech Stack:** Next.js (App Router), React Flow.
- **Design System:** Contains a legacy "glassmorphism" design system (custom CSS inside `cloud_frontend/src/globals.css`). 

---

## 2. The Workflow Editor (Designer) Caveat

**CRITICAL RULE: DO NOT ATTEMPT TO SHARE COMPONENTS VIA NPM WORKSPACES.**
The `WorkflowEditor.tsx` component (and related logic) is explicitly and intentionally **duplicated** between `frontend/src/components/` and `cloud_frontend/src/components/`. 

We previously attempted to extract this into a shared `@ivoryos/shared-ui` package, but it was rejected due to build compilation complexity and Turbopack issues. 

**When modifying the designer:**
- If you make a functional or structural change to `WorkflowEditor.tsx` in `frontend/`, you MUST manually copy that change over to `cloud_frontend/src/components/WorkflowEditor.tsx` (and vice versa) if the feature applies to both.
- Do not try to symlink them or create a monorepo setup. They must remain decoupled files.

---

## 3. CSS Environment Differences

Be extremely careful when copying UI code between the two frontends:
- **`frontend/`**: Relies on standard Tailwind utility classes.
- **`cloud_frontend/`**: To prevent the legacy Cloud CSS from overriding Tailwind utilities in copied components, the legacy Cloud CSS has been wrapped in `@layer base` and `@layer components`. Always use standard Tailwind utility classes (e.g. `bg-white`, `border-none`) in the React components so they successfully override the legacy global styles.
- **Fonts:** Both apps use `Geist` and `Inter` via `next/font`. Ensure these fonts are injected via `layout.tsx` in both apps when restructuring layouts.

---

## 4. Build Requirements

**REMEMBER:** Always run `npm run build` in the `frontend/` directory (and `cloud_frontend/` when applicable) after making significant structural or UI changes to ensure that the Next.js production bundle correctly generates and the Python backend can serve the latest static files!
