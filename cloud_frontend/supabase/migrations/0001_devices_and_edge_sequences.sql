-- Cloud's own Supabase project — deliberately separate from the Hub's project. This is the
-- persistence layer for what the MQTT/AWS IoT daemon (see ../../daemon.js) writes as it consumes
-- each Edge device's retained status/schema/sequences topics, and what the Cloud frontend reads
-- to show a device's live state and its scripted workflows.

create table if not exists devices (
    id text primary key,                    -- the MQTT/AWS IoT client_id, chosen when a device's
                                             -- CLOUD_TOKEN is minted
    owner_id uuid references auth.users(id),-- null until a real token-minting flow exists to
                                             -- claim a device for a user (see AGENTS.md gap below)
    name text not null default '',
    status text not null default 'offline', -- 'online' | 'offline', from the retained status topic
                                             -- (or the LWT firing) — see edge_server's status_loop
    last_seen timestamptz,
    schema jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create table if not exists edge_sequences (
    id uuid primary key default gen_random_uuid(),
    device_id text not null references devices(id) on delete cascade,
    name text not null,                     -- the workflow's file name on Edge (WORKFLOWS_DIR)
    description text not null default '',
    body jsonb not null,                    -- the full prep/sequence/cleanup workflow JSON
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (device_id, name)
);

create index if not exists edge_sequences_device_id_idx on edge_sequences(device_id);

alter table devices enable row level security;
alter table edge_sequences enable row level security;

-- Only an owning user can see their own device (and its sequences) from the browser. The daemon
-- writes with the service-role key, which bypasses RLS entirely, so these policies only govern
-- what the Cloud frontend itself can read/write on a user's behalf.
create policy "Users can view their own devices"
    on devices for select
    using (auth.uid() = owner_id);

create policy "Users can update their own devices"
    on devices for update
    using (auth.uid() = owner_id);

create policy "Users can view sequences for their own devices"
    on edge_sequences for select
    using (exists (
        select 1 from devices
        where devices.id = edge_sequences.device_id
        and devices.owner_id = auth.uid()
    ));
