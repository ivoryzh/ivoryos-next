import typing
import dataclasses
import enum

from ivoryos_edge.introspection import extract_type_info


def test_plain_builtin_types_get_clean_names_not_class_repr():
    # str(float) is Python's repr, "<class 'float'>" — cast_value/cast_arguments never read this
    # string (they always re-introspect the real annotation object), so it was pure noise that
    # every frontend consumer had to strip with its own regex.
    assert extract_type_info(float)["type"] == "float"
    assert extract_type_info(int)["type"] == "int"
    assert extract_type_info(str)["type"] == "str"
    assert extract_type_info(bool)["type"] == "bool"


def test_typing_generics_are_unaffected():
    assert extract_type_info(typing.List[str])["type"] == "List[str]"
    assert extract_type_info(typing.Optional[float])["type"] == "Optional[float]"


def test_enum_and_dataclass_names_still_clean():
    class Color(enum.Enum):
        RED = "red"
        BLUE = "blue"

    info = extract_type_info(Color)
    assert info["type"] == "Color"
    assert info["options"] == ["red", "blue"]

    @dataclasses.dataclass
    class Config:
        mode: str = "auto"

    info = extract_type_info(Config)
    assert info["type"] == "Config"
    assert info["is_object"] is True
    assert info["fields"]["mode"]["type"] == "str"
