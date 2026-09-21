"""Signature shapes that don't fit "a step stores named arguments and we call `method(**args)`".

The deck's whole contract with a driver is that door: `inspect.signature()` becomes a schema,
the designer fills named arguments, and execution calls `method(**args)`. Four shapes stress
it, and each one used to fail differently:

- `*args` / `**kwargs` — introspected as required parameters literally named "args" and
  "kwargs". Filling one is a TypeError for `*` and a junk key for `**`.
- keyword-only parameters — real parameters that merely sit after a `*`, so any rule phrased
  as "skip what follows a star" drops arguments the method actually requires.
- positional-only parameters — real, required, and *not nameable*, so `method(**args)` raises
  "got some positional-only arguments passed as keyword arguments" mid-workflow.
- no readable signature at all (a compiled entry point) — `inspect.signature` raises, and the
  method vanished from the deck with nothing but a line on stderr.

The classes under test are the demo deck's own (`example/variadic_driver.py`), so the thing a
person can click through in the UI is the same thing these assertions pin down.
"""

import asyncio
import inspect
import sys
from pathlib import Path

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "example"))

from variadic_driver import Grating, VariadicProbe, VendorBridge  # noqa: E402

from ivoryos_edge.agent.validate import validate_body  # noqa: E402
from ivoryos_edge.introspection import (  # noqa: E402
    cast_arguments,
    inspect_device_module,
    resolve_callable,
)
from ivoryos_edge.server import app  # noqa: E402


@pytest.fixture(scope="module")
def probe_schema():
    return inspect_device_module(VariadicProbe())


@pytest.fixture(scope="module")
def bridge_schema():
    return inspect_device_module(VendorBridge())


# --------------------------------------------------------------------------------------
# What the schema says
# --------------------------------------------------------------------------------------

def test_variadics_are_not_parameters_whatever_they_are_called(probe_schema):
    """Keyed on `param.kind`: `*standards` / `**vendor_options` are the same case as
    `*args` / `**kwargs`, and an implementation filtering on the conventional names would
    pass the usual spelling and fail here."""
    assert list(probe_schema["measure"]["parameters"]) == ["wavelength_nm"]
    assert probe_schema["configure"]["parameters"] == {}
    assert probe_schema["calibrate"]["parameters"] == {}
    assert probe_schema["scan"]["parameters"] == {}


def test_accepts_kwargs_marks_only_the_methods_that_take_keywords(probe_schema):
    """`**` means "arguments I cannot list"; `*` means "no keywords at all". Collapsing the two
    would either lose real arguments or invite ones that raise TypeError."""
    assert probe_schema["measure"]["accepts_kwargs"] is True
    assert probe_schema["configure"]["accepts_kwargs"] is True
    assert probe_schema["scan"]["accepts_kwargs"] is True
    assert probe_schema["acquire"]["accepts_kwargs"] is True

    assert probe_schema["calibrate"]["accepts_kwargs"] is False
    assert probe_schema["average"]["accepts_kwargs"] is False
    assert probe_schema["blank"]["accepts_kwargs"] is False


def test_a_kwargs_only_method_and_an_empty_one_differ_only_in_that_flag(probe_schema):
    """Both show `parameters: {}`. The flag is the entire difference between "send what the
    vendor manual says" and "sending anything is a mistake"."""
    assert probe_schema["configure"]["parameters"] == probe_schema["blank"]["parameters"] == {}
    assert probe_schema["configure"]["accepts_kwargs"] is True
    assert probe_schema["blank"]["accepts_kwargs"] is False


def test_keyword_only_parameters_are_ordinary_parameters(probe_schema):
    """A `*` in front of a parameter list does not make what follows variadic. `seconds` is
    required, `mode` is defaulted, and both are as fillable as any other parameter."""
    integrate = probe_schema["integrate"]["parameters"]
    assert list(integrate) == ["seconds", "mode"]
    assert integrate["seconds"]["required"] is True
    assert integrate["mode"]["required"] is False
    assert integrate["mode"]["default"] == "peak"


def test_a_keyword_only_parameter_after_star_args_survives_the_variadic(probe_schema):
    """`def average(self, *scans, discard_first=True)` — the variadic is dropped and its
    neighbour is not, which is the case a name-based or position-based filter gets wrong."""
    average = probe_schema["average"]["parameters"]
    assert list(average) == ["discard_first"]
    assert average["discard_first"]["required"] is False
    assert average["discard_first"]["default"] is True


def test_a_positional_only_parameter_is_listed_and_marked(probe_schema):
    """It is not a variadic: the caller does have to supply it. It just cannot be supplied by
    name, so it stays in the schema carrying `positional`, which is what tells execution to
    bind it by position and the Python preview to render it without a keyword."""
    channel = probe_schema["read_channel"]["parameters"]["channel"]
    assert channel["required"] is True
    assert channel["positional"] is True
    # A normal parameter is not marked, so nothing downstream has to special-case the absence.
    assert "positional" not in probe_schema["read_channel"]["parameters"]["gain"]
    assert "positional" not in probe_schema["measure"]["parameters"]["wavelength_nm"]


def test_async_and_accepts_kwargs_are_independent(probe_schema):
    """The queue awaits on `is_coroutine` and validation relaxes on `accepts_kwargs`; a method
    that is both must not lose either flag."""
    assert probe_schema["acquire"]["is_coroutine"] is True
    assert probe_schema["acquire"]["accepts_kwargs"] is True


def test_a_decorator_without_wraps_no_longer_hides_the_signature(bridge_schema):
    """The most common introspection failure there is, in lab code and vendor SDKs alike: a
    method wrapped for retries or a device lock, without `functools.wraps`. All that reaches
    introspection is `(*args, **kwargs)` and no docstring, so the deck published "no parameters,
    accepts anything" for a method taking two named ones — and every argument typed into the
    resulting free-text rows came back as "unexpected keyword argument" from the function
    underneath, naming a signature the operator was never shown.

    Recovered from the wrapper's closure, so it reads like the `@wraps` version beside it."""
    assert list(bridge_schema["send"]["parameters"]) == ["command", "timeout_s"]
    assert bridge_schema["send"]["accepts_kwargs"] is False
    assert bridge_schema["send"]["description"]  # the docstring the wrapper swallowed

    assert list(bridge_schema["send_checked"]["parameters"]) == ["command", "timeout_s"]
    assert bridge_schema["send_checked"]["accepts_kwargs"] is False


def test_the_recovery_is_refused_when_the_closure_does_not_identify_the_method(bridge_schema):
    """Two decorators deep the closure holds the other *wrapper*, so the name no longer matches
    and nothing is assumed about whatever else is in there. The fallback is the old behaviour,
    which is honest: parameters unknown, arguments forwarded."""
    assert bridge_schema["send_double_wrapped"]["parameters"] == {}
    assert bridge_schema["send_double_wrapped"]["accepts_kwargs"] is True


def test_the_recovered_signature_is_what_the_call_is_cast_against():
    """Description and execution have to agree or the schema promises a float and the driver is
    handed "2.5" — and the wrapper stays in the call path, since retrying or taking a device
    lock is the whole reason it exists."""
    entered = []

    def logging_decorator(func):
        def wrapper(*args, **kwargs):
            entered.append(kwargs)
            return func(*args, **kwargs)
        return wrapper

    class Device:
        @logging_decorator
        def send(self, command: str, timeout_s: float = 5.0):
            return {"command": command, "timeout_s": timeout_s}

    device = Device()
    assert list(inspect_device_module(device)["send"]["parameters"]) == ["command", "timeout_s"]

    method = resolve_callable(device, "send")
    assert method(**cast_arguments(method, {"command": "*IDN?", "timeout_s": "2.5"})) == {
        "command": "*IDN?", "timeout_s": 2.5,
    }
    assert entered == [{"command": "*IDN?", "timeout_s": 2.5}]


def test_a_closure_that_does_not_hold_the_method_is_left_alone():
    """The guard that makes this safe to do at all: the closure must hold one function named
    like the method. A registering decorator keeps the original in a table and closes over the
    table instead, so there is nothing in scope that identifies this method — and describing it
    by whatever function happened to be nearby would be worse than describing it as opaque.

    (A decorator closing over helpers *as well* is fine: one function of the right name is what
    is being looked for, not a closure of size one.)"""
    registry = {}

    def registering(func):
        registry[func.__name__] = func

        def wrapper(*args, **kwargs):
            return registry[wrapper.target](*args, **kwargs)
        wrapper.target = func.__name__
        return wrapper

    class Device:
        @registering
        def send(self, command: str): ...

    entry = inspect_device_module(Device())["send"]
    assert entry["parameters"] == {}
    assert entry["accepts_kwargs"] is True


def test_an_async_method_behind_a_sync_decorator_is_still_awaited():
    """Such a wrapper is an ordinary function that returns a coroutine, so `is_coroutine` was
    false and the queue ran it in a thread and recorded the coroutine object as the result.
    Read from the recovered function, and the shim awaits what the wrapper returns."""
    def decorator(func):
        def wrapper(*args, **kwargs):
            return func(*args, **kwargs)
        return wrapper

    class Device:
        @decorator
        async def acquire(self, frames: int = 1):
            return {"frames": frames}

    device = Device()
    assert inspect_device_module(device)["acquire"]["is_coroutine"] is True

    method = resolve_callable(device, "acquire")
    assert inspect.iscoroutinefunction(method) is True
    assert asyncio.run(method(**cast_arguments(method, {"frames": "3"}))) == {"frames": 3}


def test_a_method_with_no_readable_signature_stays_on_the_deck(bridge_schema):
    """A ctypes/pybind11 entry point raises from `inspect.signature`. Dropping it hid a
    capability the driver plainly exposes; "parameters unknown" is exactly what accepts_kwargs
    already means downstream, so it is described that way instead."""
    assert "send_raw" in bridge_schema
    assert bridge_schema["send_raw"]["parameters"] == {}
    assert bridge_schema["send_raw"]["accepts_kwargs"] is True
    # Its docstring still reaches the deck, which is the only documentation such a method has.
    assert bridge_schema["send_raw"]["description"]


def test_an_unreadable_signature_is_not_advertised_as_a_real_kwargs(bridge_schema, probe_schema):
    """`accepts_kwargs` on a method whose signature was read is a promise that signature made.
    On one that could not be read it is a guess, and a guess that is wrong for a whole family of
    compiled functions: one taking only positional arguments reports having received nothing
    however much the caller sent (`min(x=1)` — "expected at least 1 argument, got 0"), and this
    deck has no way to send positional arguments. The flag is what lets the form say which of
    the two it is instead of offering the same confident editor for both."""
    assert bridge_schema["send_raw"]["signature_unavailable"] is True
    # A real **kwargs carries no such flag — nothing was guessed about it.
    assert "signature_unavailable" not in probe_schema["configure"]
    assert "signature_unavailable" not in probe_schema["measure"]


def test_a_real_c_function_reports_its_positional_only_parameters(bridge_schema):
    """zlib.crc32 is `(data, value=0, /)` — not a contrived example but what wrapping a
    compiled library normally looks like."""
    checksum = bridge_schema["checksum"]["parameters"]
    assert checksum["data"]["positional"] is True
    assert checksum["value"]["positional"] is True
    assert checksum["value"]["required"] is False


# --------------------------------------------------------------------------------------
# A **kwargs the driver declares (PEP 692)
# --------------------------------------------------------------------------------------

def test_declared_kwargs_become_ordinary_parameters(probe_schema):
    """`**options: Unpack[LampOptions]` is a driver saying exactly what its **kwargs accepts.
    The form can only render fields it has been told about, so this is the difference between a
    typed field with a dropdown and a free-text row the scientist must spell correctly."""
    declared = probe_schema["measure_declared"]["parameters"]
    assert list(declared) == ["wavelength_nm", "slit_um", "grating", "lamp_on"]

    # Required-ness comes from the TypedDict's key sets, not from an absent default — a
    # TypedDict key has no value to default to, so "has no default" would call them all required.
    assert declared["slit_um"]["required"] is True
    assert declared["grating"]["required"] is False
    assert declared["lamp_on"]["required"] is False

    # And they are extracted like any other annotation, so an enum is still a dropdown.
    assert declared["grating"]["options"] == [g.value for g in Grating]
    assert declared["lamp_on"]["options"] == ["True", "False"]


def test_declaring_them_turns_typo_detection_back_on(probe_schema):
    """The flip side. `accepts_kwargs` exists to stop unlisted arguments being reported as
    typos; once the set is written down there is no reason to keep that suppression, and every
    reason not to — a misspelled `slit_um` would otherwise be forwarded in silence."""
    assert probe_schema["measure_declared"]["accepts_kwargs"] is False
    assert probe_schema["measure"]["accepts_kwargs"] is True

    schema = {"probe": probe_schema}
    issues = _errors(validate_body(
        _body([_step("probe", "measure_declared", {"wavelength_nm": 500, "slit_ym": 20})]), schema))
    assert any("has no parameter 'slit_ym'" in i["message"] for i in issues)
    assert any("slit_um" in (i.get("hint") or "") for i in issues)


def test_declared_keys_are_cast_like_the_parameters_they_now_are():
    """The rule AGENTS.md states for every annotation: whatever extract_type_info reported, the
    call has to actually apply — otherwise the schema promises an int and the driver gets "20"."""
    probe = VariadicProbe()
    method = resolve_callable(probe, "measure_declared")
    result = method(**cast_arguments(method, {
        "wavelength_nm": "450", "slit_um": "20", "grating": "blazed_1200", "lamp_on": "True",
    }))
    assert result["wavelength_nm"] == 450.0
    assert result["options"] == {"slit_um": 20, "grating": Grating.BLAZED_1200, "lamp_on": True}
    assert result["types"] == ["int", "Grating", "bool"]


def test_an_undeclared_key_is_still_forwarded_not_dropped():
    """The validator objects before dispatch, which is where an argument outside the declared
    set should be caught. If one arrives anyway, the driver is the one entitled to reject it —
    quietly swallowing an argument is how a step runs while meaning something else."""
    probe = VariadicProbe()
    method = resolve_callable(probe, "measure_declared")
    result = method(**cast_arguments(method, {"wavelength_nm": 1.0, "slit_um": 1, "undocumented": "x"}))
    assert result["options"]["undocumented"] == "x"


# --------------------------------------------------------------------------------------
# What actually reaches the driver
# --------------------------------------------------------------------------------------

def test_a_positional_only_parameter_is_bound_by_position_at_call_time():
    """The bug this closes: every call site invokes `method(**args)`, so a positional-only
    parameter raised TypeError in the middle of a run. `resolve_callable` — the one door
    execution goes through — returns a shim that moves it back into position."""
    probe = VariadicProbe()
    method = resolve_callable(probe, "read_channel")
    result = method(**cast_arguments(method, {"channel": "3", "gain": "2.5"}))
    assert result == {"channel": 3, "gain": 2.5}

    # Calling the raw method the way the queue would, to show what is being worked around.
    with pytest.raises(TypeError, match="positional-only"):
        probe.read_channel(channel=3, gain=2.5)


def test_a_missing_positional_only_argument_still_raises_pythons_own_error():
    """Only the leading run of supplied names is moved. A gap means an argument is missing, and
    Python says that better than a rearranged call could."""
    method = resolve_callable(VariadicProbe(), "read_channel")
    with pytest.raises(TypeError, match="missing 1 required positional argument"):
        method(**cast_arguments(method, {"gain": 1.0}))


def test_a_compiled_positional_only_function_is_callable_through_the_same_door():
    bridge = VendorBridge()
    method = resolve_callable(bridge, "checksum")
    assert method(**{"data": b"ivoryos"}) == __import__("zlib").crc32(b"ivoryos")


def test_an_async_positional_only_method_is_still_a_coroutine_function():
    """The shim has to be async when the method is, or the queue stops awaiting it and records
    a coroutine object as the step's result."""
    class Device:
        async def read(self, channel: int, /, **options):
            return {"channel": channel, "options": options}

    method = resolve_callable(Device(), "read")
    assert inspect.iscoroutinefunction(method) is True
    assert asyncio.run(method(**cast_arguments(method, {"channel": "4", "gain": 2}))) == {
        "channel": 4, "options": {"gain": 2},
    }


def test_unlisted_arguments_are_cast_by_the_kwargs_annotation():
    """A form sends JSON, so every value arrives as a string. A named `float` parameter is cast
    from it; `**offsets: float` says the same thing about arguments the schema cannot list, and
    ignoring it handed the driver "2.5" where it asked for a number."""
    probe = VariadicProbe()
    method = resolve_callable(probe, "tune")
    result = method(**cast_arguments(method, {"base_nm": "500", "red": "2.5", "blue": "-1"}))
    assert result["base_nm"] == 500.0
    assert result["offsets"] == {"red": 2.5, "blue": -1.0}
    assert result["types"] == ["float", "float"]


def test_unannotated_kwargs_pass_through_untouched():
    """With nothing to cast against, guessing would be worse than forwarding: `"2"` may well be
    the string the vendor SDK expects."""
    probe = VariadicProbe()
    method = resolve_callable(probe, "configure")
    assert method(**cast_arguments(method, {"gain": "2", "lamp": True}))["settings"] == {
        "gain": "2", "lamp": True,
    }


def test_internal_metadata_never_reaches_a_kwargs_method():
    """`_return_bindings` and friends are the designer talking to the runner. A `**kwargs`
    method accepts anything, so nothing but the underscore rule stops them being forwarded into
    a driver as if they were instrument settings."""
    probe = VariadicProbe()
    method = resolve_callable(probe, "configure")
    casted = cast_arguments(method, {"gain": 2, "_return_var": "x", "_return_bindings": []})
    assert casted == {"gain": 2}


def test_an_unknown_argument_to_a_strict_method_stays_an_error():
    """Deliberately *not* filtered. Dropping an argument a method cannot accept would run the
    step with a silently different meaning — a renamed parameter would quietly take its default
    — and on real hardware that is the wrong reaction rather than a failed one. The agent
    validator reports it before dispatch; this is the backstop for a workflow saved against an
    older driver."""
    probe = VariadicProbe()
    method = resolve_callable(probe, "integrate")
    with pytest.raises(TypeError, match="unexpected keyword argument"):
        method(**cast_arguments(method, {"seconds": 1.0, "gian": 2}))


def test_casting_survives_a_method_with_no_readable_signature():
    """`cast_arguments` calls `inspect.signature` too, so the same compiled method that used to
    vanish from the schema would have raised here the moment it was executed."""
    bridge = VendorBridge()
    method = resolve_callable(bridge, "send_raw")
    assert cast_arguments(method, {"command": "*IDN?", "_return_var": "x"}) == {"command": "*IDN?"}


def test_an_opaque_method_can_actually_be_called_with_what_the_form_sends():
    """The point of keeping it on the deck. Nothing can be cast — there is no annotation to cast
    against — but the arguments reach the driver, which is the whole of what this case can
    promise."""
    bridge = VendorBridge()
    method = resolve_callable(bridge, "send_raw")
    assert method(**cast_arguments(method, {"command": "*IDN?", "timeout_s": 2})) == {
        "forwarded": {"command": "*IDN?", "timeout_s": 2},
    }


# --------------------------------------------------------------------------------------
# What the agent validator makes of it
# --------------------------------------------------------------------------------------

def _body(steps):
    return {"prep": [], "script": steps, "cleanup": []}


def _step(instrument, method, args):
    return {"instrument": instrument, "action": method, "args": args}


def _errors(issues):
    return [i for i in issues if i["severity"] == "error"]


def test_the_validator_lets_a_kwargs_method_take_what_the_schema_cannot_list(probe_schema):
    schema = {"probe": probe_schema}
    issues = validate_body(_body([_step("probe", "measure", {"wavelength_nm": 500, "slit_um": 20})]), schema)
    assert _errors(issues) == []


def test_the_validator_still_demands_the_listed_ones(probe_schema):
    """Relaxing on unlisted arguments must not relax on listed ones: `**kwargs` says nothing
    about `wavelength_nm` being optional."""
    schema = {"probe": probe_schema}
    issues = _errors(validate_body(_body([_step("probe", "measure", {"slit_um": 20})]), schema))
    assert len(issues) == 1
    assert "wavelength_nm" in issues[0]["message"]


def test_the_validator_rejects_arguments_to_a_star_only_method(probe_schema):
    """`*standards` takes no keywords at all, so there is no argument that could be right."""
    schema = {"probe": probe_schema}
    issues = _errors(validate_body(_body([_step("probe", "calibrate", {"standards": [1, 2]})]), schema))
    assert len(issues) == 1
    assert "has no parameter 'standards'" in issues[0]["message"]
    assert "takes no parameters" in issues[0]["hint"]


def test_the_validator_asks_nothing_of_a_method_it_cannot_read(bridge_schema):
    """A compiled entry point publishes no parameters and accepts anything — reporting its
    arguments as typos would make the deck unusable for exactly the drivers that need it."""
    schema = {"bridge": bridge_schema}
    assert validate_body(_body([_step("bridge", "send_raw", {"anything": 1})]), schema) == []


# --------------------------------------------------------------------------------------
# End to end, through the server's own execute path
# --------------------------------------------------------------------------------------

@pytest.fixture
def variadic_deck(setup_app_state):
    """Put the demo instruments on the running deck for the duration of one test."""
    probe = VariadicProbe()
    app.state.instruments["variadic"] = probe
    app.state.instrument_schemas["variadic"] = inspect_device_module(probe)
    try:
        yield probe
    finally:
        app.state.instruments.pop("variadic", None)
        app.state.instrument_schemas.pop("variadic", None)


async def _execute(ac, module, method, args=None):
    started = await ac.post("/api/execute", json={"module": module, "method": method, "args": args or {}})
    assert started.status_code == 200, started.text
    task_id = started.json()["task_id"]
    for _ in range(50):
        await asyncio.sleep(0.05)
        poll = await ac.get(f"/api/execute/{task_id}")
        if poll.json().get("status") in ("completed", "error"):
            return poll.json()
    raise AssertionError("the task never finished")


@pytest.mark.asyncio
async def test_running_the_variadic_shapes_by_hand(variadic_deck):
    """The manual-execute path is the shortest route through resolve_callable, cast_arguments
    and run_and_track_task — the same three the queue uses for a workflow step."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # Unlisted arguments reach **kwargs rather than being rejected or renamed.
        data = await _execute(ac, "variadic", "measure", {"wavelength_nm": "450", "slit_um": 20})
        assert data["status"] == "completed"
        assert data["result"] == {"wavelength_nm": 450.0, "vendor_options": {"slit_um": 20}}

        # A **kwargs-only method called with nothing at all, which is what the empty form sends.
        data = await _execute(ac, "variadic", "configure", {})
        assert data["result"] == {"settings": {}}

        # A *args-only method: no arguments to send, and it runs.
        data = await _execute(ac, "variadic", "calibrate", {})
        assert data["result"] == {"standards": []}

        # Positional-only, by name over the wire and by position at the call.
        data = await _execute(ac, "variadic", "read_channel", {"channel": "2", "gain": "1.5"})
        assert data["result"] == {"channel": 2, "gain": 1.5}

        # Keyword-only parameters are filled like any other.
        data = await _execute(ac, "variadic", "integrate", {"seconds": "0.5", "mode": "area"})
        assert data["result"] == {"seconds": 0.5, "mode": "area"}

        # Async and **kwargs at once: awaited, not run in a thread, and the result is the value.
        data = await _execute(ac, "variadic", "acquire", {"frames": 3})
        assert data["result"] == {"options": {"frames": 3}}

        # Declared **kwargs arrive as the types the schema promised, from JSON strings.
        data = await _execute(ac, "variadic", "measure_declared",
                              {"wavelength_nm": "450", "slit_um": "20", "grating": "blazed_500"})
        assert data["status"] == "completed"
        assert data["result"]["options"] == {"slit_um": 20, "grating": "blazed_500"}
        assert data["result"]["types"] == ["int", "Grating"]


@pytest.mark.asyncio
async def test_a_star_only_method_run_with_an_argument_reports_the_error(variadic_deck):
    """Nothing filters it out on the way in, so the failure has to be legible in the Action Log
    rather than a silent no-op."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        data = await _execute(ac, "variadic", "calibrate", {"standards": [1, 2]})
        assert data["status"] == "error"
        assert "unexpected keyword argument" in data["error"]
