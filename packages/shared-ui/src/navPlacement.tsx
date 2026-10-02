"use client";
import { useEffect, useState } from 'react';
import { inDesktopApp } from './theme';

/**
 * Where an app's navigation sits: a sidebar down the left, or a bar across the top.
 *
 * As a standalone website the sidebar reads fine. Inside the desktop app it does not: the app
 * already has a sidebar of its own (the launcher's deck list), so an edge page or Cloud opened in
 * a tab there showed two sidebars side by side, splitting the window into columns. So inside the
 * desktop app it is always the top bar, and in a browser each app's Settings page lets the person
 * choose (the sidebar by default). The choice is per browser (localStorage
 * under this app's origin), like the collapsed state of the sidebar.
 *
 * The chosen placement is also written to `<html data-ivoryos-nav>`, which is what lets each
 * page's frame -- a flex row of sidebar and page in every page file -- turn into a column with
 * one stylesheet rule instead of an edit to every page.
 */
export type NavPlacement = 'side' | 'top';

export const NAV_PLACEMENT_KEY = 'ivoryos-nav';
const CHANGED = 'ivoryos-nav-changed';

export function defaultNavPlacement(): NavPlacement {
  return inDesktopApp() ? 'top' : 'side';
}

export function readNavPlacement(): NavPlacement {
  if (typeof window === 'undefined') return 'side';
  // Inside the desktop app it is not a choice: the launcher's own sidebar is down the left, and a
  // second one beside it split the window into columns. Its Settings pages offer no switch there.
  if (inDesktopApp()) return 'top';
  try {
    const v = localStorage.getItem(NAV_PLACEMENT_KEY);
    if (v === 'side' || v === 'top') return v;
  } catch { /* private window, blocked storage */ }
  return defaultNavPlacement();
}

function applyNavPlacement(p: NavPlacement) {
  if (typeof document !== 'undefined') document.documentElement.dataset.ivoryosNav = p;
}

export function setNavPlacement(p: NavPlacement) {
  try { localStorage.setItem(NAV_PLACEMENT_KEY, p); } catch { /* ignore */ }
  applyNavPlacement(p);
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * The placement and a setter. Starts at 'side' on every render the server could have made and
 * corrects after mount (AGENTS.md section 11), applying the attribute the frame rule reads.
 */
export function useNavPlacement(): [NavPlacement, (p: NavPlacement) => void] {
  const [placement, setPlacement] = useState<NavPlacement>('side');
  useEffect(() => {
    const read = () => { const p = readNavPlacement(); setPlacement(p); applyNavPlacement(p); };
    read();
    window.addEventListener(CHANGED, read);
    return () => window.removeEventListener(CHANGED, read);
  }, []);
  return [placement, setNavPlacement];
}

/** Side / Top, as two buttons, in the same shape as ThemeChoice. */
export function NavPlacementChoice({ value, onChange, className = '' }: { value: NavPlacement; onChange: (p: NavPlacement) => void; className?: string }) {
  const options: { value: NavPlacement; label: string }[] = [{ value: 'side', label: 'Left sidebar' }, { value: 'top', label: 'Top bar' }];
  return (
    <div className={`inline-grid grid-cols-2 gap-1 p-1 rounded-lg bg-gray-100 dark:bg-white/5 ${className}`}>
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={`px-3 py-1 rounded-md text-xs font-medium ${value === o.value ? 'bg-white text-accent-fg shadow-sm ring-1 ring-accent-tint/60 dark:bg-accent-soft dark:ring-0' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
