# IvoryOS desktop

> New to this? Start with the plain-language guide: [docs/desktop_launcher_guide.md](../docs/desktop_launcher_guide.md).

A desktop app around the IvoryOS edge server. It is a **launcher and a window**, not a second
implementation: the edge is the same Python program as `python example/demo.py`, and the window
shows the edge's own web UI. The app sets up Python, keeps the edge running, and installs drivers.

```
┌──────────── Electron app (this folder) ──────────┐
│  window ──► http://127.0.0.1:<port> (edge web UI) │
│  menus · ivoryos:// links · driver installs       │
│        │ starts / restarts / stops                │
│        ▼                                          │
│  ┌──── python -m ivoryos_edge --deck deck.json ─┐ │
│  │ FastAPI · queue · drivers · SQLite · MQTT    │─┼──► instruments
│  └──────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────┘
```

## The launcher

The app opens on the **launcher**: a list of saved **profiles**, each one way of starting an edge,
in the spirit of a `launch.json`. Several can run at once on different ports. With no profile
yet it shows a welcome page instead: **Try the example** (a simulated lab, `src/example.js`,
written into `<home>/example/` as a script profile with its own data folder), **Add a deck**
(empty, or from a Python script you have) and the Automation Hub, plus sign in / sign up, none
of it required. The sidebar keeps the same two actions under the deck list, above Cloud.

| Kind | What it runs | Where instruments are configured |
|---|---|---|
| **Deck** | `python -m ivoryos_edge --deck deck.json` | In the launcher: the Instruments tab edits each one's arguments (COM port, IP, …), switches it off, or adds one from the Hub. |
| **Python script** | Any script ending in `ivoryos_edge.run(__name__)`, such as `example/demo.py` | In the script. Read a port from an environment variable (`os.environ.get("PUMP_PORT", "COM3")`) and set the variable in the profile's Configuration tab. |

For each profile the launcher shows its state, Start (green) / Stop (red) / Restart / **Open**,
and a live log. A script profile also has a **Code** tab: the script itself, editable in place,
with Save and **Save and restart**, since a deck script is usually one short file and the loop
that matters is edit, save, restart. The launcher reloads an edge's open tab whenever that edge
comes back after a restart (an install, a deck edit, Restart), so the tab always shows the edge
that is running.
Open shows the edge's UI as a **tab in the launcher window** (a `WebContentsView` laid under the
tab bar, one per open profile), so the app is one window however many decks run. ↗ opens the
same page in the system browser; the edge is an ordinary web server either way. A deck profile also shows whether each instrument loaded,
and why not when it didn't. A script profile runs with the launcher's Python by default (which
has the edge and every driver installed from the Hub), or with an interpreter you choose. It keeps
the script's own runs and workflows unless you give it a separate data folder.

The launcher page is part of the IvoryOS frontend (`frontend/src/app/launcher`), served by the app
over `ivoryos-app://`, so it works before any edge is running. It reaches the app through
`src/preload.js`. Every launcher call is refused unless it comes from that page, so an edge's own
page, or a plugin inside it, cannot start processes or install packages.

## Running it

```bash
cd frontend && npm run build   # the launcher page and the edge UI
cd ../desktop
npm install
npm start            # the app, using ../edge_server (editable) and ../frontend/out
npm test             # supervisor, profiles, manager and manifest tests (no Electron, no Python)
npm run smoke        # boot headless, start the first profile, check the launcher, exit
```

Development uses the repository directly: the edge is installed as an editable package, so a
Python change applies on the next Restart, and the UI comes from `frontend/out`. `uv` must be
installed. `IVORYOS_DESKTOP_HOME=/some/folder npm start` uses a separate profile folder;
`IVORYOS_HUB_URL=http://localhost:3000` points the launcher's Hub website links at a local Hub, for
development only: the Hub is one central service and the app has no setting for its address.

## What lives where

Everything is in the app's per-user folder (`~/Library/Application Support/IvoryOS` on macOS,
`%APPDATA%\IvoryOS` on Windows, `~/.config/IvoryOS` on Linux), never inside the app bundle:

| Path | What |
|---|---|
| `profiles.json` | Saved profiles and the Hub address. |
| `profiles/<id>/deck.json` | A deck profile's instruments. |
| `profiles/<id>/data/` | That deck's runs, workflows and Cloud settings (`IVORYOS_DATA_DIR`). |
| `runtime/venv/` | The Python environment every profile runs in. uv creates it on first launch and downloads Python if the machine has none. |
| `logs/<id>.log` | Each profile's edge output, kept across restarts. |
| `example/` | The example lab's script and simulated drivers (from **Try the example**), plus its `data/`. |

A launcher from before profiles existed kept one deck in `data/`; it becomes the first profile.

## Decks and installing drivers

A deck file lists pip `packages` to install and `instruments` to build from them. The format is
documented at the top of `edge_server/ivoryos_edge/deck_config.py`; `example/deck.json` is the
demo deck written that way.

An **install manifest** is a deck file describing only what to add. Drivers reach a deck two
ways, both through the same install path:

- **Add from Hub** on a deck's Instruments tab, or **Automation Hub** in the sidebar: search the
  Hub's drivers, fill in the settings form the Hub provides for that driver (connection, port,
  init arguments), and add. With no deck yet, the first add asks for a deck name and creates
  the deck it lands on. `src/hubCatalog.js` turns the choice into a deck entry, mirroring the
  Hub repo's `utils/deck-manifest.ts`.
- **Open in IvoryOS** on the Hub's build page: the cart as Hub ids,
  `ivoryos://install?modules=4,7,7&plugins=3&templates=9&optimizers=ax-platform` (or
  `?platform=12`). The app reads each from the Hub and opens the platform install screen on them,
  the same one as **Add platform**, with names, settings, deck choice and who contributed each
  driver; nothing installs until **Install** there (`src/installLink.js`). A link carrying a whole
  deck (`?deck=`, the old form) is refused: any web page could build one naming any package or
  importable class, and it would have looked like it came from the Hub.
  `ivoryos://install?manifest=https://…` (a manifest by URL) still goes through the dialog below.

There is no "install from a deck file on disk": the deck files the app writes live in its own
data folder, out of a person's way, so the button only invited picking a JSON file nobody had.
**Add installed driver** writes an entry for a driver the app's Python can already import (module
and class); it installs nothing.

Installing a manifest asks for confirmation (listing the packages, and each
instrument with the class it loads, and warning about any package not pinned to one version), then stops the edge, runs `uv pip install`, writes the deck,
and starts the edge again. If the install fails, the deck is left unchanged and the old edge
comes back. Instruments that fail to load (a missing driver, an unplugged device) are marked in
the launcher and under **Not loaded** on the edge's Instruments page, with the reason.

**Drivers are code with access to the instruments.** A manifest may not pass pip options, and a
downloaded one may not add import folders, but the packages themselves run unsandboxed: that is
what lets them talk to hardware. Only install from sources you trust.

## Accounts, plans and private drivers

The **bottom-left corner** of the launcher is the account (or Sign in / Sign up) and the
**Settings** gear. Settings holds what the old menu bar and header buttons did: theme, updates,
the Hub address, the launcher's Python, the data folder, keyboard shortcuts. On Windows and Linux
there is **no menu bar** (it sat inside the window, above the launcher's own tabs); the shortcuts
it carried are kept (`Ctrl+L` launcher, `Ctrl+Tab`, `Ctrl+R`, zoom, `F12`). macOS keeps its menu,
which is at the top of the screen and is what makes copy/paste work in text fields there.

- **Accounts are the Hub's** (its Supabase project, `src/account.js`): email/password, or GitHub
  / Google in the system browser, returning to a one-off `127.0.0.1` listener with PKCE. That
  return address must be allowed in the Hub's Supabase project (Authentication -> URL
  Configuration -> Redirect URLs: `http://127.0.0.1:*` followed by `/**`); without it the browser
  lands on the Hub's home page and the launcher waits until cancelled. Name and lab are the Hub's
  `profiles` row, so they match the Hub's profile page.
- **Tokens never reach the page.** The launcher is told who is signed in and on which plan; the
  session and GitHub/GitLab tokens stay in the main process, encrypted with the OS keychain
  (`src/secrets.js`). Where there is no keychain nothing is written and sign-in lasts one run.
- **Plans are a preview.** "Upgrade" sets `user_metadata.ivoryos_plan = "pro"` with no payment.
  That field is writable by the user, which is fine for trying the features and never for billing.
  Pro unlocks the Cloud page and **Private repositories** in Add from Hub.
- **Private repositories** (`src/gitRepos.js`): connect GitHub or GitLab (also self-hosted) with a
  personal access token; pick a repository; the app downloads it **at its current commit** and
  installs that archive into the deck like any driver, then lists the classes it provides
  (`src/scan_driver.py`) so one can be picked as the instrument. No git needed on the machine, and
  the deck lists `private-packages/<provider>-<repo>-<commit>.tar.gz`, never the token. Importing
  again moves the deck to the newer commit (`packageKey` treats it as the same package).

## The tray

A tray icon (menu bar on macOS) lists every profile with its state and port, each with Open /
Start / Stop / Restart, plus Open IvoryOS and Quit (which says how many decks it will stop). On
Windows and Linux, minimizing hides the window to the tray, and so does closing it: decks keep
running, and the first time a balloon says so. Both are switches in Settings -> Window; with
close-to-tray off, closing quits and stops every deck as before. Clicking the icon opens the
window. macOS keeps its conventions (minimize to the Dock; closing already leaves the app
running). `npm run smoke` with `IVORYOS_SMOKE_TRAY=1` checks minimize and close really hide.

## Updates

`src/updater.js`, from the GitHub releases CI publishes. Windows and Linux: electron-updater
checks shortly after launch and every 4 hours, downloads in the background (Settings can turn that
off), and installs on **Restart to update**, which stops every deck first. macOS: unsigned apps
cannot install their own updates, so it only checks and offers the download.

## The contract with the edge

- The app starts `python -m ivoryos_edge --deck … --data-dir … --port … --host …` with
  `IVORYOS_SUPERVISED=1`, and waits until `GET /api/status` answers before showing the UI.
- `POST /api/system/restart` (the Restart button) makes a supervised edge exit with code **75**;
  the app starts it again. Any other exit is a crash, shown with the end of the log.
- Driver installs happen with the edge stopped, because a running interpreter holds its packages'
  compiled files open (on Windows they cannot be replaced until it exits).

## Packaging

```bash
cd frontend && npm run build          # the UI to bundle
cd ../desktop && npm run dist          # prepare-resources + electron-builder
```

`scripts/prepare-resources.js` copies this machine's `uv`, builds the edge wheel and copies the
UI into `resources/`, which is bundled into the app. Build on each target OS, since `uv` is a
native binary. `npm run dist:dir` builds an unpacked app for testing, and
`<app> --smoke-test` checks a build on a clean machine.

**Download links (CI).** `.github/workflows/desktop.yml` builds all three OSes on their own
runners, runs `npm test`, and smoke-tests each packaged app against an empty profile folder. Any
push touching `desktop/` attaches the installers to the workflow run as artifacts. To publish
download links, push a tag:

```bash
git tag desktop-v0.1.0-test.1 && git push origin desktop-v0.1.0-test.1
```

That creates a GitHub **pre-release** with the Windows `.exe`, macOS (Apple silicon) `.dmg` and
Linux `.AppImage`, and first-open instructions for unsigned builds. A tag without a suffix
(`desktop-v0.2.0`) is a full release, which is what installed apps update to; the version comes
from the tag, so `package.json`'s `version` does not need editing.

**App icon:** `build/icon.png` (1024×1024) is generated from `build/logo.png` by
`uv run --with pillow python scripts/make-icon.py`. electron-builder makes the macOS and Windows
icon formats from that one PNG, so a PNG logo is enough and no SVG is needed. In development the
Dock shows the icon, but the menu bar still says "Electron" (it is Electron's own program);
packaged builds are named IvoryOS throughout.

## Not done yet

- **Code signing and notarization.** Builds are unsigned, so macOS Gatekeeper and Windows
  SmartScreen will warn. This needs an Apple Developer ID and a Windows signing certificate in CI.
- **Auto-install on macOS** needs code signing (see above); until then macOS only checks.
- **Real plans.** The Pro switch is a preview on a user-writable field (see Accounts).
- **Offline first launch.** uv downloads Python on first run; bundling a standalone Python would
  remove that.
- **The Hub's download bundle still targets the legacy `ivoryos` package** (`import ivoryos` in
  the generated `main.py`); "Open in IvoryOS" targets this edge.
- **Tested by hand on macOS (arm64) and Windows (x64).** Linux is covered only by CI's smoke
  test. No Intel macOS build: the bundled uv is the build machine's, and CI's macOS runner is arm64.
