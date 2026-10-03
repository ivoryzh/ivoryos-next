// Turns a page of the tour build into a page of the desktop app on a simulated lab (README.md):
//
//   - `fetch` to the edge (`/api/...`, the same origin, as every page calls it: src/config.ts) and the
//     queue's WebSocket (`/api/ws/queue`) reach the deck's simulated edge (edge.ts) instead;
//   - the launcher page gets the desktop app's API (desktop.ts), as Electron's preload gives it.
//
// Deck pages run in the launcher's iframes (tabs.ts) and share its lab (lab.ts currentLab); the
// frame's name says which deck's edge they talk to. Everything else (the Hub's own servers, fonts)
// goes out as usual.
import { makeDesktopApi } from './desktop';
import type { TourEdge } from './edge';
import { createExampleLab, EXAMPLE_ID } from './example';
import { currentLab, DECK_FRAME_PREFIX, STORAGE_PREFIX, TOUR_BASE } from './lab';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// `/api/x`, or a deck's own address `${TOUR_BASE}/deck-<id>/api/x` (the launcher's absolute
// `${profile.status.url}/api/...` calls; example.ts sets those URLs).
const EDGE_PATH = new RegExp(`^(?:${escape(TOUR_BASE)}(?:/deck-([\\w-]+))?)?/api/(.*)$`);

let installed = false;

export function installTour() {
  if (installed) return;
  installed = true;
  const realFetch = window.fetch.bind(window);
  const lab = currentLab(createExampleLab);
  const frameDeck = window.name.startsWith(DECK_FRAME_PREFIX) ? window.name.slice(DECK_FRAME_PREFIX.length) : null;
  // Each deck keeps its own browser storage, as each is its own origin in the app (127.0.0.1:8000,
  // :8001): the Designer's working copy, a run page's rows, the cached schema. Every deck is this one
  // origin here, so a deck frame sees only the keys under its own prefix.
  if (frameDeck) {
    scopeStorage('localStorage', `${STORAGE_PREFIX}${frameDeck}:`);
    scopeStorage('sessionStorage', `${STORAGE_PREFIX}${frameDeck}:`);
  }

  const edgeFor = (deckId: string | undefined) => {
    const id = deckId || frameDeck || (lab.decks.has(EXAMPLE_ID) ? EXAMPLE_ID : [...lab.decks.keys()][0]);
    const deck = id ? lab.decks.get(id) : undefined;
    if (!deck || deck.profile.status.state !== 'running') return null;
    return deck.edge;
  };

  const match = (raw: string) => {
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin) return null;
    const m = EDGE_PATH.exec(url.pathname);
    return m ? { deckId: m[1], path: `/${m[2]}`, query: url.searchParams } : null;
  };

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const hit = match(raw);
    if (!hit) return realFetch(input, init);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body: unknown = null;
    const text = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
    const edge = edgeFor(hit.deckId);
    // A stopped deck answers like a stopped edge: nothing is listening.
    if (!edge) throw new TypeError('Failed to fetch');
    await new Promise(r => setTimeout(r, 15));
    const { status, body: out } = await edge.handle(method, hit.path, hit.query, body);
    return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
  };

  const RealWebSocket = window.WebSocket;
  function TourWebSocket(this: unknown, url: string | URL, protocols?: string | string[]) {
    const hit = match(String(url).replace(/^ws/, 'http'));
    if (!hit || hit.path !== '/ws/queue') return new RealWebSocket(url, protocols);
    return new QueueSocket(String(url), () => edgeFor(hit.deckId));
  }
  Object.assign(TourWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  TourWebSocket.prototype = RealWebSocket.prototype;
  window.WebSocket = TourWebSocket as unknown as typeof WebSocket;

  // The launcher, as Electron's preload would give it. Deck pages see it too, as in the app
  // (shared-ui inDesktopApp), which is what lays them out as a desktop tab.
  let parentApi: unknown = null;
  try { parentApi = frameDeck && window.parent !== window ? window.parent.ivoryosDesktop : null; } catch { /* another origin */ }
  window.ivoryosDesktop = parentApi || makeDesktopApi(lab, realFetch);
}

/** This window's `localStorage` or `sessionStorage`, narrowed to the keys under `prefix`. */
function scopeStorage(which: 'localStorage' | 'sessionStorage', prefix: string) {
  const real = window[which];
  const keys = () => Array.from({ length: real.length }, (_, i) => real.key(i)).filter((k): k is string => !!k && k.startsWith(prefix));
  const scoped: Storage = {
    get length() { return keys().length; },
    key: i => keys()[i]?.slice(prefix.length) ?? null,
    getItem: k => real.getItem(prefix + k),
    setItem: (k, v) => real.setItem(prefix + k, String(v)),
    removeItem: k => real.removeItem(prefix + k),
    clear: () => keys().forEach(k => real.removeItem(k)),
  };
  Object.defineProperty(window, which, { configurable: true, get: () => scoped });
}

/** The queue WebSocket of a simulated edge: one snapshot on connect, then every change, like queue.py's. */
class QueueSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = 'blob';
  bufferedAmount = 0;
  extensions = '';
  protocol = '';
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(readonly url: string, edge: () => TourEdge | null) {
    super();
    setTimeout(() => {
      const target = edge();
      if (!target) { this.fire(new Event('error')); this.finish(); return; }
      this.readyState = 1;
      this.fire(new Event('open'));
      this.unsubscribe = target.subscribe(payload => {
        if (this.readyState === 1) this.fire(new MessageEvent('message', { data: JSON.stringify(payload) }));
      });
    }, 0);
  }

  send() { /* the edge's queue socket never reads what a page sends */ }

  close() {
    if (this.readyState >= 2) return;
    this.finish();
  }

  private finish() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.readyState = 3;
    this.fire(new CloseEvent('close', { code: 1000, wasClean: true }));
  }

  private fire(event: Event) {
    this.dispatchEvent(event);
    const handler = (this as unknown as Record<string, ((e: Event) => void) | null>)[`on${event.type}`];
    handler?.call(this, event);
  }
}

declare global {
  interface Window { ivoryosDesktop?: unknown }
}
