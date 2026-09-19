-- Short-lived, single-use device pairing codes.
--
-- Replaces the flow where a person copied a base64 CLOUD_TOKEN from Cloud and pasted it into the
-- edge server on another machine. On AWS that token wrapped the device's *private key*, so the
-- documented workflow put a private key on a clipboard and, in practice, through chat or email.
-- Now the key is generated at redemption and travels once, over TLS, straight to the device that
-- will use it; what a person carries between machines is 8 characters.
--
-- The code is a bearer credential for exactly one provisioning: 8 characters from a 31-character
-- unambiguous alphabet (~8.5e11 possibilities), 10 minute lifetime, claimed atomically so two
-- devices cannot race one code into two identities. See src/lib/pairing.js.
--
-- status: 'pending' -> 'redeeming' (claimed, mid-provision) -> 'redeemed'. A failed provision is
-- put back to 'pending' so the person can retry with the same code rather than fetching a new one.
create table if not exists pairing_codes (
    code text primary key,
    device_name text not null default '',
    status text not null default 'pending',
    device_id text,                          -- set once redeemed; the AWS Thing name, or the
                                             -- device name in LAN mode
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    redeemed_at timestamptz
);

create index if not exists pairing_codes_status_idx on pairing_codes(status);

alter table pairing_codes enable row level security;

-- Same posture as the other tables: all access is via the service-role key from the API routes,
-- which bypasses RLS. Enabled defensively. Note that /api/pair/new itself is still unauthenticated
-- — Cloud has no user accounts yet — so pairing narrows the provisioning hole rather than closing
-- it. See AGENTS.md's Cloud section.
