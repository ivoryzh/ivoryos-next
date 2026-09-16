# Workflow Reuse, Versioning & Preview — Design

**Status:** implemented. **Date:** 2026-09-15.

Sections 1-3 describe the design as built; section 4 records what shipped and section 5 what
is still open. Section 1's "what exists today" is written in the past tense of the old
behaviour — it is kept because every rejection and badge in the current system exists to
prevent one of the failures described there.

This covers what happens when one saved workflow is used inside another: what gets stored, what
happens when the original changes, who finds out, and what the user can see before they commit
hardware to it.

---

## 1. What exists today

Four facts, all load-bearing:

1. **Save is a destructive overwrite.** [`saveWorkflow`](../frontend/src/app/designer/page.tsx#L297)
   POSTs to `/api/workflows/{name}`, which `json.dump`s over `workflows/{name}.json`
   ([`save_workflow`](../edge_server/ivoryos_edge/server.py#L663)). The name *is* the identity — same
   on the Cloud side, where `edge_sequences` is keyed `unique (device_id, name)`. No history is kept
   anywhere.

2. **Reuse is a late-bound reference.** Dragging a saved workflow into another produces a block
   `{instrument: "Library Workflows", method: <name>, params: {...}}`. It stores only the *name*. The
   toolbox entry is synthesized client-side by scanning the saved body for `#var` placeholders and
   exposing them as parameters — [designer/page.tsx:187](../frontend/src/app/designer/page.tsx#L187),
   [edge-sequence/page.tsx:171](../cloud_frontend/src/app/edge-sequence/page.tsx#L171), and
   [cloud page.tsx:79](../cloud_frontend/src/app/page.tsx#L79) for the distributed canvas.

3. **Resolution happens at dispatch.**
   [`expand_workflow_blocks`](../edge_server/ivoryos_edge/server.py#L350), called from `create_run`,
   reads the referenced `.json` off disk *at that moment* and splices its blocks inline, substituting
   `#var`s from the block's params and stamping `_parent_workflow` onto each expanded step.

4. **Nothing records what actually ran.** `WorkflowRun`
   ([models.py](../edge_server/ivoryos_edge/models.py)) stores the expanded steps but not which body
   produced them.

### The consequence

Editing a workflow **retroactively and silently changes every workflow that references it** —
including runs already sitting in the queue, and including the comparison between the run you did
last week and the one you do tomorrow. Since these are experimental protocols driving real hardware,
that is a data-integrity problem, not just a UX annoyance: two runs can differ with nothing in the
record showing it.

### Three latent bugs in the same area

- **Missing reference degrades silently.** The `except` at
  [server.py:397](../edge_server/ivoryos_edge/server.py#L397) falls back to appending the raw
  `Library Workflows` block into the run, which then dispatches as a call to an instrument literally
  named `Library Workflows`. A renamed or deleted workflow should be a hard rejection at enqueue, not
  a malformed step at runtime.

- **Nesting is broken, not prevented.** `instantiate_blocks` copies inner blocks without
  re-expanding, so a library workflow containing another library workflow ships a bogus block. The
  Designer only guards the *self*-reference case, by hiding the currently-edited workflow from the
  toolbox ([designer/page.tsx:212](../frontend/src/app/designer/page.tsx#L212)) — that stops `A→A`
  but not `A→B→C→A`.

- **Batch semantics diverge between copy and reference.** `executeSpreadsheet()` walks the
  **un-expanded** sequence client-side
  ([execution/page.tsx:421](../frontend/src/app/execution/page.tsx#L421)), so a `Library Workflows`
  block is per-sample or batch *as a single unit* and its inner blocks' `batch_action` flags are
  ignored entirely; expansion happens server-side afterward. Inline the same blocks by hand and those
  flags suddenly take effect. Same protocol, two behaviors, no indication which one you're getting.
  See [AGENTS.md §8](../AGENTS.md) for the batch model this diverges from.

---

## 2. The core mismatch

UX observation: **most of the time, users want to edit and reuse.** They drag in a saved workflow
expecting to take a copy and adjust it.

What they get is a live link. That mismatch is the root of the reported pain — someone edits a
workflow, forgets (or never knew) it was referenced elsewhere, and a different workflow, possibly
another person's, changes underneath them. The surprise isn't that versioning is hard. It's that
users assumed copy semantics and received link semantics.

So the fix is not primarily a versioning scheme. It is **making the default match the expectation**,
and making the exception visible.

---

## 3. Design

### 3.1 Two explicit modes, copy by default

**Copy (default).** Dragging a saved workflow **inlines its blocks** into the parent, immediately
editable, carrying a provenance breadcrumb on the group: `from wash_protocol @ v7`. No live
dependency. If the source changes later, nothing happens here — correct behavior for a protocol.

**Link (opt-in).** Stays a collapsed reference that resolves at run time, for genuine shared
boilerplate (`safe_shutdown`, `purge_lines`) where one edit *should* reach everywhere. Rendered
visually distinct — chain icon, "tracks `wash_protocol`" — so the mode is never ambiguous.

Both modes are offered at drag time and switchable afterwards on the block: **Detach** turns a link
into an owned copy; **Link** turns a copy back into a reference (offered only when the copy still
matches some saved version).

This collapses most of the versioning question. Copies need versions only as a *breadcrumb*, so that
"the source has moved on since you copied this — see diff?" is answerable. Only links need real
resolution semantics, and those are now rare enough that pinning them is cheap.

### 3.2 Versioning: append-only, with a moving head

Saving becomes append-only rather than destructive:

```
workflow          (device_id, name)   -- identity, mutable metadata, head_version
workflow_version  (workflow_id, version int, body jsonb, body_hash, created_at,
                   created_by, note)  -- immutable
```

Save inserts a `workflow_version` and bumps `head_version`. Hash the body first — a save with no
semantic change must not burn a version, since people hit save reflexively.

On Edge, keep `workflows/{name}.json` as the head so every existing reader keeps working, and add
`workflows/.versions/{name}/{n}.json`. Purely additive: existing workflows become v1 on first read.

A link block carries a resolved version, written at drag time:

```json
{ "instrument": "Library Workflows", "method": "wash_protocol",
  "ref": { "version": 7, "body_hash": "a3f…", "mode": "pinned" },
  "params": { "volume": 5.0 } }
```

`mode` is `"pinned"` (default — resolves to exactly v7 forever) or `"latest"` (resolves to head; must
be rendered distinctly on the block). `create_run` resolves the ref, verifies `body_hash`, and
**rejects the run with a clear error** if that version is gone.

Finally, stamp `workflow_version` + `body_hash` onto `WorkflowRun` so a finished run can state exactly
what it executed. That is the payoff — not undo.

### 3.3 Notify at edit time, not run time

Run time is too late: the user is already committed and will click through anything. The moment that
still has context is **save**:

> Saving `wash_protocol`. **3 workflows link to this** and will change: `screening_A`, `screening_B`,
> `overnight_cal`.
> [Review changes] [Save anyway] [Save as a new workflow instead]

That third button is the important one — it converts an accidental edit of shared state into an
intentional fork.

Two honest limits:

- **"Another user won't know" is only partly solvable on Edge.** There is no auth anywhere in
  `edge_server/` — no identity to attribute an edit to. The most Edge can offer is a timestamp plus an
  optional one-line change note captured at save (`workflow_version.note`), surfaced on the library
  card and in the diff. Real attribution (`created_by`) works only on Cloud, which has `auth.uid()`
  and `owner_id`.
- **Copies trade surprise for divergence.** Five copies of a protocol, you fix one, four go stale.
  Nobody is *startled* — nothing moved under them — but improvements stop propagating. That is the
  right trade for protocols. Mitigation is the breadcrumb plus a **non-blocking** "source updated
  since you copied — review diff?" nudge on the library card. It must never block a run.

### 3.4 Cycles and nesting

Cycle detection must be **graph-wide and server-side**. Client-only checks have already drifted twice
in this project (see [AGENTS.md §3](../AGENTS.md)), and both Edge and Cloud write through the same
save endpoint.

- `save_workflow` builds the link graph over the incoming body and **refuses the save** on a cycle,
  naming the path: `wash → rinse → wash`.
- Nesting depth: either recurse in `expand_workflow_blocks` with a cap of 3, or reject
  links-inside-links at save. Either is acceptable; today's "accept it, break at runtime" is not.
- The missing-reference fallback at [server.py:397](../edge_server/ivoryos_edge/server.py#L397)
  becomes a hard failure.

The existing self-reference guard in the Designer toolbox stays, but as a UX affordance only — the
server check is the real gate.

### 3.5 The full map (preview)

A step that hides forty steps of someone else's protocol is a safety problem: the user is being asked
to start hardware from instructions they cannot read.

**Generate the map from the same code that generates the run.** Add a dry-run endpoint,
`POST /api/workflows/expand`, returning the flattened step list without enqueuing, so the preview is
produced by the actual `expand_workflow_blocks`. Mirroring the expansion in TypeScript would put us
straight back into the §3 drift trap — except a drifted copy here means *the safety preview lies about
what the robot will do*. Not a place to duplicate logic.

The panel itself:

- Flat ordered list, grouped by phase (Prep / Main / Cleanup).
- Sub-grouped under collapsible headers: `wash_protocol (12 steps) · v7 · linked`.
- Each step tagged per-sample or batch, with group boundaries drawn the way the spreadsheet table
  already draws "Batch N".
- With a spreadsheet loaded, show the real expanded totals — "24 rows × batch 4 = 6 groups, 148
  steps" — since that number is currently impossible to work out ahead of time.
- Actions per group: *Open in Designer*, *Detach into this workflow*, *Diff against v9*.

The Queue page already renders parent-workflow grouping and indentation
([queue/page.tsx:276](../frontend/src/app/queue/page.tsx#L276)). The map is that same renderer moved
earlier — shown *before* you commit instead of after.

---

## 4. What shipped

| # | Work | Where |
|---|---|---|
| 1 | Expansion hardening: graph-wide cycle rejection at save, depth-capped recursion, hard-fail on missing refs, path-traversal-safe names | `edge_server/ivoryos_edge/workflows.py`, `server.py` |
| 2 | `POST /api/workflows/expand` dry-run endpoint, plus `/versions`, `/dependents`, `DELETE` | `server.py` |
| 3 | Full-map preview panel, fed by that endpoint | `packages/shared-ui/src/WorkflowMap.tsx`; Designer and Configure pages |
| 4 | Copy-by-default drag, link as opt-in, Detach, version badges | `packages/shared-ui/src/workflowBody.ts`, `WorkflowEditor.tsx` |
| 5 | Append-only version store, breadcrumbs, save-time impact warning, history panel | `workflows.py`; Designer and Library pages |

Coverage: `tests/automated/test_workflow_links.py` (39 tests) pins the expansion, versioning,
cycle-rejection and endpoint behaviour. Every rejection listed in §1 has a test that asserts the
rejection rather than the old degraded output.

Three things were found and fixed while building, all instances of the same class of bug this work
is about — something quietly misrepresenting or substituting what the user asked for:

- **Detach used the head, not the pin.** Detaching a step pinned to v1 inlined v4's steps, because
  the Designer only had the head body cached. Detach now loads the pinned version through
  `fetchWorkflowVersion` and refuses if it can't, rather than silently inlining something else.
- **The Designer's load/persist race wiped loaded sequences.** The persistence effect wrote the
  empty initial state over what "Load to Designer" had just put in localStorage; under React
  StrictMode the load effect then re-read the emptied value, so opening a saved workflow landed on
  an empty canvas. Persistence is now gated on a `hasLoaded` state flag plus a content comparison.

- **The preview dropped every plain step's method and arguments.** The Designer posts the saved
  `action`/`args` block shape to `/api/workflows/expand`, but the expander only normalised that
  shape inside the link-expansion path — plain blocks passed straight through, so the panel showed
  bare instrument names and no parameters. A preview that silently omits the pump rates is worse
  than no preview. `expand_workflow_blocks` now normalises both shapes uniformly, with tests
  pinning it.

### Model correction: groups vs links

Copy and link converged in practice — a *pinned* link and a copy behave identically at run time
until someone explicitly updates, and both wore the same "vN available" badge. The split is now:

- **Group** — organisation only. Copying a saved workflow produces one, and groups can also be
  created by hand and have steps dragged in and out. A group records where its steps came from as a
  label and tracks nothing further.
- **Link** — the version-tracked reference: pinned, read-only, with the diff-and-update flow.

So "copy vs link" is no longer a choice between two kinds of reference. It is: do you want *these
steps, as yours* (copy → a group you can edit and reorganise), or *whatever that workflow says*
(link → tracked, updated deliberately).

### Added after first review

- **Copied groups collapse.** A copy renders as one header row (name, version, step count) that
  expands to the real editable steps, rather than dumping every step loose onto the canvas. The
  header carries *Ungroup* (dissolve the grouping, keep the steps) and a delete for the whole group.
- **Batch execution is visualised in the preview**, per group: which steps repeat once per row and
  which fire once for the batch, with a live batch-size control bound to the Configure page's real
  setting.
- **The Library can delete a workflow**, honouring the dependents guard: deleting one that others
  link to is refused with those names listed, and forcing past it is a separate, explicit confirm.

---

## 5. Still open

- **Rename.** With name as identity, a rename breaks every pinned ref. Either forbid rename, or
  introduce a stable id and make name a label. Now more pressing than when this was drafted, since
  pinned refs are live: `DELETE` is guarded by a dependents check, but rename is not guarded at all.
- **Does Cloud share the version store, or mirror it?** `edge_sequences` is written by the daemon
  from retained MQTT topics. Cloud currently reads `body.version` when one is present and pins
  distributed nodes to it, but it has no version *history* of its own: the Cloud sequence editor
  can only detach a link pinned to the version it happens to hold, and refuses otherwise.
- **Diff view — done.** Both update paths now show a step-by-step comparison before applying
  (`WorkflowDiff` / `diffSteps`). Still open: the Library's version history lists versions but
  cannot diff two arbitrary ones against each other, only the update flows are wired.
- **Retention.** Append-only versions grow forever, and `.versions/` is gitignored as local runtime
  state. Fine at lab scale; revisit if a workflow gets thousands of saves.

### Resolved since drafting

- **Batch semantics for a linked subworkflow.** Settled in favour of honouring the inner
  `batch_action` flags, so a copy and a link of the same protocol describe the same execution. The
  expander preserves them, and the Configure page now resolves links through
  `/api/workflows/expand` *before* its per-sample/batch walk, so it sees real steps instead of one
  opaque block. This does change behaviour for anyone who was relying on a linked subworkflow
  running as a single batch unit — that behaviour was never chosen, it was an artifact of the walk
  never seeing inside the link.
