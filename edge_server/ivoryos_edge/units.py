"""A unit a driver *may* declare on a value: `Annotated[float, Unit("mL")]`.

Units belong to the Safety page (safety.py): beside a field's boundaries, the lab picks what
its numbers are in, and nothing is asked of a driver. That is the path that works for the
drivers labs actually run -- vendor SDKs, pymeasure, a package from the Hub -- none of which
will ever carry an annotation. A unit is a label for people, the record and the assistant;
nothing is converted, and the number reaches the driver as typed.

This marker is the optional other half: a driver that does say what a value is in, where it
says the type, has that shown as the field's unit (fixed, since it describes what the code
does) with no configuration. It may sit on a parameter, a return (or one field of a dataclass
or Pydantic model it returns, or one element of a tuple), or a property's getter or setter,
and lands as `unit` on the parameter's schema entry and on each `return_paths` leaf. Like the
labware markers (labware.py), any annotation metadata with an `ivoryos_schema()` method is
read, so a package can define its own and import nothing from IvoryOS.

    from typing import Annotated
    from ivoryos_edge import Unit

    def read_temperature(self) -> Annotated[float, Unit("°C")]: ...
"""


class Unit:
    """`Annotated[float, Unit("mL")]`: the unit this value is in. See the module docstring."""

    def __init__(self, unit: str):
        text = str(unit).strip()
        if not text:
            raise ValueError("Unit() needs the unit's text, e.g. Unit('mL')")
        self.unit = text

    def ivoryos_schema(self) -> dict:
        return {"unit": self.unit}

    def __repr__(self) -> str:
        return f"Unit({self.unit!r})"
