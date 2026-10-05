# The tour

This frontend, built to run in a plain browser against a simulated lab, so a visitor to the Hub
website can use the desktop app's real interface before installing anything. It is not a mockup:
the launcher, the Hub browser and every deck page are the screens the app ships. The Hub serves it
at `/tour` (landing-page-supabase `app/tour`, `public/tour/app`).

```bash
npm run build:tour      # -> out-tour/, served under /tour/app (next.config.ts)
```

Then, in landing-page-supabase, `scripts/sync-tour.sh` builds it and copies it into
`public/tour/app`, where it is committed. A regular `next build` does not include any of this:
`NEXT_PUBLIC_IVORYOS_TOUR` is `'0'` there, so `src/instrumentation-client.ts` drops it at build time.

## Opening it

`/tour/app/launcher/` opens on the example lab. With `?hub` (the Hub site's "Build My Lab",
`/tour?build`) it starts on an empty "My lab" deck with the Automation Hub browser open on it, so a
visitor builds a lab from the Hub's real drivers and then designs and runs against them.

## How it works

`src/instrumentation-client.ts` calls `installTour()` (`install.ts`) before the app hydrates, so
the first request any page makes already lands here:

| Piece | What it stands in for |
|---|---|
| `desktop.ts` | The desktop app's API for the launcher page (`desktop/src/preload.js`). Profiles, starts, installs and deck edits are the lab's. The Automation Hub is the real one, read anonymously through the app's own `desktop/src/hubCatalog.js`. Anything else (accounts, files, Python, updates) says it is part of the desktop app. |
| `tabs.ts` | A deck's tab: an iframe laid where the app lays its `WebContentsView` (`desktop/src/main.js` `layoutTabs`). The frame's `name` says which deck its pages belong to. |
| `edge.ts` | A deck's edge: every `/api/...` call and the `/api/ws/queue` WebSocket, mirroring `edge_server/ivoryos_edge/server.py` and `queue.py` (run and step shapes, the queue broadcast, `#name` substitution, return bindings, If/While/User input/Sleep, failed-step decisions, pause, stop, graceful stop). |
| `sim.ts` | The instruments: a port of `example/lab_drivers.py` (the Suzuki coupling), and stand-ins for drivers from the Hub. A stand-in has the methods the Hub introspected for the driver (`modules.schema`, found by its Hub id or, added by hand, by import path and class), answers in each method's declared return type, and reads back what a `set_x` (or a property setter) set. |
| `example.ts`, `fixtures/example-lab.json` | The example lab the tour opens on. |

Deck pages call the edge at `/api/...` on the same origin (`src/config.ts`), so `install.ts` patches
`fetch` and `WebSocket` for those paths only; everything else goes out as usual. The launcher's
absolute calls (`${profile.status.url}/api/...`) carry the deck in the path (`/tour/app/deck-<id>`).

## Keeping it honest

- When `queue.py` or `server.py` change what a page reads, change `edge.ts` to match. The pages
  are the ones the app ships; a fake that drifts from the edge makes them misbehave here.
- When `example/lab_drivers.py` changes, port the change to `sim.ts`.
- Regenerate `fixtures/example-lab.json` rather than editing it: `example/deck.json`, the first
  seven instruments of `ivoryos_schema.json` after starting `example/demo.py`, and the committed
  `Suzuki coupling screen` and `UV-Vis linearity check` workflows.
- A page that navigates with `window.location.href` must go through `withBase()` (`src/config.ts`),
  and an `<img>` of a `public/` file needs the base path too; a `<Link>` gets it on its own.

## Not in the tour (yet)

Optimizers (Ax, BayBE and NIMO are Python libraries: an Optimization run is refused with a message
saying so), Cloud, plugins, the agent panel, accounts and private repositories. The tour starts
with no run history; a visitor's runs, saved workflows and installed decks last until the page is
reloaded.
