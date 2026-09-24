"""Versioned deck schema: which instruments, methods and parameters this device had, and when.

The schema is introspected from the live drivers at every startup (`startup_event`) and used to be
thrown away at shutdown. So once a driver changed -- a parameter renamed, a method dropped, an
instrument swapped for a newer model -- nothing could say what the deck looked like when a
workflow was written or when a past run executed. This module keeps every distinct shape:

- `record()` runs once at startup. The deck gets a new version only when its fingerprint differs
  from the *latest* version's, so restarting against the same drivers changes nothing, and going
  back to an older driver is recorded as a new change (the history is a timeline, not a set).
- `current_version()` is what runs and saved workflow versions are stamped with.
- `diff()` says what changed between two versions, in the terms a person fixing a workflow needs:
  instruments and methods added or removed, parameters added, removed, retyped or made required.

The fingerprint is `compatibility.schema_fingerprint`, the same digest that decides when a saved
workflow's compatibility verdict can change, so "the deck changed" means one thing everywhere.
"""

import time

from sqlalchemy import func, select

from .models import DeckVersion, sync_session

_current = {"version": None, "fingerprint": None}


def record(schema, instrument_meta, fingerprint):
    """Store this startup's deck if it differs from the latest version. Returns its version."""
    now = time.time()
    with sync_session() as session:
        latest = session.execute(
            select(DeckVersion).order_by(DeckVersion.version.desc()).limit(1)
        ).scalar_one_or_none()
        if latest is not None and latest.fingerprint == fingerprint:
            latest.last_seen = now
            row = latest
        else:
            row = DeckVersion(
                version=(latest.version + 1) if latest else 1,
                fingerprint=fingerprint,
                schema=schema or {},
                instrument_meta=instrument_meta or {},
                first_seen=now,
                last_seen=now,
            )
            session.add(row)
        session.commit()
        _current.update(version=row.version, fingerprint=fingerprint)
        return row.version


def current_version():
    """The deck version this process is running against, or None before startup has recorded it."""
    return _current["version"]


def list_versions():
    with sync_session() as session:
        rows = session.execute(select(DeckVersion).order_by(DeckVersion.version.desc())).scalars().all()
        return [
            {
                "version": r.version,
                "fingerprint": r.fingerprint,
                "first_seen": r.first_seen,
                "last_seen": r.last_seen,
                "instruments": sorted((r.schema or {}).keys()),
            }
            for r in rows
        ]


def get_version(version):
    with sync_session() as session:
        row = session.get(DeckVersion, int(version))
        if row is None:
            return None
        return {
            "version": row.version,
            "fingerprint": row.fingerprint,
            "first_seen": row.first_seen,
            "last_seen": row.last_seen,
            "schema": row.schema or {},
            "instrument_meta": row.instrument_meta or {},
        }


def latest_version_number():
    with sync_session() as session:
        return session.execute(select(func.max(DeckVersion.version))).scalar()


def _param_signature(spec):
    """The parts of a parameter a saved step depends on. Descriptions and defaults' formatting
    are left out: changing a docstring must not read as breaking a workflow."""
    spec = spec or {}
    return {
        "type": spec.get("type"),
        "required": bool(spec.get("required")),
        "options": list(spec.get("options") or []) or None,
    }


def diff(old_schema, new_schema):
    """What changed from `old_schema` to `new_schema`, as a list of plain records.

    Each record is `{change, instrument, method?, param?, before?, after?}` with `change` one of
    instrument_added / instrument_removed / method_added / method_removed / param_added /
    param_removed / param_changed / returns_changed.
    """
    old_schema = old_schema or {}
    new_schema = new_schema or {}
    changes = []

    for inst in sorted(set(old_schema) | set(new_schema)):
        if inst not in new_schema:
            changes.append({"change": "instrument_removed", "instrument": inst})
            continue
        if inst not in old_schema:
            changes.append({"change": "instrument_added", "instrument": inst})
            continue
        old_methods, new_methods = old_schema[inst] or {}, new_schema[inst] or {}
        for m in sorted(set(old_methods) | set(new_methods)):
            if m not in new_methods:
                changes.append({"change": "method_removed", "instrument": inst, "method": m})
                continue
            if m not in old_methods:
                changes.append({"change": "method_added", "instrument": inst, "method": m})
                continue
            old_params = (old_methods[m] or {}).get("parameters") or {}
            new_params = (new_methods[m] or {}).get("parameters") or {}
            for p in sorted(set(old_params) | set(new_params)):
                if p not in new_params:
                    changes.append({"change": "param_removed", "instrument": inst, "method": m, "param": p})
                elif p not in old_params:
                    changes.append({
                        "change": "param_added", "instrument": inst, "method": m, "param": p,
                        "after": _param_signature(new_params[p]),
                    })
                else:
                    before, after = _param_signature(old_params[p]), _param_signature(new_params[p])
                    if before != after:
                        changes.append({
                            "change": "param_changed", "instrument": inst, "method": m, "param": p,
                            "before": before, "after": after,
                        })
            old_ret = (old_methods[m] or {}).get("return_type")
            new_ret = (new_methods[m] or {}).get("return_type")
            if old_ret != new_ret:
                changes.append({
                    "change": "returns_changed", "instrument": inst, "method": m,
                    "before": old_ret, "after": new_ret,
                })
    return changes
