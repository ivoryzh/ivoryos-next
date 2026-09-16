# Legacy UX backlog

Behaviours that exist in legacy IvoryOS (the Flask/Jinja app) and have no equivalent in
nextgen yet. Legacy accumulated these over three years of real lab use, so most of them
are answers to problems that will resurface here rather than nice-to-haves.

Items already ported live in `feat/legacy-ux-parity`; this file is what's *left*.

Ranked roughly by how much operator pain each one covers.

---

## 1. Abort semantics

Legacy had three distinct ways to stop, each with its own options:

| Action | Options offered |
| --- | --- |
| Abort current step | "Continue execution queue?" |
| Abort pending iterations | "Proceed to cleanup steps?", "Continue execution queue?" |
| Stop from the error modal | Retry step / Continue / Stop |

Nextgen has a single `Cancel`. The cleanup-on-abort option is the one that matters most
for chemistry — cancelling mid-run otherwise leaves hardware hot, pressurised, or holding
reagent. Legacy also stated plainly in the UI that the current step can't be interrupted
until it finishes, which set the right expectation instead of making Cancel look broken.

**Where:** `edge_server/ivoryos_edge/queue.py` (cancel path), `frontend/src/app/queue/page.tsx`,
`frontend/src/components/GlobalQueueBar.tsx`.

## 2. Repeat × N

Legacy's Run tab took a repeat count and a batch size, so any workflow could be run N times.
Nextgen only repeats by adding spreadsheet rows, which means a workflow with no `#variables`
can't be repeated at all — you have to submit it by hand N times.

**Where:** `frontend/src/app/execution/page.tsx`, plus a `repeat` parameter on the run payload.

## 3. Interactive Python console

Legacy had a CodeMirror offcanvas on the Instruments page that executed arbitrary Python
against the live deck and streamed stdout/stderr back. It is the escape hatch operators reach
for when an instrument misbehaves and no exposed method covers what they need to check.

**Where:** new endpoint alongside `POST /api/execute`, drawer on `frontend/src/app/instruments/page.tsx`.

## 4. Hide/show instrument methods, and persisted card order

A driver can expose 40 methods when an operator uses 5. Legacy let each user hide the rest
(collapsing them into a "Hidden functions" accordion) and drag the remaining cards into their
own order, persisted server-side per instrument.

**Where:** `frontend/src/app/instruments/page.tsx` + per-user preference storage.

## 5. Data page gaps

- Per-run delete (nextgen only has "clear all history").
- Search / filter / pagination over runs.
- The vis-timeline execution view, with click-through from a timeline item to that phase's
  step detail. Legacy's timeline made a long run's shape legible at a glance — where the
  time actually went, and which phase failed.

**Where:** `frontend/src/app/data/page.tsx`.

## 6. Library management

No delete, rename, save-as, deck filter, or pagination. `DELETE /api/workflows/{name}` does
not exist yet. Legacy also filtered the library by deck configuration, which stops workflows
written for a different rig from showing up as runnable.

**Where:** `edge_server/ivoryos_edge/server.py` (workflow CRUD), `frontend/src/app/library/page.tsx`.

## 7. Import from Python

Legacy parsed an uploaded `.py`, listed the workflows it found, flagged which ones already
existed, and let the user tick exactly which to import/overwrite. This is the main on-ramp
for people whose protocols already live in scripts.

**Where:** `ivoryos/parsers/py_to_json.py` in legacy is the reference implementation.

## 8. Design agent

Legacy had an LLM panel in the designer sidebar: describe an experiment in prose, get steps
appended to the canvas. Enter submitted, Shift+Enter added a newline. See the separate
discussion on API-key cost before rebuilding this as-is.

## 9. Workflow finalize / lock

Legacy workflows had a `finalized` status that made them read-only — protecting a validated
protocol from being edited by accident while it is in production use.

## 10. Config table polish

Nextgen autosaves the spreadsheet to `localStorage` but gives no feedback and no way back.
Legacy showed a "Saved" pill after a debounced write, a "Modified" pill when the table
diverged from the uploaded file, and a Reset button to return to the file's contents.

**Where:** `frontend/src/app/execution/page.tsx`.

## 11. Dashboard

Currently placeholder: hardcoded "0 / 1 Local" stat cards, no recent workflows, no version,
no online/simulation-mode badge. Legacy's home page listed recently modified designs with
open-in-editor links and showed connection state and version prominently.

**Where:** `frontend/src/app/page.tsx`.

---

## Known bugs found while comparing

- **Designer canvas can be wiped by a reload in dev.** React StrictMode double-mounts, and
  the save effect in `frontend/src/app/designer/page.tsx` writes empty state back to
  `localStorage` before the load effect's state lands. Production static export is unaffected,
  but the race is real and should be fixed with an explicit "hydrated" gate.

---

## Where nextgen is already ahead of legacy

Worth not regressing while porting the above:

- Optimizer page: history-run selection, existing-data upload, early-stop criteria,
  per-optimizer schema-driven config.
- Block-level validation warnings in the designer (missing params, wrong types, methods that
  no longer exist in the deck).
- Nesting-depth colouring for flow control.
- Offline schema caching, so the designer still opens when the edge server is down.
- Dark mode.
