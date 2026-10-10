"use client";
import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * The one assistant: whether its panel is open, which mode it is in, and what the page it is open
 * over has told it (components/AssistantPanel.tsx, mounted once in the root layout).
 *
 * A page says where the person is and, on the Designer, hands over its canvas (`useAssistantPage`),
 * so one panel can draft onto the canvas there, propose safety on the Safety page and answer about
 * the selected run on Data History. And the panel asks a page to do something it owns (open a run,
 * review a safety proposal) with `sendPageRequest`, which reaches the page when it is already open
 * and, when it is not, travels in the address (`?run=`, `?proposal=`) for the page to read on load.
 */

export type AssistantMode = 'ask' | 'workflow' | 'safety';

/** A workflow in the saved shape (prep/script/cleanup of {instrument, action, args, ...}). */
export type SavedBody = { name?: string; description?: string; prep: any[]; script: any[]; cleanup: any[] };

/** What the Designer lends the assistant: its canvas, and a way to replace it. */
export type DesignerBridge = {
  getBody: () => SavedBody;
  hasSteps: () => boolean;
  apply: (body: SavedBody) => void;
};

export type AssistantPage = {
  /** 'designer', 'safety', 'data', ... */
  page: string;
  /** Where the person is, in words the model can use ("Data History, run #12 'Plate' selected"). */
  describe?: string;
  defaultMode?: AssistantMode;
  designer?: DesignerBridge;
};

type State = { open: boolean; mode: AssistantMode | null; page: AssistantPage | null };

const OPEN_KEY = 'ivoryos_assistant_open';
let state: State = { open: false, mode: null, page: null };
const listeners = new Set<() => void>();
const SERVER_STATE: State = { open: false, mode: null, page: null };

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useAssistant(): State {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}

function remember(open: boolean) {
  try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* per-viewer convenience only */ }
}

/** Open the panel, in `mode` when given (else the page's default, or what was chosen). */
export function openAssistant(mode?: AssistantMode) {
  set({ open: true, ...(mode ? { mode } : {}) });
  remember(true);
}

export function closeAssistant() {
  set({ open: false });
  remember(false);
}

export function toggleAssistant() {
  if (state.open) closeAssistant(); else openAssistant();
}

export function setAssistantMode(mode: AssistantMode) {
  set({ mode });
}

/** Read back after hydration (AGENTS.md section 11): the panel stays open across full reloads. */
export function restoreAssistantOpen() {
  try { if (localStorage.getItem(OPEN_KEY) === '1') set({ open: true }); } catch { /* fine */ }
}

/** The mode a page opens the assistant in, when the person has not chosen one there. */
export function defaultMode(page: AssistantPage | null, pathname: string): AssistantMode {
  if (page?.defaultMode) return page.defaultMode;
  if (pathname.startsWith('/designer')) return 'workflow';
  if (pathname.startsWith('/safety')) return 'safety';
  return 'ask';
}

/**
 * Tell the assistant about this page while it is mounted. `page` is re-read whenever `deps`
 * change; leaving the page clears it, and a different page resets the mode to that page's default.
 */
export function useAssistantPage(page: AssistantPage | null, deps: unknown[]) {
  const latest = useRef(page);
  latest.current = page;
  useEffect(() => {
    const next = latest.current;
    set({ page: next, ...(state.page?.page !== next?.page ? { mode: null } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => () => { if (state.page?.page === latest.current?.page) set({ page: null, mode: null }); }, []);
}

// --- asking a page to act ----------------------------------------------------------------------

export type PageRequestKind = 'open-run' | 'review-safety';
const REQUEST_EVENT = 'ivoryos:assistant-request';
/** The address parameter that carries a request to a page that is not open yet. */
export const REQUEST_PARAM: Record<PageRequestKind, string> = { 'open-run': 'run', 'review-safety': 'proposal' };
export const REQUEST_PAGE: Record<PageRequestKind, string> = { 'open-run': '/data', 'review-safety': '/safety' };

/** Ask the page that owns `kind` to act on `id`. Returns false when that page is not the one open
 * (the caller then navigates to `REQUEST_PAGE[kind]?param=id`). */
export function sendPageRequest(kind: PageRequestKind, id: number): boolean {
  if (typeof window === 'undefined') return false;
  const here = window.location.pathname.replace(/\/+$/, '');
  if (!here.endsWith(REQUEST_PAGE[kind])) return false;
  window.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: { kind, id } }));
  return true;
}

/** Act on requests of `kind`: one in the address when the page loads, and any sent while it is open. */
export function usePageRequest(kind: PageRequestKind, handler: (id: number) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const fromAddress = Number(new URLSearchParams(window.location.search).get(REQUEST_PARAM[kind]));
    if (Number.isInteger(fromAddress) && fromAddress > 0) latest.current(fromAddress);
    const listen = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.kind === kind) latest.current(Number(detail.id));
    };
    window.addEventListener(REQUEST_EVENT, listen);
    return () => window.removeEventListener(REQUEST_EVENT, listen);
  }, [kind]);
}

/** Drop a request parameter from the address once it has been acted on, without navigating. */
export function clearRequestParam(kind: PageRequestKind) {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(REQUEST_PARAM[kind])) return;
  url.searchParams.delete(REQUEST_PARAM[kind]);
  window.history.replaceState(window.history.state, '', url.toString());
}
