-- What a device reports back about the Cloud tasks it runs, and whether it is busy.
--
--   run_tasks.progress  the latest "how far along" summary while the task executes
--                       ({done, total, state, phase, step, row, rows_done, rows_total, iteration,
--                       budget}; see run_progress_summary in edge_server/ivoryos_edge/queue.py),
--                       at most every 2 seconds per run. Cleared when the task is dispatched again.
--   run_tasks.result    the finished run's record (parameters + steps, the same shape the edge's
--                       Data History reads; queue.build_cloud_result), sent once at the end.
--   devices.busy        the device's own heartbeat answer: a run in progress or queued there,
--                       bench runs included. Shown on the Devices page.

alter table run_tasks add column if not exists progress jsonb;
alter table run_tasks add column if not exists result jsonb;
alter table devices add column if not exists busy boolean not null default false;
