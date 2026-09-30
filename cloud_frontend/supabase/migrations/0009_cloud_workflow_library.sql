-- The Orchestrator's saved multi-device graphs (the Library's "Distributed" workflows), which
-- used to live only in one browser's localStorage. Keyed by name, as the Library always was.
create table if not exists cloud_workflows (
    name text primary key,
    description text not null default '',
    nodes jsonb not null default '[]'::jsonb,
    edges jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table cloud_workflows enable row level security;
