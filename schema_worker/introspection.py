import inspect
import typing
from typing import get_origin, get_args

# A leaf that an optimizer can actually treat as an objective. bool is a subclass of int in
# Python but is never a numerical objective, so it's excluded explicitly.
NUMERIC_TYPE_NAMES = {"int", "float"}

# How deep extract_type_info will expand nested dataclass/Pydantic fields. Without a cap a
# self-referencing model (`parent: Optional[Node]`) recurses until the stack blows.
MAX_OBJECT_DEPTH = 6


def _is_numeric_annotation(annotation):
    if isinstance(annotation, type):
        return issubclass(annotation, (int, float)) and not issubclass(annotation, bool)
    # Under PEP 563 the annotation may still be the string "float" — the name is all we have.
    return isinstance(annotation, str) and annotation.strip() in NUMERIC_TYPE_NAMES


def extract_type_info(annotation, default=inspect.Parameter.empty, _depth=0, _seen=None):
    param_type = "Any"
    options = None
    is_object = False
    is_numeric = False
    fields = {}
    _seen = set() if _seen is None else _seen

    if annotation != inspect.Parameter.empty:
        # For a plain class (float, int, a dataclass, ...) str(annotation) is Python's repr,
        # "<class 'float'>" — noise that isn't used anywhere (cast_value/cast_arguments always
        # re-introspect the real annotation object, never this string), so use the clean name
        # directly. typing constructs (List[str], Optional[int], ...) aren't classes and keep
        # falling through to str(annotation) as before.
        if isinstance(annotation, type):
            param_type = annotation.__name__
        else:
            param_type = str(annotation).replace("typing.", "")

        is_numeric = _is_numeric_annotation(annotation)

        # Check for Enum
        import enum
        if isinstance(annotation, type) and issubclass(annotation, enum.Enum):
            options = [e.value for e in annotation]
            param_type = annotation.__name__

        # Check for Literal
        try:
            # Need to handle Literal which might be typing.Literal or typing_extensions.Literal
            if getattr(get_origin(annotation), '__name__', '') == 'Literal' or get_origin(annotation) is getattr(typing, 'Literal', None):
                options = list(get_args(annotation))
                param_type = "Literal"
        except Exception:
            pass

        # Check for bool
        if annotation is bool:
            options = ["True", "False"]

        # A model that contains itself (directly or through a cycle) would otherwise recurse
        # forever; expanding it once and reporting the repeat as a plain leaf is enough for
        # both a form and a return-path list.
        recursion_ok = _depth < MAX_OBJECT_DEPTH and id(annotation) not in _seen
        child_seen = _seen | {id(annotation)}

        # Check for Dataclass
        import dataclasses
        if dataclasses.is_dataclass(annotation):
            is_object = True
            param_type = getattr(annotation, '__name__', 'Dataclass')
            if recursion_ok:
                for f in dataclasses.fields(annotation):
                    f_default = f.default if f.default != dataclasses.MISSING else inspect.Parameter.empty
                    if f.default_factory != dataclasses.MISSING:
                        try:
                            f_default = f.default_factory()
                        except Exception:
                            pass
                    fields[f.name] = extract_type_info(_resolve_field_type(annotation, f.name, f.type),
                                                       f_default, _depth + 1, child_seen)

        # Check for Pydantic
        else:
            try:
                from pydantic import BaseModel
                if isinstance(annotation, type) and issubclass(annotation, BaseModel):
                    is_object = True
                    param_type = getattr(annotation, '__name__', 'BaseModel')
                    if recursion_ok and hasattr(annotation, 'model_fields'):
                        for f_name, f_info in annotation.model_fields.items():
                            f_default = getattr(f_info, 'default', inspect.Parameter.empty)
                            # Handle Pydantic v2 ...
                            if f_default.__class__.__name__ == 'PydanticUndefinedType' or f_default == Ellipsis:
                                f_default = inspect.Parameter.empty
                            fields[f_name] = extract_type_info(f_info.annotation, f_default, _depth + 1, child_seen)
                    elif recursion_ok and hasattr(annotation, '__fields__'):
                        for f_name, f_info in annotation.__fields__.items():
                            f_default = f_info.default if f_info.required == False else inspect.Parameter.empty
                            fields[f_name] = extract_type_info(f_info.type_, f_default, _depth + 1, child_seen)
            except ImportError:
                pass

        # Optional[X] / Union[X, None] is still just X as far as a form (or an objective) is
        # concerned — without unwrapping it, an optional enum loses its choices, an optional
        # dataclass loses its fields, and an Optional[float] return stops looking numeric.
        if options is None and not is_object:
            try:
                args = [a for a in get_args(annotation) if a is not type(None)]
                if get_origin(annotation) is not None and len(args) == 1:
                    inner = extract_type_info(args[0], inspect.Parameter.empty, _depth, _seen)
                    if inner.get("options") is not None:
                        options = inner["options"]
                        param_type = inner["type"]
                    elif inner.get("is_object"):
                        is_object = True
                        fields = inner.get("fields", {})
                        param_type = inner["type"]
                    elif inner.get("numeric"):
                        is_numeric = True
            except Exception:
                pass

    param_data = {
        "type": param_type,
        "required": default == inspect.Parameter.empty
    }
    if options is not None:
        param_data["options"] = options
    if is_object:
        param_data["is_object"] = True
        param_data["fields"] = fields
    if is_numeric:
        # Marks a leaf an optimizer can use as an objective — see build_return_paths.
        param_data["numeric"] = True

    if default != inspect.Parameter.empty:
        import enum
        if isinstance(default, enum.Enum):
            param_data["default"] = default.value
        else:
            param_data["default"] = default

    return param_data


def _resolve_field_type(owner, field_name, declared):
    """dataclasses.fields() hands back the *declared* annotation, which under PEP 563 is a
    string. Resolve it against the owning class where possible so nested dataclasses/enums
    keep expanding instead of degrading to a free-text leaf."""
    if not isinstance(declared, str):
        return declared
    try:
        return typing.get_type_hints(owner).get(field_name, declared)
    except Exception:
        return declared


def build_return_paths(annotation, info=None):
    """Flatten a return annotation into an ordered list of addressable leaves:

        [{"path": "yield_pct", "type": "float", "numeric": True},
         {"path": "metrics.purity", "type": "float", "numeric": True},
         {"path": "sample_id", "type": "str", "numeric": False}]

    A method returning a complex dataclass/Pydantic model rarely returns one number, but an
    optimizer can only take numbers — these paths are what lets the UI bind a named variable
    to one *field* of a structured result (and grey out the non-numeric ones) instead of
    forcing the whole object through a single return variable. `path` is dotted and is
    resolved against the serialized result by resolve_output_path at run time; a scalar
    return yields a single entry with an empty path, meaning "the result itself".
    """
    if annotation is inspect.Parameter.empty or annotation is None:
        return []

    # A fixed-length tuple return (`-> tuple[float, float]`) is addressed by index. Tuple[X, ...]
    # is variadic — there's no fixed leaf to point at, so it stays a single opaque result.
    try:
        origin = get_origin(annotation)
        args = get_args(annotation)
        if origin in (tuple, typing.Tuple) and args and Ellipsis not in args:
            paths = []
            for i, arg in enumerate(args):
                paths.extend(_flatten_info(extract_type_info(arg), str(i)))
            return paths
    except Exception:
        pass

    return _flatten_info(info if info is not None else extract_type_info(annotation), "")


def _flatten_info(info, prefix):
    if not info:
        return []
    fields = info.get("fields") if info.get("is_object") else None
    if fields:
        paths = []
        for name, child in fields.items():
            paths.extend(_flatten_info(child, f"{prefix}.{name}" if prefix else name))
        return paths
    return [{
        "path": prefix,
        "type": info.get("type", "Any"),
        "numeric": bool(info.get("numeric")),
    }]


_MISSING = object()


def resolve_output_path(value, path):
    """Walk a dotted return path (as produced by build_return_paths) against an actual result.

    Works on the serialized form (dicts/lists) and on the live object (attributes), so it
    doesn't matter which one the caller has. Returns the _MISSING sentinel rather than None
    when the path doesn't exist, since None is a legitimate field value.
    """
    if not path:
        return value
    current = value
    for segment in str(path).split("."):
        if isinstance(current, dict):
            if segment not in current:
                return _MISSING
            current = current[segment]
        elif isinstance(current, (list, tuple)) and segment.lstrip("-").isdigit():
            index = int(segment)
            if index >= len(current) or index < -len(current):
                return _MISSING
            current = current[index]
        elif hasattr(current, segment):
            current = getattr(current, segment)
        else:
            return _MISSING
    return current


def inspect_class(cls):
    """
    Inspects a Python class and returns a JSON-serializable 
    schema of its available methods, their arguments, and return types.
    """
    schema = {}
    
    # Get all callable methods that don't start with '_' (private)
    for name, method in inspect.getmembers(cls, predicate=callable):
        if name.startswith("_"):
            continue
            
        try:
            sig = inspect.signature(method)
            docstring = inspect.getdoc(method)

            # Under PEP 563 (`from __future__ import annotations`, increasingly common) every
            # annotation arrives as a *string*, so the Enum, bool and dataclass checks below all
            # silently fail and a dropdown degrades into a free-text box. Resolve the real objects
            # first where we can; if a forward reference cannot be resolved, fall back to the raw
            # annotations rather than losing the method.
            try:
                hints = typing.get_type_hints(method)
            except Exception:
                hints = {}

            params = {}
            for param_name, param in sig.parameters.items():
                if param_name == "self":
                    continue
                annotation = hints.get(param_name, param.annotation)
                params[param_name] = extract_type_info(annotation, param.default)
                
            return_type = "Any"
            return_info = None
            return_paths = []
            if sig.return_annotation != inspect.Signature.empty:
                ret = hints.get("return", sig.return_annotation)
                return_type = ret.__name__ if isinstance(ret, type) else str(ret).replace("typing.", "")
                return_info = extract_type_info(ret)
                # Addressable leaves of a structured return — see build_return_paths.
                if return_type not in ("None", "NoneType"):
                    return_paths = build_return_paths(ret, return_info)
                
            schema[name] = {
                "description": docstring or "",
                "parameters": params,
                "return_type": return_type,
                "return_info": return_info,
                "return_paths": return_paths,
                "is_coroutine": inspect.iscoroutinefunction(method)
            }
        except Exception as e:
            print(f"Failed to inspect method {name} of class {cls.__name__}: {e}")
            
    return schema
