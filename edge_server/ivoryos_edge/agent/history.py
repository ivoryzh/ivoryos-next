"""Run history, as an assistant reads it: find runs, read one as its table, compare several.

Everything here is read-only. Tables come from `datasheet.format_run`, the edge's copy of the
reading Data History uses (held to it by shared fixtures), so the assistant and the page agree
about which value belongs to which sample.

Comparisons are computed here rather than left to the model: a small local model asked to find
the best of forty yields in a JSON dump gets it wrong often enough to matter, and every model
states a mean more confidently than it computes one. The model is handed the numbers (count,
minimum, maximum, mean, the best row by the objective's own direction) and explains them.
"""

from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional

from ivoryos_edge.datasheet import format_run

# How much of one run a reply carries. A table past this is cut, and says so: the whole of a
# 384-row screen in a prompt costs more than it explains, and the stats below cover every row.
MAX_ROWS = 200
MAX_COMPARE = 10


def _seconds(start: Optional[str], end: Optional[str]) -> Optional[float]:
    try:
        return round((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds(), 1)
    except (TypeError, ValueError):
        return None


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value


def column_stats(values: Iterable[Any], minimize: Optional[bool] = None) -> Optional[Dict[str, Any]]:
    """Count, min, max and mean of the numbers among `values`; None when there are none.
    `best_index` is the position of the best value when a direction is known."""
    numbers = [(i, v) for i, v in enumerate(values) if _is_number(v)]
    if not numbers:
        return None
    only = [v for _, v in numbers]
    stats = {"n": len(only), "min": min(only), "max": max(only), "mean": round(sum(only) / len(only), 6)}
    if minimize is not None:
        best = min(numbers, key=lambda p: p[1]) if minimize else max(numbers, key=lambda p: p[1])
        stats["best_index"] = best[0]
        stats["goal"] = "minimize" if minimize else "maximize"
    return stats


def _objectives(table: Dict[str, Any]) -> Dict[str, bool]:
    """Datasheet column -> minimize, for an optimization's objectives."""
    config = table.get("config") or {}
    return {f"{o.get('name')} (objective)": bool(o.get("minimize"))
            for o in config.get("objective_config") or [] if o.get("name")}


def run_table(record: Dict[str, Any], max_rows: int = MAX_ROWS) -> Dict[str, Any]:
    """One run as the assistant reads it: what it was, how it went, its table and its numbers."""
    table = format_run(record)
    params = record.get("parameters") or {}
    objectives = _objectives(table)
    columns = table["variables"]
    stats = {}
    for i, column in enumerate(columns):
        s = column_stats((row["values"][i] if i < len(row["values"]) else None for row in table["rows"]),
                         objectives.get(column))
        if s:
            if "best_index" in s:
                s["best_row"] = table["rows"][s.pop("best_index")]["row"]
            stats[column] = s
    rows = table["rows"]
    statuses: Dict[str, int] = {}
    for row in rows:
        statuses[row["status"]] = statuses.get(row["status"], 0) + 1
    return {
        "id": record.get("id"),
        "name": table["name"],
        "status": record.get("status"),
        "type": table["type"],
        "start_time": record.get("start_time"),
        "end_time": record.get("end_time"),
        "duration_s": _seconds(record.get("start_time"), record.get("end_time")),
        "workflow": params.get("workflow_name"),
        "deck_version": table["deck_version"],
        "issues": params.get("_issues") or None,
        "optimizer": (table.get("config") or {}).get("optimizer"),
        "columns": columns,
        "rows": [{"row": r["row"], "status": r["status"], "values": r["values"]} for r in rows[:max_rows]],
        "row_count": len(rows),
        "rows_by_status": statuses,
        "truncated": len(rows) > max_rows,
        "stats": stats,
    }


def compare_tables(tables: List[Dict[str, Any]], columns: Optional[List[str]] = None) -> Dict[str, Any]:
    """Several runs side by side: for each column they share (or the ones asked for), each run's
    numbers and which run did best when the direction is known."""
    wanted = columns or sorted({c for t in tables for c in t["columns"]},
                               key=lambda c: min(t["columns"].index(c) for t in tables if c in t["columns"]))
    per_column = {}
    for column in wanted:
        entries = []
        for t in tables:
            s = t["stats"].get(column)
            if s:
                entries.append({"run": t["id"], "name": t["name"], **s})
        if not entries:
            continue
        goal = next((e.get("goal") for e in entries if e.get("goal")), None)
        summary: Dict[str, Any] = {"runs": entries}
        if goal:
            pick = min if goal == "minimize" else max
            best = pick(entries, key=lambda e: e["min"] if goal == "minimize" else e["max"])
            summary["goal"] = goal
            summary["best_run"] = best["run"]
        per_column[column] = summary
    return {
        "runs": [{k: t[k] for k in ("id", "name", "status", "type", "start_time", "duration_s",
                                     "workflow", "deck_version", "issues", "row_count", "rows_by_status")}
                 for t in tables],
        "columns": per_column,
        "missing": [c for c in (columns or []) if c not in per_column],
    }


def summary_line(run: Dict[str, Any]) -> Dict[str, Any]:
    """A run summary (`list_run_summaries`) trimmed to what helps choose a run."""
    return {k: run.get(k) for k in ("id", "name", "status", "type", "start_time", "end_time",
                                     "row_count", "instruments", "issues") if run.get(k) is not None}


async def search(queue_manager, q: str = "", status: str = "all", limit: int = 20,
                 offset: int = 0, sort: str = "newest") -> Dict[str, Any]:
    found = await queue_manager.list_run_summaries(limit=max(1, min(int(limit or 20), 100)),
                                                   offset=max(0, int(offset or 0)), q=q or "",
                                                   sort=sort or "newest", status=status or "all")
    return {"runs": [summary_line(r) for r in found["runs"]], "total": found["total"]}


async def read(queue_manager, run_id: int, max_rows: int = MAX_ROWS) -> Optional[Dict[str, Any]]:
    record = await queue_manager.get_run_status(int(run_id))
    return run_table(record, max_rows) if record else None


async def compare(queue_manager, run_ids: List[int], columns: Optional[List[str]] = None) -> Dict[str, Any]:
    ids = []
    for value in run_ids or []:
        try:
            ids.append(int(value))
        except (TypeError, ValueError):
            continue
    ids = list(dict.fromkeys(ids))[:MAX_COMPARE]
    tables, not_found = [], []
    for run_id in ids:
        table = await read(queue_manager, run_id, max_rows=0)
        (tables if table else not_found).append(table or run_id)
    result = compare_tables(tables, columns)
    result["not_found"] = not_found
    return result
