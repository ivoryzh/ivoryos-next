"""The translate-validate-correct loop, driven by a scripted model.

A real model is not needed to test this and would make the test meaningless anyway — what
matters is the machinery around it: that an invalid draft is caught and sent back with the
specific errors, that a corrected draft is accepted, that a draft which never validates still
reaches the scientist rather than vanishing, and that in every case the result is a *proposal*
and not a saved workflow.
"""

import json

import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge.agent.chat import translate
from ivoryos_edge.agent.providers import (
    OllamaProvider,
    ProviderError,
    build_provider,
    extract_json_object,
)
from ivoryos_edge.server import app


class ScriptedProvider:
    """Returns pre-written replies in order, and records what it was asked."""

    name = "scripted"

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []
        self.model = "scripted-1"

    async def complete(self, system, messages, json_mode=False):
        self.calls.append({"system": system, "messages": messages, "json_mode": json_mode})
        if not self.replies:
            raise AssertionError("The loop asked for more replies than the test scripted.")
        return self.replies.pop(0)


SCHEMA = {
    "reactor": {
        "set_temperature": {
            "description": "Set the setpoint.",
            "parameters": {"setpoint_c": {"type": "float", "required": True}},
            "return_type": "None",
            "return_paths": [],
        },
        "hold": {
            "description": "Hold for a time.",
            "parameters": {"minutes": {"type": "float", "required": True}},
            "return_type": "None",
            "return_paths": [],
        },
    },
    "hplc": {
        "measure_yield": {
            "description": "Assay yield.",
            "parameters": {},
            "return_type": "float",
            "return_paths": [{"path": "", "type": "float", "numeric": True}],
        },
    },
}


def _reply(steps, summary="ok", **extra):
    return json.dumps({
        "summary": summary,
        "body": {"name": "P", "description": "d", "prep": [], "script": steps, "cleanup": []},
        **extra,
    })


GOOD_STEPS = [
    {"instrument": "reactor", "action": "set_temperature", "args": {"setpoint_c": 65}},
    {"instrument": "reactor", "action": "hold", "args": {"minutes": 120}},
    {"instrument": "hplc", "action": "measure_yield", "args": {},
     "return": "yield_percent",
     "return_bindings": [{"path": "", "var": "yield_percent"}]},
]


@pytest.mark.asyncio
async def test_a_valid_first_draft_is_returned_without_a_retry():
    provider = ScriptedProvider([_reply(GOOD_STEPS, summary="Heats to 65 and assays.")])
    result, transcript = await translate(provider, SCHEMA, "Heat to 65 C for 2 h then assay yield.")

    assert result["ok"] is True
    assert result["attempts"] == 1
    assert result["issues"] == []
    assert result["summary"] == "Heats to 65 and assays."
    assert len(transcript) == 1
    # The deck went into the prompt, so the model could only have used real methods.
    assert "set_temperature" in provider.calls[0]["messages"][0]["content"]
    assert provider.calls[0]["json_mode"] is True


@pytest.mark.asyncio
async def test_an_invalid_draft_is_sent_back_with_the_specific_errors_and_then_accepted():
    """The reason this loop exists: a local model writing "65 C" is corrected mechanically
    rather than reaching the scientist as a broken workflow."""
    bad = _reply([{"instrument": "reactor", "action": "set_temperature", "args": {"setpoint_c": "65 C"}}])
    provider = ScriptedProvider([bad, _reply(GOOD_STEPS)])

    result, transcript = await translate(provider, SCHEMA, "Heat to 65 C.")

    assert result["ok"] is True
    assert result["attempts"] == 2
    assert len(transcript) == 2

    # The correction names the field and says what was wrong with it.
    correction = provider.calls[1]["messages"][-1]["content"]
    assert "does not validate" in correction
    assert "setpoint_c" in correction and "expects a number" in correction
    assert "no unit" in correction


@pytest.mark.asyncio
async def test_an_invented_method_is_corrected_with_the_real_ones():
    bad = _reply([{"instrument": "reactor", "action": "warm_up", "args": {}}])
    provider = ScriptedProvider([bad, _reply(GOOD_STEPS)])

    result, _ = await translate(provider, SCHEMA, "Warm the reactor.")

    assert result["ok"] is True
    correction = provider.calls[1]["messages"][-1]["content"]
    assert "has no method 'warm_up'" in correction
    # It is told what *does* exist, which is what makes the retry likely to succeed.
    assert "set_temperature" in correction and "hold" in correction


@pytest.mark.asyncio
async def test_a_draft_that_never_validates_is_still_returned_with_its_problems():
    bad = _reply([{"instrument": "reactor", "action": "warm_up", "args": {}}])
    provider = ScriptedProvider([bad, bad, bad])

    result, transcript = await translate(provider, SCHEMA, "Warm the reactor.")

    assert result["ok"] is False
    assert result["attempts"] == 3
    assert len(transcript) == 3
    # Not an exception and not an empty body: the scientist gets the draft and the reasons.
    assert result["body"]["script"][0]["action"] == "warm_up"
    assert any(i["severity"] == "error" for i in result["issues"])
    assert "must be fixed" in result["validation_summary"]


@pytest.mark.asyncio
async def test_non_json_output_is_retried_before_giving_up():
    provider = ScriptedProvider(["Sure! Here is your workflow:", _reply(GOOD_STEPS)])
    result, _ = await translate(provider, SCHEMA, "Heat it.")
    assert result["ok"] is True
    assert "single JSON object" in provider.calls[1]["messages"][-1]["content"]


@pytest.mark.asyncio
async def test_editing_an_existing_workflow_puts_the_current_body_in_the_prompt():
    existing = {"name": "Screen", "prep": [], "cleanup": [],
                "script": [{"instrument": "reactor", "action": "hold", "args": {"minutes": 60}}]}
    provider = ScriptedProvider([_reply(GOOD_STEPS, summary="Raised the hold to 120 min.")])

    result, _ = await translate(
        provider, SCHEMA, "Make it two hours instead.",
        existing_name="Screen", existing_body=existing,
    )

    assert result["ok"] is True
    prompt = provider.calls[0]["messages"][0]["content"]
    assert "You are editing the saved workflow 'Screen'" in prompt
    assert '"minutes": 60' in prompt
    assert "complete new body, not a patch" in prompt


@pytest.mark.asyncio
async def test_questions_come_back_for_the_scientist_to_answer():
    provider = ScriptedProvider([_reply(
        GOOD_STEPS, questions=["The protocol does not say which solvent — which should I use?"]
    )])
    result, _ = await translate(provider, SCHEMA, "Run the coupling.")
    assert result["questions"] == ["The protocol does not say which solvent — which should I use?"]


def test_json_is_recovered_from_a_fenced_or_chatty_reply():
    assert extract_json_object('{"a": 1}') == {"a": 1}
    assert extract_json_object('```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json_object('Here you go:\n{"a": {"b": 2}}\nHope that helps!') == {"a": {"b": 2}}
    # A brace inside a string must not end the object early.
    assert extract_json_object('{"a": "} not the end", "b": 2}') == {"a": "} not the end", "b": 2}
    for junk in ("", "no json here", '{"unterminated": '):
        with pytest.raises(ValueError):
            extract_json_object(junk)


def test_provider_defaults_to_a_local_ollama():
    provider = build_provider({})
    assert isinstance(provider, OllamaProvider)
    assert provider.base_url == "http://localhost:11434"
    with pytest.raises(ProviderError) as excinfo:
        build_provider({"provider": "nope"})
    assert "No provider called 'nope'" in str(excinfo.value)


@pytest.mark.asyncio
async def test_unreachable_ollama_says_how_to_start_it():
    provider = OllamaProvider(base_url="http://127.0.0.1:1")
    with pytest.raises(ProviderError) as excinfo:
        await provider.list_models()
    assert "ollama serve" in str(excinfo.value)


@pytest.mark.asyncio
async def test_settings_round_trip_without_ever_echoing_the_key(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/agent/settings")
        assert resp.status_code == 200
        assert resp.json()["settings"]["provider"] == "ollama"
        assert [p["name"] for p in resp.json()["providers"]] == ["ollama", "openai-compatible"]

        saved = await ac.post("/api/agent/settings", json={
            "provider": "openai-compatible", "model": "llama-3.3-70b",
            "base_url": "https://api.groq.com/openai/v1", "api_key": "secret-value",
        })
        assert saved.status_code == 200
        settings = saved.json()["settings"]
        assert settings["model"] == "llama-3.3-70b"
        assert settings["api_key_set"] is True
        assert "api_key" not in settings

        # Switching model must not require re-sending the key, and must not clear it.
        again = await ac.post("/api/agent/settings", json={"model": "llama-3.1-8b"})
        assert again.json()["settings"]["api_key_set"] is True
        assert "secret-value" not in json.dumps(again.json())


@pytest.mark.asyncio
async def test_chat_requires_a_message(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/agent/chat", json={"message": "   "})
        assert resp.status_code == 400


@pytest.mark.asyncio
async def test_chat_reports_an_unreachable_model_instead_of_failing_silently(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/agent/settings", json={
            "provider": "ollama", "base_url": "http://127.0.0.1:1", "model": "nope",
        })
        resp = await ac.post("/api/agent/chat", json={"message": "Heat to 65 C."})
        assert resp.status_code == 503
        assert "127.0.0.1:1" in resp.json()["error"]


@pytest.mark.asyncio
async def test_chat_files_a_proposal_and_saves_nothing(api_workflows_dir, monkeypatch):
    """End to end through the endpoint, with the model scripted: a valid translation becomes a
    pending proposal, and the library is untouched until someone accepts it."""
    provider = ScriptedProvider([json.dumps({
        "summary": "Heats to 65 C and assays yield.",
        "body": {"name": "Heat And Assay", "description": "", "prep": [], "cleanup": [],
                 "script": [{"instrument": "dummy", "action": "test_method", "args": {"duration": 0}}]},
    })])
    monkeypatch.setattr("ivoryos_edge.agent.routes.build_provider", lambda settings: provider)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/agent/chat", json={"message": "Heat to 65 C then assay."})
        assert resp.status_code == 200, resp.text
        payload = resp.json()

        assert payload["ok"] is True
        assert payload["model"] == "scripted/scripted-1"
        proposal = payload["proposal"]
        assert proposal["status"] == "pending"
        assert proposal["name"] == "Heat And Assay"
        assert proposal["summary"] == "Heats to 65 C and assays yield."
        # Provenance records which model wrote it, not just that "an agent" did.
        assert proposal["source"] == "panel:scripted/scripted-1"

        listed = (await ac.get("/api/workflows")).json()["workflows"]
        assert "Heat And Assay" not in [w["name"] for w in listed]

        accepted = await ac.post(f"/api/agent/proposals/{proposal['id']}/accept", json={})
        assert accepted.status_code == 200, accepted.text
        listed = (await ac.get("/api/workflows")).json()["workflows"]
        assert "Heat And Assay" in [w["name"] for w in listed]
