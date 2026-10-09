// The desktop app's API (src/desktop.ts DesktopApi, desktop/src/preload.js) for the launcher page in
// the tour. Profiles, decks and installs are the simulated lab's (lab.ts); deck tabs are iframes
// (tabs.ts); the Automation Hub is the real one, read anonymously through the app's own catalog code
// (desktop/src/hubCatalog.js). Anything that would reach the machine or an account says it belongs
// to the desktop app instead of pretending.
import type { AccountInfo, DeckInstrument, DesktopApi, Snapshot } from '@/desktop';
import { HubCatalog } from '../../../desktop/src/hubCatalog.js';
import { HUB_AUTH } from '../../../desktop/src/hubProject.js';
import { OPTIMIZERS, selectionOf } from '../../../desktop/src/optimizers.js';
import { addDeck, EXAMPLE_ID } from './example';
import { type Lab, type MethodSchema, TOUR_BASE } from './lab';
import { TourTabs } from './tabs';

export const DESKTOP_ONLY = 'That is part of the desktop app, not the tour.';

const SIGNED_OUT: AccountInfo = { signedIn: false, plan: 'free' };

/** `fetch` before the tour wraps it (install.ts): the Hub is a real server, not the simulated edge. */
export function makeDesktopApi(lab: Lab, realFetch: typeof fetch): DesktopApi {
  // Plain JavaScript (desktop/src/hubCatalog.js): its answers are read as the launcher's own Hub
  // types (src/desktop.ts), here as in the app. Anonymous: the tour has no accounts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const catalog: any = new HubCatalog({ fetch: realFetch, url: HUB_AUTH.url, key: HUB_AUTH.key, token: async () => null, userId: () => null, online: () => navigator.onLine });
  // A driver's methods as the Hub introspected them (modules.schema): what its simulated stand-in
  // (sim.ts) offers in the Designer and answers when run. Empty when the Hub has none for it.
  const hubSchema = async (filter: string): Promise<Record<string, MethodSchema>> => {
    try {
      const res = await realFetch(`${HUB_AUTH.url}/rest/v1/modules?select=schema&${filter}&limit=1`, {
        headers: { apikey: HUB_AUTH.key, Authorization: `Bearer ${HUB_AUTH.key}`, Accept: 'application/json' },
      });
      const [row] = res.ok ? await res.json() : [];
      return row?.schema && typeof row.schema === 'object' ? row.schema : {};
    } catch {
      return {};
    }
  };
  // Where an instrument's methods come from: a deck in the lab that already has the same driver (a
  // second pump), else the Hub, by the module it was added from or, added by hand, by its import
  // path and class.
  const schemaFor = async (inst: DeckInstrument): Promise<Record<string, MethodSchema>> => {
    for (const d of lab.decks.values()) {
      const twin = (d.deck.instruments || []).find(i => i.import === inst.import && i.class === inst.class && d.schemas[i.name] && Object.keys(d.schemas[i.name]).length);
      if (twin) return d.schemas[twin.name];
    }
    if (inst.hub?.moduleId !== undefined) return hubSchema(`id=eq.${Number(inst.hub.moduleId)}`);
    if (inst.import && inst.class) return hubSchema(`module_path=eq.${encodeURIComponent(inst.import)}&module_name=eq.${encodeURIComponent(inst.class)}`);
    return {};
  };
  // Give an instrument its methods, keeping the ones it has when it is still the same driver (an
  // edit of its settings or its name), and say in the deck's log where they came from.
  const simulate = async (id: string, inst: DeckInstrument, previous?: DeckInstrument) => {
    const d = lab.get(id);
    if (previous && previous.import === inst.import && previous.class === inst.class && d.schemas[previous.name]) {
      if (previous.name !== inst.name) {
        d.schemas[inst.name] = d.schemas[previous.name];
        delete d.schemas[previous.name];
      }
      return;
    }
    d.schemas[inst.name] = await schemaFor(inst);
    const n = Object.keys(d.schemas[inst.name]).length;
    lab.log(id, n
      ? `${inst.name}: simulated from the Hub's schema for ${inst.import}.${inst.class} (${n} methods)`
      : `${inst.name}: the Hub has no schema for ${inst.import}.${inst.class}, so the tour cannot simulate its methods`);
  };
  const tabs = new TourTabs(state => lab.emit('tabs', state));
  const stars = new Set<string>();
  const changed = () => lab.emit('changed');

  const snapshot = (): Snapshot => ({
    profiles: lab.profiles(),
    runtime: { state: 'ready' },
    hubUrl: 'https://ivoryos.ai',
    cloudUrl: '',
    dataRoot: 'IvoryOS (tour)',
    version: 'tour',
    tabs: tabs.state(),
    platform: 'web',
    account: SIGNED_OUT,
    update: { state: 'unsupported', current: 'tour' },
    autoUpdate: false,
    // No keychain warning on the sign-in page: there is nothing to keep, as there is no signing in.
    secretsPersist: true,
    tray: { available: false, minimizeToTray: false, closeToTray: false },
    theme: 'system',
    cloudComingSoon: true,
    noCloud: true,
  });

  // A start or restart in the tour: a moment in 'starting', as an edge loading its drivers would be.
  const start = async (id: string) => {
    const d = lab.get(id);
    d.profile.status = { ...d.profile.status, state: 'starting', message: 'Loading instruments…' };
    changed();
    lab.log(id, `Starting ${d.profile.name} (simulated)…`);
    await new Promise(r => setTimeout(r, 700));
    d.profile.status = { ...d.profile.status, state: 'running', message: undefined, url: `${location.origin}${TOUR_BASE}/deck-${id}` };
    for (const inst of d.deck.instruments || []) {
      if (inst.enabled !== false) lab.log(id, `  ${inst.name}: loaded (simulated ${inst.class})`);
    }
    lab.log(id, 'Ready.');
    changed();
    tabs.reloadDeck(id);
    return d.profile.status;
  };

  const api: Partial<DesktopApi> = {
    isDesktop: true,
    snapshot: async () => snapshot(),
    onChanged: cb => lab.on('changed', () => cb()),
    onLog: cb => lab.on('log', (id, line) => cb(id as string, line as string)),
    onSelect: cb => lab.on('select', id => cb(id as string)),
    onTabs: cb => lab.on('tabs', state => cb(state as Snapshot['tabs'])),
    onToggleSidebar: () => () => {},
    onHubLink: () => () => {},
    takeHubLink: async () => null,

    start,
    restart: start,
    stop: async id => {
      const d = lab.get(id);
      tabs.close(id);
      d.profile.status = { ...d.profile.status, state: 'stopped', url: null };
      lab.log(id, 'Stopped.');
      changed();
    },
    open: async (id, page) => {
      if (lab.get(id).profile.status.state !== 'running') throw new Error('Start the profile first.');
      tabs.open(id, page);
    },
    openInBrowser: async id => { window.open(`${TOUR_BASE}/`, '_blank', 'noopener'); void id; },
    showTab: async id => tabs.show(id),
    closeTab: async id => tabs.close(id),
    setTabBarHeight: async px => tabs.setTabBarHeight(px),
    setSidebarWidth: async px => tabs.setSidebarWidth(px),
    reloadTab: async () => tabs.reload(),
    log: async id => lab.get(id).log.join('\n'),
    copy: async text => { await navigator.clipboard?.writeText(text); },

    deck: async id => lab.get(id).deck,
    createProfile: async fields => {
      if (fields.kind === 'script') throw new Error('Python script profiles need Python on your computer: that is the desktop app.');
      const d = addDeck(lab, { name: String(fields.name || 'New deck') });
      changed();
      return lab.profiles().find(p => p.id === d.profile.id)!;
    },
    createExample: async () => lab.profiles().find(p => p.id === EXAMPLE_ID) || lab.profiles()[0],
    updateProfile: async (id, patch) => {
      const d = lab.get(id);
      const { status: _status, ...rest } = patch;
      void _status;
      d.profile = { ...d.profile, ...rest };
      changed();
      return lab.profiles().find(p => p.id === id)!;
    },
    removeProfile: async id => {
      tabs.close(id);
      lab.decks.delete(id);
      changed();
    },
    // Installing in the tour: nothing is downloaded. Each Hub driver joins the deck as a simulated
    // stand-in with the methods the Hub introspected for it, and the deck restarts as it would.
    install: async (id, manifest) => {
      const d = lab.get(id);
      const before = new Set((d.deck.instruments || []).map(i => i.name));
      const instruments = [...(d.deck.instruments || [])];
      for (const inst of manifest.instruments || []) {
        const at = instruments.findIndex(i => i.name === inst.name);
        await simulate(id, inst, at === -1 ? undefined : instruments[at]);
        if (at === -1) instruments.push(inst); else instruments[at] = inst;
      }
      d.deck = { ...d.deck, name: manifest.name || d.deck.name, packages: [...new Set([...(d.deck.packages || []), ...(manifest.packages || [])])], instruments };
      for (const pkg of manifest.packages || []) lab.log(id, `Would install ${pkg} (the tour downloads nothing)`);
      if ((manifest.plugins || []).length) lab.log(id, 'Plugins run in the desktop app; the tour lists them but does not load them.');
      changed();
      await start(id);
      const names = (manifest.instruments || []).map(i => i.name);
      return { added: names.filter(n => !before.has(n)), replaced: names.filter(n => before.has(n)), pluginsAdded: [] };
    },
    addWorkflows: async (id, workflows) => {
      const edge = lab.get(id).edge;
      const listed = (await edge.handle('GET', '/workflows', new URLSearchParams(), null)).body.workflows.map((w: { name: string }) => w.name);
      const taken = new Set<string>(listed);
      const saved: { requested: string; saved: string }[] = [];
      for (const w of workflows) {
        let name = w.name;
        for (let n = 2; taken.has(name); n++) name = `${w.name} ${n}`;
        taken.add(name);
        await edge.handle('POST', `/workflows/${encodeURIComponent(name)}`, new URLSearchParams(), { ...w.body, name });
        saved.push({ requested: w.name, saved: name });
      }
      return saved;
    },
    saveInstrument: async (id, originalName, entry) => {
      const list = [...(lab.get(id).deck.instruments || [])];
      const at = list.findIndex(i => i.name === (originalName ?? entry.name));
      await simulate(id, entry, at === -1 ? undefined : list[at]);
      if (at === -1) list.push(entry); else list[at] = entry;
      lab.setInstruments(id, list);
      await start(id);
      return lab.get(id).deck;
    },
    removeInstrument: async (id, name) => {
      delete lab.get(id).schemas[name];
      lab.setInstruments(id, (lab.get(id).deck.instruments || []).filter(i => i.name !== name));
      await start(id);
      return lab.get(id).deck;
    },
    setInstrumentEnabled: async (id, name, enabled) => {
      lab.setInstruments(id, (lab.get(id).deck.instruments || []).map(i => (i.name === name ? { ...i, enabled } : i)));
      await start(id);
      return lab.get(id).deck;
    },
    freeName: async (id, suggestion) => {
      const taken = new Set((lab.get(id).deck.instruments || []).map(i => i.name));
      const base = String(suggestion || 'device').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'device';
      let name = /^[a-z]/.test(base) ? base : `device_${base}`;
      for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
      return name;
    },

    optimizers: async id => {
      const selected = selectionOf(id ? lab.get(id).deck.packages || [] : []);
      return { catalog: OPTIMIZERS, selected, installed: {}, error: null };
    },

    hubSearch: q => catalog.search(q),
    hubBrowse: () => catalog.browse(),
    hubModule: id => catalog.module(id),
    hubEntry: payload => catalog.deckEntry(payload),
    hubPlatforms: () => catalog.platforms(),
    hubPlatform: id => catalog.platform(id),
    hubPlugins: () => catalog.plugins(),
    hubPlugin: id => catalog.plugin(id),
    hubTemplates: () => catalog.templates(),
    hubTemplate: id => catalog.template(id),
    hubSelection: request => catalog.selection(request),
    hubStarred: async () => [...stars],
    hubStar: async (key, on) => { if (on) stars.add(key); else stars.delete(key); return [...stars]; },

    account: async () => SIGNED_OUT,
    // The launcher's Python check (Settings): there is none to check, and none needed.
    inspectPython: async () => ({ ok: true, python: 'Simulated in your browser: the tour runs no Python', version: '3.12', edge: '(simulated)' }),
    // The tour's scripts are its own simulated lab, never IvoryOS Classic.
    classicScript: async () => null,
    reorderProfiles: async () => {},
    setTheme: async () => {},
  };

  // Everything else (accounts, files on disk, Python, updates, private repositories): the page
  // shows this message where the app would have done it.
  return new Proxy(api as DesktopApi, {
    get(target, prop: string) {
      if (prop in target) return (target as unknown as Record<string, unknown>)[prop];
      if (prop.startsWith('on')) return () => () => {};
      return async () => { throw new Error(DESKTOP_ONLY); };
    },
  });
}

