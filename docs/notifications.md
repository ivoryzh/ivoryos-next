# Notifications

What reaches a person when they are not looking at a deck: what exists, how it is decided, what to
add next, and where it goes after that (Slack and other channels).

## What exists (2026-10)

**Where moments come from.** The edge publishes two lists on `/api/ws/queue`, each item with a
`key` so every listener announces a moment once:

- `status.attention` (`attention_items` in `queue.py`): what needs a person now. That is a User
  input waiting (or a pause), a failed step waiting for retry, skip or stop, or the optimizer waiting
  for a decision. An item stays until someone answers it.
- `status.notices` (`finished_notice`): runs that just ended. `finished` means completed, with any
  issues named (failed steps skipped, retries, stopped early). `stopped` means Stop, or ended on an
  error. A stage of a set is announced only when it is the last stage, under the set's name and
  duration. Notices are kept for 10 minutes with their `age_s`, so a listener that reconnects still
  hears of one, and a listener that connects later does not announce old news.

The desktop app adds the moments only it knows about:

- a deck that crashed while running, naming the run it was on
- a deck someone started that is ready or could not start, and an install that finished or failed

Both of these are announced only while the person is in another app. Decks started with the app
are never announced.

**Who decides.** `announce()` in `desktop/src/main.js` is the only path to a notification. The
person's choices decide what passes (`desktop/src/notifyPrefs.js`, launcher Settings →
Notifications, stored as `notifications` in `profiles.json`):

| Group | Switch | Default |
|---|---|---|
| Needs you | input, failed step, deck stopped unexpectedly | on, with sound |
| When a run ends | finished (only runs longer than N min, 5 by default) | on |
| When a run ends | stopped or ended with an error | off |
| Heads up | deck ready or could not start; install finished or failed | on, only while in another app |

A deck can be muted (`muteNotifications`, the deck list in the same section). Nothing about a deck
is announced while its tab is the focused one, because its own pop-up or run bar already says it.
Focus and Do Not Disturb are left to the OS.

**When the system refuses.** macOS can refuse the app's notifications, and an ad-hoc-signed build
always gets `UNErrorDomain error 1`; the development Electron (`com.github.Electron`) is one.
Electron reports this only through the notification's `failed` event, which used to be ignored, so
nothing showed and nothing said why. Now:

- the refusal is kept (`notifyHealth`), and Settings shows it with a button to the system's
  notification settings and a "Send a test notification" button
- the Dock bounce, or a flashing taskbar button on Windows and Linux, needs no permission; for
  what needs someone, the bounce repeats until the app is looked at
- the Dock badge counts what waits across decks, but on macOS it follows the notification
  permission ("Badge application icon")

A release build should be signed with a Developer ID, which is also what Gatekeeper requires.

**A plain browser** (`frontend/src/components/RunNotifier.tsx`) announces attention items only.

## Next

- Announce `status.notices` in a plain browser too.
- A bell beside Run ("notify me when this one finishes") that overrides the length threshold for one
  run.
- Queue empty: nothing left to run after several runs in a row.
- A run taking much longer than usual, measured against the medians in `runtime.py`.
- Progress milestones (every N rows or trials), off by default.
- Cloud: connection lost, a task arrived, a schedule starts soon.
- An optimization's notice could name its best result so far.

## Later: other channels (Slack and others)

People want to hear about a run where they already are, which is often not at this computer.

- **Who sends.** Without Cloud, the edge sends: it runs beside the hardware for as long as the run
  does, and it also covers decks started from a terminal, where there is no app. With Cloud, Cloud
  sends: it already has accounts, workspaces and every device's task status. So once outside
  channels exist, the choices above must also be stored where the edge can read them (its data
  folder), not only in the app's `profiles.json`. The edge already publishes every moment and
  leaves the filtering to the listener, and that does not change.
- **Slack first, as an incoming webhook.** The person pastes a URL, per deck or per lab. No OAuth and
  no Slack app. Microsoft Teams webhooks work the same way. A generic JSON webhook covers n8n,
  Zapier, Home Assistant and lab-specific tools.
- **Phone push** for "Needs you" and crashes overnight: ntfy or Pushover need no app of our own, and
  Cloud mobile push comes later. Email, either through the Hub or over SMTP.
- **Escalation:** a "Needs you" left unanswered for N minutes goes to the next channel (desktop, then
  Slack, then phone). This is where quiet hours matter.
- **Notify, do not act.** Retry, skip, stop and continue are decisions about moving hardware. Slack
  buttons that make those decisions need real authentication and the same human gate as the app, so
  the first version only links back to the deck or to Cloud.
- **Privacy.** Run names and step errors leave the building, so offer a "names only" level, and pass
  the text through the same redaction the problem reports use (`problemReport.js`).
- **Multi-user labs:** notify the person who started the run, not everyone, once runs carry an owner
  (Cloud has accounts; a bench run does not yet).
