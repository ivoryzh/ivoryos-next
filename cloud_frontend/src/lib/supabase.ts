import { createClient } from "@supabase/supabase-js";

// Server-only client (service-role key — never import this from a "use client" component or
// expose it to the browser). Cloud doesn't have real user accounts/auth wired up yet, so there's
// no per-request user session to scope reads to; every API route here uses this one server-side
// client for now. Once auth exists, routes that serve a specific user's data should switch to a
// per-request client built from that user's session so the devices/edge_sequences RLS policies
// (see supabase/migrations/0001_devices_and_edge_sequences.sql) actually take effect for reads —
// this client bypasses RLS entirely.
// Fall back to obvious placeholders rather than asserting non-null: createClient() throws
// synchronously on a missing/empty URL, which would otherwise crash the build itself (Next.js
// evaluates route modules during `next build`, before any request — and therefore before real
// env vars are necessarily configured, e.g. in CI or a fresh checkout) rather than failing only
// the specific request that actually needs Supabase at runtime.
export const supabaseAdmin = createClient(
    process.env.SUPABASE_URL || "https://placeholder.supabase.co",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key"
);
