"use client";

import { Settings2, Zap } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';

/**
 * Configure and Optimize are two routes but one destination.
 *
 * They answer the same question — "this workflow has open parameters, what do I put in them?" —
 * and differ only in who picks the values: you, by hand, in a spreadsheet, or the optimizer, one
 * trial at a time. Two sidebar entries made that look like two unrelated places and buried the
 * fact that you can switch. So the sidebar has one entry and the switch lives here, in the page.
 *
 * They stay separate routes deliberately: the deep links already in the app (the Designer's
 * Configure and Optimize buttons) keep working untouched, each page keeps its own bundle, and a
 * bookmark still lands where it did.
 */

export const RUN_TABS = [
  { key: 'configure', href: '/execution', label: 'Configure', icon: Settings2 },
  { key: 'optimize', href: '/optimize', label: 'Optimize', icon: Zap },
] as const;

export type RunTabKey = typeof RUN_TABS[number]['key'];

const STORAGE_KEY = 'ivoryos_run_tab';

/**
 * Route comparison that survives `trailingSlash: true` (see next.config.ts): usePathname()
 * reports "/optimize/" while every href in the app is written "/optimize", so a bare === is
 * always false and nothing ever highlights as current.
 */
export const samePath = (a: string, b: string) =>
  a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** Which of the two tabs a path is, or undefined if it isn't one of them. */
export const runTabForPath = (pathname: string) =>
  RUN_TABS.find(t => samePath(t.href, pathname));

/** Where the sidebar's single entry should point: whichever of the two you were last on. */
export function lastRunTabHref(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const match = RUN_TABS.find(t => t.key === saved);
    if (match) return match.href;
  } catch {
    // Private mode / blocked storage. Falling back to the default is the whole handling needed.
  }
  return '/execution';
}

/**
 * Remembering happens on arrival, not on click: that way *every* route into these pages counts —
 * the tab strip, the Designer's buttons, a bookmark, the back button — and the sidebar sends you
 * back where you actually were rather than only where you last clicked a tab.
 */
export default function RunTabs({ active }: { active: RunTabKey }) {
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, active);
    } catch {
      // Not remembering the tab is a smaller problem than throwing during render.
    }
  }, [active]);

  return (
    <nav className="flex items-center gap-1 p-0.5 rounded-lg bg-gray-100 dark:bg-white/5" aria-label="Run mode">
      {RUN_TABS.map(tab => {
        const Icon = tab.icon;
        const isActive = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={isActive ? 'page' : undefined}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              isActive
                ? 'bg-white text-gray-900 shadow-sm dark:bg-white/10 dark:text-white'
                : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
