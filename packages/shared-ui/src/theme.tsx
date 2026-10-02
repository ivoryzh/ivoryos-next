"use client";
import { useEffect, useState } from 'react';

/**
 * One theme for every IvoryOS page: the launcher, each edge's UI and Cloud.
 *
 * Each page used to keep its own light/dark state under its own origin's localStorage, with a
 * toggle in its own sidebar. In the desktop app those are three origins (the launcher, each edge,
 * Cloud), so switching one left the others as they were -- Cloud stayed dark inside a light app.
 * Now pages do not choose a theme at all; they only show one:
 *
 * - Inside the desktop app the app owns the choice (its Settings) and sets Electron's
 *   `nativeTheme`, which every page it shows sees as `prefers-color-scheme`. A page there follows
 *   the media query and ignores anything it stored itself.
 * - In an ordinary browser the preference is stored per site under THEME_KEY and set from that
 *   site's Settings page; "system" (the default) follows the operating system.
 *
 * `ThemeSync`, mounted once in each app's root layout, applies the result to `<html>` and keeps it
 * current. Components read it with `useDocumentTheme`, which observes the class rather than keeping
 * a copy, so there is exactly one source of truth: the one on screen.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'ivoryos-theme';
const CHANGED = 'ivoryos-theme-changed';

/** Whether the page is shown by the IvoryOS desktop app (its preload exposes this). */
export function inDesktopApp(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { ivoryosDesktop?: unknown }).ivoryosDesktop;
}

export function readThemePreference(): ThemePreference {
  if (typeof window === 'undefined' || inDesktopApp()) return 'system';
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function setThemePreference(pref: ThemePreference) {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, pref);
  } catch { /* not remembered; applied for this page anyway */ }
  window.dispatchEvent(new Event(CHANGED));
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(pref: ThemePreference = readThemePreference()): Theme {
  return pref === 'system' ? systemTheme() : pref;
}

/**
 * Keeps `<html>` in the current theme: `dark` or `light` as its class. `cookie`: also write the
 * resolved theme to that cookie, for a server that renders `<html>` in it (Cloud) and so shows the
 * right theme from the first paint of the next page.
 */
export function ThemeSync({ cookie }: { cookie?: string }) {
  useEffect(() => {
    const apply = () => {
      const theme = resolveTheme();
      const root = document.documentElement;
      root.classList.toggle('dark', theme === 'dark');
      root.classList.toggle('light', theme === 'light');
      root.style.colorScheme = theme;
      if (cookie) document.cookie = `${cookie}=${theme}; path=/; max-age=31536000; samesite=lax`;
    };
    apply();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onStorage = (e: StorageEvent) => { if (e.key === THEME_KEY) apply(); };
    media.addEventListener('change', apply);
    window.addEventListener(CHANGED, apply);
    window.addEventListener('storage', onStorage);
    return () => {
      media.removeEventListener('change', apply);
      window.removeEventListener(CHANGED, apply);
      window.removeEventListener('storage', onStorage);
    };
  }, [cookie]);
  return null;
}

/**
 * The theme the page is showing, read from `<html>`'s class. Starts as `initial` (what the server
 * rendered) and corrects after mount, per AGENTS.md section 11.
 */
export function useDocumentTheme(initial: Theme = 'light'): Theme {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme(root.classList.contains('dark') ? 'dark' : 'light');
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** The stored preference and a setter, for a Settings page in a browser. */
export function useThemePreference(): [ThemePreference, (pref: ThemePreference) => void] {
  const [pref, setPref] = useState<ThemePreference>('system');
  useEffect(() => {
    const read = () => setPref(readThemePreference());
    read();
    window.addEventListener(CHANGED, read);
    return () => window.removeEventListener(CHANGED, read);
  }, []);
  return [pref, (next) => { setThemePreference(next); setPref(next); }];
}

/** System / Light / Dark, as three buttons. In the desktop app the choice lives in its Settings. */
export function ThemeChoice({ value, onChange, className = '' }: { value: ThemePreference; onChange: (pref: ThemePreference) => void; className?: string }) {
  const options: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' },
  ];
  return (
    <div className={`inline-grid grid-cols-3 gap-1 p-1 rounded-lg bg-gray-100 dark:bg-white/5 ${className}`}>
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={`px-3 py-1 rounded-md text-xs font-medium ${value === o.value ? 'bg-white text-accent-fg shadow-sm ring-1 ring-accent-tint/60 dark:bg-accent-soft dark:ring-0' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
