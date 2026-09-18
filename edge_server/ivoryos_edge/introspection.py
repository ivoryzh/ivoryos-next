import inspect
import typing

def extract_type_info(annotation, default=inspect.Parameter.empty):
    param_type = "Any"
    options = None
    is_object = False
    fields = {}

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


def _get_property(instance, name):
    """The property object behind `name`, or None if `name` isn't a property."""
    attr = getattr(type(instance), name, None)
    return attr if isinstance(attr, property) else None


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


def has_member(instance, name):
    """True when `name` names something this instance can actually run — a method, or either
    half of a property pair. Never triggers a getter just to answer the question."""
    if name.endswith(PROPERTY_SETTER_SUFFIX):
        prop = _get_property(instance, name[: -len(PROPERTY_SETTER_SUFFIX)])
        return prop is not None and prop.fset is not None
    if _get_property(instance, name) is not None:
        return True
    try:
        inspect.getattr_static(instance, name)
        return True
    except AttributeError:
        return False


def resolve_callable(instance, name):
    """Return a plain callable for a schema entry name.

    A step stores an instrument and an action name, and everything downstream —
    cast_arguments, the iscoroutinefunction check, run_and_track_task — expects a callable it
    can introspect and invoke with **kwargs. Property access isn't that shape, so wrap it:
    "<prop>_(setter)" becomes a one-argument function that assigns, and a getter becomes a
    zero-argument function that reads.
    """
    if name.endswith(PROPERTY_SETTER_SUFFIX):
        prop_name = name[: -len(PROPERTY_SETTER_SUFFIX)]
        prop = _get_property(instance, prop_name)
        if prop is None or prop.fset is None:
            raise AttributeError(f"{type(instance).__name__} has no writable property '{prop_name}'")

        def property_setter(value):
            setattr(instance, prop_name, value)
            return None

        property_setter.__name__ = name
        property_setter.__signature__ = inspect.Signature(
            parameters=[inspect.Parameter("value", inspect.Parameter.POSITIONAL_OR_KEYWORD,
                                          annotation=_setter_value_annotation(prop))],
            return_annotation=None,
        )
        return property_setter

    prop = _get_property(instance, name)
    if prop is not None:
        if prop.fget is None:
            raise AttributeError(f"Property '{name}' on {type(instance).__name__} is write-only")

        def property_getter():
            return getattr(instance, name)

        property_getter.__name__ = name
        property_getter.__signature__ = inspect.Signature(parameters=[])
        return property_getter

    return getattr(instance, name)


def inspect_device_module(device_instance):
    """
    Inspects a Python object (device instance) and returns a JSON-serializable 
    schema of its available methods, their arguments, and return types.
    """
    schema = {}
    cls = type(device_instance)

    # Properties first, and from the class rather than the instance (see
    # _iter_class_properties). Each one claims its own name, so the method sweep below skips it.
    property_names = set()
    for name, prop in _iter_class_properties(cls):
        property_names.add(name)
        try:
            schema.update(describe_property(name, prop))
        except Exception as e:
            print(f"Failed to inspect property {name}: {e}")

    # Get all callable methods that don't start with '_' (private).
    # inspect.getmembers(instance, ...) reads every attribute, which runs each property's
    # getter — on a real driver that means hardware traffic just to build a schema. Walk names
    # instead and look each up statically first, so only things we know are safe get read.
    for name in dir(device_instance):
        if name.startswith("_") or name in property_names:
            continue

        try:
            if isinstance(inspect.getattr_static(device_instance, name), property):
                continue
            method = getattr(device_instance, name)
        except Exception:
            continue

        if not callable(method):
            continue

        try:
            sig = inspect.signature(method)
            docstring = inspect.getdoc(method)
            
            params = {}
            for param_name, param in sig.parameters.items():
                if param_name == "self":
                    continue
                params[param_name] = extract_type_info(param.annotation, param.default)
                
            return_type = "Any"
            return_info = None
            if sig.return_annotation != inspect.Signature.empty:
                # Same repr problem as extract_type_info above, and here it has a visible
                # consequence: a `-> None` method reported as "<class 'NoneType'>" fails the
                # frontend's isNone check, so the designer offers a return-variable box for a
                # method that returns nothing.
                ret = sig.return_annotation
                return_type = ret.__name__ if isinstance(ret, type) else str(ret).replace("typing.", "")
                return_info = extract_type_info(sig.return_annotation)
                
            schema[name] = {
                "description": docstring or "",
                "parameters": params,
                "return_type": return_type,
                "return_info": return_info,
                "is_coroutine": inspect.iscoroutinefunction(method)
            }
        except Exception as e:
            print(f"Failed to inspect method {name}: {e}")
            
    return schema

def cast_value(annotation, val):
    if annotation == inspect.Parameter.empty or val is None:
        return val
        
    import dataclasses
    if dataclasses.is_dataclass(annotation) and isinstance(val, dict):
        kwargs = {}
        for f in dataclasses.fields(annotation):
            if f.name in val:
                kwargs[f.name] = cast_value(f.type, val[f.name])
        return annotation(**kwargs)
        
    try:
        from pydantic import BaseModel
        if isinstance(annotation, type) and issubclass(annotation, BaseModel) and isinstance(val, dict):
            return annotation(**val)
    except ImportError:
        pass
        
    if isinstance(annotation, type):
        import enum
        if issubclass(annotation, enum.Enum):
            try:
                return annotation(val)
            except Exception:
                pass
        if annotation == bool and isinstance(val, str):
            return val.lower() == 'true'
        try:
            return annotation(val)
        except Exception:
            return val
    return val

def cast_arguments(method, args):
    if not args:
        return {}
    sig = inspect.signature(method)
    casted_args = {}
    for param_name, param in sig.parameters.items():
        if param_name in args:
            casted_args[param_name] = cast_value(param.annotation, args[param_name])
            
    # Also include any args that aren't in signature (kwargs etc)
    # Exclude internal metadata arguments which start with '_'
    for k, v in args.items():
        if k not in casted_args and not k.startswith('_'):
            casted_args[k] = v
    return casted_args
