-- Sign-in, workspaces and platforms (src/lib/auth.ts, src/lib/workspace.ts).
--
-- Cloud signs people in with their IvoryOS account (the Hub's auth); it does not keep users of its
-- own. What it keeps is:
--   sessions        a signed-in browser: the IvoryOS tokens, the workspace it is working in and
--                   the workspaces it may switch to. The browser holds only the random id, in an
--                   http-only cookie.
--   ownership       which workspace owns a device, a run, a library workflow, a schedule or a
--                   pairing code. A workspace is `user:<id>` (personal) or `org:<id>` (an
--                   organization on the Hub). Kept apart from those tables so the dispatch daemon,
--                   which works on every workspace's tasks alike, is unchanged.
--   edge_platforms  named groups of edges inside a workspace.
--
-- Same posture as the other tables: all access is through the service-role key from the API
-- routes and the daemon; RLS is enabled with no policies, so the anon key reaches none of it.

create table if not exists sessions (
    id text primary key,
    user_id text not null,
    email text,
    name text,
    access_token text,
    refresh_token text,
    token_expires_at bigint not null default 0,
    workspace_id text not null,
    workspaces jsonb not null default '[]'::jsonb,
    workspaces_checked_at timestamptz,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    last_seen timestamptz
);
create index if not exists sessions_expires_idx on sessions(expires_at);

create table if not exists ownership (
    kind text not null,
    key text not null,
    workspace_id text not null,
    primary key (kind, key)
);
create index if not exists ownership_workspace_idx on ownership(kind, workspace_id);

create table if not exists edge_platforms (
    id text primary key,
    workspace_id text not null,
    name text not null,
    device_ids jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists edge_platforms_workspace_idx on edge_platforms(workspace_id);

alter table sessions enable row level security;
alter table ownership enable row level security;
alter table edge_platforms enable row level security;
