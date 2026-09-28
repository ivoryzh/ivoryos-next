"""`ivoryos-edge` / `python -m ivoryos_edge`: start an edge server from a deck file.

    ivoryos-edge --deck deck.json --data-dir ~/ivoryos-data --port 8080

This is how the desktop app starts the edge, and how a headless lab PC can run one without a
Python script of its own. The script-based way (`ivoryos_edge.run(__name__)`, example/demo.py)
still works unchanged.

Order matters here: the data directory has to be in the environment before the server module is
imported, because importing it fixes every path and opens the database (see paths.py). So nothing
from `.server` is imported until the arguments have been read.
"""

import argparse
import json
import os
import sys


def _parse(argv):
    parser = argparse.ArgumentParser(prog="ivoryos-edge", description="Run an IvoryOS edge server from a deck file.")
    parser.add_argument("--deck", help="deck file (JSON). Default: deck.json in the data directory, "
                                       "or in the current directory without one. Created empty if missing.")
    parser.add_argument("--data-dir", help="where runs, workflows and settings are kept "
                                           "(default: $IVORYOS_DATA_DIR, else the legacy locations)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("IVORYOS_PORT", 8080)))
    parser.add_argument("--host", default=os.environ.get("IVORYOS_HOST", "0.0.0.0"),
                        help="interface to listen on; 127.0.0.1 keeps it off the network")
    parser.add_argument("--frontend-dir", help="built UI to serve (default: $IVORYOS_FRONTEND_DIR, else frontend/out)")
    parser.add_argument("--plugins-dir", help="static plugins folder (default: 'plugins' beside the deck file)")
    return parser.parse_args(argv)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    args = _parse(argv)

    # Windows, from a terminal: become the restart loop and run the edge as a child, before a
    # single instrument is created (restart.py explains why). --help and bad arguments have
    # already been answered by _parse, in this process.
    from .restart import needs_loop, run_loop
    if needs_loop():
        sys.exit(run_loop([sys.executable, "-m", "ivoryos_edge", *argv]))

    if args.data_dir:
        os.environ["IVORYOS_DATA_DIR"] = os.path.abspath(os.path.expanduser(args.data_dir))
    data_dir = os.environ.get("IVORYOS_DATA_DIR")
    if data_dir:
        os.makedirs(data_dir, exist_ok=True)

    deck_path = os.path.abspath(args.deck or os.path.join(data_dir or os.getcwd(), "deck.json"))
    if not os.path.exists(deck_path):
        from .deck_config import DECK_FORMAT
        os.makedirs(os.path.dirname(deck_path), exist_ok=True)
        with open(deck_path, "w", encoding="utf-8") as handle:
            json.dump({"format": DECK_FORMAT, "name": "My deck", "packages": [], "instruments": []}, handle, indent=2)
        print(f"No deck file yet; created an empty one at {deck_path}")

    # Only now: importing these fixes the data paths (paths.py).
    from .paths import ENV_PATH
    from .instance_lock import acquire_or_exit
    # Before any instrument is created: a second copy must not open the first one's hardware.
    acquire_or_exit(os.path.dirname(ENV_PATH))
    from .deck_config import load_deck
    from .server import run

    loaded = load_deck(deck_path)
    # Python plugins the deck lists ("package.module:plugin"), imported after the deck so a
    # plugin in one of the deck's `paths` is importable. Each receives the instruments just built.
    from .plugins import load_plugin_refs
    plugins, plugin_errors = load_plugin_refs(loaded.config.get("plugins") or [])
    plugins_dir = args.plugins_dir or os.path.join(os.path.dirname(deck_path), "plugins")
    run(
        port=args.port,
        host=args.host,
        instruments=loaded.instruments,
        plugins=plugins,
        plugin_errors=plugin_errors,
        instrument_errors=loaded.errors,
        deck_path=deck_path,
        frontend_dir=args.frontend_dir,
        plugins_dir=plugins_dir,
    )


if __name__ == "__main__":
    main()
