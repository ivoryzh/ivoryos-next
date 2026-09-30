-- Pairing now goes the other way round: the edge shows a code and a signed-in person approves it
-- on Cloud (src/lib/pairing.js). The code alone can only be approved; the credentials go to
-- whoever holds the secret the edge kept, stored here only as its SHA-256.
--
-- status: waiting -> approved -> provisioning -> redeemed, or waiting -> denied.
-- The workspace a request is approved into is recorded in `ownership` (kind 'pairing'), like the
-- codes it replaces, and becomes the device's workspace when the edge collects its credentials.
create table if not exists pairing_requests (
    code text primary key,
    secret_hash text not null unique,
    -- The device's own lasting id (the edge's CLOUD_DEVICE_ID): its MQTT client id and AWS Thing
    -- name, so pairing the same device again reattaches it instead of creating another.
    requested_id text,
    device_name text not null default '',
    instruments jsonb not null default '[]'::jsonb,
    status text not null default 'waiting'
        check (status in ('waiting', 'approved', 'provisioning', 'redeemed', 'denied')),
    device_id text,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    approved_at timestamptz,
    redeemed_at timestamptz
);

create index if not exists pairing_requests_status_idx on pairing_requests(status);

-- Service-role access only, from the API routes, like every other Cloud table.
alter table pairing_requests enable row level security;

-- Devices removed from Cloud (Devices page, or the device leaving). A device still running, or a
-- retained message the broker replays, would otherwise register it again from its next
-- heartbeat; the daemon ignores these ids until the device is paired again.
create table if not exists removed_devices (
    id text primary key,
    removed_at timestamptz not null default now()
);
alter table removed_devices enable row level security;

-- The Cloud-issued codes this replaces. Nothing reads them any more, and a pending one would
-- otherwise sit here as a bearer credential until it expired.
drop table if exists pairing_codes;
