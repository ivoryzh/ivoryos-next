-- Small named settings as JSON under a key: the assistant's model provider, for one.
-- cloud_config (0004) is typed for the broker alone, so anything else lives here.
create table if not exists cloud_settings (
    key text primary key,
    value jsonb not null,
    updated_at timestamptz default now()
);

alter table cloud_settings enable row level security;
-- Read and written only through the service-role key, like cloud_config.
