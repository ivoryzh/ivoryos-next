import json
from introspection import inspect_class
import dummy_driver

def fallback(o):
    return f"<not serializable: {type(o)}>"

schemas = {
    "PumpConfig": inspect_class(dummy_driver.PumpConfig),
    "Pump": inspect_class(dummy_driver.Pump)
}

print("Schema:")
print(json.dumps(schemas, default=fallback, indent=2))
