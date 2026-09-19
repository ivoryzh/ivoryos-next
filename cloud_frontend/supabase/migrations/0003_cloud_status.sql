-- The daemon's liveness beacon, for GET /api/health.
--
-- Before this, a device list could be empty for four unrelated reasons — daemon not running,
-- broker unreachable, store misconfigured, or genuinely no devices yet — and all four rendered
-- identically as "0 Edges Online". There was no way for the frontend to tell them apart, because
-- the frontend never talks to MQTT (by design: a Next route is request-scoped and must not own a
-- broker connection). The daemon is the only process that knows, so it writes what it knows here
-- every 5 seconds and the health route reads it back.
--
-- A table rather than a pid file or a local socket: in cloud mode the Next app and the daemon
-- need not share a filesystem or a host, and the health check has to mean the same thing in both
-- deployment modes. The LAN/SQLite backend creates the equivalent table itself on first open
-- (see src/lib/store/sqlite.js) — this file is only for the hosted Supabase project.

create table if not exists cloud_status (
    id text primary key,                     -- always 'daemon'; one row, upserted in place
    broker_connected boolean not null default false,
    broker_url text not null default '',
    mode text not null default '',           -- 'local' | 'cloud', as the daemon resolved it
    store_location text not null default '', -- the store the daemon is actually writing to, so
                                             -- /api/health can catch app and daemon pointed at
                                             -- two different databases (a real, silent LAN bug)
    last_seen timestamptz
);

alter table cloud_status enable row level security;

-- Same posture as runs/run_tasks (see 0002): every access today goes through the service-role
-- key from the Next.js API routes and daemon.js, which bypasses RLS. Enabled defensively so a
-- future per-user policy needs no migration.
