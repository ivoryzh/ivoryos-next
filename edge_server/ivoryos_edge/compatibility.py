"""Which saved workflows still run against the deck that is actually connected.

A workflow is stored as instrument/method/arguments, resolved against the live schema only when
it runs. That is what makes the library reusable — and what makes it quietly rot: rename a
driver's parameter, drop a method, swap an instrument for a newer model, and every workflow that
used it is still sitting there looking fine, right up to the moment someone queues it and a
reaction fails four steps in.

The check itself is `validate_body`, the same pass the agent runs before proposing a workflow, so
there is no second notion of "valid" to keep in sync. Two things are specific to this use:

- **Only errors count.** `validate_body` also reports warnings, and the commonest one — "reads
  #temperature, which no earlier step produces" — is precisely how a *reusable* workflow is meant
  to look: the Configure page fills it from a spreadsheet, or an optimization run fills it per
  trial. Counting those would light up the whole library and teach everyone to ignore the badge.
- **A workflow with no steps is not a deck problem.** It cannot run either, but saying "no longer
  compatible" about an empty draft is a lie about the cause.

Caching is not an optimization here so much as a statement about when the answer can change.
`app.state.instrument_schemas` is built once in `startup_event` and never written again, so a
verdict can only go stale when the *workflow* changes — which `body_hash` already tracks — or when
the *deck* changes, which means a restart. Keying on both means a re-check happens exactly when
one of those two things happened, and never otherwise. (Measured on a demo library: 7 µs per
workflow uncached, so this is about correctness and predictability, not speed.)
"""

import hashlib
import json

from ivoryos_edge.agent.validate import validate_body

# name -> (body key, schema fingerprint, verdict)
_cache: dict = {}

# How many errors travel with a list row. The badge needs a count and a reason or two; the whole
# list belongs on the workflow itself, where there is room to show which step each one is about.
MAX_REPORTED = 5


def schema_fingerprint(schema) -> str:
    """A short digest of the deck's published schema.

    Over the whole schema, not just the method names: a renamed parameter or a changed enum breaks
    a saved workflow exactly as thoroughly as a deleted method, and is the case a coarser
    fingerprint would miss.
    """
    try:
        blob = json.dumps(schema or {}, sort_keys=True, default=str)
    except Exception:
        blob = repr(schema)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _body_key(body) -> str:
    """`body_hash` where the workflow has one, a digest of the body where it doesn't (bodies
    written before versioning, or synced down from Cloud, carry an empty hash)."""
    stored = (body or {}).get("body_hash")
    if stored:
        return str(stored)
    try:
        return hashlib.sha256(json.dumps(body or {}, sort_keys=True, default=str).encode()).hexdigest()[:16]
    except Exception:
        return ""


def check(name, body, schema, fingerprint, known_workflows=()):
    """`{"status": "ok"|"broken", "error_count": n, "errors": [...]}` for one workflow."""
    key = _body_key(body)
    cached = _cache.get(name)
    if cached is not None and cached[0] == key and cached[1] == fingerprint and key:
        return cached[2]

    issues = validate_body(body or {}, schema or {}, known_workflows)
    errors = [
        issue for issue in issues
        if issue.get("severity") == "error" and issue.get("where") != "body"
    ]
    verdict = {
        "status": "broken" if errors else "ok",
        "error_count": len(errors),
        "errors": [
            {k: v for k, v in issue.items() if k in ("where", "message", "hint")}
            for issue in errors[:MAX_REPORTED]
        ],
    }
    # Which deck this workflow was last saved against, so a broken one can say "written for deck
    # v3" -- the version whose diff to the current deck explains the errors. Absent for workflows
    # saved before decks were versioned.
    if (body or {}).get("deck_version") is not None:
        verdict["deck_version"] = body["deck_version"]
    _cache[name] = (key, fingerprint, verdict)
    return verdict


def forget(name=None):
    """Drop cached verdicts. Only needed when a body changes without its hash changing with it —
    a delete-and-recreate under the same name — since every other path is covered by the key."""
    if name is None:
        _cache.clear()
    else:
        _cache.pop(name, None)
