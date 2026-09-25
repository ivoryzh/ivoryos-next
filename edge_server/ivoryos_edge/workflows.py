"""Saved-workflow storage, versioning, link resolution and expansion.

This is the single source of truth for what a `Library Workflows` block means. Both the live
dispatch path (`create_run`) and the dry-run preview endpoint (`/api/workflows/expand`) call
`expand_workflow_blocks` here, deliberately — the preview exists to tell a user what hardware is
about to do, so it must be produced by the same code that actually produces the run. Mirroring
this logic client-side would let the two drift, and a drifted preview is worse than no preview.

Storage (Edge): the database is the store, the JSON files are its mirror.

    saved_workflows           one row per workflow: the head body, its version, tags
    saved_workflow_versions   immutable snapshots, append-only, never cascaded away

    workflows/{name}.json               the head, mirrored on every save — unchanged format
    workflows/.versions/{name}/{n}.json snapshots, mirrored on every save

Both halves earn their keep. The database is what makes the library cheap to query: listing it is
one statement instead of a file read per workflow plus one per version, tags stop living in a
side-car that can drift from the files beside it, and a save is a transaction rather than two
writes that can half-succeed. The files are how a workflow arrives from *outside* this process —
dropped in by hand, synced down from Cloud, restored from git — which is a capability this module
has always had and deliberately keeps.

So reconciliation runs on read, not once at startup: a file that has appeared is imported, one
that has changed becomes the new head (without appending a version — only `save_version` does
that), and one that has been removed takes its head row with it. The recorded mtime/size make the
common case a stat rather than a re-parse. An out-of-band edit to the head does not touch the
snapshots, exactly as hand-editing the head file never touched `.versions/` before.

The head body carries three metadata keys (`version`, `body_hash`, `updated_at`). They are
additive; a workflow saved before versioning existed is adopted as v1 the first time it is seen.
"""

import hashlib
import itertools
import json
import os
import re
import time
from contextlib import contextmanager

from sqlalchemy import select

from ivoryos_edge.models import SavedWorkflow, SavedWorkflowVersion, sync_session

# The synthetic instrument name a saved workflow is exposed under in the Designer toolbox. Kept in
# one place because frontend, dispatch and cycle detection all have to agree on the exact string.
LIBRARY_INSTRUMENT = "Library Workflows"

# How deep a chain of linked workflows may nest (A links B links C = depth 2). A cap rather than
# unlimited recursion because a deep chain is almost always a modelling mistake, and an unbounded
# expansion here turns into an unbounded step list on real hardware.
MAX_LINK_DEPTH = 3

VERSIONS_DIRNAME = ".versions"

# Tags live here rather than inside the workflow body, deliberately. The body is content-hashed to
# decide whether a save is a real edit, so folding tags in would make re-filing a workflow look like
# a protocol change and burn a version — and would mean a pinned reference to v3 carried v3's tags
# forever. Tags are how people *find* a protocol; they are not part of what it does.
META_FILENAME = ".meta.json"

MAX_TAGS = 24
MAX_TAG_LENGTH = 40

# Block keys that change on every save without changing meaning — `formatBlocks` in the Designer
# regenerates a random `uuid` each time it serialises. Hashing them would make every save look like
# a real edit and defeat the whole point of content-hashing.
_VOLATILE_BLOCK_KEYS = ("id", "uuid")


class WorkflowError(Exception):
    """Base for every rejection this module raises. Callers turn these into 4xx responses."""


class WorkflowNotFound(WorkflowError):
    pass


class WorkflowCycleError(WorkflowError):
    pass


class WorkflowDepthError(WorkflowError):
    pass


class InvalidWorkflowName(WorkflowError):
    pass


# --- naming -------------------------------------------------------------------------------------

# A workflow name becomes a path segment, and it arrives from a URL path parameter, so it has to be
# validated before it is ever joined onto WORKFLOWS_DIR. A leading dot is rejected too, so a
# workflow can never collide with (or be written inside) the .versions store.
_UNSAFE_NAME = re.compile(r"[/\\\x00]")


def validate_name(name):
    if not isinstance(name, str) or not name.strip():
        raise InvalidWorkflowName("Workflow name must be a non-empty string")
    if name in (".", "..") or name.startswith("."):
        raise InvalidWorkflowName(f"Invalid workflow name: {name!r}")
    if _UNSAFE_NAME.search(name):
        raise InvalidWorkflowName(
            f"Invalid workflow name {name!r}: cannot contain '/', '\\' or null bytes"
        )
    return name


def workflow_path(workflows_dir, name):
    return os.path.join(workflows_dir, f"{validate_name(name)}.json")


def _versions_dir(workflows_dir, name):
    return os.path.join(workflows_dir, VERSIONS_DIRNAME, validate_name(name))


def _version_path(workflows_dir, name, version):
    return os.path.join(_versions_dir(workflows_dir, name), f"{int(version)}.json")


# --- block helpers ------------------------------------------------------------------------------

def block_method(block):
    """The called thing, across both shapes. Saved JSON uses `action`; a live run payload uses
    `method`. Every reader here has to tolerate both."""
    return block.get("method") or block.get("action")


def block_instrument(block):
    return block.get("instrument") or block.get("module")


def is_library_block(block):
    return block_instrument(block) == LIBRARY_INSTRUMENT


def block_ref(block):
    """The resolved reference on a link block: {version, body_hash, mode}.

    Absent on blocks written before versioning shipped, and on copies (a copy has no reference at
    all — its blocks are inlined). An absent ref resolves against the head, preserving exactly the
    old late-binding behaviour for already-saved workflows.
    """
    ref = block.get("ref")
    return dict(ref) if isinstance(ref, dict) else {}


def iter_blocks(body):
    """Every block in a saved body, in execution order, regardless of phase."""
    for phase_key in ("prep", "script", "cleanup"):
        blocks = body.get(phase_key)
        if phase_key == "script" and not blocks:
            blocks = body.get("sequence")
        for block in (blocks or []):
            yield block


def link_targets(body):
    """Names of workflows this body links to, deduplicated, in first-seen order."""
    seen = []
    for block in iter_blocks(body):
        if is_library_block(block):
            name = block_method(block)
            if name and name not in seen:
                seen.append(name)
    return seen


# --- hashing ------------------------------------------------------------------------------------

def canonical_body(body):
    """The semantic content of a workflow — what two saves have to differ in to count as an edit."""
    def clean(blocks):
        return [
            {k: v for k, v in (block or {}).items() if k not in _VOLATILE_BLOCK_KEYS}
            for block in (blocks or [])
        ]

    return {
        "description": body.get("description", "") or "",
        "prep": clean(body.get("prep")),
        "script": clean(body.get("script") or body.get("sequence")),
        "cleanup": clean(body.get("cleanup")),
    }


def body_hash(body):
    payload = json.dumps(canonical_body(body), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# --- version store ------------------------------------------------------------------------------

# --- storage ------------------------------------------------------------------------------------
#
# The database is the source of truth; the JSON files are kept in step on every write.
#
# Both, rather than either alone, because they do different jobs. The files are how a workflow
# gets in from *outside* -- dropped in by hand, synced down from Cloud, committed to git -- and
# `ensure_versioned` has always existed to adopt one. The DB is what makes everything else sane:
# listing the library stops being one file read per workflow plus one per version, tags stop
# living in a side-car that can drift from the files beside it, and a save becomes one transaction
# instead of two writes that can half-succeed.
#
# The rule is one-directional and worth keeping that way: a write lands in the DB first and then
# mirrors to disk; a read comes from the DB, importing from disk first if the DB has never seen
# that name. Disk never overwrites a name the DB already knows -- otherwise a stale file left by
# an older build could silently roll a workflow back.


@contextmanager
def _db():
    session = sync_session()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def _head_row(session, name):
    return session.get(SavedWorkflow, validate_name(name))


def _version_row(session, name, version):
    return session.execute(
        select(SavedWorkflowVersion).where(
            SavedWorkflowVersion.name == name,
            SavedWorkflowVersion.version == int(version),
        )
    ).scalar_one_or_none()


def _db_versions(session, name):
    rows = session.execute(
        select(SavedWorkflowVersion.version).where(SavedWorkflowVersion.name == name)
    ).scalars()
    return sorted(int(v) for v in rows)


def _disk_names(workflows_dir):
    try:
        return sorted(
            f[:-5] for f in os.listdir(workflows_dir)
            if f.endswith(".json") and not f.startswith(".")
        )
    except OSError:
        return []


def _disk_versions(workflows_dir, name):
    try:
        entries = os.listdir(_versions_dir(workflows_dir, name))
    except OSError:
        return []
    versions = []
    for entry in entries:
        if entry.endswith(".json"):
            try:
                versions.append(int(entry[:-5]))
            except ValueError:
                continue
    return sorted(versions)


def _read_json(path):
    with open(path, "r") as fp:
        return json.load(fp)


def _file_stat(path):
    try:
        st = os.stat(path)
        return float(st.st_mtime), int(st.st_size)
    except OSError:
        return None


def _sync_from_disk(session, workflows_dir, name):
    """Reconcile one workflow's DB row with its mirror file. Returns the head row, or None.

    The DB is the query surface, but the file stays authoritative for existence and content,
    because things outside this process write it: a workflow dropped in by hand, synced down from
    Cloud, restored from git, or hand-edited. That is a documented capability (the expander
    defends itself against a file that has gone cyclic behind the API's back), so "the DB already
    knows this name" is not a reason to stop looking at the file.

    Cheap in the common case: the recorded mtime/size are compared first, and only a file that
    actually moved is re-read and re-hashed.
    """
    row = _head_row(session, name)
    path = workflow_path(workflows_dir, name)
    stat = _file_stat(path)

    if stat is None:
        # Deleted behind the API's back. The head goes with it; snapshots stay, as ever.
        if row is not None:
            session.delete(row)
            session.flush()
        return None

    if row is not None and (row.file_mtime, row.file_size) == stat:
        return row

    try:
        file_body = _read_json(path)
    except (OSError, ValueError) as e:
        raise WorkflowError(f"Workflow '{name}' could not be read: {e}")
    if not isinstance(file_body, dict):
        raise WorkflowError(f"Workflow '{name}' is not a JSON object")

    file_hash = body_hash(file_body)

    if row is not None:
        if row.body_hash != file_hash:
            # Same reconciliation the old code got for free by reading the file every time.
            row.body = file_body
            row.body_hash = file_hash
            row.updated_at = float(file_body.get("updated_at") or time.time())
            try:
                row.version = int(file_body.get("version") or row.version)
            except (TypeError, ValueError):
                pass
        row.file_mtime, row.file_size = stat
        session.flush()
        return row

    # First sight of this name: bring its snapshots across too, and adopt a pre-versioning
    # workflow as v1.
    body = dict(file_body)
    body.setdefault("version", 1)
    body.setdefault("body_hash", file_hash)
    body.setdefault("updated_at", time.time())

    snapshots = {}
    for version in _disk_versions(workflows_dir, name):
        try:
            snapshots[version] = _read_json(_version_path(workflows_dir, name, version))
        except (OSError, ValueError):
            continue
    if not snapshots:
        snapshots = {int(body["version"]): body}

    for version, snap in sorted(snapshots.items()):
        if _version_row(session, name, version) is not None:
            continue
        session.add(SavedWorkflowVersion(
            name=name,
            version=int(version),
            body=snap,
            body_hash=str(snap.get("body_hash") or body_hash(snap)),
            updated_at=float(snap.get("updated_at") or time.time()),
            note=snap.get("note"),
            author=snap.get("author"),
        ))

    row = SavedWorkflow(
        name=name,
        version=int(body.get("version") or max(snapshots)),
        body=body,
        body_hash=str(body.get("body_hash") or file_hash),
        updated_at=float(body.get("updated_at") or time.time()),
        tags=normalise_tags((read_meta(workflows_dir).get(name) or {}).get("tags")),
        file_mtime=stat[0],
        file_size=stat[1],
    )
    session.add(row)
    session.flush()
    return row


def list_workflow_names(workflows_dir):
    with _db() as session:
        known = set(session.execute(select(SavedWorkflow.name)).scalars().all())
        # The union, not just what is on disk: a file deleted behind the API's back has no name
        # left to iterate, so reconciling only disk names would leave its row (and its tags) in
        # the library forever.
        for name in sorted(known | set(_disk_names(workflows_dir))):
            try:
                _sync_from_disk(session, workflows_dir, name)
            except WorkflowError:
                continue  # one unreadable file shouldn't take the whole library down
        names = session.execute(select(SavedWorkflow.name)).scalars().all()
    return sorted(names)


def read_head(workflows_dir, name):
    with _db() as session:
        row = _sync_from_disk(session, workflows_dir, name)
        if row is None:
            raise WorkflowNotFound(f"Workflow '{name}' not found")
        return dict(row.body)


def list_versions(workflows_dir, name):
    with _db() as session:
        _sync_from_disk(session, workflows_dir, name)
        return _db_versions(session, name)


def ensure_versioned(workflows_dir, name):
    """Adopt a pre-versioning workflow as v1, idempotently.

    Still the name every reader calls, even though adoption now happens inside the import: the
    contract ("give me the head, whatever state it was left in") has not changed, and a caller
    that only wants the body should not have to know whether it came from disk or the DB.
    """
    return read_head(workflows_dir, name)


def head_version(workflows_dir, name):
    with _db() as session:
        row = _sync_from_disk(session, workflows_dir, name)
        if row is None:
            raise WorkflowNotFound(f"Workflow '{name}' not found")
        return int(row.version or 1)


def read_version(workflows_dir, name, version=None):
    """Load an exact version, or the head when `version` is None.

    A pinned reference to a version that no longer exists is an error, never a silent fallback to
    head -- the whole point of pinning is that the run is reproducible, so quietly substituting
    different steps would be the one unacceptable outcome.
    """
    if version is None:
        return read_head(workflows_dir, name)

    with _db() as session:
        _sync_from_disk(session, workflows_dir, name)
        row = _version_row(session, name, version)
        if row is None:
            available = _db_versions(session, name)
            raise WorkflowNotFound(
                f"Workflow '{name}' has no version {version} "
                f"(available: {', '.join(str(v) for v in available) or 'none'})"
            )
        return dict(row.body)


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fp:
        json.dump(data, fp, indent=4)


def _mirror_to_disk(workflows_dir, name, body, version):
    """Keep the on-disk copy in step. Never fatal: the DB write has already committed, so a failed
    mirror is a degraded export, not a lost workflow."""
    try:
        _write_json(_version_path(workflows_dir, name, version), body)
        _write_json(workflow_path(workflows_dir, name), body)
    except OSError as e:
        print(f"Workflow '{name}' saved, but its on-disk mirror failed: {e}")


def save_version(workflows_dir, name, body, note=None, author=None):
    """Append-only save. Returns (body, version, created).

    `created` is False when the incoming body is semantically identical to the head -- people hit
    save reflexively, and a no-op save must not burn a version number or invent a fake edit in the
    history.
    """
    validate_name(name)
    body = dict(body)
    incoming_hash = body_hash(body)

    with _db() as session:
        row = _sync_from_disk(session, workflows_dir, name)

        if row is not None and row.body_hash == incoming_hash:
            return dict(row.body), int(row.version), False

        existing = _db_versions(session, name)
        version = (max(existing) + 1) if existing else 1
        body["version"] = version
        body["body_hash"] = incoming_hash
        body["updated_at"] = time.time()
        if note:
            body["note"] = note
        if author:
            body["author"] = author
        # The deck this version was written against, beside note/author: metadata, not content,
        # so `body_hash` ignores it and re-saving on a newer deck is not a new version.
        from . import deck
        if deck.current_version() is not None:
            body["deck_version"] = deck.current_version()

        session.add(SavedWorkflowVersion(
            name=name,
            version=version,
            body=body,
            body_hash=incoming_hash,
            updated_at=body["updated_at"],
            note=note,
            author=author,
        ))
        if row is None:
            row = SavedWorkflow(name=name, tags=[])
            session.add(row)
        row.version = version
        row.body = body
        row.body_hash = incoming_hash
        row.updated_at = body["updated_at"]

        # Mirror inside the transaction so the stat we record is the stat of the file we just
        # wrote. Recording it afterwards would leave the row looking stale and make the very next
        # read re-parse the file it had itself produced.
        _mirror_to_disk(workflows_dir, name, body, version)
        stat = _file_stat(workflow_path(workflows_dir, name))
        if stat is not None:
            row.file_mtime, row.file_size = stat

    return body, version, True


def delete_workflow(workflows_dir, name):
    """Remove the head. Version snapshots are deliberately kept -- a finished run may still
    reference one, and that provenance is the reason the store exists."""
    with _db() as session:
        row = _sync_from_disk(session, workflows_dir, name)
        if row is None:
            raise WorkflowNotFound(f"Workflow '{name}' not found")
        session.delete(row)

    try:
        os.remove(workflow_path(workflows_dir, name))
    except OSError:
        pass
    _write_meta_mirror(workflows_dir)


# --- tags ---------------------------------------------------------------------------------------

def read_meta(workflows_dir):
    """The on-disk tag side-car. Only read during import now -- the DB holds tags once a workflow
    is known -- but still written, so the files remain a complete export."""
    try:
        with open(os.path.join(workflows_dir, META_FILENAME), "r") as fp:
            data = json.load(fp)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_meta_mirror(workflows_dir):
    with _db() as session:
        rows = session.execute(select(SavedWorkflow)).scalars().all()
        meta = {r.name: {"tags": list(r.tags or [])} for r in rows if r.tags}
    try:
        _write_json(os.path.join(workflows_dir, META_FILENAME), meta)
    except OSError as e:
        print(f"Tag mirror could not be written: {e}")


def normalise_tags(tags):
    """Trim, drop blanks, dedupe case-insensitively (keeping the first spelling), and cap.

    Case-insensitive deduping matters because "Screening" and "screening" filing a workflow into
    two different buckets is exactly the kind of quiet mess that makes tagging useless.
    """
    out = []
    seen = set()
    for tag in (tags or []):
        if not isinstance(tag, str):
            continue
        cleaned = " ".join(tag.split())[:MAX_TAG_LENGTH].strip()
        if not cleaned:
            continue
        key = cleaned.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(cleaned)
        if len(out) >= MAX_TAGS:
            break
    return out


def get_tags(workflows_dir, name):
    with _db() as session:
        row = _sync_from_disk(session, workflows_dir, name)
        return normalise_tags(row.tags if row is not None else [])


def set_tags(workflows_dir, name, tags):
    """Replace a workflow's tags. Returns the normalised list actually stored."""
    cleaned = normalise_tags(tags)
    with _db() as session:
        row = _sync_from_disk(session, workflows_dir, name)
        if row is None:
            raise WorkflowNotFound(f"Workflow '{name}' not found")
        row.tags = cleaned
    _write_meta_mirror(workflows_dir)
    return cleaned


def all_tags(workflows_dir):
    """Every tag in use, deduped case-insensitively, alphabetical -- the Library's filter bar."""
    list_workflow_names(workflows_dir)  # pick up anything newly dropped on disk
    with _db() as session:
        rows = session.execute(select(SavedWorkflow.tags)).scalars().all()
    collected = []
    for tags in rows:
        collected.extend(tags or [])
    return sorted(normalise_tags(collected), key=str.casefold)


# --- dependency graph ---------------------------------------------------------------------------

def dependents(workflows_dir, name, bodies=None):
    """Names of saved workflows that *link* to `name` and would therefore change if it is edited.

    Copies are invisible here by design: an inlined copy has no reference to follow, which is
    precisely why copy is the safe default.
    """
    out = []
    for candidate in list_workflow_names(workflows_dir):
        if candidate == name:
            continue
        try:
            body = (bodies or {}).get(candidate) or read_head(workflows_dir, candidate)
        except WorkflowError:
            continue
        if name in link_targets(body):
            out.append(candidate)
    return out


def find_cycle(workflows_dir, name, body):
    """Detect a link cycle reachable from `name`, using `body` as the (possibly unsaved) content of
    `name` itself. Returns the offending path, e.g. ['wash', 'rinse', 'wash'], or None.

    Graph-wide rather than self-reference-only: hiding the current workflow from the toolbox stops
    A->A but does nothing about A->B->C->A, which the old expander accepted at save time and then
    broke at runtime.
    """
    validate_name(name)

    def visit(current, current_body, path, visiting):
        for target in link_targets(current_body):
            if target in visiting:
                return path + [target]
            try:
                target_body = read_head(workflows_dir, target)
            except WorkflowError:
                # A dangling link is a real problem, but it is not a cycle; save_workflow reports
                # it separately so the two failures don't get conflated in the error message.
                continue
            found = visit(target, target_body, path + [target], visiting | {target})
            if found:
                return found
        return None

    return visit(name, body, [name], {name})


def missing_links(workflows_dir, body):
    """Link targets in `body` that don't exist on disk."""
    return [
        target for target in link_targets(body)
        if not os.path.exists(workflow_path(workflows_dir, target))
    ]


# --- expansion ----------------------------------------------------------------------------------

def _substitute(params, caller_params):
    """Replace `#var` placeholders with the values the caller supplied for them.

    Whole-value only, matching `substitute_workflow_vars` in queue.py — an unmatched placeholder is
    left intact so it can still be resolved later from the live run context.
    """
    out = {}
    for key, value in (params or {}).items():
        if isinstance(value, str) and value.startswith("#"):
            out[key] = caller_params.get(value[1:], value)
        else:
            out[key] = value
    return out


def _normalise(block):
    """Saved-JSON shape -> run-payload shape."""
    nb = dict(block)
    nb["instrument"] = block_instrument(nb)
    nb["method"] = block_method(nb)
    if "args" in nb:
        nb["params"] = nb.pop("args")
    return nb


def expand_workflow_blocks(
    sequence_list,
    workflows_dir,
    default_phase="main",
    resolved=None,
    _depth=0,
    _stack=(),
    _counter=None,
):
    """Flatten `Library Workflows` blocks into the real steps they stand for.

    Raises rather than degrading: a missing, cyclic or too-deeply-nested reference aborts the whole
    expansion. The previous implementation appended the unexpanded block on failure, which meant a
    renamed or deleted workflow dispatched a step calling an instrument literally named
    "Library Workflows" — a silent corruption discovered only once hardware was already moving.

    Pass a list as `resolved` to collect one `{name, version, body_hash, depth}` record per link
    actually followed. `create_run` persists that onto the run, so a finished run can say exactly
    which body of each subworkflow it executed.
    """
    # Every expansion of a link gets its own id. Two links to the *same* workflow produce two runs
    # of steps carrying the same `_parent_workflow`, and readers that group by name alone merged
    # them into one block -- the preview showed "Suzuki coupling screen, 32 steps" where there
    # were two sixteen-step uses. A counter rather than a uuid so the same input expands to the
    # same output: the preview endpoint and the dispatch path both call this and must agree.
    if _counter is None:
        _counter = itertools.count(1)

    expanded = []

    for block in (sequence_list or []):
        if not is_library_block(block):
            # Normalised even though a live run payload already arrives as method/params: the
            # dry-run preview endpoint posts the *saved* shape (action/args), and without this the
            # non-library branch passed it through untouched — so every plain step in a preview
            # came back with no method and no arguments at all. A preview that quietly drops the
            # arguments is worse than no preview, since those are pump rates and volumes.
            nb = _normalise(block)
            params = dict(nb.get("params") or {})
            params.setdefault("_phase", default_phase)
            ret = block.get("returnVar") or block.get("return")
            if ret:
                params["_return_var"] = ret
            # Explicit per-field pointers into a structured return value — see
            # extract_return_values in queue.py. Carried alongside _return_var, which stays as
            # the flat positional fallback for sequences saved before pointers existed. Every
            # step reaches this branch, including ones inside a linked workflow, since the
            # library branch recurses back through here.
            ret_bindings = block.get("returnBindings") or block.get("return_bindings")
            if ret_bindings:
                params["_return_bindings"] = ret_bindings
            nb["params"] = params
            expanded.append(nb)
            continue

        name = block_method(block)
        if not name:
            raise WorkflowError("A linked workflow block is missing its workflow name")

        if name in _stack:
            raise WorkflowCycleError(
                "Linked workflows form a cycle: " + " -> ".join(list(_stack) + [name])
            )
        if _depth >= MAX_LINK_DEPTH:
            raise WorkflowDepthError(
                f"Linked workflows nest more than {MAX_LINK_DEPTH} deep "
                f"({' -> '.join(list(_stack) + [name])}); inline one of them instead"
            )

        ref = block_ref(block)
        version = None if ref.get("mode") == "latest" else ref.get("version")
        body = read_version(workflows_dir, name, version)

        expected_hash = ref.get("body_hash")
        if expected_hash and body.get("body_hash") and expected_hash != body.get("body_hash"):
            raise WorkflowError(
                f"Workflow '{name}' v{body.get('version')} no longer matches what this step "
                f"was built against. Re-link or detach the step to continue."
            )

        if resolved is not None:
            resolved.append({
                "name": name,
                "version": body.get("version"),
                "body_hash": body.get("body_hash"),
                "mode": ref.get("mode") or ("latest" if version is None else "pinned"),
                "depth": _depth,
            })

        caller_params = block.get("params") or block.get("args") or {}

        # A link normally stands for the whole saved workflow, prep through cleanup. `phases`
        # narrows that to a subset, which is what lets a caller run the setup once, the body once
        # per sample, and the teardown once.
        #
        # Needed because a spreadsheet dispatched from Cloud sends one link per row: without this
        # the workflow's *prep and cleanup ran once per row too* -- a two-row screen tared the
        # balance twice and cooled the reactor down twice, which is wrong both as chemistry and
        # as a record. The bench Configure page never had the problem, because there prep and
        # cleanup are separate lists it submits once.
        wanted_phases = block.get("phases") or block.get("_phases")
        phase_keys = (
            tuple(p for p in ("prep", "script", "cleanup") if p in wanted_phases)
            if wanted_phases else ("prep", "script", "cleanup")
        )

        inner = []
        for phase_key in phase_keys:
            blocks = body.get(phase_key)
            if phase_key == "script" and not blocks:
                blocks = body.get("sequence")
            for inner_block in (blocks or []):
                nb = _normalise(inner_block)
                nb["params"] = _substitute(nb.get("params"), caller_params)
                inner.append(nb)

        # Recurse so a link inside a linked workflow resolves too. The old expander copied inner
        # blocks verbatim, so a nested link shipped straight through to the executor as a bogus
        # step; it was accepted at save time and only failed once running.
        expansion_id = next(_counter)
        steps = expand_workflow_blocks(
            inner,
            workflows_dir,
            default_phase,
            resolved=resolved,
            _depth=_depth + 1,
            _stack=tuple(_stack) + (name,),
            _counter=_counter,
        )

        for step in steps:
            params = step.setdefault("params", {})
            # The innermost owner wins, so the Queue page keeps grouping steps under the workflow
            # they literally came from. `_parent_path` carries the full chain for the preview, and
            # `_expansion_id` tells two uses of that same workflow apart.
            params.setdefault("_parent_workflow", name)
            params.setdefault("_parent_path", list(_stack) + [name])
            params.setdefault("_expansion_id", expansion_id)
            # A spreadsheet row's identity has to survive expansion. Cloud dispatches one linked
            # block per row, so without this the fifteen steps a workflow expands into carry no
            # record of which sample they belong to, and Data History has nothing to group them
            # by -- which is exactly how a two-row run came back showing one step per row.
            for key in ("_row", "_block"):
                if key in caller_params:
                    params.setdefault(key, caller_params[key])

        expanded.extend(steps)

    return expanded
