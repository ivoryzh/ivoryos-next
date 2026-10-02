-- Each device's secret for a Cloud that runs its own MQTT broker (brokerAuth.js), as a hash only.
-- Minted at pairing and handed to the edge inside its token, so no person sees it; replaced by
-- pairing again, deleted with the device. Read and written through the service-role key only.
-- (A Cloud on AWS IoT authenticates devices by certificate and does not use this table.)
create table if not exists broker_credentials (
    device_id text primary key,
    secret_hash text not null,
    created_at timestamptz default now()
);
alter table broker_credentials enable row level security;
