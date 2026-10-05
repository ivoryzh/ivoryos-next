"""Plain words to a draft of the safety configuration.

"Don't let the arm put anything on the balance unless its door is open" is one sentence to say
and, by hand, a state, two things that set it and a rule to click together. The loop here is the
one `chat.py` uses for workflows: describe the deck, ask for one JSON object, check it with the
guard's own `validate`, and hand the errors back to the model, up to a few attempts.

What comes out is a draft and nothing more. It is returned to the Safety page, which shows it
in its editors unsaved; a person reads it and presses Save, or does not. Nothing here writes
`safety.json`, for the same reason an agent never saves a workflow: a model near a deck that
moves liquid gets to propose, not to decide.
"""

import copy
import json

from ivoryos_edge import safety
from ivoryos_edge.agent.providers import extract_json_object

MAX_ATTEMPTS = 3

SYSTEM_PROMPT = """You write safety configuration for a laboratory automation deck.

You are given the instruments on this deck with their methods, arguments and readings, and the
safety configuration it already has. Use only those instruments, methods, arguments and
readings. Never invent one: if the request cannot be expressed with what the deck has, say so in
"summary" and add nothing.

Reply with a single JSON object and nothing else:

{
  "summary": "<plain language: what you added and what it will now block>",
  "add": {
    "states": {"<name>": {"label": "<words>", "values": ["<value>", "<value>"],
                          "read": {"read": "<instrument.reading>", "map": {"<raw reading>": "<value>"}},
                          "set_by": [{"target": "<instrument or class:Driver>", "method": "<method>", "value": "<value>"}]}},
    "limits": [{"target": "<instrument or class:Driver>", "method": "<method>", "param": "<argument>",
                "min": 0, "max": 10, "allowed": ["<value>"]}],
    "rules": [{"name": "<what it protects>",
               "when": {"target": "<instrument or class:Driver>", "method": "<method>"},
               "if": [<clause>], "require": [<clause>],
               "message": "<what the person should do instead>"}]
  },
  "questions": ["<anything a person must decide before this is right>"]
}

A clause is {"left": <operand>, "op": "<one of < <= > >= == != in>", "right": <operand>}.
An operand is exactly one of:
  {"arg": "<an argument of the method named in when>"}
  {"read": "<instrument.reading, from that instrument's readings>"}
  {"state": "<a state name, existing or one you add>"}
  {"value": <a number, text, true/false, or a list for "in">}

How to choose:
- One value with a range or a short list of allowed values is a limit. Leave out min, max or
  allowed when the request does not give them.
- A call on one instrument that depends on another instrument is a rule. "if" narrows when the
  rule applies (e.g. only when the destination argument is the balance); "require" is what must
  hold. Omit "if" when the rule always applies.
- A condition of the deck that a rule depends on (a door open or closed, a gripper holding or
  empty, a pan occupied or empty) is a state. Reuse an existing state when one fits. Give a new
  one exactly one source: "read" when a listed reading reports it (with "map" only if the raw
  reading differs from the state's values), otherwise "set_by" listing EVERY method that changes
  it and the value each leaves. In "set_by", "value" may also be {"arg": "<argument>"} or
  {"result": "<field of the result>"}.
- A method that carries out a whole sequence by itself needs only what must be true before it (a
  rule) and what it leaves behind (a set_by entry on that one method). Do not write rules about
  the steps inside it.
- "class:<Driver>" as a target covers every instrument of that driver class. Use it when the
  request says "any pump" or "every arm".
- Omit "states", "limits" or "rules" when you add none of that kind."""


def deck_brief(deck: safety.Deck) -> dict:
    """The deck as this task needs it: what can be called, with which arguments, and what can be read."""
    out = {}
    for name in deck.names():
        methods, readings = {}, []
        for method, entry in (deck.schemas.get(name) or {}).items():
            params = {}
            for param, info in (entry.get("parameters") or {}).items():
                text = str(info.get("type") or "any")
                if info.get("options") is not None:
                    text += " one of " + ", ".join(str(o) for o in info["options"])
                params[param] = text
            methods[method] = params
            needs_arguments = any(p.get("required") and "default" not in p
                                  for p in (entry.get("parameters") or {}).values())
            if not needs_arguments and safety.looks_like_reading(method, entry):
                readings.append(f"{name}.{method}")
        classes = deck.classes(name)
        out[name] = {"class": classes[0] if classes else None, "methods": methods, "readings": readings}
    return out


def merge(config: dict, add: dict) -> dict:
    """The configuration with a model's additions laid over it. A state or tray of the same name,
    or a limit on the same field, is replaced; rules are added."""
    merged = copy.deepcopy(config)
    for kind in ("trays", "states"):
        if isinstance(add.get(kind), dict):
            merged.setdefault(kind, {}).update(add[kind])
    for limit in add.get("limits") or []:
        if not isinstance(limit, dict):
            continue
        same = lambda l: all(l.get(k) == limit.get(k) for k in ("target", "method", "param"))
        merged["limits"] = [l for l in merged.get("limits", []) if not same(l)] + [limit]
    for rule in add.get("rules") or []:
        if isinstance(rule, dict):
            merged.setdefault("rules", []).append({k: v for k, v in rule.items() if k != "id"})
    return merged


def _added(add: dict) -> dict:
    return {
        "states": sorted((add.get("states") or {}).keys()) if isinstance(add.get("states"), dict) else [],
        "limits": [f"{l.get('target')}.{l.get('method')}.{l.get('param')}" for l in add.get("limits") or [] if isinstance(l, dict)],
        "rules": [str(r.get("name") or "a rule") for r in add.get("rules") or [] if isinstance(r, dict)],
    }


async def draft_safety(provider, deck: safety.Deck, config: dict, message: str, max_attempts: int = MAX_ATTEMPTS):
    """Run the draft-validate-correct loop. Returns (result, transcript).

    `result` is {ok, summary, questions, config, problems, added, attempts}. `config` is the whole
    configuration with the additions in it, normalized by the guard, for the page to show unsaved;
    when the model never got it valid it is still returned, with `problems` saying what is wrong,
    because a nearly-right rule a person can fix beats an apology."""
    base, base_problems = safety.validate(config, deck)
    if any(p["level"] == "error" for p in base_problems):
        raise ValueError("Fix what the page already marks before asking for more.")

    messages = [{
        "role": "user",
        "content": ("This lab's deck, as JSON:\n\n" + json.dumps(deck_brief(deck), indent=1)
                    + "\n\nIts safety configuration so far:\n\n"
                    + json.dumps({k: base[k] for k in ("trays", "states", "limits", "rules")}, indent=1)),
    }, {
        "role": "assistant",
        "content": "Understood. I will use only what this deck has, and reply with a single JSON object.",
    }, {"role": "user", "content": message}]

    transcript = []
    result = {"ok": False, "summary": "", "questions": [], "config": base, "problems": [],
              "added": {"states": [], "limits": [], "rules": []}, "attempts": 0}
    for attempt in range(1, max_attempts + 1):
        raw = await provider.complete(SYSTEM_PROMPT, messages, json_mode=True)
        transcript.append({"attempt": attempt, "raw": raw})
        result["attempts"] = attempt
        try:
            parsed = extract_json_object(raw)
        except ValueError:
            messages.append({"role": "assistant", "content": raw[:4000]})
            messages.append({"role": "user", "content": "That was not valid JSON. Reply with a single JSON object and nothing else."})
            result["problems"] = [{"level": "error", "where": "reply", "message": "The model did not answer with JSON."}]
            continue

        add = parsed.get("add") if isinstance(parsed.get("add"), dict) else {}
        merged, problems = safety.validate(merge(base, add), deck)
        errors = [p for p in problems if p["level"] == "error"]
        result.update({
            "ok": not errors, "summary": str(parsed.get("summary") or "").strip(),
            "questions": [str(q) for q in (parsed.get("questions") or []) if str(q).strip()],
            "config": merged, "problems": problems, "added": _added(add),
        })
        if not errors:
            break
        messages.append({"role": "assistant", "content": raw[:4000]})
        messages.append({"role": "user", "content": (
            "That does not validate against the deck. Fix exactly these problems and return the "
            "corrected JSON object:\n\n" + "\n".join(f"- {p['message']}" for p in errors))})
    return result, transcript
