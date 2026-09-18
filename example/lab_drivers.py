"""Simulated instruments for a small self-driving lab.

The deck models a Suzuki-Miyaura cross-coupling screen: three syringe pumps charge a
vial with substrate, boronic acid and Pd catalyst, a heater-stirrer holds the vial at a
setpoint, and HPLC / UV-Vis read out how much product formed.

These are simulations, not hardware drivers, but they are not decorative: every
instrument reads and writes one shared reaction state, and each hold on the heater
integrates the textbook consecutive-reaction kinetics A --k1--> P --k2--> D with
Arrhenius rate constants. The analytics then report whatever that integration left in
the vial. Yield responds to temperature, catalyst loading, reaction time
and stoichiometry the way a real screen would -- there is a genuine interior optimum
(~65-70 C, ~2.5 mol% Pd) for an optimizer to find, and pushing the temperature up
burns the product rather than making more of it.

Wall-clock time is compressed by SIM_MINUTE_SECONDS so a two-hour hold finishes in a
couple of seconds.
"""

import math
import random
import time
from typing import Literal

# One simulated minute costs this many real seconds. A 120 min hold -> ~2.4 s.
SIM_MINUTE_SECONDS = 0.02

R_GAS = 8.314  # J / (mol K)

# Arrhenius parameters. Product formation (k1) has the lower barrier; the
# over-reaction / decomposition path (k2) has the higher one, so selectivity falls
# away as the reactor gets hotter.
K1_PREFACTOR = 4.0e7      # 1/min
K1_ACTIVATION = 60_000.0  # J/mol
K2_PREFACTOR = 6.0e11     # 1/min
K2_ACTIVATION = 95_000.0  # J/mol

_noise = random.Random(20260912)


class _ReactionState:
    """Shared latent state of the vial on the heater. Not an instrument -- the drivers
    below are the only things that touch it.

    Conversion is integrated as it happens, inside each hold, rather than recomputed from
    the current setpoint at readout: the vial has usually been cooled by the time anything
    is measured, and a hold at 90 C followed by one at 60 C is not the same experiment as
    either one alone.
    """

    def __init__(self):
        self.reset()

    def reset(self):
        self.charges = {}          # reagent role -> moles delivered
        self.volume_ml = 0.0
        self.temperature_c = 22.0
        self.setpoint_c = 22.0
        self.hold_minutes = 0.0
        self.stir_rpm = 0
        # Fractions of the substrate charge. The boronic-acid-limited remainder is inert.
        self.substrate_unreacted = 0.0
        self.inert = 0.0
        self.product = 0.0
        self._pool_open = False

    def charge(self, reagent: str, moles: float, volume_ml: float):
        self.charges[reagent] = self.charges.get(reagent, 0.0) + moles
        self.volume_ml += volume_ml
        self._pool_open = False  # re-open the pool: stoichiometry has changed

    def _limiting_moles(self) -> float:
        return self.charges.get("substrate", 0.0)

    def catalyst_loading_mol_percent(self) -> float:
        substrate = self._limiting_moles()
        if substrate <= 0:
            return 0.0
        return 100.0 * self.charges.get("catalyst", 0.0) / substrate

    def boronic_acid_equivalents(self) -> float:
        substrate = self._limiting_moles()
        if substrate <= 0:
            return 0.0
        return self.charges.get("boronic_acid", 0.0) / substrate

    def _open_pool(self):
        """Fix how much of the substrate charge can couple at all, given the boronic acid
        available. Below one equivalent the coupling is stoichiometrically capped; excess
        helps a little and then plateaus."""
        equivalents = self.boronic_acid_equivalents()
        reactive = max(0.0, min(1.0, 1.0 - math.exp(-3.0 * (equivalents - 0.75))))
        self.substrate_unreacted = reactive
        self.inert = 1.0 - reactive
        self.product = 0.0
        self._pool_open = True

    def advance(self, minutes: float):
        """Integrate A --k1--> P --k2--> D over a hold at the current setpoint."""
        if minutes <= 0 or self._limiting_moles() <= 0:
            self.hold_minutes += max(0.0, minutes)
            return
        if not self._pool_open:
            self._open_pool()

        loading = self.catalyst_loading_mol_percent()
        temp_k = self.setpoint_c + 273.15
        self.hold_minutes += minutes
        if loading <= 0 or temp_k <= 0:
            return

        # Catalyst saturates on the productive path and accelerates decomposition
        # (Pd black), which is what puts an interior optimum on loading.
        catalyst_activity = loading / (loading + 1.0)
        decomposition_factor = 1.0 + 0.30 * loading
        # A biphasic coupling needs vigorous mixing to reach its intrinsic rate.
        mixing = min(1.0, 0.55 + 0.45 * self.stir_rpm / 500.0) if self.stir_rpm else 0.55

        k1 = K1_PREFACTOR * math.exp(-K1_ACTIVATION / (R_GAS * temp_k)) * catalyst_activity * mixing
        k2 = K2_PREFACTOR * math.exp(-K2_ACTIVATION / (R_GAS * temp_k)) * decomposition_factor

        a0, p0, t = self.substrate_unreacted, self.product, minutes
        self.substrate_unreacted = a0 * math.exp(-k1 * t)
        if abs(k2 - k1) < 1e-12:
            self.product = p0 * math.exp(-k2 * t) + a0 * k1 * t * math.exp(-k1 * t)
        else:
            self.product = p0 * math.exp(-k2 * t) + a0 * k1 / (k2 - k1) * (
                math.exp(-k1 * t) - math.exp(-k2 * t)
            )

    def product_yield_percent(self) -> float:
        """Product as a percentage of the substrate charged."""
        return max(0.0, min(100.0, 100.0 * self.product))

    def substrate_remaining_percent(self) -> float:
        if not self._pool_open:
            return 100.0 if self._limiting_moles() > 0 else 0.0
        return max(0.0, min(100.0, 100.0 * (self.substrate_unreacted + self.inert)))

    def product_concentration_m(self) -> float:
        if self.volume_ml <= 0:
            return 0.0
        return self.product * self._limiting_moles() / (self.volume_ml / 1000.0)


_reaction = _ReactionState()


class SyringePump:
    """Syringe pump delivering one reagent stock solution into the reaction vial."""

    def __init__(self, reagent: str, role: str, concentration_m: float, syringe_volume_ml: float = 10.0):
        self.reagent = reagent
        self.role = role  # substrate | boronic_acid | catalyst
        self.concentration_m = concentration_m
        self.syringe_volume_ml = syringe_volume_ml
        self.delivered_ml = 0.0

    def dispense(self, volume_ml: float, flow_rate_ml_min: float = 2.0) -> dict:
        """Deliver a volume of this pump's stock solution into the reaction vial."""
        if volume_ml <= 0:
            raise ValueError("volume_ml must be positive")
        if volume_ml > self.syringe_volume_ml:
            raise ValueError(
                f"Requested {volume_ml} mL exceeds the {self.syringe_volume_ml} mL syringe"
            )
        duration_min = volume_ml / max(flow_rate_ml_min, 0.01)
        print(f"[{self.reagent}] Dispensing {volume_ml:.3f} mL at {flow_rate_ml_min:.2f} mL/min")
        time.sleep(duration_min * SIM_MINUTE_SECONDS)

        moles = volume_ml / 1000.0 * self.concentration_m
        _reaction.charge(self.role, moles, volume_ml)
        self.delivered_ml += volume_ml
        return {
            "reagent": self.reagent,
            "volume_ml": volume_ml,
            "moles": moles,
            "vial_volume_ml": round(_reaction.volume_ml, 3),
        }

    def dispense_moles(self, micromoles: float, flow_rate_ml_min: float = 2.0) -> dict:
        """Deliver a target amount of reagent, converting to volume via the stock concentration."""
        volume_ml = micromoles * 1e-6 / self.concentration_m * 1000.0
        return self.dispense(volume_ml, flow_rate_ml_min)

    def prime(self, cycles: int = 3) -> dict:
        """Flush air out of the line before the first dispense of a campaign."""
        print(f"[{self.reagent}] Priming line, {cycles} cycles")
        time.sleep(cycles * 0.5 * SIM_MINUTE_SECONDS)
        return {"reagent": self.reagent, "cycles": cycles, "primed": True}

    def read_volume_remaining(self) -> float:
        """Stock left in the syringe, in mL."""
        return round(max(0.0, self.syringe_volume_ml - self.delivered_ml), 3)

    def refill(self) -> dict:
        """Draw the syringe back up to full from the reservoir."""
        print(f"[{self.reagent}] Refilling syringe to {self.syringe_volume_ml} mL")
        time.sleep(0.5)
        self.delivered_ml = 0.0
        return {"reagent": self.reagent, "volume_ml": self.syringe_volume_ml}


class HeaterStirrer:
    """Heated, magnetically stirred reaction block holding the vial."""

    def __init__(self, max_temperature_c: float = 150.0):
        self.max_temperature_c = max_temperature_c

    def load_vial(self, vial_id: str = "A1") -> dict:
        """Seat a fresh, empty vial in the block.

        This starts a new experiment: whatever was charged and converted before is gone,
        so call it first in every run or a second run will build on the first one's
        contents."""
        print(f"[Reactor] Loading fresh vial {vial_id}")
        time.sleep(0.5)
        _reaction.reset()
        return {"vial_id": vial_id, "temperature_c": round(self.read_temperature(), 2)}

    def set_temperature(self, setpoint_c: float) -> dict:
        """Set the block setpoint. The vial ramps toward it at roughly 5 C/min."""
        if setpoint_c > self.max_temperature_c:
            raise ValueError(
                f"Setpoint {setpoint_c} C exceeds the block limit of {self.max_temperature_c} C"
            )
        ramp_min = abs(setpoint_c - _reaction.temperature_c) / 5.0
        print(f"[Reactor] Ramping {_reaction.temperature_c:.1f} -> {setpoint_c:.1f} C")
        time.sleep(ramp_min * SIM_MINUTE_SECONDS)
        _reaction.setpoint_c = setpoint_c
        _reaction.temperature_c = setpoint_c
        return {"setpoint_c": setpoint_c, "temperature_c": round(self.read_temperature(), 2)}

    def set_stir_rate(self, rpm: int = 400) -> dict:
        """Set the stir rate. Biphasic couplings need vigorous mixing to reach full conversion."""
        print(f"[Reactor] Stirring at {rpm} rpm")
        _reaction.stir_rpm = rpm
        return {"stir_rpm": rpm}

    def hold(self, minutes: float) -> dict:
        """Hold at the current setpoint for the reaction time. This is what advances the chemistry."""
        if minutes < 0:
            raise ValueError("minutes must be non-negative")
        print(f"[Reactor] Holding {_reaction.setpoint_c:.1f} C for {minutes:.1f} min")
        time.sleep(minutes * SIM_MINUTE_SECONDS)
        _reaction.advance(minutes)
        return {
            "temperature_c": round(self.read_temperature(), 2),
            "elapsed_min": _reaction.hold_minutes,
        }

    def read_temperature(self) -> float:
        """Internal vial temperature in C, as read by the probe."""
        return _reaction.temperature_c + _noise.gauss(0.0, 0.15)

    # Real drivers routinely expose a setting as a property rather than a method, so the demo
    # deck has one too -- the designer should offer `reactor.stir_rate` as a readable step and
    # `stir_rate_(setter)` as a writable one, exactly like a get_/set_ pair.
    @property
    def stir_rate(self) -> int:
        """Current stir rate in rpm."""
        return _reaction.stir_rpm

    @stir_rate.setter
    def stir_rate(self, rpm: int):
        print(f"[Reactor] Stirring at {rpm} rpm")
        _reaction.stir_rpm = rpm

    @property
    def temperature(self) -> float:
        """Internal vial temperature in C. Read-only: use set_temperature so the vial ramps
        at a believable rate instead of jumping."""
        return self.read_temperature()

    def cool_down(self, target_c: float = 25.0) -> dict:
        """Quench the heat and let the vial cool before sampling."""
        ramp_min = abs(_reaction.temperature_c - target_c) / 3.0
        print(f"[Reactor] Cooling to {target_c:.1f} C")
        time.sleep(ramp_min * SIM_MINUTE_SECONDS)
        _reaction.temperature_c = target_c
        _reaction.setpoint_c = target_c
        return {"temperature_c": round(self.read_temperature(), 2)}


class VialHandler:
    """Four-axis gantry moving capped vials between deck stations."""

    STATIONS = ("rack", "reactor", "hplc", "balance", "waste")

    def __init__(self):
        self.position = "home"
        self.held_vial = None

    def pick_vial(self, vial_id: str, station: Literal["rack", "reactor", "hplc", "balance"] = "rack") -> dict:
        """Pick a vial from a deck station."""
        if self.held_vial is not None:
            raise RuntimeError(f"Gripper already holding {self.held_vial}")
        print(f"[Handler] Picking {vial_id} from {station}")
        time.sleep(0.4)
        self.held_vial = vial_id
        self.position = station
        return {"vial_id": vial_id, "station": station}

    def place_vial(self, station: Literal["rack", "reactor", "hplc", "balance", "waste"] = "reactor") -> dict:
        """Place the held vial at a deck station."""
        if self.held_vial is None:
            raise RuntimeError("Gripper is empty")
        print(f"[Handler] Placing {self.held_vial} at {station}")
        time.sleep(0.4)
        vial_id, self.held_vial = self.held_vial, None
        self.position = station
        return {"vial_id": vial_id, "station": station}

    def transfer_vial(
        self,
        vial_id: str,
        source: Literal["rack", "reactor", "hplc", "balance"] = "rack",
        destination: Literal["rack", "reactor", "hplc", "balance", "waste"] = "reactor",
    ) -> dict:
        """Move a vial from one station to another in a single motion."""
        self.pick_vial(vial_id, source)
        return self.place_vial(destination)

    def home(self) -> dict:
        """Return the gantry to its home position."""
        print("[Handler] Homing")
        time.sleep(0.5)
        self.position = "home"
        return {"position": self.position}


class AnalyticalBalance:
    """Enclosed analytical balance, 0.1 mg readability."""

    def __init__(self):
        self.tare_g = 0.0

    def tare(self) -> dict:
        """Zero the balance with the current load on the pan."""
        print("[Balance] Taring")
        time.sleep(0.6)
        self.tare_g = 0.0
        return {"tare_g": 0.0}

    def weigh(self, settle_seconds: float = 3.0) -> float:
        """Read the stable mass in grams once the reading settles."""
        time.sleep(min(settle_seconds, 3.0) * 0.2)
        mass = 1.2450 + _reaction.volume_ml * 0.00098 + _noise.gauss(0.0, 0.0001)  # tared vial + dioxane
        print(f"[Balance] {mass:.4f} g")
        return round(mass, 4)


class UVVisSpectrometer:
    """UV-Vis spectrometer for a fast read on product formation, ahead of the HPLC."""

    MOLAR_ABSORPTIVITY = 14_800  # L / (mol cm), product band at 312 nm

    def __init__(self, path_length_cm: float = 1.0):
        self.path_length_cm = path_length_cm
        self.blanked = False

    def blank(self) -> dict:
        """Record a solvent blank. Absorbance readings are referenced to this."""
        print("[UV-Vis] Recording solvent blank")
        time.sleep(0.8)
        self.blanked = True
        return {"blanked": True}

    def measure_absorbance(self, wavelength_nm: float = 312.0, dilution_factor: float = 1000.0) -> float:
        """Absorbance of a diluted aliquot at one wavelength.

        The biaryl product absorbs near 312 nm. Neat reaction mixture is far off-scale, so
        the aliquot is diluted (1:1000 by default) to land inside the linear range."""
        if not self.blanked:
            raise RuntimeError("Spectrometer has not been blanked")
        time.sleep(0.5)
        absorbance = self._absorbance_at(wavelength_nm, dilution_factor) + _noise.gauss(0.0, 0.002)
        print(f"[UV-Vis] A({wavelength_nm:.0f} nm) = {absorbance:.4f}")
        return round(max(0.0, absorbance), 4)

    def collect_spectrum(
        self,
        start_nm: float = 260.0,
        end_nm: float = 450.0,
        step_nm: float = 2.0,
        dilution_factor: float = 1000.0,
    ) -> dict:
        """Sweep a wavelength range and return the full absorbance trace."""
        if not self.blanked:
            raise RuntimeError("Spectrometer has not been blanked")
        print(f"[UV-Vis] Scanning {start_nm:.0f}-{end_nm:.0f} nm")
        time.sleep(1.2)
        wavelengths, absorbances = [], []
        nm = start_nm
        while nm <= end_nm:
            wavelengths.append(round(nm, 1))
            absorbances.append(self._absorbance_at(nm, dilution_factor))
            nm += step_nm
        peak = wavelengths[absorbances.index(max(absorbances))] if absorbances else None
        return {"wavelength_nm": wavelengths, "absorbance": absorbances, "peak_nm": peak}

    def _absorbance_at(self, wavelength_nm: float, dilution_factor: float) -> float:
        """Beer-Lambert on the product band, with a broad Gaussian line shape."""
        conc_m = _reaction.product_concentration_m() / max(dilution_factor, 1.0)
        band = math.exp(-((wavelength_nm - 312.0) ** 2) / (2 * 24.0 ** 2))
        return round(max(0.0, self.MOLAR_ABSORPTIVITY * conc_m * self.path_length_cm * band), 4)


class HPLC:
    """Reverse-phase HPLC-UV with an autosampler, calibrated against an internal standard."""

    def __init__(self):
        self.injections = 0

    def inject(
        self,
        sample_volume_ul: float = 5.0,
        method: Literal["fast_gradient", "standard_gradient", "isocratic"] = "fast_gradient",
    ) -> dict:
        """Draw an aliquot from the vial and run a separation."""
        runtimes = {"fast_gradient": 4.0, "standard_gradient": 12.0, "isocratic": 8.0}
        runtime_min = runtimes[method]
        print(f"[HPLC] Injecting {sample_volume_ul:.1f} uL, {method} ({runtime_min:.0f} min)")
        time.sleep(runtime_min * SIM_MINUTE_SECONDS)
        self.injections += 1
        return {"injection": self.injections, "method": method, "runtime_min": runtime_min}

    def measure_yield(self) -> float:
        """Assay yield of the coupled product as a percentage of the limiting substrate.

        This is the objective an optimizer should maximise."""
        value = _reaction.product_yield_percent() + _noise.gauss(0.0, 0.4)
        value = round(max(0.0, min(100.0, value)), 2)
        print(f"[HPLC] Assay yield {value:.2f} %")
        return value

    def analyze(self) -> dict:
        """Full peak table: product yield, unreacted substrate and the impurity balance."""
        time.sleep(0.5)
        product = _reaction.product_yield_percent()
        remaining = _reaction.substrate_remaining_percent()
        impurities = max(0.0, 100.0 - product - remaining)
        return {
            "yield_percent": round(product, 2),
            "substrate_remaining_percent": round(remaining, 2),
            "impurities_percent": round(impurities, 2),
            "purity_percent": round(100.0 * product / max(product + impurities, 1e-6), 2),
            "catalyst_mol_percent": round(_reaction.catalyst_loading_mol_percent(), 3),
            "boronic_acid_equivalents": round(_reaction.boronic_acid_equivalents(), 2),
            "reaction_time_min": _reaction.hold_minutes,
        }


class ReactionVialWasher:
    """Wash station that empties and rinses the vial between experiments."""

    def __init__(self, solvent: str = "acetone"):
        self.solvent = solvent
        self.cycles_run = 0

    def wash(self, cycles: int = 2, dry: bool = True) -> dict:
        """Rinse the vial and reset the deck for the next experiment.

        Clears the reaction state, so call this between runs in a campaign."""
        print(f"[Washer] {cycles}x {self.solvent} rinse" + (", drying under N2" if dry else ""))
        time.sleep(cycles * 0.6 + (0.8 if dry else 0.0))
        self.cycles_run += cycles
        _reaction.reset()
        return {"cycles": cycles, "dried": dry, "solvent": self.solvent}
