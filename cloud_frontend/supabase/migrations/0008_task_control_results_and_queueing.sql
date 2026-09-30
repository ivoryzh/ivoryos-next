-- Answering a device from Cloud, a picture per device, and every occurrence's results.
--
--   run_tasks.command   a decision made in Cloud about a task its device has stopped on (an
--                       answer to a User_Input step, or retry/skip/stop on a failed step):
--                       {action, value, pause, state: 'pending'|'sent', sent_at, attempts}.
--                       daemon.js publishes it on {prefix}/{device}/task-control and clears it
--                       once the device's progress no longer shows that pause.
--   run_tasks.results  every occurrence's record for a repeating task (oldest first); `result`
--                       stays the latest. Before this, "every 5 min, 3 times" kept only the last.
--   runs.after_runs     a run submitted "after current work" starts as 'queued' and waits until
--                       these runs (open on its devices when it was submitted) have nothing open.
--   devices.image       a small data: URL chosen on the Devices page (scaled down in the browser
--                       before upload). Served by /api/devices/{id}/image, never in the device list.

alter table run_tasks add column if not exists command jsonb;
alter table devices add column if not exists image text;
alter table devices add column if not exists image_updated_at timestamptz;
alter table run_tasks add column if not exists results jsonb;
alter table runs add column if not exists after_runs jsonb not null default '[]'::jsonb;
