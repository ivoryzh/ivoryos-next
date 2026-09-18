"""Turning a paragraph of protocol into a reviewable workflow.

The loop is: describe the deck, ask for one JSON workflow body, validate it against that same
deck, and hand the errors back to the model to fix — up to a small number of attempts. The
retry is what makes this usable with a local model: a 8B model asked cold gets an argument name
or a unit wrong perhaps half the time, and gets it right when told precisely what was wrong,
because `validate_body`'s messages name the offending field and list the legal alternatives.

What comes out is never applied. It is filed as a proposal for the scientist to accept, so the
worst case of a bad translation is a rejected diff rather than a wrong reaction.
"""

import json

from ivoryos_edge.agent.deck import describe_deck
from ivoryos_edge.agent.providers import ProviderError, extract_json_object
from ivoryos_edge.agent.validate import validate_body, summarise

MAX_ATTEMPTS = 3

SYSTEM_PROMPT = """You translate laboratory protocols into IvoryOS workflows.

You are given the exact set of instruments and methods available on this lab's deck. You must
use only those. Never invent an instrument, a method or an argument name: if the protocol asks
for something the deck cannot do, say so in your summary and leave that step out rather than
approximating it with a method that does something else.

Reply with a single JSON object and nothing else:

{
  "summary": "<plain language: what this does, and for an edit, what you changed and why>",
  "body": {
    "name": "<short name>",
    "description": "<one line>",
    "prep": [ ...steps... ],
    "script": [ ...steps... ],
    "cleanup": [ ...steps... ]
  },
  "questions": ["<anything the protocol left ambiguous that a person must decide>"]
}

A step is {"instrument": "<name>", "action": "<method>", "args": {"<arg>": <value>}}.

Rules that matter:
- Numbers are bare numbers. Write 65, never "65 C" or "65 degrees".
- `prep` runs once at the start, `script` is the part repeated per sample or per optimization
  trial, and `cleanup` runs once at the end. If the protocol does not distinguish them, put
  everything in `script`.
- To save a result for a later step or as an optimization objective, add to that step:
  "return": "name", "return_bindings": [{"path": "<a save_from value from the deck>", "var": "name"}].
  Use the exact `save_from` strings the deck lists. Only numeric results can be optimized.
- To use a saved value later, write it as a string "#name" in an argument.
- A value the protocol leaves to the operator should be "#name" and listed in `questions`,
  or read with a Flow_Control User_Input step.
- Every Flow_Control "If" needs a matching "End_If", and every "While" a matching "End_While".
- Prefer fewer, correct steps. Do not invent safety, washing or calibration steps the protocol
  does not mention.

If you are editing an existing workflow, keep every step the scientist did not ask you to
change, exactly as it was."""


def _deck_prompt(schema, workflows):
    return (
        "This lab's deck, as JSON. These are the only instruments and methods that exist:\n\n"
        + json.dumps(describe_deck(schema, workflows=workflows), indent=1)
    )


def _existing_prompt(name, body):
    return (
        f"You are editing the saved workflow '{name}'. Its current body is:\n\n"
        + json.dumps(body, indent=1)
        + "\n\nReturn the complete new body, not a patch."
    )


def _retry_prompt(issues):
    errors = [i for i in issues if i["severity"] == "error"]
    lines = []
    for issue in errors:
        line = f"- {issue['where']}: {issue['message']}"
        if issue.get("hint"):
            line += f" ({issue['hint']})"
        lines.append(line)
    return (
        "That workflow does not validate against the deck. Fix exactly these problems and "
        "return the corrected JSON object:\n\n" + "\n".join(lines)
    )


async def translate(provider, schema, user_message, history=None, workflows=(),
                    existing_name=None, existing_body=None, max_attempts=MAX_ATTEMPTS,
                    on_progress=None, resolve_workflow=None):
    """Run the translate-validate-correct loop.

    Returns (result, transcript) where result is {summary, body, questions, issues, ok,
    attempts} and transcript is the raw exchange, kept so a failure can be shown to the
    scientist rather than swallowed.

    `on_progress` is awaited with a dict at each phase. The interesting part of this loop is not
    the tokens, it is the check-and-correct cycle — "wrote 9 steps, two were wrong, fixing" is
    what tells a waiting scientist the thing is working and roughly how well. A local model
    takes tens of seconds per attempt, which is far too long to show nothing.
    """
    async def report(**event):
        if on_progress is not None:
            await on_progress(event)
    messages = []
    context = [_deck_prompt(schema, workflows)]
    if existing_body:
        context.append(_existing_prompt(existing_name, existing_body))
    messages.append({"role": "user", "content": "\n\n".join(context)})
    messages.append({
        "role": "assistant",
        "content": "Understood. I will use only those instruments and methods, and reply with a single JSON object.",
    })

    for turn in (history or []):
        role = turn.get("role")
        content = turn.get("content")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": str(content)[:20000]})

    messages.append({"role": "user", "content": user_message})

    await report(phase="reading_deck", instruments=len(schema),
                 editing=existing_name or None)

    transcript = []
    last_error = None
    for attempt in range(1, max_attempts + 1):
        await report(phase="drafting", attempt=attempt, max_attempts=max_attempts)
        raw = await provider.complete(SYSTEM_PROMPT, messages, json_mode=True)
        transcript.append({"attempt": attempt, "raw": raw})

        try:
            parsed = extract_json_object(raw)
        except ValueError as e:
            last_error = str(e)
            await report(phase="unreadable", attempt=attempt, detail=str(e))
            messages.append({"role": "assistant", "content": raw[:4000]})
            messages.append({
                "role": "user",
                "content": "That was not valid JSON. Reply with a single JSON object and nothing else.",
            })
            continue

        body = parsed.get("body")
        if not isinstance(body, dict):
            last_error = "The reply had no 'body' object."
            await report(phase="unreadable", attempt=attempt, detail=last_error)
            messages.append({"role": "assistant", "content": raw[:4000]})
            messages.append({
                "role": "user",
                "content": "The JSON object must contain a 'body' with prep/script/cleanup arrays.",
            })
            continue

        body.setdefault("name", existing_name or parsed.get("name") or "Untitled protocol")
        for phase in ("prep", "script", "cleanup"):
            body.setdefault(phase, [])

        step_count = sum(len(body.get(phase) or []) for phase in ("prep", "script", "cleanup"))
        await report(phase="validating", attempt=attempt, steps=step_count,
                     name=body.get("name"))

        issues = validate_body(body, schema, workflows, resolve_workflow)
        errors = [i for i in issues if i["severity"] == "error"]
        result = {
            "summary": str(parsed.get("summary") or "").strip(),
            "body": body,
            "questions": [str(q) for q in (parsed.get("questions") or [])][:10],
            "issues": issues,
            "validation_summary": summarise(issues),
            "ok": not errors,
            "attempts": attempt,
        }
        if not errors:
            await report(phase="valid", attempt=attempt, steps=step_count)
            return result, transcript

        await report(phase="found_problems", attempt=attempt,
                     errors=[f"{i['where']}: {i['message']}" for i in errors])

        if attempt == max_attempts:
            await report(phase="gave_up", attempt=attempt, remaining=len(errors))
            # Out of attempts, but the draft still goes back: a workflow with two bad arguments
            # and the errors named against it is a far better starting point for the scientist
            # than an apology, and the Designer shows the issues inline.
            return result, transcript

        messages.append({"role": "assistant", "content": json.dumps(parsed)[:8000]})
        messages.append({"role": "user", "content": _retry_prompt(issues)})

    raise ProviderError(last_error or "The model did not return a usable workflow.")
