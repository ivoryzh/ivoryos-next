"""Where the edge server keeps what it writes.

Everything the server creates at runtime -- the run database, saved workflows, the `.env` holding
the Cloud token, device certificates, optimizer scratch files, the schema dump -- used to be put
wherever was convenient: the database in the process's working directory, the rest beside the
package's own source files. That works from a git checkout. It does not work for an installed
package: site-packages is not a place to keep a lab's data, and the next `pip install` of a newer
edge would replace the workflows folder along with the code.

So all of it resolves through here. Set `IVORYOS_DATA_DIR` (the desktop app always does, pointing at
its per-user data folder; `python -m ivoryos_edge --data-dir` sets it too) and every file lives
under that one directory. Leave it unset and each path is exactly what it has always been, so an
existing checkout keeps finding its database and workflows where they already are.

Read once, at import time, like the paths it replaces: the database engine is created when
`models` is imported, so the variable has to be set before the server is imported, which is what
the CLI does.
"""

import os

_PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))

# IVORYOS_EDGE_HOME is the same setting under the name the flow_lab examples use (one folder per
# edge process, so two edges on one machine keep separate databases and Cloud pairings).
DATA_DIR = os.environ.get("IVORYOS_DATA_DIR") or os.environ.get("IVORYOS_EDGE_HOME") or None
if DATA_DIR:
    DATA_DIR = os.path.abspath(os.path.expanduser(DATA_DIR))
    os.makedirs(DATA_DIR, exist_ok=True)


def _in_data_dir(name: str, legacy: str) -> str:
    return os.path.join(DATA_DIR, name) if DATA_DIR else legacy


# The SQLite file. Legacy: relative to the working directory the server was started from.
DB_PATH = _in_data_dir("ivoryos_edge.db", "ivoryos_edge.db")

# Saved workflows (head files, `.versions/`, `.meta.json`). Agent settings sit beside this folder.
WORKFLOWS_DIR = _in_data_dir("workflows", os.path.join(_PACKAGE_DIR, "workflows"))

# CLOUD_TOKEN and friends, written by the Cloud Connect page.
ENV_PATH = _in_data_dir(".env", os.path.join(os.path.dirname(_PACKAGE_DIR), ".env"))

# Per-device AWS IoT certificate and key, unpacked from the Cloud token.
CERTS_DIR = _in_data_dir(".certs", os.path.join(_PACKAGE_DIR, ".certs"))

# Files an optimizer backend needs on disk (NIMO works from a CSV).
OPTIMIZER_DATA_DIR = _in_data_dir("optimizer_data", os.path.join(_PACKAGE_DIR, "optimizer_data"))

# The introspected schema, dumped at startup for anyone who wants to diff it.
SCHEMA_DUMP_PATH = _in_data_dir("ivoryos_schema.json", "ivoryos_schema.json")
