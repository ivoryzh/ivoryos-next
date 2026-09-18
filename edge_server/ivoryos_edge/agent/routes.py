"""/api/agent — the tool layer over HTTP.

Read endpoints tell an assistant what the deck can do and what is already saved. Write
endpoints do not write: they file a proposal for a person to accept. The split is the point,
so it is worth being blunt about which is which:

    GET  /api/agent/deck                describe the deck (summary, or one instrument in full)
    GET  /api/agent/deck/{i}/{m}        one method's full call shape
    GET  /api/agent/workflows           saved workflows an agent may read or link to
    GET  /api/agent/workflows/{name}    one saved body
    POST /api/agent/validate            check a body against the live deck — no side effects
    POST /api/agent/propose             file a proposed workflow body for review
    POST /api/agent/request-run         ask for a workflow to be queued, for review
    GET  /api/agent/proposals           the review queue
    POST /api/agent/proposals/{id}/accept   a *person* applies it
    POST /api/agent/proposals/{id}/reject

Nothing an agent posts reaches hardware, or even the workflow library, without an accept.
"""

import json
import os
from datetime import datetime

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select

from ivoryos_edge import workflows as wf
from ivoryos_edge.agent.chat import translate
from ivoryos_edge.agent.deck import describe_deck, describe_method
from ivoryos_edge.agent.providers import ProviderError, build_provider, provider_catalogue
from ivoryos_edge.agent.validate import summarise, unbound_variables, validate_body
from ivoryos_edge.models import AgentProposal, async_session

router = APIRouter(prefix="/api/agent", tags=["agent"])

# A proposal carries a model's free text and a body it wrote. Both are shown to a person and
# neither is executed, but an unbounded field still reaches the database and the browser, so
# they are capped on the way in.
MAX_SUMMARY = 4000
MAX_BODY_BYTES = 512_000


def _state(request):
    return request.app.state


def _schema(request):
    return getattr(_state(request), "instrument_schemas", {}) or {}


def _workflow_dir(request):
    from ivoryos_edge.server import WORKFLOWS_DIR
    return WORKFLOWS_DIR


def _known_workflows(request):
    try:
        return list(wf.list_workflow_names(_workflow_dir(request)))
    except Exception:
        return []


def _clip(text, limit):
    text = "" if text is None else str(text)
    return text[:limit]


def _resolver(request):
    """Reads a saved workflow body by name, so validation can check a link's arguments."""
    def resolve(name):
        try:
            return wf.read_head(_workflow_dir(request), name)
        except Exception:
            return None
    return resolve


@router.get("/deck")
def agent_deck(request: Request, instrument: str = None):
    schema = _schema(request)
    if instrument:
        described = describe_deck(schema, instrument=instrument)
        if described is None:
            return JSONResponse(status_code=404, content={
                "error": f"No instrument called '{instrument}'.",
                "available": sorted(schema),
            })
        return described
    return describe_deck(schema, workflows=_known_workflows(request))


@router.get("/deck/{instrument}/{method}")
def agent_method(instrument: str, method: str, request: Request):
    described = describe_method(_schema(request), instrument, method)
    if described is None:
        return JSONResponse(status_code=404, content={
            "error": f"No method '{method}' on '{instrument}'.",
        })
    return described


@router.get("/workflows")
def agent_workflows(request: Request):
    names = _known_workflows(request)
    out = []
    for name in names:
        try:
            body = wf.read_head(_workflow_dir(request), name) or {}
        except Exception:
            body = {}
        out.append({
            "name": name,
            "description": body.get("description", ""),
            "version": body.get("version"),
            "steps": sum(len(body.get(phase) or []) for phase in ("prep", "script", "cleanup")),
        })
    return {"workflows": out}


@router.get("/workflows/{name}")
def agent_workflow(name: str, request: Request):
    try:
        body = wf.read_head(_workflow_dir(request), name)
    except Exception as e:
        return JSONResponse(status_code=404, content={"error": str(e)})
    if body is None:
        return JSONResponse(status_code=404, content={"error": f"No saved workflow called '{name}'."})
    return body


@router.post("/validate")
async def agent_validate(request: Request):
    try:
        data = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    body = data.get("body", data)
    issues = validate_body(body, _schema(request), _known_workflows(request), _resolver(request))
    return {
        "ok": not any(i["severity"] == "error" for i in issues),
        "summary": summarise(issues),
        "issues": issues,
    }


@router.post("/propose")
async def agent_propose(request: Request):
    """File a proposed workflow body. Returns the proposal, including its validation issues —
    an agent is expected to read those and propose again rather than leave a broken draft for
    a person to decipher."""
    try:
        data = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    name = (data.get("name") or "").strip()
    body = data.get("body")
    if not name:
        return JSONResponse(status_code=400, content={"error": "A proposal needs a workflow name."})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "A proposal needs a workflow body object."})
    if len(json.dumps(body)) > MAX_BODY_BYTES:
        return JSONResponse(status_code=413, content={"error": "Proposed workflow is too large."})
    try:
        wf.validate_name(name)
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

    issues = validate_body(body, _schema(request), _known_workflows(request), _resolver(request))
    errors = [i for i in issues if i["severity"] == "error"]

    # Refuse rather than file something broken. The agent has everything it needs to fix it —
    # each error names the field and lists the legal alternatives — and a scientist's review
    # queue is not the place to discover that a draft was never going to run. The escape hatch
    # exists for the one honest case: the agent has tried and cannot get there, and wants a
    # person to look at how far it got. That mirrors the panel, which files an imperfect draft
    # only after exhausting its own retries.
    if errors and not data.get("allow_invalid"):
        return JSONResponse(status_code=422, content={
            "error": summarise(issues),
            "issues": issues,
            "hint": ("Fix these and propose again. If you have tried and cannot resolve them, "
                     "re-send with allow_invalid: true to put the draft in front of a person "
                     "anyway, and say in the summary what you could not work out."),
            "filed": False,
        })

    try:
        current = wf.read_head(_workflow_dir(request), name)
    except Exception:
        current = None

    async with async_session() as session:
        proposal = AgentProposal(
            kind="workflow",
            name=name,
            payload=body,
            summary=_clip(data.get("summary"), MAX_SUMMARY),
            source=_clip(data.get("source"), 128),
            issues=issues,
            base_version=(current or {}).get("version"),
            status="pending",
        )
        session.add(proposal)
        await session.commit()
        await session.refresh(proposal)
        result = _as_dict(proposal)

    result["validation"] = {
        "ok": not any(i["severity"] == "error" for i in issues),
        "summary": summarise(issues),
    }
    result["note"] = (
        "Filed for review. It is not saved and will not run until a person accepts it."
        + ("" if not errors else
           " Filed with unresolved errors at your request — tell the scientist what you could"
           " not work out.")
    )
    return result


@router.post("/request-run")
async def agent_request_run(request: Request):
    """Ask for a saved workflow to be queued. This does not start anything: it files a request
    that a person has to accept, which is the only way a model-initiated action reaches the
    hardware."""
    try:
        data = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    name = (data.get("name") or "").strip()
    if not name:
        return JSONResponse(status_code=400, content={"error": "A run request needs a workflow name."})
    if name not in _known_workflows(request):
        return JSONResponse(status_code=404, content={
            "error": f"No saved workflow called '{name}'.",
            "hint": "Propose and accept it first, then request a run.",
        })

    try:
        body = wf.read_head(_workflow_dir(request), name) or {}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

    # A reusable workflow leaves values open for the spreadsheet or the optimizer to fill. A
    # one-shot run has neither, so the missing ones are demanded here — before a person is asked
    # to approve a run that would stop partway through, with reagent already in the vial.
    variables = data.get("variables") or {}
    if not isinstance(variables, dict):
        return JSONResponse(status_code=400, content={"error": "'variables' must be an object of name -> value."})
    missing = [v for v in unbound_variables(body) if v not in variables]
    if missing:
        return JSONResponse(status_code=400, content={
            "error": f"'{name}' needs a value for: " + ", ".join(missing),
            "missing_variables": missing,
            "hint": ("Pass them as 'variables', or tell the scientist to run it from the "
                     "Configure page where they can be filled in per sample."),
        })

    async with async_session() as session:
        proposal = AgentProposal(
            kind="run",
            name=name,
            payload={"parameters": data.get("parameters") or {}, "variables": variables},
            summary=_clip(data.get("summary"), MAX_SUMMARY),
            source=_clip(data.get("source"), 128),
            issues=[],
            status="pending",
        )
        session.add(proposal)
        await session.commit()
        await session.refresh(proposal)
        result = _as_dict(proposal)

    result["note"] = "Filed for review. Nothing runs until a person accepts it."
    return result


def _as_dict(proposal):
    return {
        "id": proposal.id,
        "kind": proposal.kind,
        "name": proposal.name,
        "payload": proposal.payload,
        "summary": proposal.summary,
        "source": proposal.source,
        "issues": proposal.issues,
        "base_version": proposal.base_version,
        "status": proposal.status,
        "result_id": proposal.result_id,
        "decided_note": proposal.decided_note,
        "created_at": proposal.created_at.isoformat() if proposal.created_at else None,
        "decided_at": proposal.decided_at.isoformat() if proposal.decided_at else None,
    }


@router.get("/proposals")
async def agent_proposals(status: str = "pending", limit: int = 50):
    async with async_session() as session:
        query = select(AgentProposal).order_by(AgentProposal.id.desc()).limit(max(1, min(limit, 200)))
        if status and status != "all":
            query = query.where(AgentProposal.status == status)
        rows = (await session.execute(query)).scalars().all()
        return {"proposals": [_as_dict(row) for row in rows]}


@router.get("/proposals/{proposal_id}")
async def agent_proposal(proposal_id: int):
    async with async_session() as session:
        row = await session.get(AgentProposal, proposal_id)
        if row is None:
            return JSONResponse(status_code=404, content={"error": "No such proposal."})
        return _as_dict(row)


@router.post("/proposals/{proposal_id}/accept")
async def agent_accept(proposal_id: int, request: Request):
    """Apply a proposal. This is the human end of the loop and the only thing here with an
    effect: it is reached from the review UI, never by an agent."""
    try:
        data = await request.json()
    except Exception:
        data = {}

    async with async_session() as session:
        row = await session.get(AgentProposal, proposal_id)
        if row is None:
            return JSONResponse(status_code=404, content={"error": "No such proposal."})
        if row.status != "pending":
            return JSONResponse(status_code=409, content={
                "error": f"This proposal was already {row.status}.",
            })

        if row.kind == "workflow":
            # Re-validate at accept time. The deck can change between a model writing a
            # workflow and a person reading it — an instrument goes offline, a driver is
            # updated — and the issues stored on the proposal are a record of what the agent
            # was told, not a current verdict.
            issues = validate_body(row.payload, _schema(request), _known_workflows(request), _resolver(request))
            blocking = [i for i in issues if i["severity"] == "error"]
            if blocking and not data.get("force"):
                return JSONResponse(status_code=400, content={
                    "error": "This no longer validates against the current deck.",
                    "issues": issues,
                    "forceable": True,
                })
            # Taking a proposal onto the Designer canvas is also an acceptance, but it must not
            # write a version: the scientist is about to edit it and will save when they are
            # happy. Recording it as accepted anyway keeps the review queue honest — the
            # proposal has been dealt with, and by whom.
            if data.get("save") is False:
                row.status = "accepted"
                row.decided_note = data.get("note") or "Taken onto the canvas"
                row.decided_at = datetime.utcnow()
                await session.commit()
                return {"ok": True, "kind": "workflow", "name": row.name,
                        "saved": False, "body": row.payload}

            try:
                body, version, created = wf.save_version(
                    _workflow_dir(request),
                    row.name,
                    dict(row.payload),
                    note=data.get("note") or f"Accepted agent proposal #{row.id}",
                    author=data.get("author") or row.source or "agent",
                )
            except Exception as e:
                return JSONResponse(status_code=400, content={"error": str(e)})
            row.result_id = version
            row.status = "accepted"
            row.decided_note = data.get("note")
            row.decided_at = datetime.utcnow()
            await session.commit()
            return {"ok": True, "kind": "workflow", "name": row.name, "version": version,
                    "created": created, "saved": True}

        if row.kind == "run":
            from ivoryos_edge.server import WORKFLOWS_DIR, queue_manager
            try:
                body = wf.read_head(WORKFLOWS_DIR, row.name) or {}
                # Expanded per phase, like /api/queue/runs does: the phase travels on each step
                # as `_phase` and is what the Queue and Data History group by, so flattening
                # all three together would label every step "main".
                resolved_links = []
                steps = []
                for phase, key in (("prep", "prep"), ("main", "script"), ("cleanup", "cleanup")):
                    steps += wf.expand_workflow_blocks(
                        list(body.get(key) or []), WORKFLOWS_DIR, phase, resolved=resolved_links,
                    )
                supplied = (row.payload or {}).get("variables") or {}
                if supplied:
                    for step in steps:
                        params = step.get("params") or {}
                        for key, value in list(params.items()):
                            if isinstance(value, str) and value.strip().startswith("#"):
                                var_name = value.strip()[1:].strip()
                                if var_name in supplied:
                                    params[key] = supplied[var_name]

                parameters = dict((row.payload or {}).get("parameters") or {})
                if supplied:
                    parameters["agent_variables"] = supplied
                # Provenance: a run that a person approved on an agent's suggestion should say so
                # in its own record, not only in the proposal table.
                parameters["agent_proposal_id"] = row.id
                if row.source:
                    parameters["agent_source"] = row.source
                if resolved_links:
                    parameters["resolved_links"] = resolved_links
                run_id = await queue_manager.submit_sequence(row.name, steps, parameters)
            except Exception as e:
                return JSONResponse(status_code=400, content={"error": str(e)})
            row.result_id = run_id
            row.status = "accepted"
            row.decided_note = data.get("note")
            row.decided_at = datetime.utcnow()
            await session.commit()
            return {"ok": True, "kind": "run", "name": row.name, "run_id": run_id}

        return JSONResponse(status_code=400, content={"error": f"Unknown proposal kind '{row.kind}'."})


@router.post("/proposals/{proposal_id}/reject")
async def agent_reject(proposal_id: int, request: Request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    async with async_session() as session:
        row = await session.get(AgentProposal, proposal_id)
        if row is None:
            return JSONResponse(status_code=404, content={"error": "No such proposal."})
        if row.status != "pending":
            return JSONResponse(status_code=409, content={"error": f"This proposal was already {row.status}."})
        row.status = "rejected"
        row.decided_note = _clip(data.get("note"), MAX_SUMMARY)
        row.decided_at = datetime.utcnow()
        await session.commit()
        return {"ok": True, "status": "rejected"}


# --- the in-app panel: model settings and the translate loop -------------------------------
#
# The panel and the MCP server reach the same tools; the difference is only who is driving.
# These endpoints exist because the panel needs a model *chosen for it* (the MCP client brings
# its own), and because calling the model from the server rather than the browser keeps the
# key, and any protocol text, off the client.

SETTINGS_FILENAME = "agent_settings.json"


def _settings_path(request):
    # Beside the workflow store rather than in the process's working directory, so a test that
    # redirects WORKFLOWS_DIR gets its own settings too, and so a lab running two decks from
    # one checkout does not have them share a model. Gitignored: it can hold an API key.
    return os.path.join(os.path.dirname(_workflow_dir(request)), SETTINGS_FILENAME)


def _read_settings(request):
    try:
        with open(_settings_path(request), "r") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        # No settings yet means a local Ollama on its default port, which is the case that
        # should need no configuration at all.
        return {"provider": "ollama"}


def _write_settings(request, settings):
    with open(_settings_path(request), "w") as handle:
        json.dump(settings, handle, indent=2)


def _public_settings(settings):
    """Never echo the key back — the UI only needs to know whether one is set."""
    out = {k: v for k, v in settings.items() if k != "api_key"}
    out["api_key_set"] = bool(settings.get("api_key"))
    return out


@router.get("/settings")
def agent_settings(request: Request):
    return {"settings": _public_settings(_read_settings(request)), "providers": provider_catalogue()}


@router.post("/settings")
async def agent_update_settings(request: Request):
    try:
        data = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    settings = _read_settings(request)
    for field in ("provider", "base_url", "model"):
        if field in data:
            settings[field] = _clip(data.get(field), 500)
    if "api_key" in data:
        # An empty string clears it; absent leaves whatever is stored alone, so the UI can save
        # a model change without having to re-send the key it was never shown.
        key = data.get("api_key")
        if key:
            settings["api_key"] = _clip(key, 500)
        else:
            settings.pop("api_key", None)
    try:
        _write_settings(request, settings)
    except OSError as e:
        return JSONResponse(status_code=500, content={"error": f"Could not save settings: {e}"})
    return {"settings": _public_settings(settings)}


@router.get("/models")
async def agent_models(request: Request):
    """Which models the configured provider can actually offer right now — this is what the
    model switcher lists, rather than a hardcoded set that goes stale."""
    settings = _read_settings(request)
    try:
        provider = build_provider(settings)
        models = await provider.list_models()
    except ProviderError as e:
        return JSONResponse(status_code=503, content={"error": str(e), "provider": settings.get("provider")})
    return {"provider": provider.name, "models": models, "current": provider.model}


@router.post("/chat")
async def agent_chat(request: Request):
    """Translate prose into a workflow and file it for review.

    One call does the whole loop — generate, validate against the live deck, correct — and
    always ends at a proposal, including when the model could not get it fully valid: the
    scientist is better served by a draft with its problems named than by a failure message.
    """
    try:
        data = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    message = (data.get("message") or "").strip()
    if not message:
        return JSONResponse(status_code=400, content={"error": "Say what the protocol should do."})

    settings = _read_settings(request)
    try:
        provider = build_provider(settings)
    except ProviderError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

    existing_name = (data.get("workflow_name") or "").strip() or None
    existing_body = data.get("workflow_body")
    if existing_name and existing_body is None:
        try:
            existing_body = wf.read_head(_workflow_dir(request), existing_name)
        except Exception:
            existing_body = None

    known = _known_workflows(request)
    try:
        result, transcript = await translate(
            provider,
            _schema(request),
            message,
            history=data.get("history") or [],
            workflows=known,
            existing_name=existing_name,
            existing_body=existing_body,
        )
    except ProviderError as e:
        return JSONResponse(status_code=503, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"The model call failed: {e}"})

    body = result["body"]
    name = existing_name or (body.get("name") or "Untitled protocol")
    # `model` is what wrote it; `source` also says which surface asked, since the MCP server
    # files proposals into the same queue and the reviewer should be able to tell them apart.
    model_id = f"{provider.name}/{provider.model}"
    source = f"panel:{model_id}"

    async with async_session() as session:
        proposal = AgentProposal(
            kind="workflow",
            name=name,
            payload=body,
            summary=_clip(result["summary"], MAX_SUMMARY),
            source=_clip(source, 128),
            issues=result["issues"],
            base_version=(existing_body or {}).get("version"),
            status="pending",
        )
        session.add(proposal)
        await session.commit()
        await session.refresh(proposal)
        stored = _as_dict(proposal)

    return {
        "proposal": stored,
        "ok": result["ok"],
        "validation_summary": result["validation_summary"],
        "questions": result["questions"],
        "attempts": result["attempts"],
        "model": model_id,
        # Only on failure, and only the last reply: enough to see what the model actually said
        # when it could not produce something valid, without dumping every attempt into the UI.
        "raw": None if result["ok"] else (transcript[-1]["raw"][:4000] if transcript else None),
    }
