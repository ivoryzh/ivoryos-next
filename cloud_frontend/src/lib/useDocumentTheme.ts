"use client";

import { useEffect, useState } from 'react';

/**
 * The theme the page is actually showing, read from `<html>`'s class rather than kept as a copy.
 *
 * Cloud is dark unless `localStorage.theme` says 'light' (layout.tsx applies that before first
 * paint, and the Sidebar owns the toggle). A page that kept its own theme state and "restored" it
 * on mount got that default wrong -- Edge Sequence read a missing value as light and stripped the
 * `dark` class, so opening it flipped the whole app to light mode. It also never heard about the
 * Sidebar's toggle. Observing the class fixes both: there is one source of truth, and it is the
 * one on screen.
 *
 * Starts as 'dark' (the server render's theme) and corrects after mount, per AGENTS.md section 11.
 */
export function useDocumentTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme(root.classList.contains('light') || !root.classList.contains('dark') ? 'light' : 'dark');
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
