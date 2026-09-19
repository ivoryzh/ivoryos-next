-- Two tables that exist because the Next app and daemon.js are separate processes: a request-
-- scoped API route cannot reach into the daemon, and the daemon is the only thing holding a
-- broker connection. Both are therefore mailboxes between them.

-- Which broker the daemon should dial, chosen in /settings rather than an env var. One row,
-- id='broker'. Absent until someone sets it, in which case the env vars still decide (see
-- src/lib/store/index.js resolveBrokerUrl). The daemon polls this and reconnects on a change.
create table if not exists cloud_config (
    id text primary key,
    host text not null default '',
    port integer not null default 1883,
    updated_at timestamptz
);

-- Outbox for Cloud -> Edge workflow writes.
--
-- Before this, a sequence authored in the Cloud editor was written to Cloud's database and
-- nowhere else. The device resolves a workflow against its own WORKFLOWS_DIR, so such a sequence
-- could never run (expand_workflow_blocks would not find it) — and editing an existing one was
-- silently reverted the next time the device republished its own copy over the same
-- {device_id, name} key. Two writable copies, no reconciliation.
--
-- The device stays the owner. A row here is a *request* to write: the daemon publishes it to
-- {prefix}/{device_id}/sequences-push, the device applies it through the same save path a local
-- save uses, and then echoes the result on its own retained sequences topic. That echo is the
-- acknowledgement — matched by body_hash, so a concurrent bench edit that won leaves the push
-- unacknowledged instead of falsely closing it out.
--
-- status: 'pending' (queued) -> 'sent' (published) -> 'acked' (device echoed the same body back).
-- Anything stuck below 'acked' is a write that did not take effect.
create table if not exists sequence_pushes (
    device_id text not null references devices(id) on delete cascade,
    name text not null,
    body jsonb not null default '{}'::jsonb,
    body_hash text not null default '',
    status text not null default 'pending',
    updated_at timestamptz not null default now(),
    primary key (device_id, name)
);

create index if not exists sequence_pushes_status_idx on sequence_pushes(status);

alter table cloud_config enable row level security;
alter table sequence_pushes enable row level security;

-- Same posture as the other tables (see 0002/0003): all access today is via the service-role key
-- from the API routes and daemon.js, which bypasses RLS. Enabled defensively.
