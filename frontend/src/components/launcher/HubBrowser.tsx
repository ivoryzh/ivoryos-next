"use client";
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowLeft, Bot, Camera, CheckCircle2, Cpu, Droplets, ExternalLink, FileText, FlaskConical, FlaskRound, Gauge,
  GitBranch, Globe, GraduationCap, Layers, Loader2, Lock, Microscope, Package, Puzzle, Scale, Search, Sparkles, Star, Syringe,
  Thermometer, Wind, type LucideIcon,
} from 'lucide-react';
import { confirmDialog, notify } from '@ivoryos/shared-ui';
import type { Deck, DesktopApi, HubLinkRequest, HubModule, HubPlatform, HubPlugin, HubTemplate } from '@/desktop';
import { emptyFields, toForm, type FormValues } from '@/launcherArgs';
import { inScope, preferV2, type Scope } from '@/hubCatalog';
import ArgsForm from './ArgsForm';
import PrivateRepos, { type InstrumentSeed } from './PrivateRepos';
import { LinkDetail, PlatformCard, PlatformDetail } from './HubPlatforms';
import { PluginCard, PluginDetail } from './HubPlugins';
import { TemplateCard, TemplateDetail, templateTitle } from './HubTemplates';
import { addTo, deckLabel, plainInstrumentName, ErrorBox, Loading, VisibilityBadge, type DeckAccess, type DeckTarget } from './hubUi';
import { Button, Field, Modal, inputClass, labelClass } from './ui';
import { installFailed } from './ReportProblem';

type Kind = 'starred' | 'instruments' | 'platforms' | 'plugins' | 'workflows' | 'repos';
/** A section the browser can be opened on. */
export type HubKind = Exclude<Kind, 'starred' | 'repos'>;
type ListKind = Exclude<Kind, 'repos' | 'starred'>;
type Chosen =
  | { kind: 'instrument'; module: HubModule }
  | { kind: 'platform'; platform: HubPlatform }
  | { kind: 'plugin'; plugin: HubPlugin }
  | { kind: 'template'; template: HubTemplate }
  | { kind: 'link'; request: HubLinkRequest };
type Loaded<T> = { items: T[] | null; error: string | null };

/** Load one catalog list once; `items` is null until it arrives, [] (with `error`) if it failed. */
function useCatalog<T>(load: () => Promise<T[]>): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ items: null, error: null });
  useEffect(() => {
    let cancelled = false;
    load().then(items => { if (!cancelled) setState({ items, error: null }); })
      .catch(e => { if (!cancelled) setState({ items: [], error: e.message }); });
    return () => { cancelled = true; };
  }, [load]);
  return state;
}

const KINDS: { kind: ListKind; label: string; icon: LucideIcon; noun: string }[] = [
  { kind: 'instruments', label: 'Instruments', icon: Cpu, noun: 'driver' },
  { kind: 'platforms', label: 'Platforms', icon: Layers, noun: 'platform' },
  { kind: 'plugins', label: 'Plugins', icon: Puzzle, noun: 'plugin' },
  { kind: 'workflows', label: 'Workflows', icon: FileText, noun: 'workflow' },
];

/**
 * The Hub, from a deck: its instrument drivers, platforms (a whole deck's worth of drivers,
 * plugins and workflows), plugins and workflow templates, each added to this deck in one step.
 * A platform can instead become a new deck of its own. The Hub website's "Open in IvoryOS" button
 * lands here too: its link names Hub ids, opened on the platform install screen (`initialLink`).
 *
 * Public and private hub are the same browser over different rows. The Hub decides which rows a
 * signed-in person may see (row-level security: their own, and their organizations'); the switch
 * here only chooses which of those to list, and the private side is a Pro feature. Private
 * repositories (GitHub/GitLab, imported by this app, never on the Hub) sit on the private side.
 *
 * Each list arrives in one request and is filtered here, so switching and typing answer
 * instantly. Only a few devices have a photo on the Hub; every other driver card shows its
 * category's picture, so the grid never reads as a list of blank boxes.
 */
export default function HubBrowser({ api, profile, newDeck, initialKind, initialLink, hubUrl, pro, onUpgrade, onPrivatePicked, onClose, onAdded, onOpenProfile }: {
  api: DesktopApi;
  /** The deck this browser adds to; null when the launcher has no deck yet (see `newDeck`). */
  profile: DeckTarget | null;
  /**
   * With no `profile`, the first add makes a deck through this (`create` asks for the name), and a
   * failed first add removes it again. The browser then adds to that deck until it is closed.
   */
  newDeck?: { create: (suggestedName: string) => Promise<DeckTarget | null>; discard: (deck: DeckTarget) => Promise<void> };
  /** Open on this section rather than on starred items / instruments. */
  initialKind?: HubKind;
  /** Open on what an `ivoryos://install` link from the Hub asks for (desktop/src/installLink.js). */
  initialLink?: HubLinkRequest | null;
  hubUrl: string;
  /** The private hub and private repositories are Pro features (preview plans, desktop/src/account.js). */
  pro: boolean;
  onUpgrade: () => void;
  /** A class picked from an imported private repository: open the instrument form with it. */
  onPrivatePicked: (seed: InstrumentSeed) => void;
  onClose: () => void;
  onAdded: () => void;
  /** A platform installed as a new deck: show that deck. */
  onOpenProfile: (id: string) => void;
}) {
  const [scope, setScope] = useState<Scope>('public');
  const [kind, setKind] = useState<Kind>(initialKind || 'instruments');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [testedOnly, setTestedOnly] = useState(false);
  const [chosen, setChosen] = useState<Chosen | null>(initialLink ? { kind: 'link', request: initialLink } : null);
  // A second link while the browser is open replaces whatever it was showing (adjusted while
  // rendering, as React recommends for state that follows a prop, rather than in an effect).
  const [shownLink, setShownLink] = useState(initialLink);
  if (initialLink !== shownLink) {
    setShownLink(initialLink);
    if (initialLink) setChosen({ kind: 'link', request: initialLink });
  }
  const [deck, setDeck] = useState<Deck | null>(null);
  // The deck adds land on: the one the browser was opened on, else whatever the first add created.
  const [created, setCreated] = useState<DeckTarget | null>(null);
  const target = profile ?? created;
  const access = useMemo<DeckAccess>(() => ({
    target,
    ensure: async suggested => {
      if (target) return target;
      if (!newDeck) throw new Error('This browser was opened without a deck to add to.');
      const made = await newDeck.create(suggested);
      if (made) setCreated(made);
      return made;
    },
    discard: async made => {
      setCreated(c => (c?.id === made.id ? null : c));
      if (newDeck) await newDeck.discard(made);
    },
  }), [target, newDeck]);
  // Starred for quick access (kept per account by the app): 'module:12', 'platform:4', ...
  // The browser opens on them when there are any, so the whole catalog is one click away, not
  // the first thing to scroll through.
  const [stars, setStars] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.hubStarred()
      .then(list => { if (!cancelled) { setStars(list); if (list.length && !initialKind) setKind('starred'); } })
      .catch(() => { if (!cancelled) setStars([]); });
    return () => { cancelled = true; };
  }, [api, initialKind]);
  const starred = useMemo(() => new Set(stars || []), [stars]);
  const toggleStar = (key: string) => {
    const on = !starred.has(key);
    setStars(list => (on ? [...(list || []), key] : (list || []).filter(k => k !== key)));
    api.hubStar(key, on).catch(e => notify(e.message, { tone: 'error' }));
  };
  // A one-cell grid, so the card fills the wrapper: a <button> in plain block flow shrinks to its
  // content, which left every card a different width and height inside the grid.
  const withStar = (key: string, card: React.ReactNode) => (
    <div key={key} className="relative group/star grid">
      {card}
      <StarButton on={starred.has(key)} onClick={() => toggleStar(key)} />
    </div>
  );

  const modules = useCatalog(useCallback(() => api.hubBrowse().then(r => r.modules), [api]));
  const platforms = useCatalog(useCallback(() => api.hubPlatforms().then(r => r.platforms), [api]));
  const plugins = useCatalog(useCallback(() => api.hubPlugins().then(r => r.plugins), [api]));
  const templates = useCatalog(useCallback(() => api.hubTemplates().then(r => r.templates), [api]));

  // The deck the browser adds to: templates are checked against it, and platform drivers are
  // named clear of what is already on it.
  const refreshDeck = useCallback(() => {
    if (target) api.deck(target.id).then(setDeck).catch(() => setDeck(null));
    else setDeck(null);
  }, [api, target]);
  useEffect(refreshDeck, [refreshDeck]);

  const words = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const locked = scope === 'private' && !pro;

  const lists = useMemo(() => {
    const match = (text: string) => words.every(w => text.includes(w));
    return {
      instruments: (modules.items || []).filter(m => inScope(m, scope) && (!testedOnly || m.is_tested_with_ivoryos) && match(haystack(m))),
      platforms: (platforms.items || []).filter(p => inScope(p, scope) && match([p.name, p.description].join(' ').toLowerCase())),
      plugins: preferV2((plugins.items || []).filter(p => inScope(p, scope) && match([p.name, p.description, p.pip_name].join(' ').toLowerCase()))),
      workflows: (templates.items || []).filter(t => inScope(t, scope) && match([templateTitle(t), t.description, ...t.instruments].join(' ').toLowerCase())),
    };
  }, [modules.items, platforms.items, plugins.items, templates.items, scope, testedOnly, words]);

  const loaded: Record<ListKind, Loaded<unknown>> = { instruments: modules, platforms, plugins, workflows: templates };

  // The starred view: every starred item the searched words match, whichever hub it is on.
  const starredLists = useMemo(() => {
    const match = (text: string) => words.every(w => text.includes(w));
    return {
      instruments: (modules.items || []).filter(m => starred.has(`module:${m.id}`) && match(haystack(m))),
      platforms: (platforms.items || []).filter(p => starred.has(`platform:${p.id}`) && match([p.name, p.description].join(' ').toLowerCase())),
      plugins: (plugins.items || []).filter(p => starred.has(`plugin:${p.id}`) && match([p.name, p.description, p.pip_name].join(' ').toLowerCase())),
      workflows: (templates.items || []).filter(t => starred.has(`template:${t.id}`) && match([templateTitle(t), t.description, ...t.instruments].join(' ').toLowerCase())),
    };
  }, [modules.items, platforms.items, plugins.items, templates.items, starred, words]);
  const starredCount = Object.values(starredLists).reduce((n, l) => n + l.length, 0);
  const cards = {
    instruments: (m: HubModule) => withStar(`module:${m.id}`, <ModuleCard module={m} onPick={() => setChosen({ kind: 'instrument', module: m })} />),
    platforms: (p: HubPlatform) => withStar(`platform:${p.id}`, <PlatformCard platform={p} onPick={() => setChosen({ kind: 'platform', platform: p })} />),
    plugins: (p: HubPlugin) => withStar(`plugin:${p.id}`, <PluginCard plugin={p} onPick={() => setChosen({ kind: 'plugin', plugin: p })} />),
    workflows: (t: HubTemplate) => withStar(`template:${t.id}`, <TemplateCard template={t} deck={deck} onPick={() => setChosen({ kind: 'template', template: t })} />),
  };

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    lists.instruments.forEach(m => counts.set(categoryOf(m), (counts.get(categoryOf(m)) || 0) + 1));
    return [...counts.entries()].sort((a, b) => (a[0] === OTHER) !== (b[0] === OTHER) ? (a[0] === OTHER ? 1 : -1) : b[1] - a[1]);
  }, [lists.instruments]);
  const shownInstruments = category ? lists.instruments.filter(m => categoryOf(m) === category) : lists.instruments;

  const finish = () => { onAdded(); onClose(); };
  const where = target ? target.name : 'a new deck';
  const title = !chosen ? `Add to ${where} from the Hub`
    : chosen.kind === 'instrument' ? `Add ${chosen.module.name} to ${where}`
      : chosen.kind === 'platform' ? `Install ${chosen.platform.name}`
        : chosen.kind === 'plugin' ? `Add ${chosen.plugin.name.trim()} to ${where}`
          : chosen.kind === 'link' ? 'Install from the Automation Hub'
            : `Add ${templateTitle(chosen.template)} to ${where}`;

  return (
    <Modal wide="browser" onClose={onClose} title={chosen
      ? <span className="flex items-center gap-2"><button type="button" onClick={() => setChosen(null)} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><ArrowLeft className="w-4 h-4" /></button>{title}</span>
      : title}
    >
      {chosen ? (
        <div className="flex-1 overflow-y-auto p-5">
          {chosen.kind === 'instrument' && <Configure api={api} access={access} summary={chosen.module} onDone={finish} />}
          {chosen.kind === 'platform' && (
            <PlatformDetail api={api} access={access} deck={deck} platformId={chosen.platform.id}
              onDone={newId => { finish(); if (newId) onOpenProfile(newId); }} />
          )}
          {chosen.kind === 'link' && (
            <LinkDetail api={api} access={access} deck={deck} request={chosen.request}
              onDone={newId => { finish(); if (newId) onOpenProfile(newId); }} />
          )}
          {chosen.kind === 'plugin' && <PluginDetail api={api} access={access} deck={deck} plugin={chosen.plugin} onDone={finish} />}
          {chosen.kind === 'template' && (
            // A workflow does not restart the deck, so stay in the browser to add more.
            <TemplateDetail api={api} access={access} deck={deck} template={chosen.template}
              onDone={() => { onAdded(); setChosen(null); }} />
          )}
        </div>
      ) : (
        <>
          <aside className="w-64 shrink-0 border-r border-gray-100 dark:border-white/10 overflow-y-auto p-2 space-y-0.5">
            <div className="grid grid-cols-2 gap-1 p-1 mb-2 rounded-lg bg-gray-100 dark:bg-white/5">
              {(['public', 'private'] as const).map(s => (
                <button key={s} type="button" onClick={() => { setScope(s); setCategory(null); if (s === 'public' && kind === 'repos') setKind('instruments'); }}
                  className={`flex items-center justify-center gap-1.5 rounded-md py-1 text-xs font-medium ${scope === s ? 'bg-white text-accent-fg shadow-sm ring-1 ring-accent-tint/60 dark:bg-accent-soft dark:ring-0' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'}`}>
                  {s === 'public' ? <Globe className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                  {s === 'public' ? 'Public' : 'Private'}
                  {s === 'private' && !pro && <span className="text-[9px] font-bold uppercase tracking-wider text-violet-500">Pro</span>}
                </button>
              ))}
            </div>
            <CategoryButton label="Starred" icon={Star} tint="from-amber-50 to-amber-100 text-amber-500 dark:from-amber-500/10 dark:to-amber-500/20 dark:text-amber-300"
              count={stars === null ? '…' : stars.length} active={kind === 'starred'} onClick={() => { setKind('starred'); setCategory(null); }} />
            <div className="h-1" />
            {KINDS.map(k => (
              <CategoryButton key={k.kind} label={k.label} icon={k.icon} count={locked ? null : loaded[k.kind].items === null ? '…' : lists[k.kind].length}
                active={kind === k.kind && (k.kind !== 'instruments' || category === null)} onClick={() => { setKind(k.kind); setCategory(null); }} />
            ))}
            {/* Below the kinds, not between them: the Hub has many categories, and listing them under
                Instruments pushed Platforms, Plugins and Workflows out of sight. */}
            {kind === 'instruments' && !locked && categories.length > 1 && (
              <>
                <div className="pt-3 pb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Instrument categories</div>
                {categories.map(([name, count]) => (
                  <CategoryButton key={name} label={name} icon={look(name).icon} tint={look(name).tile} count={count} active={category === name} onClick={() => setCategory(name)} />
                ))}
              </>
            )}
            {scope === 'private' && (
              <>
                <div className="pt-3 pb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Your code</div>
                <CategoryButton label="Private repositories" icon={GitBranch} count={pro ? null : <span className="text-[9px] font-bold uppercase tracking-wider text-violet-500">Pro</span>} active={kind === 'repos'} onClick={() => setKind('repos')} />
              </>
            )}
          </aside>

          {kind === 'repos' ? (
            <div className="flex-1 min-w-0 overflow-y-auto p-4">
              <PrivateRepos api={api} access={access} pro={pro} onUpgrade={onUpgrade} onPicked={seed => { onClose(); onPrivatePicked(seed); }} />
            </div>
          ) : locked && kind !== 'starred' ? (
            <ProGate onUpgrade={onUpgrade} />
          ) : (
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="px-4 py-3 flex items-center gap-3 border-b border-gray-100 dark:border-white/10">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                  <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
                    placeholder={kind === 'instruments' ? 'Search by instrument, vendor or package: pump, balance, Keithley…' : kind === 'starred' ? 'Search starred…' : `Search ${kind}…`}
                    className={`${inputClass} !pl-9 !py-2`} />
                </div>
                {kind === 'instruments' && (
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap">
                    <input type="checkbox" checked={testedOnly} onChange={e => setTestedOnly(e.target.checked)} className="accent-accent" />
                    Tested with IvoryOS
                  </label>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {kind === 'starred' ? (
                  starredCount === 0 ? (
                    <div className="text-sm text-gray-500 dark:text-gray-400 space-y-1">
                      <p>{query ? <>Nothing starred matches &ldquo;{query}&rdquo;.</> : 'Nothing starred yet.'}</p>
                      {!query && <p className="flex items-center gap-1">Star the drivers, platforms, plugins and workflows you use, with <Star className="w-3.5 h-3.5" /> on their card, and they wait here.</p>}
                    </div>
                  ) : (
                    <div className="space-y-5">
                      {KINDS.filter(k => starredLists[k.kind].length > 0).map(k => (
                        <section key={k.kind}>
                          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{k.label}</div>
                          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                            {k.kind === 'instruments' && starredLists.instruments.map(cards.instruments)}
                            {k.kind === 'platforms' && starredLists.platforms.map(cards.platforms)}
                            {k.kind === 'plugins' && starredLists.plugins.map(cards.plugins)}
                            {k.kind === 'workflows' && starredLists.workflows.map(cards.workflows)}
                          </div>
                        </section>
                      ))}
                    </div>
                  )
                ) : (
                  <KindList kind={kind} scope={scope} query={query} category={category} hubUrl={hubUrl} loaded={loaded[kind]}
                    count={kind === 'instruments' ? shownInstruments.length : lists[kind].length}>
                    {kind === 'instruments' && shownInstruments.map(cards.instruments)}
                    {kind === 'platforms' && lists.platforms.map(cards.platforms)}
                    {kind === 'plugins' && lists.plugins.map(cards.plugins)}
                    {kind === 'workflows' && lists.workflows.map(cards.workflows)}
                  </KindList>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/** A list's loading and error states, its count, and what to say when it is empty. */
function KindList({ kind, scope, query, category, hubUrl, loaded, count, children }: {
  kind: ListKind; scope: Scope; query: string; category: string | null; hubUrl: string;
  loaded: Loaded<unknown>; count: number; children: React.ReactNode;
}) {
  const noun = KINDS.find(k => k.kind === kind)!.noun;
  if (loaded.items === null) return <Loading what={`${noun}s from the Hub`} />;
  return (
    <>
      {loaded.error && <div className="mb-3"><ErrorBox>{loaded.error}</ErrorBox></div>}
      {count === 0 && !loaded.error && (
        <div className="text-sm text-gray-500 dark:text-gray-400 space-y-2">
          {scope === 'private' && !query
            ? <p>No private {noun}s yet. What you, or an organization you belong to, keep private on the Hub appears here, and only here.</p>
            : <p>No {noun}s match{query ? <> &ldquo;{query}&rdquo;</> : ''}{category ? <> in {category}</> : ''}.</p>}
          {kind === 'instruments' && scope === 'public' && (
            <a href={`${hubUrl}/hub/devices`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-fg hover:underline">
              Can&apos;t find your instrument? Request or contribute a driver on the Hub <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      )}
      {count > 0 && (
        <>
          <div className="mb-3 text-xs text-gray-500 dark:text-gray-400">{count} {noun}{count === 1 ? '' : 's'}{category ? ` in ${category}` : ''}</div>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">{children}</div>
        </>
      )}
    </>
  );
}

/** The star on a card: always shown once on, otherwise on hover, so the grid stays quiet. */
function StarButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onClick(); }}
      title={on ? 'Unstar' : 'Star for quick access'}
      className={`absolute top-2 left-2 p-1 rounded-full bg-white/90 dark:bg-black/60 shadow-sm transition-opacity ${on ? 'opacity-100 text-amber-500' : 'opacity-0 group-hover/star:opacity-100 focus:opacity-100 text-gray-400 hover:text-amber-500'}`}
    >
      <Star className="w-3.5 h-3.5" fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}

function ProGate({ onUpgrade }: { onUpgrade: () => void }) {
  return (
    <div className="flex-1 min-w-0 flex items-center justify-center p-8">
      <div className="max-w-md text-center space-y-3">
        <div className="mx-auto w-12 h-12 rounded-2xl bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-300 flex items-center justify-center"><Lock className="w-6 h-6" /></div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">The private hub is part of IvoryOS Pro</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Drivers, platforms, plugins and workflows that only you, or your organization, can see: kept on the Hub, and
          installed from here like anything public.
        </p>
        <Button tone="primary" onClick={onUpgrade}><Sparkles className="w-4 h-4" /> See Pro</Button>
      </div>
    </div>
  );
}

// --- categories and their pictures ------------------------------------------------------------------

const OTHER = 'Other';

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
  { match: /test|measur|meter/i, icon: Gauge, tile: 'from-gray-50 to-gray-100 text-gray-900 dark:text-white dark:from-white/5 dark:to-white/10 dark:text-white' },
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
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm ${active ? 'bg-accent-soft text-accent-fg font-medium' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
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
      className="group text-left rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden bg-white dark:bg-white/[0.03] hover:border-gray-300 dark:hover:border-white/20 hover:shadow-md dark:hover:border-white/30 transition flex flex-col"
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
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate group-hover:text-accent-fg">{m.name}</span>
          <VisibilityBadge row={m} />
        </div>
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

/** The browse card has no argument form; read the full entry once a driver is picked. */
function Configure({ api, access, summary, onDone }: { api: DesktopApi; access: DeckAccess; summary: HubModule; onDone: () => void }) {
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
  return <ConfigureForm api={api} access={access} module={module} onDone={onDone} />;
}

function ConfigureForm({ api, access, module, onDone }: { api: DesktopApi; access: DeckAccess; module: HubModule; onDone: () => void }) {
  const defs = useMemo(() => module.init_args || [], [module]);
  const connections = module.connection || [];
  const [name, setName] = useState('');
  const [form, setForm] = useState<FormValues>(() => toForm(defs, {}));
  const [busy, setBusy] = useState(false);

  const deckId = access.target?.id;
  useEffect(() => {
    if (deckId) api.freeName(deckId, module.name).then(setName).catch(() => setName('device'));
    else setName(plainInstrumentName(module.name));
  }, [api, deckId, module.name]);

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
          `Install ${packages.join(', ') || 'nothing new'} and add “${instrument.name}” (${instrument.import}.${instrument.class}) to ${deckLabel(access.target)}.`,
          ...(empty.length ? [`Left empty, so not passed to the driver: ${empty.join(', ')}. If the driver needs them it will not load; you can fill them in later with Edit.`] : []),
          ...warnings,
          'Drivers run on this computer with access to your instruments. The deck restarts to load it.',
        ].join('\n\n'),
        { title: 'Install and add?', confirmLabel: 'Install and add' },
      );
      if (!ok) return;
      if (!await addTo(access, module.name, deck => api.install(deck.id, { packages, instruments: [instrument] }))) return;
      onDone();
    } catch (e: any) {
      await installFailed(api, 'Could not add the instrument', e, access.target?.id ?? null);
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
