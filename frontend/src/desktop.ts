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
  /** The edge started on another port than the profile's (desktop/src/supervisor.js). */
  portNote?: { requested: number; actual: number } | null;
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

export type Plan = 'free' | 'pro';

/** Who is signed in (the Hub's accounts). The app never hands the page a token. */
export type AccountInfo = {
  signedIn: boolean;
  plan: Plan;
  user?: { id: string; email: string | null; name: string | null; avatarUrl: string | null; lab: string | null; providers: string[] };
  /** Sign-up with email confirmation on: no session until the emailed link is opened. */
  confirmEmail?: boolean;
  email?: string;
};

export type UpdateStatus = {
  state: 'unsupported' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error';
  current: string;
  version?: string;
  percent?: number;
  message?: string | null;
  /** macOS: unsigned builds cannot install themselves, so an update is a download link. */
  manual?: boolean;
  releaseUrl?: string;
  downloadUrl?: string;
  checkedAt?: number;
};

export type GitProvider = 'github' | 'gitlab';
export type GitConnection = { provider: GitProvider; label: string; tokenHelp: string; scopes: string; connected: boolean; login: string | null; host: string };
export type GitRepo = { id: string; name: string; description: string | null; private: boolean; defaultBranch: string; updatedAt: string; url: string };
export type DriverScan = {
  distribution?: string; version?: string; modules?: string[];
  classes?: { module: string; class: string; doc: string }[];
  errors?: { module: string; error: string }[];
  error?: string;
};
export type GitImport = { file: string; sha: string; ref: string; scan: DriverScan };

export type Snapshot = {
  profiles: Profile[]; runtime: RuntimeStatus; hubUrl: string; cloudUrl: string; dataRoot: string; version: string; tabs: Tabs;
  platform: string; account: AccountInfo; update: UpdateStatus; autoUpdate: boolean; secretsPersist: boolean;
};

/** An edge's `GET /api/cloud-settings`: whether it is paired with Cloud, and how its link is doing. */
export type CloudLink = {
  paired: boolean;
  client_id?: string | null;
  broker?: string | null;
  connection_state?: string | null;
  connection_error?: string | null;
};

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
  devices?: { name?: string; vendor?: string; category?: string | null; image_url?: string | null } | null;
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
  /** `page` opens that page of the edge in its tab, e.g. '/cloud/'. */
  open(id: string, page?: string): Promise<void>;
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
  setCloudUrl(url: string): Promise<void>;
  /** Open IvoryOS Cloud as a tab of this window (tab id CLOUD_TAB). */
  /** The launcher's own interpreter (the environment deck profiles and Hub installs use). */
  launcherPython(): Promise<string>;
  /** An interpreter's version and whether IvoryOS is installed in it; null for the launcher's own. */
  inspectPython(python: string | null): Promise<PythonInfo>;
  /** Make (or reuse) `<folder>/.venv` with IvoryOS installed; returns its interpreter. */
  createVenv(folder: string): Promise<string>;
  installEdgeInto(python: string): Promise<void>;
  openCloud(): Promise<void>;
  openCloudInBrowser(): Promise<void>;
  checkCloud(): Promise<CloudCheck>;
  hubSearch(q: string): Promise<{ modules: HubModule[] }>;
  hubBrowse(): Promise<{ modules: HubModule[] }>;
  hubModule(id: number): Promise<{ module: HubModule }>;
  hubEntry(payload: {
    moduleId: number;
    name: string;
    connection: { type?: string; port?: string; ip?: string; networkPort?: string; args?: Record<string, unknown> };
  }): Promise<{ instrument: DeckInstrument; packages: string[]; warnings: string[] }>;

  account(): Promise<AccountInfo>;
  signIn(email: string, password: string): Promise<AccountInfo>;
  signUp(email: string, password: string, name: string): Promise<AccountInfo>;
  resetPassword(email: string): Promise<void>;
  /** Opens the system browser; resolves once the sign-in comes back (or rejects when cancelled). */
  signInWith(provider: 'github' | 'google'): Promise<AccountInfo>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<void>;
  updateProfile(fields: { full_name?: string; lab_info?: string }): Promise<AccountInfo>;
  changePassword(password: string): Promise<void>;
  /** Preview only: no payment is taken (desktop/src/account.js). */
  setPlan(plan: Plan): Promise<AccountInfo>;
  openHub(page: 'profile' | 'signup' | 'home'): Promise<void>;

  gitList(): Promise<GitConnection[]>;
  gitConnect(provider: GitProvider, token: string, host?: string): Promise<GitConnection[]>;
  gitDisconnect(provider: GitProvider): Promise<GitConnection[]>;
  gitRepos(provider: GitProvider, query?: string): Promise<GitRepo[]>;
  gitImport(profileId: string, provider: GitProvider, repoId: string, ref?: string): Promise<GitImport>;
  gitTokenPage(provider: GitProvider): Promise<void>;

  checkForUpdate(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  openUpdatePage(): Promise<void>;
  setAutoUpdate(on: boolean): Promise<void>;
  revealData(): Promise<void>;
}

export type PythonInfo = { ok: boolean; python: string; version?: string; edge?: string | null; prefix?: string; error?: string };

/** The id of the Cloud tab among the open tabs. */
export const CLOUD_TAB = '@cloud';

export type CloudCheck = {
  url: string;
  reachable: boolean;
  /** Answered like an IvoryOS Cloud (its /api/health has the expected shape). */
  isCloud?: boolean;
  /** Cloud's own list of what is wrong on its side, e.g. its daemon not running. */
  problems?: string[];
  error?: string;
  /** When unreachable: an address that does answer as a Cloud, and why it is likely the one meant. */
  suggestion?: { url: string; reason: string };
};

export function desktopApi(): DesktopApi | null {
  if (typeof window === 'undefined') return null;
  return ((window as unknown as { ivoryosDesktop?: DesktopApi }).ivoryosDesktop) ?? null;
}
