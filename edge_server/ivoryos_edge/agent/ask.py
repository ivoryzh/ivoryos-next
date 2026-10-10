"""Answering questions about this lab's runs and deck, from its own records.

Small local models are unreliable at a tool-calling protocol and fine at emitting one JSON object
(see providers.py), so tools are offered the same way workflows are written: each reply is one
JSON object, either a tool to run or the answer. The tool runs here, its result goes back as the
next message, and after a few rounds the model must answer with what it has.

Read-only by construction: the tools are history.search / read / compare and nothing else. An
answer that should change something (a workflow, a run, a safety rule) is the other modes' job,
which file proposals for a person to accept.
"""

import json
from typing import Any, Awaitable, Callable, Dict, List, Optional

from ivoryos_edge.agent import history
from ivoryos_edge.agent.providers import extract_json_object

MAX_TOOL_CALLS = 5
MAX_RESULT_CHARS = 12000

SYSTEM_PROMPT = """You answer questions about this lab's experiments, using its own records.

You can look things up. Reply with exactly one JSON object and nothing else, either a lookup:

  {"tool": "search_runs", "args": {"q": "<words in the run's name, columns or instruments>", "status": "<completed, error, cancelled or all>", "limit": 20}}
  {"tool": "run_table", "args": {"run_id": <id>}}
  {"tool": "compare_runs", "args": {"run_ids": [<id>, <id>], "columns": ["<column>"]}}

or, when you can answer:

  {"answer": "<your answer, in plain language; short markdown lists and tables are fine>", "runs": [<ids of the runs your answer is about>]}

How to work:
- run_table gives one run's columns, rows and per-column numbers (n, min, max, mean, and the best
  row for an optimization objective). compare_runs computes the same across runs. Use those
  numbers; do not compute statistics yourself from rows.
- Every number in your answer must come from a lookup result in this conversation. If the records
  do not hold what was asked, say so plainly and say what they do hold.
- Name runs as "<name> (#<id>)" so the person can open them.
- A column ending in "(objective)" is what an optimization was trying to improve.
- Prefer one or two lookups. You may make at most %d.""" % MAX_TOOL_CALLS


def _clip_json(value: Any) -> str:
    text = json.dumps(value, default=str)
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + ' ... (cut: ask for fewer rows or one run at a time)'
    return text


async def _run_tool(queue_manager, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    if name == "search_runs":
        return await history.search(queue_manager, q=str(args.get("q") or ""), status=str(args.get("status") or "all"),
                                    limit=args.get("limit") or 20, offset=args.get("offset") or 0,
                                    sort=str(args.get("sort") or "newest"))
    if name == "run_table":
        table = await history.read(queue_manager, args.get("run_id"))
        return table or {"error": f"No run #{args.get('run_id')}."}
    if name == "compare_runs":
        columns = args.get("columns")
        return await history.compare(queue_manager, args.get("run_ids") or [],
                                     [str(c) for c in columns] if isinstance(columns, list) and columns else None)
    return {"error": f"There is no tool called '{name}'. Use search_runs, run_table or compare_runs."}


async def answer(provider, queue_manager, question: str, history_turns: Optional[List[dict]] = None,
                 page_context: str = "", deck_names: Optional[List[str]] = None,
                 on_progress: Optional[Callable[[dict], Awaitable[None]]] = None):
    """Run the look-up-then-answer loop. Returns (result, transcript); result is
    {answer, runs, lookups: [{tool, args}], ok}."""
    async def report(**event):
        if on_progress is not None:
            await on_progress(event)

    recent = await history.search(queue_manager, limit=15)
    context = ["The 15 most recent runs on this deck (newest first):\n" + _clip_json(recent)]
    if deck_names:
        context.append("Instruments on this deck: " + ", ".join(deck_names))
    if page_context:
        context.append("Where the person is in the app right now: " + page_context)
    messages: List[dict] = [
        {"role": "user", "content": "\n\n".join(context)},
        {"role": "assistant", "content": "Understood. I will reply with one JSON object: a lookup or the answer."},
    ]
    for turn in history_turns or []:
        if turn.get("role") in ("user", "assistant") and turn.get("content"):
            messages.append({"role": turn["role"], "content": str(turn["content"])[:8000]})
    messages.append({"role": "user", "content": question})

    lookups: List[dict] = []
    transcript: List[dict] = []
    await report(phase="thinking")
    for turn in range(MAX_TOOL_CALLS + 2):
        raw = await provider.complete(SYSTEM_PROMPT, messages, json_mode=True)
        transcript.append({"turn": turn, "raw": raw})
        try:
            reply = extract_json_object(raw)
        except ValueError:
            messages += [{"role": "assistant", "content": raw[:4000]},
                         {"role": "user", "content": "That was not one JSON object. Reply with a lookup or an answer, as JSON only."}]
            continue

        if reply.get("answer") is not None:
            runs = [r for r in (reply.get("runs") or []) if isinstance(r, int)]
            await report(phase="answered")
            return {"answer": str(reply["answer"]).strip(), "runs": runs, "lookups": lookups, "ok": True}, transcript

        tool = str(reply.get("tool") or "")
        if not tool:
            messages += [{"role": "assistant", "content": raw[:4000]},
                         {"role": "user", "content": 'Reply with {"tool": ..., "args": {...}} or {"answer": ..., "runs": [...]}.'}]
            continue
        if len(lookups) >= MAX_TOOL_CALLS:
            messages += [{"role": "assistant", "content": raw[:4000]},
                         {"role": "user", "content": "No more lookups. Answer now with what you have, and say what is missing."}]
            continue
        args = reply.get("args") if isinstance(reply.get("args"), dict) else {}
        lookups.append({"tool": tool, "args": args})
        await report(phase="looking_up", tool=tool, args=args)
        try:
            result = await _run_tool(queue_manager, tool, args)
        except Exception as e:  # a bad argument from the model is its to fix, not a failure here
            result = {"error": str(e)}
        messages += [{"role": "assistant", "content": json.dumps(reply)[:4000]},
                     {"role": "user", "content": f"Result of {tool}:\n{_clip_json(result)}"}]

    await report(phase="gave_up")
    return {"answer": "I could not get to an answer from the records. Try asking about one run, or name the runs to compare.",
            "runs": [], "lookups": lookups, "ok": False}, transcript
