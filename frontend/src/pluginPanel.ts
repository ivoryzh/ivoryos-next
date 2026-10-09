"use client";
import { useSyncExternalStore } from 'react';

/**
 * Where the plugin panel is and what it shows, shared by the panel itself (PluginPanel, mounted
 * once in the root layout so it survives navigation) and the nav's plugin entries, which open
 * plugins into it. Saved per browser in localStorage.
 *
 * Two sizes: a window floating over the pages, or full size over the page area (the nav stays in
 * sight). Neither moves the page. Docking beside the page squeezed every page each time it
 * opened, and a minimized window showed the plugin scaled down past reading, so both went; a
 * state saved with either opens as a window.
 */
export type PanelMode = 'window' | 'full';
export type FloatRect = { x: number; y: number; w: number; h: number };

export type PanelState = {
  /** The plugin shown, or null when the panel is closed. */
  open: string | null;
  mode: PanelMode;
  /** The window's place and size. An x below 0 means "not placed yet": the right-hand side. */
  float: FloatRect;
  /** Set once anything has been saved: the first visit opens a panel plugin by default, later
   * visits respect a panel the person closed. */
  touched: boolean;
};

const KEY = 'ivoryos_plugin_panel';
export const DEFAULT_PANEL: PanelState = {
  open: null, mode: 'window', float: { x: -1, y: 96, w: 420, h: 560 }, touched: false,
};

let state: PanelState = DEFAULT_PANEL;
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(l => l());
}

/** Read the saved state; called after hydration so the first render matches the static HTML. */
export function loadPanel(): PanelState {
  if (loaded || typeof window === 'undefined') return state;
  loaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved === 'object') {
      state = {
        open: typeof saved.open === 'string' ? saved.open : null,
        mode: saved.mode === 'full' ? 'full' : 'window',
        float: { ...DEFAULT_PANEL.float, ...(saved.float || {}) },
        touched: !!saved.touched,
      };
    }
  } catch { /* private window or bad JSON: defaults */ }
  emit();
  return state;
}

export function setPanel(patch: Partial<PanelState>) {
  state = { ...state, ...patch, touched: true };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* not persisted */ }
  emit();
}

/**
 * Show a plugin in the panel, in `mode` or the size it was last shown at. A `panel-left` plugin's
 * window starts on the left, the first time it is placed.
 */
export function openInPanel(id: string, placement?: string, mode?: PanelMode) {
  const unplaced = state.float.x < 0;
  setPanel({
    open: id,
    mode: mode ?? state.mode,
    ...(unplaced && placement === 'panel-left' ? { float: { ...state.float, x: 24 } } : {}),
  });
}

export function usePanel(): PanelState {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => state,
    () => DEFAULT_PANEL,
  );
}

export function isPanelPlugin(p: { placement?: string }) {
  return p.placement === 'panel-left' || p.placement === 'panel-right';
}
