-- The Cloud assistant's two tables for outside agents (MCP clients): tokens that stand for one
-- workspace (only the hash is kept), and the proposals they file, which a person accepts or
-- rejects in the Orchestrator. Read and written through the service-role key only.
create table if not exists agent_tokens (
    token_hash text primary key,
    workspace_id text not null,
    user_id text not null default '',
    label text not null default '',
    created_at timestamptz default now(),
    last_used_at timestamptz
);
create index if not exists agent_tokens_workspace_idx on agent_tokens(workspace_id);

-- A proposal answers one person's question, so accepting it is that person's decision: it is
-- listed to the user who filed it (or who minted the token an outside agent used), not the org.
create table if not exists agent_proposals (
    id text primary key,
    workspace_id text not null,
    user_id text not null default '',
    name text not null,
    summary text not null default '',
    source text not null default '',
    spec jsonb not null,
    graph jsonb,
    issues jsonb not null default '[]'::jsonb,
    questions jsonb not null default '[]'::jsonb,
    status text not null default 'pending',
    result text,
    created_at timestamptz default now(),
    decided_at timestamptz
);
create index if not exists agent_proposals_ws_status_idx on agent_proposals(workspace_id, user_id, status);

alter table agent_tokens enable row level security;
alter table agent_proposals enable row level security;
