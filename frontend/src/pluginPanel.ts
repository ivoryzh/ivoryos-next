"use client";
import { useSyncExternalStore } from 'react';

/**
 * Where the plugin panel is and what it shows, shared by the panel itself (PluginPanel, mounted
 * once in the root layout so it survives navigation) and the sidebar's plugin entries, which
 * open plugins into it. Saved per browser in localStorage.
 */
export type PanelMode = 'dock' | 'float';
export type PanelSide = 'left' | 'right';
export type FloatRect = { x: number; y: number; w: number; h: number };

export type PanelState = {
  /** The plugin shown, or null when the panel is closed. */
  open: string | null;
  mode: PanelMode;
  side: PanelSide;
  /** Docked width in px. */
  width: number;
  /** Shown as a small floating window, whatever `mode` is; restoring returns to `mode`/`side`.
   * The plugin keeps running (and showing, scaled down) the whole time. */
  minimized: boolean;
  float: FloatRect;
  /** Where the minimized window sits; -1 means "not placed yet": bottom right. */
  mini: { x: number; y: number };
  /** Set once anything has been saved: the first visit opens a panel plugin by default, later
   * visits respect a panel the person closed. */
  touched: boolean;
};

const KEY = 'ivoryos_plugin_panel';
export const DEFAULT_PANEL: PanelState = {
  open: null, mode: 'dock', side: 'right', width: 420, minimized: false,
  float: { x: -1, y: 96, w: 420, h: 560 }, mini: { x: -1, y: -1 }, touched: false,
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
      state = { ...DEFAULT_PANEL, ...saved, float: { ...DEFAULT_PANEL.float, ...(saved.float || {}) }, mini: { ...DEFAULT_PANEL.mini, ...(saved.mini || {}) } };
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

/** Show a plugin in the panel, restoring it if minimized; its placement picks the side the
 * first time. */
export function openInPanel(id: string, placement?: string) {
  const side = !state.touched && placement === 'panel-left' ? 'left' : state.side;
  setPanel({ open: id, minimized: false, side });
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
