// The tour's simulated lab: one per browser tab, shared by the launcher page and the decks it opens
// (each deck is an iframe of this same origin, src/tour/tabs.ts, which reads its parent's lab). It
// holds what the desktop app and an edge would: profiles, each deck's instruments, workflows and
// runs. Nothing here touches hardware or leaves the page; a reload starts the lab over.
import type { Deck, DeckInstrument, Profile, ProfileStatus } from '@/desktop';
import type { TourEdge } from './edge';

/** Where the tour build is served (next.config.ts). */
export { BASE_PATH as TOUR_BASE } from '@/config';

/** A deck frame's `name` (tabs.ts): which deck's edge the pages inside it talk to. */
export const DECK_FRAME_PREFIX = 'ivoryos-deck:';

/** Where deck frames keep their browser storage (install.ts scopeStorage); a new lab clears it (example.ts). */
export const STORAGE_PREFIX = 'ivoryos-tour-deck:';

type Listener = (...args: unknown[]) => void;

export class Emitter {
  private listeners = new Map<string, Set<Listener>>();
  on(event: string, fn: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => { this.listeners.get(event)?.delete(fn); };
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of [...(this.listeners.get(event) || [])]) {
      try { fn(...args); } catch (e) { console.error('[tour]', e); }
    }
  }
}

/** A method of a simulated instrument, in the shape the edge's introspection reports. */
export type MethodSchema = Record<string, unknown>;

export type LabDeck = {
  profile: Omit<Profile, 'status'> & { status: ProfileStatus };
  deck: Deck;
  /** Per instrument name: its methods (name -> schema), as an edge's introspection reports them. */
  schemas: Record<string, Record<string, MethodSchema>>;
  log: string[];
  /** Its edge: the API its pages call and the queue that runs its workflows (edge.ts). */
  edge: TourEdge;
};

export class Lab extends Emitter {
  readonly decks = new Map<string, LabDeck>();

  profiles(): Profile[] {
    return [...this.decks.values()].map(d => ({ ...d.profile, status: { ...d.profile.status } }));
  }

  get(id: string): LabDeck {
    const d = this.decks.get(id);
    if (!d) throw new Error('That deck is not in the tour.');
    return d;
  }

  log(id: string, line: string) {
    const d = this.get(id);
    d.log.push(line);
    if (d.log.length > 600) d.log.splice(0, d.log.length - 600);
    this.emit('log', id, line);
  }

  setInstruments(id: string, instruments: DeckInstrument[]) {
    this.get(id).deck = { ...this.get(id).deck, instruments };
    this.emit('changed');
  }
}

declare global {
  interface Window { __ivoryosTourLab?: Lab }
}

/** This tab's lab: the launcher's when this page is one of its deck frames, else a new one. */
export function currentLab(create: () => Lab): Lab {
  try {
    const parentLab = window.parent !== window ? window.parent.__ivoryosTourLab : undefined;
    if (parentLab) return parentLab;
  } catch { /* a parent on another origin: not the tour's launcher */ }
  if (!window.__ivoryosTourLab) window.__ivoryosTourLab = create();
  return window.__ivoryosTourLab;
}
