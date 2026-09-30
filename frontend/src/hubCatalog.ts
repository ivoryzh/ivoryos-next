/**
 * The launcher's rules for what the Hub offers: which rows belong to the public or the private
 * hub, how a platform's drivers are named on a deck, and whether a workflow template fits a deck.
 * Pure, so the rules are checked without the app (hubCatalog.test.ts).
 */
import type { Deck, HubTemplate, Visibility } from '@/desktop';

export type Scope = 'public' | 'private';

type Owned = { visibility?: Visibility | null; organizations?: { name: string } | null };

/** A row with no visibility comes from a Hub before the private hub existed: those were all public. */
export function visibilityOf(row: Owned): Visibility {
  return row.visibility || 'public';
}

/** The public hub shows public rows; the private hub shows the caller's own and their teams'. */
export function inScope(row: Owned, scope: Scope): boolean {
  return (visibilityOf(row) === 'public') === (scope === 'public');
}

/** Who a private-hub row is shared with, for its badge. */
export function ownerLabel(row: Owned): string | null {
  const v = visibilityOf(row);
  if (v === 'private') return 'Only you';
  if (v === 'org') return row.organizations?.name || 'Your organization';
  return null;
}

/**
 * A deck instrument name from a suggestion, free among `used`: the same rule as the launcher's
 * `freeName` (desktop/src/deckEdit.js), applied locally so a platform's several drivers get
 * distinct names before any of them is on the deck.
 */
export function uniqueName(suggestion: string, used: Iterable<string>): string {
  let base = String(suggestion || 'device').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'device';
  if (!/^[a-z]/.test(base)) base = `device_${base}`;
  const taken = new Set(used);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/** Names for a list of suggestions, each unique among `used` and among each other. */
export function uniqueNames(suggestions: string[], used: Iterable<string>): string[] {
  const taken = new Set(used);
  return suggestions.map(s => {
    const name = uniqueName(s, taken);
    taken.add(name);
    return name;
  });
}

export type TemplateFit = {
  /** Instruments the template's steps call that the deck has no instrument of that name for. */
  missing: string[];
  /** True when every instrument it calls is on the deck. */
  fits: boolean;
};

/**
 * Whether a template's steps can run on a deck, judged the way the edge will judge it: by
 * instrument name. Hub module ids are not used, since a deck names its instruments freely and a
 * step calls a name, so a template made for the same drivers can still miss (and a hand-added
 * instrument with the right name can still fit). Unfit templates can still be added; the edge's
 * Library marks their steps, and they can be re-pointed in the Designer.
 */
export function templateFit(template: Pick<HubTemplate, 'instruments'>, deck: Deck | null): TemplateFit {
  const onDeck = new Set((deck?.instruments || []).filter(i => i.enabled !== false).map(i => i.name));
  const missing = (template.instruments || []).filter(name => !onDeck.has(name));
  return { missing, fits: missing.length === 0 };
}

/** Every requirement once, in first-seen order. */
export function unionPackages(...lists: string[][]): string[] {
  const out: string[] = [];
  for (const list of lists) for (const p of list) if (p && !out.includes(p)) out.push(p);
  return out;
}
