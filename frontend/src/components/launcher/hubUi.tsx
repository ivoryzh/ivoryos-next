"use client";
import React from 'react';
import { Loader2, Lock, Users } from 'lucide-react';
import type { Visibility } from '@/desktop';
import { ownerLabel, visibilityOf } from '@/hubCatalog';

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
      className={`group text-left rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden bg-white dark:bg-white/[0.03] hover:border-indigo-300 hover:shadow-md dark:hover:border-indigo-500/40 transition flex flex-col ${muted ? 'opacity-70' : ''}`}
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
