"""List the classes a just-installed driver package provides, so the launcher can offer them.

Run by the desktop app with the launcher's Python after a private repository is installed:

    python scan_driver.py <archive file name>

The package is found by the archive it was installed from (PEP 610 `direct_url.json`), since a
repository's archive says nothing about its distribution name. Prints one JSON object.

Importing a module runs its top-level code, the same as the edge does when it loads the deck; a
module that fails to import is reported, not fatal.
"""
import importlib
import importlib.metadata as md
import inspect
import json
import pkgutil
import sys

SKIP = {"test", "tests", "conftest", "setup", "docs", "examples"}


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
            if issubclass(obj, BaseException):
                continue  # an error type is never the instrument
            doc = (inspect.getdoc(obj) or "").strip().splitlines()
            classes.append({"module": name, "class": attr, "doc": doc[0][:200] if doc else ""})
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
