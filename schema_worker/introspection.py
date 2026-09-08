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
            print(f"Failed to inspect method {name} of class {cls.__name__}: {e}")
            
    return schema
