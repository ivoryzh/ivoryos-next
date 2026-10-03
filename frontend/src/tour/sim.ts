// The example lab's instruments, simulated in the page: a port of example/lab_drivers.py, the same
// Suzuki coupling (Arrhenius kinetics, a catalyst-loading optimum, mixing, Beer-Lambert UV-Vis), so
// a run in the tour gives the numbers the desktop app's "Try the example" gives. Keep it in step
// with that file. An instrument that is not one of these (one installed from the Hub in the tour)
// gets a stand-in that answers in the shape its schema declares.

/** Real milliseconds per simulated minute: lab_drivers.py's SIM_MINUTE_SECONDS, 0.02 s. */
const SIM_MINUTE_MS = 20;

const R_GAS = 8.314;
const K1_PREFACTOR = 4.0e7;
const K1_ACTIVATION = 60_000.0;
const K2_PREFACTOR = 6.0e11;
const K2_ACTIVATION = 95_000.0;

/** Seeded noise (mulberry32 + Box-Muller), so a tour behaves the same each visit. */
class Noise {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  private next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gauss(mean: number, sd: number): number {
    const u = Math.max(this.next(), 1e-12);
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
}

const round = (x: number, digits: number) => Number(x.toFixed(digits));

class ReactionState {
  charges: Record<string, number> = {};
  volumeMl = 0;
  temperatureC = 22;
  setpointC = 22;
  holdMinutes = 0;
  stirRpm = 0;
  substrateUnreacted = 0;
  inert = 0;
  product = 0;
  private poolOpen = false;

  reset() {
    Object.assign(this, { charges: {}, volumeMl: 0, temperatureC: 22, setpointC: 22, holdMinutes: 0, stirRpm: 0, substrateUnreacted: 0, inert: 0, product: 0 });
    this.poolOpen = false;
  }

  charge(role: string, moles: number, volumeMl: number) {
    this.charges[role] = (this.charges[role] || 0) + moles;
    this.volumeMl += volumeMl;
    this.poolOpen = false;
  }

  private limiting() { return this.charges.substrate || 0; }

  catalystLoadingMolPercent() {
    const s = this.limiting();
    return s <= 0 ? 0 : (100 * (this.charges.catalyst || 0)) / s;
  }

  boronicAcidEquivalents() {
    const s = this.limiting();
    return s <= 0 ? 0 : (this.charges.boronic_acid || 0) / s;
  }

  private openPool() {
    const reactive = Math.max(0, Math.min(1, 1 - Math.exp(-3 * (this.boronicAcidEquivalents() - 0.75))));
    this.substrateUnreacted = reactive;
    this.inert = 1 - reactive;
    this.product = 0;
    this.poolOpen = true;
  }

  advance(minutes: number) {
    if (minutes <= 0 || this.limiting() <= 0) { this.holdMinutes += Math.max(0, minutes); return; }
    if (!this.poolOpen) this.openPool();
    const loading = this.catalystLoadingMolPercent();
    const tempK = this.setpointC + 273.15;
    this.holdMinutes += minutes;
    if (loading <= 0 || tempK <= 0) return;
    const activity = loading / (loading + 1);
    const decomposition = 1 + 0.3 * loading;
    const mixing = this.stirRpm ? Math.min(1, 0.55 + (0.45 * this.stirRpm) / 500) : 0.55;
    const k1 = K1_PREFACTOR * Math.exp(-K1_ACTIVATION / (R_GAS * tempK)) * activity * mixing;
    const k2 = K2_PREFACTOR * Math.exp(-K2_ACTIVATION / (R_GAS * tempK)) * decomposition;
    const a0 = this.substrateUnreacted, p0 = this.product, t = minutes;
    this.substrateUnreacted = a0 * Math.exp(-k1 * t);
    this.product = Math.abs(k2 - k1) < 1e-12
      ? p0 * Math.exp(-k2 * t) + a0 * k1 * t * Math.exp(-k1 * t)
      : p0 * Math.exp(-k2 * t) + ((a0 * k1) / (k2 - k1)) * (Math.exp(-k1 * t) - Math.exp(-k2 * t));
  }

  yieldPercent() { return Math.max(0, Math.min(100, 100 * this.product)); }

  substrateRemainingPercent() {
    if (!this.poolOpen) return this.limiting() > 0 ? 100 : 0;
    return Math.max(0, Math.min(100, 100 * (this.substrateUnreacted + this.inert)));
  }

  productConcentrationM() {
    return this.volumeMl <= 0 ? 0 : (this.product * this.limiting()) / (this.volumeMl / 1000);
  }
}

/** What a simulated call returns, and how long it takes in the tour. */
export type SimOutcome = { result: unknown; ms: number };

type Method = (args: Record<string, unknown>) => SimOutcome;

const num = (v: unknown, fallback: number) => (v === undefined || v === null || v === '' ? fallback : Number(v));
const fail = (message: string): never => { throw new Error(message); };

/** One deck's instruments, sharing one vial as lab_drivers.py's do. */
export class SimulatedDeck {
  private reaction = new ReactionState();
  private noise = new Noise(20260912);
  private instruments = new Map<string, Record<string, Method>>();

  /** `cls` and `args` are the deck entry's; `schema` is used for an instrument this file does not know. */
  add(name: string, cls: string, args: Record<string, unknown> = {}, schema: Record<string, Record<string, unknown>> = {}) {
    const make = ({
      SyringePump: () => this.syringePump(args),
      HeaterStirrer: () => this.heaterStirrer(args),
      AnalyticalBalance: () => this.balance(),
      UVVisSpectrometer: () => this.uvVis(args),
      HPLC: () => this.hplc(),
    } as Record<string, () => Record<string, Method>>)[cls];
    this.instruments.set(name, make ? make() : this.standIn(schema));
  }

  has(name: string) { return this.instruments.has(name); }

  call(instrument: string, method: string, args: Record<string, unknown>): SimOutcome {
    const inst = this.instruments.get(instrument) ?? fail(`Instrument ${instrument} not found`);
    const fn = inst[method] ?? fail(`Method ${method} not found on ${instrument}`);
    return fn(args);
  }

  private syringePump(init: Record<string, unknown>): Record<string, Method> {
    const reagent = String(init.reagent ?? 'reagent');
    const role = String(init.role ?? 'substrate');
    const concentration = num(init.concentration_m, 0.5);
    const syringe = num(init.syringe_volume_ml, 10);
    let delivered = 0;
    const dispense: Method = a => {
      const volume = num(a.volume_ml, NaN), flow = num(a.flow_rate_ml_min, 2);
      if (!(volume > 0)) fail('volume_ml must be positive');
      if (volume > syringe) fail(`Requested ${volume} mL exceeds the ${syringe} mL syringe`);
      const moles = (volume / 1000) * concentration;
      this.reaction.charge(role, moles, volume);
      delivered += volume;
      return { result: { reagent, volume_ml: volume, moles, vial_volume_ml: round(this.reaction.volumeMl, 3) }, ms: (volume / Math.max(flow, 0.01)) * SIM_MINUTE_MS };
    };
    return {
      dispense,
      dispense_moles: a => dispense({ volume_ml: ((num(a.micromoles, 0) * 1e-6) / concentration) * 1000, flow_rate_ml_min: a.flow_rate_ml_min }),
      prime: a => ({ result: { reagent, cycles: num(a.cycles, 3), primed: true }, ms: num(a.cycles, 3) * 0.5 * SIM_MINUTE_MS }),
      read_volume_remaining: () => ({ result: round(Math.max(0, syringe - delivered), 3), ms: 0 }),
      refill: () => { delivered = 0; return { result: { reagent, volume_ml: syringe }, ms: 500 }; },
    };
  }

  private heaterStirrer(init: Record<string, unknown>): Record<string, Method> {
    const max = num(init.max_temperature_c, 150);
    const r = this.reaction;
    const read = () => r.temperatureC + this.noise.gauss(0, 0.15);
    return {
      load_vial: a => { r.reset(); return { result: { vial_id: String(a.vial_id ?? 'A1'), temperature_c: round(read(), 2) }, ms: 500 }; },
      set_temperature: a => {
        const setpoint = num(a.setpoint_c, NaN);
        if (setpoint > max) fail(`Setpoint ${setpoint} C exceeds the block limit of ${max} C`);
        const ms = (Math.abs(setpoint - r.temperatureC) / 5) * SIM_MINUTE_MS;
        r.setpointC = setpoint; r.temperatureC = setpoint;
        return { result: { setpoint_c: setpoint, temperature_c: round(read(), 2) }, ms };
      },
      set_stir_rate: a => { r.stirRpm = num(a.rpm, 400); return { result: { stir_rpm: r.stirRpm }, ms: 0 }; },
      hold: a => {
        const minutes = num(a.minutes, NaN);
        if (minutes < 0) fail('minutes must be non-negative');
        r.advance(minutes);
        return { result: { temperature_c: round(read(), 2), elapsed_min: r.holdMinutes }, ms: minutes * SIM_MINUTE_MS };
      },
      read_temperature: () => ({ result: read(), ms: 0 }),
      stir_rate: () => ({ result: r.stirRpm, ms: 0 }),
      'stir_rate_(setter)': a => { r.stirRpm = num(a.value ?? a.rpm, 0); return { result: null, ms: 0 }; },
      temperature: () => ({ result: read(), ms: 0 }),
      cool_down: a => {
        const target = num(a.target_c, 25);
        const ms = (Math.abs(r.temperatureC - target) / 3) * SIM_MINUTE_MS;
        r.temperatureC = target; r.setpointC = target;
        return { result: { temperature_c: round(read(), 2) }, ms };
      },
    };
  }

  private balance(): Record<string, Method> {
    return {
      tare: () => ({ result: { tare_g: 0 }, ms: 600 }),
      weigh: a => ({
        result: round(1.245 + this.reaction.volumeMl * 0.00098 + this.noise.gauss(0, 0.0001), 4),
        ms: Math.min(num(a.settle_seconds, 3), 3) * 200,
      }),
    };
  }

  private uvVis(init: Record<string, unknown>): Record<string, Method> {
    const path = num(init.path_length_cm, 1);
    let blanked = false;
    const at = (nm: number, dilution: number) => {
      const conc = this.reaction.productConcentrationM() / Math.max(dilution, 1);
      const band = Math.exp(-((nm - 312) ** 2) / (2 * 24 ** 2));
      return round(Math.max(0, 14_800 * conc * path * band), 4);
    };
    return {
      blank: () => { blanked = true; return { result: { blanked: true }, ms: 800 }; },
      measure_absorbance: a => {
        if (!blanked) fail('Spectrometer has not been blanked');
        const value = at(num(a.wavelength_nm, 312), num(a.dilution_factor, 1000)) + this.noise.gauss(0, 0.002);
        return { result: round(Math.max(0, value), 4), ms: 500 };
      },
      collect_spectrum: a => {
        if (!blanked) fail('Spectrometer has not been blanked');
        const start = num(a.start_nm, 260), end = num(a.end_nm, 450), step = num(a.step_nm, 2), dilution = num(a.dilution_factor, 1000);
        const wavelength_nm: number[] = [], absorbance: number[] = [];
        for (let nm = start; nm <= end && wavelength_nm.length < 2000; nm += step) {
          wavelength_nm.push(round(nm, 1));
          absorbance.push(at(nm, dilution));
        }
        const peak = absorbance.length ? wavelength_nm[absorbance.indexOf(Math.max(...absorbance))] : null;
        return { result: { wavelength_nm, absorbance, peak_nm: peak }, ms: 1200 };
      },
    };
  }

  private hplc(): Record<string, Method> {
    let injections = 0;
    let lastMethod = 'fast_gradient';
    const runtimes: Record<string, number> = { fast_gradient: 4, standard_gradient: 12, isocratic: 8 };
    const r = this.reaction;
    return {
      inject: a => {
        const method = String(a.method ?? 'fast_gradient');
        const runtime = runtimes[method] ?? fail(`'${method}' is not one of fast_gradient, standard_gradient, isocratic`);
        injections += 1; lastMethod = method;
        return { result: { injection: injections, method, runtime_min: runtime }, ms: runtime * SIM_MINUTE_MS };
      },
      measure_yield: () => ({ result: round(Math.max(0, Math.min(100, r.yieldPercent() + this.noise.gauss(0, 0.4))), 2), ms: 0 }),
      analyze: () => {
        const product = r.yieldPercent(), remaining = r.substrateRemainingPercent();
        const impurities = Math.max(0, 100 - product - remaining);
        return {
          result: {
            composition: {
              yield_percent: round(product, 2),
              substrate_remaining_percent: round(remaining, 2),
              impurities_percent: round(impurities, 2),
              purity_percent: round((100 * product) / Math.max(product + impurities, 1e-6), 2),
            },
            catalyst_mol_percent: round(r.catalystLoadingMolPercent(), 3),
            boronic_acid_equivalents: round(r.boronicAcidEquivalents(), 2),
            reaction_time_min: r.holdMinutes,
            method: lastMethod,
          },
          ms: 500,
        };
      },
    };
  }

  /**
   * An instrument the tour has no model of (a driver from the Hub): every method its schema lists
   * answers in the shape it declares, so a step's output, a return binding and a condition on it
   * all work. The values are stand-ins, not readings.
   */
  private standIn(schema: Record<string, Record<string, unknown>>): Record<string, Method> {
    // What was set, by name, so `set_target_temperature(40)` then `target_temperature` (or
    // `get_target_temperature`) reads back 40, and a property setter feeds its getter.
    const settings = new Map<string, unknown>();
    const methods: Record<string, Method> = {};
    for (const [name, def] of Object.entries(schema)) {
      const d = def as { return_type?: unknown; return_info?: unknown };
      const sets = /^set_(.+)$/.exec(name)?.[1] ?? /^(.+)_\(setter\)$/.exec(name)?.[1];
      const reads = name.replace(/^get_/, '');
      methods[name] = args => {
        const given = Object.values(args);
        if (sets && given.length) settings.set(sets, given[0]);
        return { result: !sets && settings.has(reads) ? settings.get(reads) : this.standInValue(d.return_info, d.return_type), ms: 400 };
      };
    }
    return methods;
  }

  /** A value of the declared type: `return_info` when it has fields, else the type's name. */
  private standInValue(info: unknown, typeName?: unknown, depth = 0): unknown {
    const fields = (info as { fields?: Record<string, { type?: unknown }> } | null)?.fields;
    if (fields && typeof fields === 'object' && depth < 4) {
      return Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, this.standInValue(f, f?.type, depth + 1)]));
    }
    switch (baseType(typeName ?? (info as { type?: unknown } | null)?.type)) {
      case 'float': return round(Math.abs(this.noise.gauss(50, 15)), 3);
      case 'int': return Math.round(Math.abs(this.noise.gauss(50, 15)));
      case 'bool': return true;
      case 'str': return 'ok';
      case 'list': return [];
      case 'dict': return {};
      default: return null; // None, Any, or a class the tour cannot make
    }
  }
}

/**
 * The plain type behind an introspected type name, as drivers on the Hub write them:
 * `float`, `<class 'float'>`, `Optional[float]`, `Union[int, str]`, `typing.List[str]`, `list[str]`.
 */
function baseType(raw: unknown): string {
  let t = String(raw ?? '').trim();
  t = t.replace(/^<class '([^']+)'>$/, '$1').replace(/^(?:typing\.|builtins\.)/, '');
  const wrapped = /^(?:Optional|Union)\[(.*)\]$/.exec(t);
  if (wrapped) t = wrapped[1].split(',')[0].trim().replace(/^(?:typing\.|builtins\.)/, '');
  const lower = t.toLowerCase();
  if (/^(float|double|number|decimal)\b/.test(lower)) return 'float';
  if (/^int\b/.test(lower)) return 'int';
  if (/^bool\b/.test(lower)) return 'bool';
  if (/^str\b/.test(lower)) return 'str';
  if (/^(list|tuple|set|sequence)\b/.test(lower)) return 'list';
  if (/^(dict|mapping)\b/.test(lower)) return 'dict';
  return '';
}
