import inspect
import typing

def extract_type_info(annotation, default=inspect.Parameter.empty):
    param_type = "Any"
    options = None
    is_object = False
    fields = {}

    if annotation != inspect.Parameter.empty:
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

def inspect_device_module(device_instance):
    """
    Inspects a Python object (device instance) and returns a JSON-serializable 
    schema of its available methods, their arguments, and return types.
    """
    schema = {}
    
    # Get all callable methods that don't start with '_' (private)
    for name, method in inspect.getmembers(device_instance, predicate=callable):
        if name.startswith("_"):
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
                return_type = str(sig.return_annotation).replace("typing.", "")
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
