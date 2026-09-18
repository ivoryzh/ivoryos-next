import inspect
import typing

def extract_type_info(annotation, default=inspect.Parameter.empty):
    param_type = "Any"
    options = None
    is_object = False
    fields = {}

    if annotation != inspect.Parameter.empty:
        # For a plain class (float, int, a dataclass, ...) str(annotation) is Python's repr,
        # "<class 'float'>" — noise no downstream consumer needs. typing constructs (List[str],
        # Optional[int], ...) aren't classes and keep falling through to str(annotation).
        if isinstance(annotation, type):
            param_type = annotation.__name__
        else:
            param_type = str(annotation).replace("typing.", "")

        # Check for Enum
        import enum
        if isinstance(annotation, type) and issubclass(annotation, enum.Enum):
            options = [e.value for e in annotation]
            param_type = annotation.__name__
            
        # Check for Literal
        import typing
        from typing import get_origin, get_args
        try:
            # Need to handle Literal which might be typing.Literal or typing_extensions.Literal
            if getattr(get_origin(annotation), '__name__', '') == 'Literal' or get_origin(annotation) is getattr(typing, 'Literal', None):
                options = list(get_args(annotation))
                param_type = "Literal"
        except Exception:
            pass
            
        # Optional[X] / Union[X, None] is still just X as far as a form is concerned — without
        # unwrapping it, an optional enum loses its choices and renders as a free-text box.
        if options is None and not is_object:
            try:
                args = [a for a in get_args(annotation) if a is not type(None)]
                if get_origin(annotation) is not None and len(args) == 1:
                    inner = extract_type_info(args[0])
                    if inner.get("options") is not None:
                        options = inner["options"]
                        param_type = inner["type"]
                    elif inner.get("is_object"):
                        is_object = True
                        fields = inner.get("fields", {})
                        param_type = inner["type"]
            except Exception:
                pass

        # Check for bool
        if annotation is bool:
            options = ["True", "False"]
            
        # Check for Dataclass
        import dataclasses
        if dataclasses.is_dataclass(annotation):
            is_object = True
            param_type = getattr(annotation, '__name__', 'Dataclass')
            for f in dataclasses.fields(annotation):
                f_default = f.default if f.default != dataclasses.MISSING else inspect.Parameter.empty
                if f.default_factory != dataclasses.MISSING:
                    try:
                        f_default = f.default_factory()
                    except Exception:
                        pass
                fields[f.name] = extract_type_info(f.type, f_default)
                
        # Check for Pydantic
        else:
            try:
                from pydantic import BaseModel
                if isinstance(annotation, type) and issubclass(annotation, BaseModel):
                    is_object = True
                    param_type = getattr(annotation, '__name__', 'BaseModel')
                    if hasattr(annotation, 'model_fields'):
                        for f_name, f_info in annotation.model_fields.items():
                            f_default = getattr(f_info, 'default', inspect.Parameter.empty)
                            # Handle Pydantic v2 ...
                            if f_default.__class__.__name__ == 'PydanticUndefinedType' or f_default == Ellipsis:
                                f_default = inspect.Parameter.empty
                            fields[f_name] = extract_type_info(f_info.annotation, f_default)
                    elif hasattr(annotation, '__fields__'):
                        for f_name, f_info in annotation.__fields__.items():
                            f_default = f_info.default if f_info.required == False else inspect.Parameter.empty
                            fields[f_name] = extract_type_info(f_info.type_, f_default)
            except ImportError:
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
        
    if default != inspect.Parameter.empty:
        import enum
        if isinstance(default, enum.Enum):
            param_data["default"] = default.value
        else:
            param_data["default"] = default

    return param_data

PROPERTY_SETTER_SUFFIX = "_(setter)"


def _resolve_hints(func):
    """Annotations as real objects where possible.

    Under PEP 563 every annotation arrives as a string, which would make extract_type_info's
    Enum/bool/dataclass checks fall through and turn a dropdown into a free-text box.
    """
    try:
        return typing.get_type_hints(func)
    except Exception:
        return {}


# Modelling frameworks put properties on their own base class -- pydantic's `model_extra` and
# `model_fields_set`, for instance. They describe the library, not the instrument, and nobody is
# going to drive one from a workflow, so they don't belong in the schema.
FRAMEWORK_PROPERTY_PACKAGES = ("pydantic",)


def _defining_class(cls, name):
    """The class in `cls`'s MRO that actually defines `name`."""
    for base in getattr(cls, "__mro__", (cls,)):
        if name in vars(base):
            return base
    return None


def _iter_class_properties(cls):
    """Yield (name, property) for every public property on `cls`.

    Properties have to be found on the *class*: looking one up on an instance runs fget, so
    on a real driver merely building the schema would go and talk to the hardware.
    """
    for name, attr in inspect.getmembers(cls, lambda x: isinstance(x, property)):
        if name.startswith("_"):
            continue
        owner = _defining_class(cls, name)
        if owner is not None and getattr(owner, "__module__", "").split(".")[0] in FRAMEWORK_PROPERTY_PACKAGES:
            continue
        yield name, attr


def _setter_value_annotation(prop):
    """The type a property's setter accepts: its own parameter annotation when it has one,
    otherwise whatever the getter promises to return."""
    if prop.fset is not None:
        try:
            hints = _resolve_hints(prop.fset)
            params = [p for n, p in inspect.signature(prop.fset).parameters.items() if n != "self"]
            if params:
                annotation = hints.get(params[0].name, params[0].annotation)
                if annotation is not inspect.Parameter.empty:
                    return annotation
        except (TypeError, ValueError):
            pass
    if prop.fget is not None:
        try:
            annotation = _resolve_hints(prop.fget).get("return", inspect.signature(prop.fget).return_annotation)
            if annotation is not inspect.Signature.empty:
                return annotation
        except (TypeError, ValueError):
            pass
    return inspect.Parameter.empty


def describe_property(name, prop):
    """Expand one `@property` into the schema entries a workflow can actually use: a
    zero-argument getter under the property's own name, and — when the property is writable —
    a one-argument setter under "<name>_(setter)".

    A property is an attribute in Python but a *step* in a workflow: plenty of drivers expose
    `pump.speed = 5` as the only way to set a speed, so dropping properties from the schema
    (which is what inspecting only callables did) made those drivers half-unusable. The
    "_(setter)" suffix is the same convention the original ivoryos designer uses, so workflows
    stay readable across both.
    """
    entries = {}
    docstring = inspect.getdoc(prop) or ""

    if prop.fget is not None:
        return_type = "Any"
        return_info = None
        try:
            annotation = _resolve_hints(prop.fget).get("return", inspect.signature(prop.fget).return_annotation)
        except (TypeError, ValueError):
            annotation = inspect.Signature.empty
        if annotation is not inspect.Signature.empty:
            return_type = annotation.__name__ if isinstance(annotation, type) else str(annotation).replace("typing.", "")
            return_info = extract_type_info(annotation)
        entries[name] = {
            "description": docstring,
            "parameters": {},
            "return_type": return_type,
            "return_info": return_info,
            "is_coroutine": False,
            "is_property": True,
            "property_access": "get",
            "property_name": name,
            "has_setter": prop.fset is not None,
        }

    if prop.fset is not None:
        value_info = extract_type_info(_setter_value_annotation(prop))
        value_info["required"] = True
        setter_doc = inspect.getdoc(prop.fset)
        if not setter_doc:
            setter_doc = f"Set {name}." if not docstring else f"Set {name}. {docstring}"
        entries[name + PROPERTY_SETTER_SUFFIX] = {
            "description": setter_doc,
            "parameters": {"value": value_info},
            "return_type": "None",
            "return_info": extract_type_info(type(None)),
            "is_coroutine": False,
            "is_property": True,
            "property_access": "set",
            "property_name": name,
            "has_setter": True,
        }

    return entries


def inspect_class(cls):
    """
    Inspects a Python class and returns a JSON-serializable 
    schema of its available methods, their arguments, and return types.
    """
    schema = {}

    # Properties become getter/setter entries — a driver that exposes `pump.speed = 5` has no
    # callable for it at all, so inspecting only callables dropped that capability entirely.
    property_names = set()
    for name, prop in _iter_class_properties(cls):
        property_names.add(name)
        try:
            schema.update(describe_property(name, prop))
        except Exception as e:
            print(f"Failed to inspect property {name} of class {cls.__name__}: {e}")

    # Get all callable methods that don't start with '_' (private)
    for name, method in inspect.getmembers(cls, predicate=callable):
        if name.startswith("_") or name in property_names:
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
            if sig.return_annotation != inspect.Signature.empty:
                ret = hints.get("return", sig.return_annotation)
                return_type = ret.__name__ if isinstance(ret, type) else str(ret).replace("typing.", "")
                return_info = extract_type_info(ret)
                
            schema[name] = {
                "description": docstring or "",
                "parameters": params,
                "return_type": return_type,
                "return_info": return_info,
                "is_coroutine": inspect.iscoroutinefunction(method)
            }
        except Exception as e:
            print(f"Failed to inspect method {name} of class {cls.__name__}: {e}")
            
    return schema
