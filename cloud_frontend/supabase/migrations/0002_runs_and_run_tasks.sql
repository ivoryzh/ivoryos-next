-- Durable replacement for orchestrator.ts's in-memory Map (which never survives a restart and
-- can't be shared across serverless instances) — this is what actually lets daemon.js dispatch
-- work to devices and report progress back, closing the gap AGENTS.md flagged: "nothing publishes
-- a ready task to .../execute anymore."
--
-- One row in `runs` per "Run" click on the distributed Orchestrator canvas; one row in
-- `run_tasks` per node in that graph. `run_tasks.status` drives everything: 'blocked' (deps not
-- met yet) -> 'pending' (ready to dispatch, daemon.js is watching for this) -> 'queued'
-- (daemon.js has published it to the device's execute topic) -> 'running' -> 'completed'/'error'.
-- daemon.js itself advances 'blocked' -> 'pending' as each task's dependencies finish, mirroring
-- orchestrator.ts's checkReadyNodes logic but against these tables instead of the Map.

create table if not exists runs (
    id text primary key,                    -- e.g. `run_${Date.now()}`, matches the id the
                                             -- frontend already generates and polls by
    name text not null default '',
    status text not null default 'running', -- 'running' | 'completed' | 'error' | 'cancelled'
    nodes jsonb not null,                    -- the full React Flow node list as designed
    edges jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists run_tasks (
    id uuid primary key default gen_random_uuid(),
    run_id text not null references runs(id) on delete cascade,
    node_id text not null,                  -- the React Flow node id this task corresponds to
    device_id text not null references devices(id),
    block jsonb not null,                    -- {instrument, method, params, ...} sent as-is in
                                             -- the MQTT execute payload
    status text not null default 'blocked', -- 'blocked' | 'pending' | 'queued' | 'running' |
                                             -- 'completed' | 'error'
    dispatched_at timestamptz,
    updated_at timestamptz not null default now(),
    unique (run_id, node_id)
);

create index if not exists run_tasks_run_id_idx on run_tasks(run_id);
create index if not exists run_tasks_pending_idx on run_tasks(status) where status = 'pending';

alter table runs enable row level security;
alter table run_tasks enable row level security;

-- No owner concept for runs yet (same gap as devices.owner_id — see AGENTS.md's Cloud section);
-- every access today goes through supabaseAdmin (service role, bypasses RLS) from the Next.js API
-- routes and from daemon.js. RLS is enabled defensively so a future per-user policy can be added
-- without a migration, but there's nothing for an anonymous/browser client to see yet.
