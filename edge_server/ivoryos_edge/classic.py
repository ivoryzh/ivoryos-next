"""Turn a script written for IvoryOS Classic (`import ivoryos`) into one IvoryOS NextGen runs.

A Classic script imports `ivoryos` and ends with `ivoryos.run(__name__, ...)`. NextGen's package
is `ivoryos_edge`, and its `run(__name__)` finds the script's instruments the same way, so most of
a script carries over with two edits, each keeping the original line commented out above the new
one so going back is uncommenting:

    # import ivoryos  # IvoryOS Classic
    import ivoryos_edge as ivoryos  # IvoryOS NextGen

    # ivoryos.run(__name__, port=7860, config=DemoConfig(), blueprint_plugins=[viz_bp])  # IvoryOS Classic
    ivoryos.run(__name__, port=7860)  # IvoryOS NextGen

What does not carry over is said in `notes`, not guessed at:
  * `run()` arguments NextGen has no use for are left out of the new call: `config`, `debug`,
    `llm_server`/`model` (the assistant is set up on the Designer page), `enable_design`,
    `notification_handler`, `optimizer_registry`, `templates_dir`, `logger_output_name`, and
    `blueprint_plugins`, Classic's Flask pages (docs/plugins.md says how to port one). `port`,
    `host`, `logger` and `exclude_names` are kept: NextGen's run() takes them.
  * An import only those arguments used (`from ivoryos.config import DemoConfig`, a Flask plugin's
    blueprint) is commented out too, so the script does not stop on a package it no longer needs.
  * Anything else taken from `ivoryos` (`ivoryos.block`, `from ivoryos.utils import ...`) is
    named, since NextGen has no counterpart, and left for the person to decide.

Parsed with Python's own `ast`, never run. `python -m ivoryos_edge.classic script.py` prints the
result as JSON (the desktop app asks this before starting a script); `--write` updates the file.
"""
import ast
import json
import sys
from typing import Dict, List, Optional, Set

KEPT_RUN_ARGUMENTS = {"port", "host", "logger", "exclude_names"}
WHY_LEFT_OUT = {
    "blueprint_plugins": "Classic's Flask pages; port one as a NextGen plugin (docs/plugins.md)",
    "config": "Classic's Flask settings",
    "debug": "Classic's Flask debug mode",
    "llm_server": "the assistant is set up on the Designer page",
    "model": "the assistant is set up on the Designer page",
    "enable_design": "the Designer is always there",
    "notification_handler": "NextGen notifies through the desktop app and the browser",
    "optimizer_registry": "optimizers are chosen in the deck's Settings",
    "templates_dir": "workflows live in the Library",
    "logger_output_name": "the output goes to the edge's log",
}
CLASSIC = "  # IvoryOS Classic"
NEXTGEN = "  # IvoryOS NextGen"


def is_classic(source: str) -> bool:
    """Whether a script imports IvoryOS Classic (and has not been converted already)."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return False
    return bool(_classic_imports(tree))


def _classic_imports(tree: ast.AST) -> List[ast.stmt]:
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import) and any(a.name == "ivoryos" or a.name.startswith("ivoryos.") for a in node.names):
            out.append(node)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module and (
                node.module == "ivoryos" or node.module.startswith("ivoryos.")):
            out.append(node)
    return out


def convert(source: str) -> dict:
    """{classic, converted, notes, changes}: the script for NextGen, and what was changed and why.

    `changes` lists each edit as {line (1-based, in the original), before: [...], after: [...]}.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return {"classic": False, "converted": source, "notes": [f"The script could not be read: {e}"], "changes": []}
    imports = _classic_imports(tree)
    if not imports:
        return {"classic": False, "converted": source, "notes": [], "changes": []}

    lines = source.splitlines(keepends=True)
    edits: Dict[int, tuple] = {}  # first line (0-based) -> (last line, replacement lines)
    notes: List[str] = []

    # Names the Classic module is known by in this script: `import ivoryos` (or `as x`).
    aliases: Set[str] = set()
    for node in imports:
        if isinstance(node, ast.Import):
            if len(node.names) > 1 or node.names[0].name != "ivoryos":
                notes.append(f"Line {node.lineno} imports more than IvoryOS itself; left as it is.")
                continue
            alias = node.names[0].asname or "ivoryos"
            aliases.add(alias)
            new = "import ivoryos_edge" + (" as " + alias)
            edits[node.lineno - 1] = (node.end_lineno - 1, _commented(lines, node) + [_indent(lines, node) + new + NEXTGEN + "\n"])

    # Every `<alias>.run(...)` that is a statement of its own: the NextGen arguments kept.
    dropped_names: Set[str] = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)):
            continue
        call = node.value
        if not (isinstance(call.func, ast.Attribute) and call.func.attr == "run"
                and isinstance(call.func.value, ast.Name) and call.func.value.id in aliases):
            continue
        kept, left_out = [], []
        for arg in call.args[:1]:
            kept.append(ast.get_source_segment(source, arg))
        if len(call.args) > 1:
            left_out.append("positional arguments after the module")
        for kw in call.keywords:
            if kw.arg in KEPT_RUN_ARGUMENTS:
                kept.append(f"{kw.arg}={ast.get_source_segment(source, kw.value)}")
            else:
                left_out.append(kw.arg or "**")
                dropped_names |= {n.id for n in ast.walk(kw.value) if isinstance(n, ast.Name)}
        if not left_out:
            continue
        new_call = f"{call.func.value.id}.run({', '.join(kept)})"
        edits[node.lineno - 1] = (node.end_lineno - 1, _commented(lines, node) + [_indent(lines, node) + new_call + NEXTGEN + "\n"])
        for name in left_out:
            why = WHY_LEFT_OUT.get(name)
            notes.append(f"run(): {name} left out" + (f" ({why})." if why else "."))

    # `from ivoryos... import X` lines, and imports only the dropped arguments used.
    used_elsewhere = _names_used_outside(tree, edits)
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Import, ast.ImportFrom)) or (node.lineno - 1) in edits:
            continue
        bound = [a.asname or a.name.split(".")[0] for a in node.names]
        from_classic = isinstance(node, ast.ImportFrom) and node in imports
        only_for_dropped = bool(bound) and all(name in dropped_names for name in bound)
        if not (from_classic or only_for_dropped):
            continue
        still_used = [name for name in bound if name in used_elsewhere]
        if still_used:
            notes.append(f"Line {node.lineno}: {', '.join(still_used)} {'is' if len(still_used) == 1 else 'are'} still "
                         "used elsewhere in the script, which NextGen does not provide; check it.")
            continue
        edits[node.lineno - 1] = (node.end_lineno - 1, _commented(lines, node))
        if from_classic:
            notes.append(f"Line {node.lineno}: {_segment(source, node)} is Classic only; commented out.")
        else:
            notes.append(f"Line {node.lineno}: {_segment(source, node)} was only for the arguments left out; commented out.")

    # Anything else read from the Classic module: named, not changed.
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in aliases and node.attr != "run":
            notes.append(f"Line {node.lineno}: {node.value.id}.{node.attr} is from Classic, and NextGen has no counterpart; check it.")

    changes, out, i = [], [], 0
    while i < len(lines):
        if i in edits:
            last, replacement = edits[i]
            changes.append({"line": i + 1, "before": [l.rstrip("\n") for l in lines[i:last + 1]],
                            "after": [l.rstrip("\n") for l in replacement]})
            out.extend(replacement)
            i = last + 1
        else:
            out.append(lines[i])
            i += 1
    return {"classic": True, "converted": "".join(out), "notes": _unique(notes), "changes": changes}


def _indent(lines: List[str], node: ast.stmt) -> str:
    line = lines[node.lineno - 1]
    return line[: len(line) - len(line.lstrip())]


def _commented(lines: List[str], node: ast.stmt) -> List[str]:
    """The statement's lines commented out, each marked as Classic's, indentation kept."""
    indent = _indent(lines, node)
    out = []
    for line in lines[node.lineno - 1: node.end_lineno]:
        body = line.rstrip("\n")
        text = body[len(indent):] if body.startswith(indent) else body.lstrip()
        out.append(f"{indent}# {text}{CLASSIC}\n")
    return out


def _names_used_outside(tree: ast.AST, edits: Dict[int, tuple]) -> Set[str]:
    """Names read anywhere except inside the lines being replaced (the old run() call)."""
    replaced = {line for first, (last, _) in edits.items() for line in range(first, last + 1)}
    return {n.id for n in ast.walk(tree)
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and (n.lineno - 1) not in replaced}


def _segment(source: str, node: ast.AST) -> str:
    return " ".join((ast.get_source_segment(source, node) or "").split())


def _unique(items: List[str]) -> List[str]:
    seen, out = set(), []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    write = "--write" in args
    files = [a for a in args if not a.startswith("--")]
    if len(files) != 1:
        print("usage: python -m ivoryos_edge.classic script.py [--write]", file=sys.stderr)
        return 2
    with open(files[0], encoding="utf-8") as f:
        result = convert(f.read())
    if write and result["classic"]:
        with open(files[0], "w", encoding="utf-8") as f:
            f.write(result["converted"])
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
