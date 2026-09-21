"""Every signature shape a driver can have, in two instruments.

The deck talks to drivers through one narrow door: introspection reads
`inspect.signature()` into a schema, a step stores *named* arguments, and execution calls
`method(**args)`. Most signatures fit that door. These are the ones that do not, each one
isolated so you can place it in the Designer, run it, and read back exactly what arrived:

    IVORYOS_DEMO_TEST_DRIVERS=1 python example/demo.py

Every method returns what it actually received, so "what does the schema say" and "what does
the driver get" can be compared without a debugger. The rules they demonstrate:

- `*args` and `**kwargs` are **not parameters**. They are dropped from the schema, keyed on
  `param.kind` and never on the name, because neither is an argument a caller can name.
- a `**kwargs` method carries `accepts_kwargs: true` instead, which is what lets the agent
  validator treat an argument the schema cannot list as real rather than as a typo.
- keyword-only parameters (after `*` or after `*args`) *are* ordinary parameters — the `*` in
  front of them is not what makes something variadic.
- a positional-only parameter (before `/`) is real too, but cannot be passed by name, so
  `resolve_callable` binds it by position at call time.
- a compiled entry point has no signature at all, and is described as "parameters unknown"
  rather than dropped.
- a `**kwargs` a driver *declares* (`**options: Unpack[SomeTypedDict]`, PEP 692) stops being
  un-enumerable: each key becomes an ordinary typed parameter, and `accepts_kwargs` goes back
  to false because an argument outside the declared set is a typo again.

`tests/automated/test_variadic_parameters.py` asserts all of it against these same classes.
"""

import asyncio
import functools
import zlib
from enum import Enum

try:  # Python 3.11+
    from typing import NotRequired, TypedDict, Unpack
except ImportError:  # 3.10 and older — the same objects, one package earlier
    from typing_extensions import NotRequired, TypedDict, Unpack


class Grating(Enum):
    BLAZED_500 = "blazed_500"
    BLAZED_1200 = "blazed_1200"


class LampOptions(TypedDict):
    """What `**options` actually accepts — the vendor's documented settings, written down.

    A `TypedDict` behind `Unpack` is Python's own way (PEP 692) of saying what a `**kwargs`
    takes. Each key here becomes an ordinary parameter in the schema — typed, with a dropdown
    where the type has one, checked for typos — instead of a free-text row the scientist has to
    know the spelling of.
    """

    slit_um: int
    grating: NotRequired[Grating]
    lamp_on: NotRequired[bool]


class VariadicProbe:
    """A spectrometer whose vendor SDK takes options this deck cannot enumerate.

    Every method records its call into `last_call` and returns it, so a manual run from the
    Instruments page shows precisely which arguments survived the trip.
    """

    def __init__(self):
        self.last_call = {}

    def _record(self, **what):
        self.last_call = what
        return what

    # --- the plain case, for comparison -------------------------------------------------
    def blank(self):
        """No parameters at all. The schema says `parameters: {}` — same as a `**kwargs`-only
        method — but `accepts_kwargs` is false, so sending anything is an error, not a
        forward."""
        return self._record()

    # --- ** is not a parameter ------------------------------------------------------------
    def measure(self, wavelength_nm: float, **vendor_options):
        """Named parameter plus `**vendor_options`.

        The schema lists `wavelength_nm` and nothing else. Anything else the caller sends is
        forwarded into `vendor_options` — legitimate, un-listable, and not a typo.
        """
        return self._record(wavelength_nm=wavelength_nm, vendor_options=vendor_options)

    def configure(self, **settings):
        """`**` only: no parameters in the schema, and calling it with none is exactly what
        works. Before variadics were excluded it showed one required parameter called
        "settings", and filling it landed a key literally named `settings` in here."""
        return self._record(settings=settings)

    # --- * is not a parameter either, and is not the same as ** --------------------------
    def calibrate(self, *standards):
        """`*` only. Takes no keyword arguments at all, so `accepts_kwargs` is false — the deck
        can call it, with nothing, and that is the whole of what it can do. Naming it
        (`calibrate(standards=[...])`) is a TypeError, which is why it is not offered."""
        return self._record(standards=standards)

    def scan(self, *ranges, **options):
        """Both. No parameters listed, `accepts_kwargs: true` — keywords reach `options`, and
        `ranges` stays empty because a step has no way to send positional arguments."""
        return self._record(ranges=ranges, options=options)

    # --- a star does not make its neighbours variadic --------------------------------------
    def integrate(self, *, seconds: float, mode: str = "peak"):
        """Keyword-only parameters, written after a bare `*`. These are ordinary parameters:
        `seconds` is required and listed, `mode` has a default. An implementation that
        excluded anything following a `*` would wrongly drop both."""
        return self._record(seconds=seconds, mode=mode)

    def average(self, *scans, discard_first: bool = True):
        """Keyword-only *after* `*scans`: `scans` is dropped, `discard_first` is kept with its
        default. The two live in the same signature precisely so they cannot be conflated."""
        return self._record(scans=scans, discard_first=discard_first)

    # --- named, but not nameable ----------------------------------------------------------
    def read_channel(self, channel: int, /, gain: float = 1.0):
        """A positional-only parameter, the shape a wrapped C driver usually has.

        `channel` has to be supplied and is listed like any other parameter, with
        `positional: true` — because `read_channel(channel=1)` raises TypeError, and every
        call site invokes `method(**args)`. `resolve_callable` pulls it back out and passes it
        by position, and the Python preview renders it without a keyword.
        """
        return self._record(channel=channel, gain=gain)

    # --- what the caller sends is text; what the method wants may not be ------------------
    def tune(self, base_nm: float, **offsets: float):
        """An annotated `**offsets`. A form sends JSON, so an offset arrives as the string
        "2.5"; the annotation on the `**` is what lets it be cast to 2.5 before the call, the
        same as a named parameter. Values are returned as-is so their types are visible."""
        return self._record(base_nm=base_nm, offsets=offsets, types=[type(v).__name__ for v in offsets.values()])

    # --- the same **, with the options written down --------------------------------------
    def measure_declared(self, wavelength_nm: float, **options: Unpack[LampOptions]):
        """`measure` again, with its `**options` declared as a TypedDict.

        The difference is everything the UI can do about it: `slit_um` is a required int field,
        `grating` is a dropdown of the enum's values, `lamp_on` is True/False, each one is cast
        before the call, and a misspelled option is reported as a typo instead of forwarded.
        Compare the empty form on `configure` — same `**`, nothing declared, nothing to render.
        """
        return self._record(
            wavelength_nm=wavelength_nm,
            options=options,
            types=[type(v).__name__ for v in options.values()],
        )

    # --- async is orthogonal to all of it --------------------------------------------------
    async def acquire(self, **options):
        """Async and `**kwargs` at once: `is_coroutine` and `accepts_kwargs` are independent
        flags, and the queue has to keep awaiting this one rather than running it in a thread."""
        await asyncio.sleep(0)
        return self._record(options=options)


def _forwarding(func):
    """A decorator that forgets what it wrapped — the common mistake."""
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)
    return wrapper


def _forwarding_wraps(func):
    """The same decorator done properly. `functools.wraps` copies `__wrapped__`, which
    `inspect.signature` follows."""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)
    return wrapper


def _vendor_entry_point(**settings):
    """Send a raw command to the instrument firmware.

    Stands in for a compiled entry point — a ctypes/pybind11 binding into the vendor's DLL.
    Those are real callables with no signature Python can read, which is the case being
    demonstrated; the `__signature__` below is the only way to reproduce that in a pure-Python
    demo. It takes keyword arguments, so the Extra arguments rows on its card actually reach it.
    """
    return {"forwarded": settings}


# inspect.signature() raises TypeError on a `__signature__` that is not a Signature, which is
# the same door the ValueError from a real builtin comes through.
_vendor_entry_point.__signature__ = "<vendor entry point>"


class VendorBridge:
    """Methods whose signature is hidden rather than variadic — decorators and compiled code.

    A decorator that forgets `functools.wraps` is the ordinary case of this and is recovered
    (`send`); two of them stacked is where the recovery gives up (`send_double_wrapped`).

    The schema has no way to tell "takes anything" from "we cannot see what it takes", and
    should not pretend otherwise: both end up with no parameters and `accepts_kwargs: true`, so
    a caller can still send what the vendor's manual says. The unreadable one is additionally
    marked `signature_unavailable`, because that flag is a guess rather than something the
    signature promised, and the UI says as much.

    The limit of the guess, worth knowing before wiring up a compiled driver: this deck calls
    every method as `method(**args)`, so a C function that takes *only positional* arguments
    cannot be driven from here at all — `min(x=1)` answers "min expected at least 1 argument,
    got 0" no matter what is typed into the form. `checksum` below is the version of that story
    with a happy ending: its signature *is* readable, so its positional-only parameters are
    listed like any others and bound by position at call time.
    """

    def __init__(self):
        self.last_call = {}

    @_forwarding
    def send(self, command: str, timeout_s: float = 5.0):
        """Wrapped without `functools.wraps` — the most common introspection failure there is.

        What `inspect.signature` is handed is the wrapper's own `(*args, **kwargs)`, which
        published "no parameters, accepts anything" for a method that takes exactly two named
        ones: the form offered free-text rows, and every argument typed into them came back as
        "unexpected keyword argument" from the function underneath.

        Introspection now recovers this one from the wrapper's closure — see
        `_unwrapped_for_description` — so it shows `command` and `timeout_s` like any other
        method, and this docstring is visible at all. The call still goes through the wrapper.
        """
        self.last_call = {"command": command, "timeout_s": timeout_s}
        return self.last_call

    @_forwarding
    @_forwarding
    def send_double_wrapped(self, command: str, timeout_s: float = 5.0):
        """Two decorators deep, neither using `functools.wraps` — where the recovery stops.

        The outer wrapper's closure holds the inner *wrapper*, not this function, so the name no
        longer matches and the guess is refused rather than risked on whatever happens to be in
        the closure. The result is the old behaviour, which is the honest fallback: no
        parameters, `accepts_kwargs`, and free-text rows.
        """
        self.last_call = {"command": command, "timeout_s": timeout_s}
        return self.last_call

    @_forwarding_wraps
    def send_checked(self, command: str, timeout_s: float = 5.0):
        """The same method, wrapped with `functools.wraps`: `command` and `timeout_s` are
        listed exactly as if the decorator were not there."""
        self.last_call = {"command": command, "timeout_s": timeout_s}
        return self.last_call

    # A compiled entry point, whose signature cannot be read. It is still a method the
    # instrument offers, so it is described with parameters unknown rather than dropped from the
    # deck in silence — see _vendor_entry_point.
    send_raw = staticmethod(_vendor_entry_point)

    # A C function with genuine positional-only parameters — `(data, value=0, /)`. Not a
    # contrived example: this is what wrapping a compiled library normally looks like, and
    # calling it by keyword is a TypeError.
    checksum = staticmethod(zlib.crc32)
