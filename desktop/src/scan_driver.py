"""List the classes a just-installed driver package provides, so the launcher can offer them.

Run by the desktop app with the launcher's Python after a private repository is installed:

    python scan_driver.py <archive file name>

The package is found by the archive it was installed from (PEP 610 `direct_url.json`), since a
repository's archive says nothing about its distribution name. Prints one JSON object.

Importing a module runs its top-level code, the same as the edge does when it loads the deck; a
module that fails to import is reported, not fatal.
"""
import enum
import importlib
import importlib.metadata as md
import inspect
import json
import math
import pkgutil
import re
import sys
import types
import typing

SKIP = {"test", "tests", "conftest", "setup", "docs", "examples"}

# The kinds of value the instrument form can type (launcherArgs.ts): anything else is the person's call.
SCALARS = {bool: "bool", int: "int", float: "float", str: "str"}
UNIONS = {typing.Union, types.UnionType}  # Optional[X] and X | None


def scalar_type(annotation):
    """'str', 'int', 'float' or 'bool' when the annotation plainly says so (Optional too), else None."""
    if annotation is inspect.Parameter.empty:
        return None
    if isinstance(annotation, str):  # left as text: `from __future__ import annotations` it could not resolve
        text = re.sub(r"^(typing\.)?Optional\[(.*)\]$", r"\2", annotation.strip())
        text = re.sub(r"\s*\|\s*None$|^None\s*\|\s*", "", text)
        return {name: name for name in SCALARS.values()}.get(text)
    origin = typing.get_origin(annotation)
    if origin is typing.Annotated:
        return scalar_type(typing.get_args(annotation)[0])
    if origin in UNIONS:
        arms = [a for a in typing.get_args(annotation) if a is not type(None)]
        return scalar_type(arms[0]) if len(arms) == 1 else None
    return SCALARS.get(annotation)


def json_safe(value):
    return value is None or isinstance(value, (bool, int, str)) or (isinstance(value, float) and math.isfinite(value))


def constructor_args(cls):
    """
    The constructor's arguments as the instrument form takes them (`ArgDef` in desktop.ts), and
    whether it also takes **kwargs. A type the code does not plainly declare is a guess from the
    default, marked `type_unknown` so the form lets the person choose. None when Python cannot read
    the signature (a compiled class): the form then falls back to name/value rows.
    """
    try:
        signature = inspect.signature(cls)
    except (TypeError, ValueError):
        return None, True
    try:
        hints = typing.get_type_hints(cls.__init__)
    except Exception:
        hints = {}
    args, kwargs = [], False
    for p in signature.parameters.values():
        if p.kind is p.VAR_KEYWORD:
            kwargs = True
            continue
        if p.kind in (p.VAR_POSITIONAL, p.POSITIONAL_ONLY):
            continue  # a deck passes arguments by name, which these cannot take
        arg = {"name": p.name, "required": p.default is p.empty}
        if not arg["required"] and json_safe(p.default):
            arg["default"] = p.default
        declared = scalar_type(hints.get(p.name, p.annotation))
        if declared:
            arg["type"] = declared
        else:
            default = p.default
            arg["type"] = next((name for t, name in SCALARS.items() if isinstance(default, t)), "str")
            arg["type_unknown"] = True
        args.append(arg)
    return args, kwargs


def find_distribution(archive_name):
    target = archive_name.replace("\\", "/").lower()
    for dist in md.distributions():
        try:
            direct = json.loads(dist.read_text("direct_url.json") or "null")
        except Exception:
            direct = None
        if direct and str(direct.get("url", "")).replace("\\", "/").lower().endswith(target):
            return dist
    return None


def top_level_modules(dist):
    listed = dist.read_text("top_level.txt")
    if listed:
        return [m.strip() for m in listed.splitlines() if m.strip() and m.strip() not in SKIP]
    tops = []
    for f in dist.files or []:
        parts = str(f).replace("\\", "/").split("/")
        if parts[0] == ".." or parts[0].endswith((".dist-info", ".data")):
            continue
        if len(parts) == 1 and parts[0].endswith(".py"):
            name = parts[0][:-3]
        elif len(parts) > 1 and parts[-1].endswith(".py"):
            name = parts[0]
        else:
            continue
        if name not in tops and not name.startswith("_") and name not in SKIP:
            tops.append(name)
    return tops


def main():
    dist = find_distribution(sys.argv[1])
    if dist is None:
        print(json.dumps({"error": "The installed package could not be found."}))
        return
    classes, errors = [], []

    def scan(name):
        try:
            module = importlib.import_module(name)
        except BaseException as e:  # SystemExit from a script-style module, too
            errors.append({"module": name, "error": f"{type(e).__name__}: {e}"})
            return None
        for attr, obj in vars(module).items():
            if attr.startswith("_") or not inspect.isclass(obj) or obj.__module__ != module.__name__:
                continue
            if issubclass(obj, (BaseException, enum.Enum)) or getattr(obj, "_is_protocol", False):
                continue  # an error type, a set of choices or an interface is never the instrument
            doc = (inspect.getdoc(obj) or "").strip().splitlines()
            init_args, kwargs = constructor_args(obj)
            classes.append({"module": name, "class": attr, "doc": doc[0][:200] if doc else "",
                            "init_args": init_args, "kwargs": kwargs})
        return module

    modules = top_level_modules(dist)
    for top in modules:
        module = scan(top)
        if module is not None and hasattr(module, "__path__"):
            for info in pkgutil.iter_modules(module.__path__):
                if not info.name.startswith("_") and info.name not in SKIP:
                    scan(f"{top}.{info.name}")
    print(json.dumps({
        "distribution": dist.metadata["Name"],
        "version": dist.version,
        "modules": modules,
        "classes": classes[:300],
        "errors": errors[:50],
    }))


if __name__ == "__main__":
    main()
