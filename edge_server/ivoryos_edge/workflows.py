"""Saved-workflow storage, versioning, link resolution and expansion.

This is the single source of truth for what a `Library Workflows` block means. Both the live
dispatch path (`create_run`) and the dry-run preview endpoint (`/api/workflows/expand`) call
`expand_workflow_blocks` here, deliberately — the preview exists to tell a user what hardware is
about to do, so it must be produced by the same code that actually produces the run. Mirroring
this logic client-side would let the two drift, and a drifted preview is worse than no preview.

Storage layout (Edge):

    workflows/{name}.json               the head — unchanged format, every existing reader still works
    workflows/.versions/{name}/{n}.json immutable snapshots, append-only

The head file gains three metadata keys (`version`, `body_hash`, `updated_at`). They are additive;
a workflow saved before versioning existed is lazily adopted as v1 the first time it is read.
"""

import hashlib
import json
import os
import re
import time

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


def list_workflow_names(workflows_dir):
    try:
        return sorted(
            f[:-5] for f in os.listdir(workflows_dir)
            if f.endswith(".json") and not f.startswith(".")
        )
    except OSError:
        return []


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

def read_head(workflows_dir, name):
    path = workflow_path(workflows_dir, name)
    if not os.path.exists(path):
        raise WorkflowNotFound(f"Workflow '{name}' not found")
    try:
        with open(path, "r") as fp:
            return json.load(fp)
    except (OSError, ValueError) as e:
        raise WorkflowError(f"Workflow '{name}' could not be read: {e}")


def list_versions(workflows_dir, name):
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


def ensure_versioned(workflows_dir, name):
    """Adopt a pre-versioning workflow as v1, idempotently.

    Called lazily on read rather than as a migration step so that a workflow file dropped into
    WORKFLOWS_DIR by hand (or synced down from Cloud) is picked up the same way as one saved
    through the UI.
    """
    body = read_head(workflows_dir, name)
    if list_versions(workflows_dir, name):
        return body

    body = dict(body)
    body.setdefault("version", 1)
    body.setdefault("body_hash", body_hash(body))
    body.setdefault("updated_at", time.time())

    os.makedirs(_versions_dir(workflows_dir, name), exist_ok=True)
    _write_json(_version_path(workflows_dir, name, 1), body)
    _write_json(workflow_path(workflows_dir, name), body)
    return body


def head_version(workflows_dir, name):
    body = ensure_versioned(workflows_dir, name)
    try:
        return int(body.get("version") or 1)
    except (TypeError, ValueError):
        return 1


def read_version(workflows_dir, name, version=None):
    """Load an exact version, or the head when `version` is None.

    A pinned reference to a version that no longer exists is an error, never a silent fallback to
    head — the whole point of pinning is that the run is reproducible, so quietly substituting
    different steps would be the one unacceptable outcome.
    """
    if version is None:
        return ensure_versioned(workflows_dir, name)

    ensure_versioned(workflows_dir, name)
    path = _version_path(workflows_dir, name, version)
    if not os.path.exists(path):
        available = list_versions(workflows_dir, name)
        raise WorkflowNotFound(
            f"Workflow '{name}' has no version {version} "
            f"(available: {', '.join(str(v) for v in available) or 'none'})"
        )
    try:
        with open(path, "r") as fp:
            return json.load(fp)
    except (OSError, ValueError) as e:
        raise WorkflowError(f"Workflow '{name}' v{version} could not be read: {e}")


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fp:
        json.dump(data, fp, indent=4)


def save_version(workflows_dir, name, body, note=None, author=None):
    """Append-only save. Returns (body, version, created).

    `created` is False when the incoming body is semantically identical to the head — people hit
    save reflexively, and a no-op save must not burn a version number or invent a fake edit in the
    history.
    """
    validate_name(name)
    body = dict(body)
    incoming_hash = body_hash(body)

    existing_versions = []
    if os.path.exists(workflow_path(workflows_dir, name)):
        ensure_versioned(workflows_dir, name)
        existing_versions = list_versions(workflows_dir, name)
        head = read_head(workflows_dir, name)
        if head.get("body_hash") == incoming_hash:
            # Keep the head file authoritative anyway (it may predate the metadata keys), but
            # report no new version.
            return head, int(head.get("version") or 1), False

    version = (max(existing_versions) + 1) if existing_versions else 1
    body["version"] = version
    body["body_hash"] = incoming_hash
    body["updated_at"] = time.time()
    if note:
        body["note"] = note
    if author:
        body["author"] = author

    _write_json(_version_path(workflows_dir, name, version), body)
    _write_json(workflow_path(workflows_dir, name), body)
    return body, version, True


def delete_workflow(workflows_dir, name):
    """Remove the head. Version snapshots are deliberately left on disk — a finished run may still
    reference one, and that provenance is the reason the store exists."""
    path = workflow_path(workflows_dir, name)
    if not os.path.exists(path):
        raise WorkflowNotFound(f"Workflow '{name}' not found")
    os.remove(path)
    set_tags(workflows_dir, name, [])


# --- tags ---------------------------------------------------------------------------------------

def read_meta(workflows_dir):
    try:
        with open(os.path.join(workflows_dir, META_FILENAME), "r") as fp:
            data = json.load(fp)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def normalise_tags(tags):
    """Trim, drop blanks, dedupe case-insensitively (keeping the first spelling), and cap.

    Case-insensitive deduping matters because "Screening" and "screening" filing a workflow into two
    different buckets is exactly the kind of quiet mess that makes tagging useless.
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
    entry = read_meta(workflows_dir).get(validate_name(name)) or {}
    return normalise_tags(entry.get("tags"))


def set_tags(workflows_dir, name, tags):
    """Replace a workflow's tags. An empty list removes its entry entirely, so deleting a workflow
    doesn't leave orphaned metadata behind that a later workflow of the same name would inherit."""
    validate_name(name)
    meta = read_meta(workflows_dir)
    cleaned = normalise_tags(tags)
    if cleaned:
        meta[name] = {**(meta.get(name) or {}), "tags": cleaned}
    else:
        meta.pop(name, None)
    _write_json(os.path.join(workflows_dir, META_FILENAME), meta)
    return cleaned


def all_tags(workflows_dir):
    """Every tag in use, deduped case-insensitively, alphabetical — the Library's filter bar."""
    known = set(list_workflow_names(workflows_dir))
    collected = []
    for name, entry in read_meta(workflows_dir).items():
        if name not in known:
            continue  # metadata for a workflow that has since been deleted
        collected.extend((entry or {}).get("tags") or [])
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

        inner = []
        for phase_key in ("prep", "script", "cleanup"):
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
        steps = expand_workflow_blocks(
            inner,
            workflows_dir,
            default_phase,
            resolved=resolved,
            _depth=_depth + 1,
            _stack=tuple(_stack) + (name,),
        )

        for step in steps:
            params = step.setdefault("params", {})
            # The innermost owner wins, so the Queue page keeps grouping steps under the workflow
            # they literally came from. `_parent_path` carries the full chain for the preview.
            params.setdefault("_parent_workflow", name)
            params.setdefault("_parent_path", list(_stack) + [name])

        expanded.extend(steps)

    return expanded
