// The tour's decks: the example lab it opens on (fixtures/example-lab.json, the desktop app's
// "Try the example"), and the empty decks a visitor makes from the launcher or the Hub.
import type { Deck, Profile } from '@/desktop';
import { TourEdge } from './edge';
import exampleLab from './fixtures/example-lab.json';
import { Lab, type LabDeck, type MethodSchema, STORAGE_PREFIX, TOUR_BASE } from './lab';

export const EXAMPLE_ID = 'example';

let nextPort = 8001;

/** A deck profile in the lab, with its own edge (its own library and run history, as a data folder gives). */
export function addDeck(lab: Lab, fields: { id?: string; name: string; deck?: Deck; schemas?: Record<string, Record<string, MethodSchema>>; workflows?: unknown[]; running?: boolean }): LabDeck {
  const id = fields.id || Math.random().toString(36).slice(2, 8);
  const port = id === EXAMPLE_ID ? 8000 : nextPort++;
  const profile: Omit<Profile, 'status'> & { status: Profile['status'] } = {
    id, name: fields.name, kind: 'deck', port, listenOnNetwork: false, autoStart: true, env: {},
    deck: 'deck.json', problems: [], windowOpen: false,
    status: fields.running
      ? { state: 'running', port, url: `${location.origin}${TOUR_BASE}/deck-${id}` }
      : { state: 'stopped', port, url: null },
  };
  const entry = { profile, deck: fields.deck || { format: 'ivoryos-deck/1', name: fields.name, packages: [], instruments: [] }, schemas: fields.schemas || {}, log: [] } as unknown as LabDeck;
  entry.edge = new TourEdge(entry, fields.workflows || []);
  lab.decks.set(id, entry);
  return entry;
}

/**
 * A new lab holding the example deck, running, with its instruments loaded and two sample workflows.
 * Opened to build a lab (the Hub site's "Build My Lab": `?hub`, which also opens the launcher in the
 * Hub browser), an empty "My lab" comes first, so the Hub adds to it and the example stays to look at.
 */
export function createExampleLab(): Lab {
  const lab = new Lab();
  // A new lab starts clean: no deck's Designer canvas or run rows left from an earlier visit.
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
  } catch { /* storage blocked: nothing was kept either */ }
  if (new URLSearchParams(location.search).has('hub')) {
    const mine = addDeck(lab, { name: 'My lab', running: true });
    mine.log.push('Starting My lab (simulated)…', 'Ready. No instruments yet: add some from the Hub.');
  }
  const example = addDeck(lab, {
    id: EXAMPLE_ID,
    name: 'Example lab',
    deck: exampleLab.deck as Deck,
    schemas: exampleLab.instruments as Record<string, Record<string, MethodSchema>>,
    workflows: exampleLab.workflows,
    running: true,
  });
  example.log.push('Starting Example lab (simulated)…');
  for (const inst of example.deck.instruments || []) example.log.push(`  ${inst.name}: loaded (simulated ${inst.class})`);
  example.log.push('Ready.');
  return lab;
}
