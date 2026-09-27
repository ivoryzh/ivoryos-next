/**
 * The IvoryOS desktop app's API, as the launcher page sees it (desktop/src/preload.js).
 *
 * Only present when a page runs inside the desktop app, and only usable from the launcher page:
 * the app refuses every call from anywhere else. Opened in an ordinary browser, `desktopApi()`
 * is null and the launcher says so.
 */

export type ProfileStatus = {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'installing' | 'crashed' | 'error';
  message?: string;
  error?: string | null;
  logTail?: string;
  port: number;
  url: string | null;
};

export type Profile = {
  id: string;
  name: string;
  kind: 'deck' | 'script';
  port: number;
  listenOnNetwork: boolean;
  autoStart: boolean;
  env: Record<string, string>;
  // deck
  deck?: string;
  // script
  script?: string;
  cwd?: string;
  args?: string[];
  python?: string | null;
  dataDir?: string | null;
  status: ProfileStatus;
  problems: string[];
  windowOpen: boolean;
};

export type RuntimeStatus = { state: 'idle' | 'preparing' | 'ready' | 'error'; message?: string; hint?: string; output?: string };

export type Tabs = { open: string[]; active: string | null };

export type Snapshot = { profiles: Profile[]; runtime: RuntimeStatus; hubUrl: string; dataRoot: string; version: string; tabs: Tabs };

export type ArgDef = { name: string; type?: string; default?: unknown; import_path?: string; class_name?: string; args?: ArgDef[] };

export type DeckInstrument = {
  name: string;
  import: string;
  class: string;
  args?: Record<string, unknown>;
  calls?: { method: string; args?: Record<string, unknown> }[];
  enabled?: boolean;
  hub?: { moduleId: number | string; name: string; init_args: ArgDef[]; connection: string[] };
};

export type Deck = { format?: string; name?: string; packages?: string[]; paths?: string[]; instruments?: DeckInstrument[] };

export type HubModule = {
  id: number;
  name: string;
  description?: string | null;
  icon_emoji?: string | null;
  pip_name: string;
  module_path?: string | null;
  module_name: string;
  connection?: string[] | null;
  init_args?: ArgDef[] | null;
  is_tested_with_ivoryos?: boolean | null;
  devices?: { name?: string; vendor?: string; category?: string | null } | null;
};

export interface DesktopApi {
  isDesktop: true;
  snapshot(): Promise<Snapshot>;
  onChanged(cb: () => void): () => void;
  onLog(cb: (id: string, line: string) => void): () => void;
  onSelect(cb: (id: string) => void): () => void;
  createProfile(fields: Partial<Profile>): Promise<Profile>;
  updateProfile(id: string, patch: Partial<Profile>): Promise<Profile>;
  removeProfile(id: string): Promise<void>;
  start(id: string): Promise<ProfileStatus>;
  stop(id: string): Promise<void>;
  restart(id: string): Promise<ProfileStatus>;
  open(id: string): Promise<void>;
  openInBrowser(id: string): Promise<void>;
  showTab(id: string | null): Promise<void>;
  closeTab(id: string): Promise<void>;
  setTabBarHeight(px: number): Promise<void>;
  onTabs(cb: (tabs: Tabs) => void): () => void;
  log(id: string): Promise<string>;
  copy(text: string): Promise<void>;
  reveal(id: string, what: 'log' | 'deck' | 'data' | 'script'): Promise<void>;
  pick(kind: 'script' | 'python' | 'folder'): Promise<string | null>;
  rebuildPython(): Promise<void>;
  deck(id: string): Promise<Deck>;
  saveInstrument(id: string, originalName: string | null, entry: DeckInstrument): Promise<Deck>;
  removeInstrument(id: string, name: string): Promise<Deck>;
  setInstrumentEnabled(id: string, name: string, enabled: boolean): Promise<Deck>;
  install(id: string, manifest: { packages: string[]; instruments: DeckInstrument[] }): Promise<{ added: string[]; replaced: string[] }>;
  installFromFile(): Promise<void>;
  freeName(id: string, suggestion: string): Promise<string>;
  setHubUrl(url: string): Promise<void>;
  hubSearch(q: string): Promise<{ modules: HubModule[] }>;
  hubModule(id: number): Promise<{ module: HubModule }>;
  hubEntry(payload: {
    moduleId: number;
    name: string;
    connection: { type?: string; port?: string; ip?: string; networkPort?: string; args?: Record<string, unknown> };
  }): Promise<{ instrument: DeckInstrument; packages: string[]; warnings: string[] }>;
}

export function desktopApi(): DesktopApi | null {
  if (typeof window === 'undefined') return null;
  return ((window as unknown as { ivoryosDesktop?: DesktopApi }).ivoryosDesktop) ?? null;
}
