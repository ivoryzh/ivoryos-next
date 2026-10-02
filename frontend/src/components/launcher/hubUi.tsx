"use client";
import React from 'react';
import { Loader2, Lock, Users } from 'lucide-react';
import type { Visibility } from '@/desktop';
import { ownerLabel, visibilityOf } from '@/hubCatalog';

/** The deck profile a Hub add lands on. */
export type DeckTarget = { id: string; name: string };

/**
 * How an add path reaches its deck. The browser is usually opened on a deck (`target`); opened
 * from the sidebar with no deck at all, it has none, and the first thing added creates one --
 * `ensure` asks for its name then and hands it back, so nothing is added into thin air and
 * nobody has to make an empty deck by hand before they can browse.
 */
export type DeckAccess = {
  target: DeckTarget | null;
  /** The deck to add to, made now (suggested `name`, editable) when there is none; null when the person cancels. */
  ensure: (suggestedName: string) => Promise<DeckTarget | null>;
  /** A deck `ensure` just made for an add that then failed: an empty profile nobody asked for. */
  discard: (deck: DeckTarget) => Promise<void>;
};

/**
 * Run `add` against the deck, creating one first when the browser has none. A failed add into a
 * deck made for it removes that deck again; a failed add into an existing deck leaves it as the
 * failure left it (manager.js writes nothing on failure). Returns false when nothing was done.
 */
export async function addTo(access: DeckAccess, suggestedName: string, add: (deck: DeckTarget) => Promise<unknown>): Promise<boolean> {
  const own = access.target;
  const deck = own ?? await access.ensure(suggestedName);
  if (!deck) return false;
  try {
    await add(deck);
  } catch (e) {
    if (!own) await access.discard(deck).catch(() => {});
    throw e;
  }
  return true;
}

/** An instrument name for a deck with nothing on it yet (deckEdit.js's freeName, without the deck). */
export function plainInstrumentName(suggestion: string): string {
  let base = String(suggestion || 'device').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'device';
  return /^[a-z]/.test(base) ? base : `device_${base}`;
}

/** "“My deck”", or what an add says when the deck does not exist yet. */
export function deckLabel(target: DeckTarget | null): string {
  return target ? `“${target.name}”` : 'a new deck';
}

/** Who a private-hub row is shared with. Nothing for a public row. */
export function VisibilityBadge({ row, className = '' }: { row: { visibility?: Visibility | null; organizations?: { name: string } | null }; className?: string }) {
  const label = ownerLabel(row);
  if (!label) return null;
  const Icon = visibilityOf(row) === 'org' ? Users : Lock;
  return (
    <span title={visibilityOf(row) === 'org' ? `Shared with ${label}` : 'Private to you'} className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300 ${className}`}>
      <Icon className="w-3 h-3" /> {label}
    </span>
  );
}

export function Loading({ what }: { what: string }) {
  return <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading {what}…</div>;
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 rounded-lg p-3">{children}</div>;
}

export function Notice({ tone = 'amber', children }: { tone?: 'amber' | 'gray' | 'red'; children: React.ReactNode }) {
  const tones = {
    amber: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:border-amber-500/20',
    gray: 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-white/5 dark:text-gray-300 dark:border-white/10',
    red: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/20',
  };
  return <div className={`text-xs rounded-lg border px-3 py-2 ${tones[tone]}`}>{children}</div>;
}

/** A card in a catalog grid: the whole card is the button that opens the item. */
export function CatalogCard({ onPick, muted, children }: { onPick: () => void; muted?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`group text-left rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden bg-white dark:bg-white/[0.03] hover:border-gray-300 dark:hover:border-white/20 hover:shadow-md dark:hover:border-white/30 transition flex flex-col ${muted ? 'opacity-70' : ''}`}
    >
      {children}
    </button>
  );
}

export function SectionTitle({ icon: Icon, children, count }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode; count?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <Icon className="w-4 h-4 text-gray-400" />
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{children}</h3>
      {count !== undefined && <span className="text-[11px] tabular-nums text-gray-400">{count}</span>}
    </div>
  );
}
