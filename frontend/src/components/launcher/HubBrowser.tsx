"use client";
import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowLeft, Bot, Camera, CheckCircle2, Cpu, Droplets, ExternalLink, FlaskConical, FlaskRound, Gauge,
  GraduationCap, LayoutGrid, Loader2, Lock, Microscope, Package, Scale, Search, Syringe, Thermometer, Wind, type LucideIcon,
} from 'lucide-react';
import { confirmDialog, notify } from '@ivoryos/shared-ui';
import type { ArgDef, DesktopApi, HubModule } from '@/desktop';
import { toForm, type FormValues } from '@/launcherArgs';
import ArgsForm from './ArgsForm';
import PrivateRepos, { type InstrumentSeed } from './PrivateRepos';
import { Button, Field, Modal, inputClass, labelClass } from './ui';

/**
 * Browse the Hub's drivers and add one to a deck: pick a category or search, pick a card, fill in
 * its settings (the Hub's own argument form), confirm, and the launcher installs the package and
 * restarts the deck. The Hub turns the choice into a deck entry (/api/catalog/deck-entry), so a
 * driver added here is the same entry the Hub's "Open in IvoryOS" button would send.
 *
 * The whole catalog arrives in one request (/api/catalog/browse, ~100KB) and is filtered here, so
 * switching category or typing answers instantly. Only a few devices have a photo on the Hub;
 * every other card shows its category's picture instead, so the grid never reads as a list of
 * blank boxes.
 */
export default function HubBrowser({ api, profileId, profileName, hubUrl, pro, onUpgrade, onPrivatePicked, onClose, onAdded }: {
  api: DesktopApi;
  profileId: string;
  profileName: string;
  hubUrl: string;
  /** Private repositories are a Pro feature (preview plans, desktop/src/account.js). */
  pro: boolean;
  onUpgrade: () => void;
  /** A class picked from an imported private repository: open the instrument form with it. */
  onPrivatePicked: (seed: InstrumentSeed) => void;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [all, setAll] = useState<HubModule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [testedOnly, setTestedOnly] = useState(false);
  const [chosen, setChosen] = useState<HubModule | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.hubBrowse()
      .then(r => { if (!cancelled) setAll(r.modules); })
      .catch(e => { if (!cancelled) { setError(e.message); setAll([]); } });
    return () => { cancelled = true; };
  }, [api]);

  // Search and "tested" narrow everything; the category then picks within that, so each
  // category's count says how many matches it holds.
  const matching = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (all || []).filter(m => (!testedOnly || m.is_tested_with_ivoryos) && words.every(w => haystack(m).includes(w)));
  }, [all, query, testedOnly]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    matching.forEach(m => counts.set(categoryOf(m), (counts.get(categoryOf(m)) || 0) + 1));
    return [...counts.entries()].sort((a, b) => (a[0] === OTHER) !== (b[0] === OTHER) ? (a[0] === OTHER ? 1 : -1) : b[1] - a[1]);
  }, [matching]);

  const shown = category ? matching.filter(m => categoryOf(m) === category) : matching;

  return (
    <Modal wide="browser" onClose={onClose} title={chosen
      ? <span className="flex items-center gap-2"><button type="button" onClick={() => setChosen(null)} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><ArrowLeft className="w-4 h-4" /></button>Add {chosen.name} to {profileName}</span>
      : `Add an instrument to ${profileName}`}
    >
      {chosen ? (
        <div className="flex-1 overflow-y-auto p-5">
          <Configure api={api} profileId={profileId} summary={chosen} onDone={() => { onAdded(); onClose(); }} />
        </div>
      ) : (
        <>
          <aside className="w-64 shrink-0 border-r border-gray-100 dark:border-white/10 overflow-y-auto p-2 space-y-0.5">
            <CategoryButton label="All drivers" icon={LayoutGrid} count={matching.length} active={category === null} onClick={() => setCategory(null)} />
            <div className="pt-2 pb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Categories</div>
            {categories.map(([name, count]) => (
              <CategoryButton key={name} label={name} icon={look(name).icon} tint={look(name).tile} count={count} active={category === name} onClick={() => setCategory(name)} />
            ))}
            <div className="pt-3 pb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Private</div>
            <CategoryButton label="Private repositories" icon={Lock} count={pro ? null : <span className="text-[9px] font-bold uppercase tracking-wider text-violet-500">Pro</span>} active={category === PRIVATE} onClick={() => setCategory(PRIVATE)} />
            {category && category !== PRIVATE && !categories.some(([n]) => n === category) && (
              <CategoryButton label={category} icon={look(category).icon} tint={look(category).tile} count={0} active onClick={() => {}} />
            )}
          </aside>

          {category === PRIVATE ? (
            <div className="flex-1 min-w-0 overflow-y-auto p-4">
              <PrivateRepos api={api} profileId={profileId} pro={pro} onUpgrade={onUpgrade} onPicked={seed => { onClose(); onPrivatePicked(seed); }} />
            </div>
          ) : (
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="px-4 py-3 flex items-center gap-3 border-b border-gray-100 dark:border-white/10">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by instrument, vendor or package: pump, balance, Keithley…" className={`${inputClass} !pl-9 !py-2`} />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap">
                <input type="checkbox" checked={testedOnly} onChange={e => setTestedOnly(e.target.checked)} className="accent-indigo-600" />
                Tested with IvoryOS
              </label>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {error && (
                <div className="mb-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 rounded-lg p-3">
                  {error} <span className="text-gray-500 dark:text-gray-400">Hub: {hubUrl}</span>
                </div>
              )}
              {all === null ? (
                <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading the Hub catalog…</div>
              ) : shown.length === 0 && !error ? (
                <div className="text-sm text-gray-500 dark:text-gray-400 space-y-2">
                  <p>No drivers match{query ? <> “{query}”</> : ''}{category ? <> in {category}</> : ''}.</p>
                  <a href={`${hubUrl}/hub/devices`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline">
                    Can’t find your instrument? Request or contribute a driver on the Hub <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              ) : (
                <>
                  <div className="mb-3 text-xs text-gray-500 dark:text-gray-400">{shown.length} driver{shown.length === 1 ? '' : 's'}{category ? ` in ${category}` : ''}</div>
                  <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                    {shown.map(m => <ModuleCard key={m.id} module={m} onPick={() => setChosen(m)} />)}
                  </div>
                </>
              )}
            </div>
          </div>
          )}
        </>
      )}
    </Modal>
  );
}

// --- categories and their pictures ------------------------------------------------------------------

const OTHER = 'Other';
/** The sidebar entry for private repositories, kept apart from the Hub's own categories. */
const PRIVATE = '@private';

function categoryOf(m: HubModule): string {
  return m.devices?.category?.trim() || OTHER;
}

function haystack(m: HubModule): string {
  return [m.name, m.description, m.pip_name, m.devices?.name, m.devices?.vendor, m.devices?.category].filter(Boolean).join(' ').toLowerCase();
}

/**
 * A category's icon and colours, matched on words rather than exact names: contributors create
 * categories freely on the Hub, so a new one ("Heating & Stirring") should still find a picture.
 * The class strings are literal so Tailwind generates them.
 */
const LOOKS: { match: RegExp; icon: LucideIcon; tile: string }[] = [
  { match: /camera|vision|imag/i, icon: Camera, tile: 'from-sky-50 to-sky-100 text-sky-600 dark:from-sky-500/10 dark:to-sky-500/20 dark:text-sky-300' },
  { match: /liquid|pipett|fluid|pump|flow/i, icon: Droplets, tile: 'from-cyan-50 to-cyan-100 text-cyan-600 dark:from-cyan-500/10 dark:to-cyan-500/20 dark:text-cyan-300' },
  { match: /temperat|heat|stirr|thermo/i, icon: Thermometer, tile: 'from-orange-50 to-orange-100 text-orange-600 dark:from-orange-500/10 dark:to-orange-500/20 dark:text-orange-300' },
  { match: /analyt|spectr|chromat/i, icon: Microscope, tile: 'from-violet-50 to-violet-100 text-violet-600 dark:from-violet-500/10 dark:to-violet-500/20 dark:text-violet-300' },
  { match: /sensor|monitor/i, icon: Activity, tile: 'from-emerald-50 to-emerald-100 text-emerald-600 dark:from-emerald-500/10 dark:to-emerald-500/20 dark:text-emerald-300' },
  { match: /test|measur|meter/i, icon: Gauge, tile: 'from-indigo-50 to-indigo-100 text-indigo-600 dark:from-indigo-500/10 dark:to-indigo-500/20 dark:text-indigo-300' },
  { match: /reactor/i, icon: FlaskRound, tile: 'from-rose-50 to-rose-100 text-rose-600 dark:from-rose-500/10 dark:to-rose-500/20 dark:text-rose-300' },
  { match: /workup|sample|process/i, icon: FlaskConical, tile: 'from-fuchsia-50 to-fuchsia-100 text-fuchsia-600 dark:from-fuchsia-500/10 dark:to-fuchsia-500/20 dark:text-fuchsia-300' },
  { match: /solid|weigh|balance/i, icon: Scale, tile: 'from-amber-50 to-amber-100 text-amber-600 dark:from-amber-500/10 dark:to-amber-500/20 dark:text-amber-300' },
  { match: /robot|arm/i, icon: Bot, tile: 'from-teal-50 to-teal-100 text-teal-600 dark:from-teal-500/10 dark:to-teal-500/20 dark:text-teal-300' },
  { match: /autosampl|syringe/i, icon: Syringe, tile: 'from-lime-50 to-lime-100 text-lime-700 dark:from-lime-500/10 dark:to-lime-500/20 dark:text-lime-300' },
  { match: /vacuum|gas/i, icon: Wind, tile: 'from-slate-50 to-slate-100 text-slate-600 dark:from-slate-500/10 dark:to-slate-500/20 dark:text-slate-300' },
  { match: /electronic|board|controller/i, icon: Cpu, tile: 'from-green-50 to-green-100 text-green-700 dark:from-green-500/10 dark:to-green-500/20 dark:text-green-300' },
  { match: /simulat|educat/i, icon: GraduationCap, tile: 'from-yellow-50 to-yellow-100 text-yellow-700 dark:from-yellow-500/10 dark:to-yellow-500/20 dark:text-yellow-300' },
];
const DEFAULT_LOOK = { icon: Package, tile: 'from-gray-50 to-gray-100 text-gray-500 dark:from-white/5 dark:to-white/10 dark:text-gray-400' };

function look(category: string) {
  return LOOKS.find(l => l.match.test(category)) || DEFAULT_LOOK;
}

function CategoryButton({ label, icon: Icon, tint, count, active, onClick }: {
  label: string; icon: LucideIcon; tint?: string; count: React.ReactNode; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm ${active ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300 font-medium' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
    >
      <span className={`w-6 h-6 shrink-0 rounded-md flex items-center justify-center bg-gradient-to-br ${tint || 'from-gray-50 to-gray-100 text-gray-500 dark:from-white/5 dark:to-white/10 dark:text-gray-400'}`}>
        <Icon className="w-3.5 h-3.5" />
      </span>
      <span className="flex-1 truncate">{label}</span>
      <span className="text-[11px] tabular-nums text-gray-400">{count}</span>
    </button>
  );
}

/** A device's photo if the Hub has one that loads, otherwise its category's picture. */
function Picture({ module, className = '' }: { module: HubModule; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = module.devices?.image_url;
  const { icon: Icon, tile } = look(categoryOf(module));
  if (src && !failed) {
    return (
      <div className={`bg-white dark:bg-white/90 flex items-center justify-center ${className}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a remote Hub image in a static export */}
        <img src={src} alt={module.devices?.name || module.name} loading="lazy" onError={() => setFailed(true)} className="max-w-full max-h-full object-contain p-2" />
      </div>
    );
  }
  return (
    <div className={`bg-gradient-to-br ${tile} flex items-center justify-center ${className}`}>
      {module.icon_emoji ? <span className="text-4xl leading-none">{module.icon_emoji}</span> : <Icon className="w-10 h-10 opacity-80" strokeWidth={1.5} />}
    </div>
  );
}

function ModuleCard({ module: m, onPick }: { module: HubModule; onPick: () => void }) {
  const device = m.devices?.name && m.devices.name !== m.name ? m.devices.name : null;
  return (
    <button
      type="button"
      onClick={onPick}
      className="group text-left rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden bg-white dark:bg-white/[0.03] hover:border-indigo-300 hover:shadow-md dark:hover:border-indigo-500/40 transition flex flex-col"
    >
      <div className="relative">
        <Picture module={m} className="h-28" />
        {m.is_tested_with_ivoryos && (
          <span className="absolute top-2 right-2 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-white/90 text-green-700 shadow-sm dark:bg-black/60 dark:text-green-300">
            <CheckCircle2 className="w-3 h-3" /> Tested
          </span>
        )}
      </div>
      <div className="p-3 flex-1 flex flex-col gap-1 min-w-0">
        <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate group-hover:text-indigo-700 dark:group-hover:text-indigo-300">{m.name}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{[m.devices?.vendor?.trim(), device].filter(Boolean).join(' · ') || m.pip_name}</div>
        {m.description && <div className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{m.description}</div>}
        {!!m.connection?.length && (
          <div className="mt-auto pt-1 flex flex-wrap gap-1">
            {m.connection.map(c => <span key={c} className="px-1.5 py-0.5 rounded border border-gray-200 dark:border-white/10 text-[10px] font-medium text-gray-500 dark:text-gray-400">{c.toUpperCase()}</span>)}
          </div>
        )}
      </div>
    </button>
  );
}

// --- the chosen driver's settings -------------------------------------------------------------------

/** Text settings left empty, by dotted name: they are left out of the constructor call. */
function emptyFields(defs: ArgDef[], values: FormValues, prefix = ''): string[] {
  return defs.flatMap(def => {
    const v = values[def.name];
    if (def.type === 'object') return emptyFields(def.args || [], (v as FormValues) || {}, `${prefix}${def.name}.`);
    if (def.type === 'bool') return [];
    return v === undefined || v === null || String(v).trim() === '' ? [`${prefix}${def.name}`] : [];
  });
}

/** The browse card has no argument form; read the full entry once a driver is picked. */
function Configure({ api, profileId, summary, onDone }: { api: DesktopApi; profileId: string; summary: HubModule; onDone: () => void }) {
  const [module, setModule] = useState<HubModule | null>(summary.init_args ? summary : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (summary.init_args) return;
    let cancelled = false;
    api.hubModule(summary.id)
      .then(r => { if (!cancelled) setModule(r.module); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [api, summary]);

  if (error) return <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 rounded-lg p-3">{error}</div>;
  if (!module) return <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading {summary.name}…</div>;
  return <ConfigureForm api={api} profileId={profileId} module={module} onDone={onDone} />;
}

function ConfigureForm({ api, profileId, module, onDone }: { api: DesktopApi; profileId: string; module: HubModule; onDone: () => void }) {
  const defs = useMemo(() => module.init_args || [], [module]);
  const connections = module.connection || [];
  const [name, setName] = useState('');
  const [form, setForm] = useState<FormValues>(() => toForm(defs, {}));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.freeName(profileId, module.name).then(setName).catch(() => setName('device'));
  }, [api, profileId, module.name]);

  const add = async () => {
    setBusy(true);
    try {
      const { instrument, packages, warnings } = await api.hubEntry({
        moduleId: module.id,
        name,
        // Settings come only from the driver's own init arguments, as on the Hub's Connect step:
        // its connection types are labels, not fields. An extra "Port" box here once duplicated
        // an init argument called `port`, and whichever box was left empty won silently.
        connection: { args: form },
      });
      const empty = emptyFields(defs, form);
      const ok = await confirmDialog(
        [
          `Install ${packages.join(', ') || 'nothing new'} and add “${instrument.name}” (${instrument.import}.${instrument.class}).`,
          ...(empty.length ? [`Left empty, so not passed to the driver: ${empty.join(', ')}. If the driver needs them it will not load; you can fill them in later with Edit.`] : []),
          ...warnings,
          'Drivers run on this computer with access to your instruments. The deck restarts to load it.',
        ].join('\n\n'),
        { title: 'Install and add?', confirmLabel: 'Install and add' },
      );
      if (!ok) return;
      await api.install(profileId, { packages, instruments: [instrument] });
      onDone();
    } catch (e: any) {
      await notify(`${e.message}${e.output ? `\n\n${String(e.output).split('\n').slice(-12).join('\n')}` : ''}`, { title: 'Could not add the instrument', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="flex gap-4">
        <Picture module={module} className="w-40 h-28 shrink-0 rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden" />
        <div className="min-w-0 space-y-1">
          <div className="text-xs text-gray-500 dark:text-gray-400">{[module.devices?.vendor?.trim(), module.devices?.name, categoryOf(module)].filter(Boolean).join(' · ')}</div>
          {module.description && <p className="text-sm text-gray-600 dark:text-gray-300">{module.description}</p>}
          <p className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">pip install {module.pip_name} · {module.module_path}.{module.module_name}</p>
          {connections.length > 0 && (
            <div className="flex items-center gap-2 pt-1">
              <span className={labelClass + ' !mb-0'}>Connects over</span>
              {connections.map(c => (
                <span key={c} className="px-2 py-0.5 rounded-md border border-gray-200 dark:border-white/10 text-[11px] font-medium text-gray-600 dark:text-gray-300">{c.toUpperCase()}</span>
              ))}
            </div>
          )}
        </div>
      </div>
      <Field label="Instrument name" hint="How workflows refer to it. Letters, digits and underscores.">
        <input value={name} onChange={e => setName(e.target.value)} className={`${inputClass} font-mono`} />
      </Field>
      {defs.length > 0 && (
        <div>
          <div className={labelClass}>Settings</div>
          <ArgsForm defs={defs} values={form} onChange={setForm} />
        </div>
      )}
      <div className="flex justify-end pt-2">
        <Button tone="primary" disabled={busy || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)} onClick={add}>
          {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Installing…</> : 'Add to deck'}
        </Button>
      </div>
    </div>
  );
}
