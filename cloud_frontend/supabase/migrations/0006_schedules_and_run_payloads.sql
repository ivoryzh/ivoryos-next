-- Cloud can now dispatch more than one call per node, and can fire a run on a cadence.
--
-- Two additions, one per half of what the Orchestrator is for:
--
--   run_tasks.run        a whole run payload (the body POST /api/queue/runs accepts) for a step
--                        that is a spreadsheet, an optimization campaign, or a merged linear
--                        chain. Null keeps a plain instrument step on the wire at its old size,
--                        which matters because AWS IoT meters in 5KB increments.
--   run_tasks.repeat_*   a node re-run on its own cadence inside one run. Two instruments on
--                        different timelines — one every 20 minutes, one every 35 — is two nodes
--                        with different cadences in one graph, instead of someone re-triggering
--                        each of them by hand on the edge.
--   schedules            a recurring trigger for a whole run.

alter table run_tasks add column if not exists run jsonb;
alter table run_tasks add column if not exists members jsonb not null default '[]'::jsonb;
alter table run_tasks add column if not exists repeat_every_ms bigint not null default 0;
alter table run_tasks add column if not exists repeat_total integer not null default 0;
alter table run_tasks add column if not exists repeat_done integer not null default 0;
alter table run_tasks add column if not exists not_before timestamptz;

-- A schedule stores an ALREADY-PLANNED run — its tasks exactly as planRun produced them — rather
-- than a graph to re-plan on every firing. daemon.js has no build step and cannot import the
-- TypeScript that builds run payloads, and a schedule firing unattended every ten minutes should
-- replay something a person validated once rather than re-derive it from a canvas nobody is
-- looking at.
create table if not exists schedules (
    id text primary key,
    name text not null default '',
    enabled boolean not null default true,
    trigger_type text not null default 'interval',
    every_ms bigint not null default 0,
    nodes jsonb not null default '[]'::jsonb,
    edges jsonb not null default '[]'::jsonb,
    tasks jsonb not null default '[]'::jsonb,
    max_runs integer not null default 0,
    runs_fired integer not null default 0,
    next_fire_at timestamptz,
    last_fire_at timestamptz,
    last_run_id text,
    owner_id uuid references auth.users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists schedules_due_idx on schedules(enabled, next_fire_at);

alter table schedules enable row level security;

-- Claiming a firing has to be one statement.
--
-- The daemon reads the due schedules, then claims each one. Doing the claim as a read-then-write
-- through the client leaves a window in which two daemons (or one daemon overlapping its own
-- restart) both see the same `next_fire_at` and both start the run — the schedule equivalent of
-- dispatching one task to real hardware twice, which is why dispatch claims before it publishes.
-- The compare-and-set on `next_fire_at` makes exactly one caller the winner.
--
-- A null `p_next_fire_at` means there is no occurrence after this one, so the schedule disables
-- itself in the same statement rather than staying enabled with nothing to fire.
create or replace function claim_schedule_firing(
    p_id text,
    p_expected_fire_at timestamptz,
    p_next_fire_at timestamptz,
    p_run_id text
) returns boolean
language plpgsql
as $$
declare
    claimed integer;
begin
    update schedules
    set runs_fired = runs_fired + 1,
        last_fire_at = now(),
        last_run_id = p_run_id,
        next_fire_at = p_next_fire_at,
        enabled = case when p_next_fire_at is null then false else enabled end,
        updated_at = now()
    where id = p_id and next_fire_at = p_expected_fire_at;

    get diagnostics claimed = row_count;
    return claimed > 0;
end;
$$;
