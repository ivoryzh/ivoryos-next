import argparse
import importlib
import inspect
import json
import sys
import os

# Add the current directory so it can find introspection.py if needed, 
# although we will likely run this script from the same directory.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from introspection import inspect_class

def extract_schemas(module_name: str, class_name: str = None):
    try:
        module = importlib.import_module(module_name)
    except Exception as e:
        print(json.dumps({"error": f"Failed to import module {module_name}: {e}"}))
        sys.exit(1)

    schemas = {}
    
    if class_name:
        if not hasattr(module, class_name):
            print(json.dumps({"error": f"Class {class_name} not found in module {module_name}"}))
            sys.exit(1)
        cls = getattr(module, class_name)
        if not inspect.isclass(cls):
            print(json.dumps({"error": f"{class_name} is not a class"}))
            sys.exit(1)
        schemas[class_name] = inspect_class(cls)
    else:
        for name, obj in inspect.getmembers(module, inspect.isclass):
            if name.startswith("_"):
                continue
            try:
                from pydantic import BaseModel
                if issubclass(obj, BaseModel):
                    continue
            except ImportError:
                pass
                
            if getattr(obj, "__module__", None) == module_name:
                schemas[name] = inspect_class(obj)
                
        if not schemas:
            for name, obj in inspect.getmembers(module, inspect.isclass):
                if name.startswith("_"):
                    continue
                try:
                    from pydantic import BaseModel
                    if issubclass(obj, BaseModel):
                        continue
                except ImportError:
                    pass
                schemas[name] = inspect_class(obj)

    def fallback(o):
        return f"<not serializable: {type(o)}>"
        
    print(json.dumps({
        "module": module_name,
        "schemas": schemas
    }, default=fallback))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract JSON schema from a Python module")
    parser.add_argument("module_name", help="The python module to import (e.g. driver.pump)")
    parser.add_argument("--class_name", help="Specific class to extract", default=None)
    
    args = parser.parse_args()
    extract_schemas(args.module_name, args.class_name)
