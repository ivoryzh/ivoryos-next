-- Pin claim_schedule_firing (0006) to the public schema.
--
-- The function names its table bare (`schedules`), which Postgres resolves through the caller's
-- search_path. A caller whose search_path listed another schema first, holding its own table
-- called `schedules`, could make the function update that one instead. Only the daemon calls it,
-- with the service-role key, so this is hardening rather than a live hole; it is what Supabase's
-- security advisor asks of every function (lint 0011_function_search_path_mutable).
--
-- A new migration rather than an edit to 0006, which is already applied: editing it would leave
-- the file and existing databases disagreeing. Behaviour is unchanged.

alter function public.claim_schedule_firing(text, timestamptz, timestamptz, text)
    set search_path = public;
