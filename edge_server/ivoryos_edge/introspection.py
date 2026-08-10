import inspect
import typing

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
                    
                # Try to get the type as a string
                param_type = "Any"
                if param.annotation != inspect.Parameter.empty:
                    param_type = str(param.annotation).replace("typing.", "")
                    
                param_data = {
                    "type": param_type,
                    "required": param.default == inspect.Parameter.empty
                }
                if param.default != inspect.Parameter.empty:
                    param_data["default"] = param.default
                params[param_name] = param_data
                
            return_type = "Any"
            if sig.return_annotation != inspect.Signature.empty:
                return_type = str(sig.return_annotation).replace("typing.", "")
                
            schema[name] = {
                "description": docstring or "",
                "parameters": params,
                "return_type": return_type,
                "is_coroutine": inspect.iscoroutinefunction(method)
            }
        except Exception as e:
            print(f"Failed to inspect method {name}: {e}")
            
    return schema

def cast_arguments(method, args):
    if not args:
        return {}
    sig = inspect.signature(method)
    casted_args = {}
    for param_name, param in sig.parameters.items():
        if param_name in args:
            val = args[param_name]
            if param.annotation != inspect.Parameter.empty and val is not None:
                try:
                    # check if the annotation is a type we can cast to
                    if isinstance(param.annotation, type):
                        if param.annotation == bool and isinstance(val, str):
                            val = val.lower() == 'true'
                        else:
                            val = param.annotation(val)
                except Exception:
                    pass # fallback to original value
            casted_args[param_name] = val
    # Also include any args that aren't in signature (kwargs etc)
    # Exclude internal metadata arguments which start with '_'
    for k, v in args.items():
        if k not in casted_args and not k.startswith('_'):
            casted_args[k] = v
    return casted_args
