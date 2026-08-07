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
