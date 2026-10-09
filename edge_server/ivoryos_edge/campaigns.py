"""Suggest-only optimization campaigns: the optimizer suggests, people run the experiments.

An optimization run (queue.py) runs a workflow for each trial and reads the objective from it. A
campaign is for experiments the deck does not run, or not all of: the optimizer suggests a batch,
a person carries it out by hand (or on another instrument), types each result in when it is ready
(today, or next week), and asks for the next batch.

Nothing of the optimizer is kept between requests. Each time more suggestions are asked for it is
built again from the campaign: its settings, any existing data it started from, every suggestion
with a result (as data), and every suggestion still waiting for one (as pending, so the same points
are not suggested twice). That is what lets a campaign outlive a restart of the edge and wait any
length of time for its results, at the price of fitting the model again per request, which for the
few dozen points of a lab campaign is seconds.

The random start has to be accounted for in that rebuild. BayBE counts the results it holds
(`random_start_counts_results` on its adapter), which is right as it is. Ax counts the trials its
random step generated, and a rebuilt Ax generated none, so it would start at random again every
time: step_1's num_samples is reduced by the suggestions already given out.
"""
import asyncio
import copy
import math
from datetime import datetime
from typing import Dict, List, Optional

from .models import Campaign, async_session


class CampaignError(ValueError):
    """Something about a campaign that cannot be done, said for the person asking."""


_locks: Dict[int, asyncio.Lock] = {}


def _lock(campaign_id: int) -> asyncio.Lock:
    # One request at a time per campaign: two "suggest more" at once would both build from the same
    # rows and give out overlapping suggestions.
    return _locks.setdefault(campaign_id, asyncio.Lock())


def _plain(value):
    """A value as JSON keeps it: numpy numbers as Python ones, NaN as nothing."""
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float) and math.isnan(value):
        return None
    return value


def _objectives(parameters: dict) -> List[str]:
    return [o.get("name") for o in parameters.get("objective_config") or []]


def _complete(row: dict, objectives: List[str]) -> bool:
    results = row.get("results") or {}
    return all(isinstance(results.get(name), (int, float)) for name in objectives)


def summary(campaign: Campaign) -> dict:
    objectives = _objectives(campaign.parameters or {})
    given = [r for r in campaign.rows or [] if not r.get("discarded")]
    done = sum(1 for r in given if _complete(r, objectives))
    return {
        "id": campaign.id,
        "name": campaign.name,
        "optimizer": (campaign.parameters or {}).get("optimizer"),
        "created_at": campaign.created_at.isoformat() if campaign.created_at else None,
        "updated_at": campaign.updated_at.isoformat() if campaign.updated_at else None,
        "done": done,
        "waiting": len(given) - done,
    }


def as_dict(campaign: Campaign) -> dict:
    return {**summary(campaign), "parameters": campaign.parameters or {}, "rows": campaign.rows or []}


def build_optimizer(campaign_id: int, parameters: dict, rows: List[dict], wanted: int = 1):
    """The optimizer as it stands for this campaign, ready to suggest `wanted` more."""
    from .optimizer.registry import OPTIMIZER_REGISTRY
    from . import paths

    name = parameters.get("optimizer")
    cls = OPTIMIZER_REGISTRY.get(name)
    if cls is None:
        raise CampaignError(f"The {name} optimizer is not installed here.")
    if not cls.get_schema().get("supports_suggest_only"):
        raise CampaignError(f"The {name} optimizer cannot suggest without running the workflow itself.")

    objectives = _objectives(parameters)
    given = [r for r in rows if not r.get("discarded")]
    done = [r for r in given if _complete(r, objectives)]
    pending = [r for r in given if not _complete(r, objectives)]
    existing = list(parameters.get("existing_data") or [])

    optimizer_config = copy.deepcopy(parameters.get("optimizer_config") or {})
    step_1 = optimizer_config.get("step_1")
    if step_1 is not None and not getattr(cls, "random_start_counts_results", False):
        remaining = max(0, int(step_1.get("num_samples") or 0) - len(given))
        # With no result yet, the model step has nothing to fit: keep suggesting at random.
        if remaining == 0 and not done and not existing:
            remaining = max(1, wanted)
        step_1["num_samples"] = remaining

    optimizer = cls(
        experiment_name=f"Campaign_{campaign_id}",
        parameter_space=parameters.get("parameter_space") or [],
        objective_config=parameters.get("objective_config") or [],
        optimizer_config=optimizer_config,
        parameter_constraints=parameters.get("parameter_constraints"),
        datapath=getattr(paths, "OPTIMIZER_DATA_DIR", None),
        additional_params=parameters.get("additional_params"),
    )
    data = existing + [{**r["values"], **{k: float(r["results"][k]) for k in objectives}} for r in done]
    if data:
        import pandas as pd
        optimizer.append_existing_data(pd.DataFrame(data))
    if pending:
        optimizer.add_pending([r["values"] for r in pending])
    return optimizer


async def list_campaigns() -> List[dict]:
    from sqlalchemy import select
    async with async_session() as session:
        found = (await session.execute(select(Campaign).order_by(Campaign.updated_at.desc()))).scalars().all()
        return [summary(c) for c in found]


async def get(campaign_id: int) -> dict:
    async with async_session() as session:
        campaign = await session.get(Campaign, campaign_id)
        if campaign is None:
            raise CampaignError("That campaign no longer exists.")
        return as_dict(campaign)


async def create(name: str, parameters: dict) -> dict:
    """A new campaign, checked by building its optimizer once, with its first batch suggested."""
    parameters = dict(parameters or {})
    if not parameters.get("parameter_space"):
        raise CampaignError("Give the optimizer at least one parameter to search.")
    if not parameters.get("objective_config"):
        raise CampaignError("Give the optimizer at least one objective.")
    from .optimizer.registry import check_constraints
    problems = [r["error"] for r in check_constraints(
        parameters.get("optimizer"), parameters.get("parameter_constraints"), parameters.get("parameter_space")) if r["error"]]
    if problems:
        raise CampaignError(" ".join(problems))
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, lambda: build_optimizer(0, parameters, []))

    keep = ("optimizer", "parameter_space", "objective_config", "optimizer_config", "parameter_constraints",
            "existing_data", "additional_params", "batch_size")
    async with async_session() as session:
        campaign = Campaign(name=(name or "Campaign").strip()[:128] or "Campaign",
                            parameters={k: parameters[k] for k in keep if k in parameters}, rows=[])
        session.add(campaign)
        await session.commit()
        campaign_id = campaign.id
    return await suggest(campaign_id, int(parameters.get("batch_size") or 1))


async def suggest(campaign_id: int, n: int) -> dict:
    """Ask for `n` more suggestions; they are added as rows waiting for their results."""
    n = max(1, min(int(n or 1), 100))
    async with _lock(campaign_id):
        async with async_session() as session:
            campaign = await session.get(Campaign, campaign_id)
            if campaign is None:
                raise CampaignError("That campaign no longer exists.")
            parameters, rows = campaign.parameters or {}, list(campaign.rows or [])
            loop = asyncio.get_running_loop()
            points = await loop.run_in_executor(
                None, lambda: build_optimizer(campaign_id, parameters, rows, n).suggest(n))
            names = [p.get("name") for p in parameters.get("parameter_space") or []]
            batch = max([r.get("batch", 0) for r in rows] or [0]) + 1
            next_id = max([r.get("id", 0) for r in rows] or [0]) + 1
            now = datetime.utcnow().isoformat()
            for i, point in enumerate(points):
                rows.append({"id": next_id + i, "batch": batch, "suggested_at": now,
                             "values": {k: _plain(point.get(k)) for k in names}, "results": None, "note": ""})
            campaign.rows = rows  # a new list: SQLAlchemy does not see a JSON list changed in place
            campaign.updated_at = datetime.utcnow()
            await session.commit()
            return as_dict(campaign)


async def update_row(campaign_id: int, row_id: int, results: Optional[dict] = None,
                     note: Optional[str] = None, discarded: Optional[bool] = None) -> dict:
    """Type in a suggestion's results (a blank clears one), its note, or set it aside."""
    async with _lock(campaign_id):
        async with async_session() as session:
            campaign = await session.get(Campaign, campaign_id)
            if campaign is None:
                raise CampaignError("That campaign no longer exists.")
            objectives = _objectives(campaign.parameters or {})
            rows = [dict(r) for r in campaign.rows or []]
            row = next((r for r in rows if r.get("id") == row_id), None)
            if row is None:
                raise CampaignError("That suggestion is not in this campaign.")
            if results is not None:
                unknown = [k for k in results if k not in objectives]
                if unknown:
                    raise CampaignError(f"{', '.join(unknown)} {'is' if len(unknown) == 1 else 'are'} not an objective here.")
                kept = dict(row.get("results") or {})
                for key, value in results.items():
                    if value is None or str(value).strip() == "":
                        kept.pop(key, None)
                        continue
                    try:
                        number = float(value)
                    except (TypeError, ValueError):
                        raise CampaignError(f"{key}: '{value}' is not a number.") from None
                    if not math.isfinite(number):
                        raise CampaignError(f"{key}: '{value}' is not a number.")
                    kept[key] = number
                row["results"] = kept or None
                row["measured_at"] = datetime.utcnow().isoformat() if kept else None
            if note is not None:
                row["note"] = str(note)[:500]
            if discarded is not None:
                row["discarded"] = bool(discarded)
            campaign.rows = rows
            campaign.updated_at = datetime.utcnow()
            await session.commit()
            return as_dict(campaign)


async def rename(campaign_id: int, name: str) -> dict:
    async with async_session() as session:
        campaign = await session.get(Campaign, campaign_id)
        if campaign is None:
            raise CampaignError("That campaign no longer exists.")
        campaign.name = (name or "").strip()[:128] or campaign.name
        await session.commit()
        return as_dict(campaign)


async def delete(campaign_id: int) -> None:
    async with async_session() as session:
        campaign = await session.get(Campaign, campaign_id)
        if campaign is not None:
            await session.delete(campaign)
            await session.commit()
    _locks.pop(campaign_id, None)
