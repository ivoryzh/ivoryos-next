"use client";
import React, { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Check, ChevronsUpDown, Maximize2, Minimize2, Plug, X } from 'lucide-react';
import { API_BASE } from '@/config';
import { isPanelPlugin, loadPanel, openInPanel, setPanel, usePanel, type PanelState } from '@/pluginPanel';

type PluginInfo = { id: string; name: string; url: string; placement?: string };
type Rect = { x: number; y: number; w: number; h: number };

const MIN_W = 280;
const MIN_H = 200;
const HEADER = 36;
/** Kept between the window and the edges of the browser window. */
const MARGIN = 8;

function frameSrc(p: PluginInfo) {
  return p.url.startsWith('http') ? p.url : `${API_BASE}${p.url}`;
}

/**
 * The plugin panel: a plugin shown over every page, in a window or full size, so a live view (the
 * bench animation, a camera, a running plot, the liquid handler's worktable) stays in reach while
 * you click through the app and while a workflow runs. Neither size moves the page underneath.
 *
 * Two rules keep the plugin running without interruption:
 * - It lives in the root layout, around the pages, not in any page: client-side navigation
 *   keeps the layout mounted, so moving between pages never reloads the plugin.
 * - It is ONE fixed-position element in both sizes; switching only changes its style. React
 *   therefore keeps the same iframe throughout, where rendering a different element per size
 *   would reload the plugin on every change.
 */
export default function PluginPanelHost({ children }: { children: React.ReactNode }) {
  const onLauncher = (usePathname() || '').startsWith('/launcher');
  const panel = usePanel();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);

  useEffect(() => {
    const saved = loadPanel();
    if (onLauncher) return;
    fetch(`${API_BASE}/api/plugins`)
      .then(r => r.json())
      .then(d => {
        const list: PluginInfo[] = d.plugins || [];
        setPlugins(list);
        // First visit: a panel plugin is meant to be seen, so open it. After that, a panel the
        // person closed stays closed.
        const first = list.find(isPanelPlugin);
        if (!saved.touched && first) openInPanel(first.id, first.placement);
      })
      .catch(() => {});
  }, [onLauncher]);

  const plugin = onLauncher ? undefined : plugins.find(p => p.id === panel.open);
  // Any plugin can be shown here (the nav's right-click menu), so any can be switched to.
  const choices = plugins;

  return (
    <>
      <div className="h-screen w-full overflow-hidden">
        <div className="h-full w-full overflow-auto">{children}</div>
      </div>
      {plugin ? <Panel plugin={plugin} choices={choices} panel={panel} /> : null}
    </>
  );
}

function useViewport() {
  const [vp, setVp] = useState({ w: 1280, h: 800 });
  useEffect(() => {
    const read = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  return vp;
}

/**
 * The page area beside the nav, which full size covers so the nav stays in sight and usable: below
 * the bar along the top, or right of the sidebar. Each page draws its own nav, and a page can draw
 * it a moment after the address changes (measuring on navigation found none, and full size covered
 * the bar), so the nav element is followed whenever it appears or is replaced, and as it changes
 * size (the sidebar expanding).
 */
function usePageArea() {
  const [area, setArea] = useState({ top: 0, left: 0 });
  useEffect(() => {
    let nav: Element | null = null;
    const measure = () => {
      const r = nav?.getBoundingClientRect();
      // Along the top it is wider than it is tall; a sidebar is the other way round.
      const next = !r ? { top: 0, left: 0 } : r.width > r.height ? { top: Math.max(0, r.bottom), left: 0 } : { top: 0, left: Math.max(0, r.right) };
      setArea(prev => (prev.top === next.top && prev.left === next.left ? prev : next));
    };
    const sized = new ResizeObserver(measure);
    const follow = () => {
      const found = document.querySelector('[data-ivoryos-nav-bar]');
      if (found === nav) return;
      if (nav) sized.unobserve(nav);
      nav = found;
      if (nav) sized.observe(nav);
      measure();
    };
    const changed = new MutationObserver(follow);
    changed.observe(document.body, { childList: true, subtree: true });
    const frame = requestAnimationFrame(follow);
    window.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(frame); changed.disconnect(); sized.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  return area;
}

/** Follow the mouse until it is released. An overlay covers everything meanwhile, because the
 * plugin's iframe would otherwise swallow the mouse events once the pointer is over it. */
function useDrag() {
  const [cursor, setCursor] = useState<string | null>(null);
  const start = (e: React.MouseEvent, kind: string, onMove: (dx: number, dy: number) => void, onEnd: () => void) => {
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY;
    setCursor(kind);
    const move = (ev: MouseEvent) => onMove(ev.clientX - x0, ev.clientY - y0);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setCursor(null);
      onEnd();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const overlay = cursor ? <div className="fixed inset-0 z-[10000]" style={{ cursor }} /> : null;
  return { start, overlay };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

function Panel({ plugin, choices, panel }: { plugin: PluginInfo; choices: PluginInfo[]; panel: PanelState }) {
  const vp = useViewport();
  const area = usePageArea();
  const { start, overlay } = useDrag();
  // While dragging, the live geometry is held here and saved once, on release.
  const [live, setLive] = useState<Rect | null>(null);
  // The list of plugins to switch to, open under the name.
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (!picking) return;
    const close = () => setPicking(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    // A click into the plugin's own page blurs this window; a click on this page is a mousedown.
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', onKey); };
  }, [picking]);
  const full = panel.mode === 'full';
  const toggleSize = () => setPanel({ mode: full ? 'window' : 'full' });

  // Esc leaves full size, while the page (not the plugin, which keeps its own keys) has the focus.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanel({ mode: 'window' }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  // The window, kept reachable: a place saved on a larger screen must not strand it.
  const f = live ?? panel.float;
  const fw = clamp(f.w, MIN_W, vp.w - 2 * MARGIN);
  const fh = clamp(f.h, MIN_H, vp.h - 2 * MARGIN);
  const win = { x: clamp(f.x < 0 ? vp.w - fw - 24 : f.x, MARGIN, vp.w - fw - MARGIN), y: clamp(f.y, MARGIN, vp.h - fh - MARGIN), w: fw, h: fh };

  const box: React.CSSProperties = full
    ? { top: area.top, left: area.left, right: 0, bottom: 0 }
    : { left: win.x, top: win.y, width: win.w, height: win.h };

  // Both keep the window inside the browser window as it goes. A place left of the edge used to
  // be saved as a negative x, which is also how "not placed yet" is saved, so a window dragged
  // past the left edge jumped to the right-hand side.
  const moveWindow = (e: React.MouseEvent) => {
    let next = win;
    start(e, 'move', (dx, dy) => {
      next = { ...win, x: clamp(win.x + dx, MARGIN, vp.w - win.w - MARGIN), y: clamp(win.y + dy, MARGIN, vp.h - win.h - MARGIN) };
      setLive(next);
    }, () => { setPanel({ float: next }); setLive(null); });
  };
  const resizeWindow = (e: React.MouseEvent) => {
    let next = win;
    start(e, 'nwse-resize', (dx, dy) => {
      next = { ...win, w: clamp(win.w + dx, MIN_W, vp.w - win.x - MARGIN), h: clamp(win.h + dy, MIN_H, vp.h - win.y - MARGIN) };
      setLive(next);
    }, () => { setPanel({ float: next }); setLive(null); });
  };

  const btn = 'p-1 rounded text-gray-400 hover:text-gray-800 hover:bg-gray-100 dark:hover:text-gray-100 dark:hover:bg-white/10';

  return (
    <div
      className={`fixed flex flex-col bg-white dark:bg-[#0d0d0d] ${
        full ? 'z-[140]' : 'z-[150] border border-gray-200 dark:border-white/15 rounded-xl overflow-hidden shadow-2xl'
      }`}
      style={box}
    >
      <div
        onMouseDown={full ? undefined : moveWindow}
        onDoubleClick={toggleSize}
        title={full ? 'Double-click for a window' : 'Drag to move; double-click for full size'}
        className={`shrink-0 flex items-center gap-1 pl-3 pr-1.5 border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.03] ${full ? '' : 'cursor-move select-none'}`}
        style={{ height: HEADER }}
      >
        <Plug className="w-3.5 h-3.5 text-gray-700 dark:text-gray-200 shrink-0" />
        {/* The switcher is the name itself, its mark right beside it: a dropdown stretched across
            the bar put its arrow next to the window buttons, where it read as one of them. */}
        {choices.length > 1 ? (
          <div className="relative min-w-0" onMouseDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setPicking(o => !o)}
              title="Switch to another plugin"
              aria-haspopup="menu"
              aria-expanded={picking}
              className={`max-w-full flex items-center gap-1 rounded px-1 py-0.5 text-xs font-semibold text-gray-700 dark:text-gray-200 hover:bg-gray-200/70 dark:hover:bg-white/10 ${picking ? 'bg-gray-200/70 dark:bg-white/10' : ''}`}
            >
              <span className="truncate">{plugin.name}</span>
              <ChevronsUpDown className="w-3 h-3 shrink-0 text-gray-400" />
            </button>
            {picking && (
              <div role="menu" className="absolute left-0 top-full mt-1 z-10 w-56 max-h-64 overflow-y-auto py-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] shadow-xl">
                {choices.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    role="menuitem"
                    onClick={() => { setPanel({ open: c.id }); setPicking(false); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10"
                  >
                    <Check className={`w-3.5 h-3.5 shrink-0 ${c.id === plugin.id ? '' : 'invisible'}`} />
                    <span className="truncate">{c.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <span className="min-w-0 truncate px-1 text-xs font-semibold text-gray-700 dark:text-gray-200">{plugin.name}</span>
        )}
        <span className="flex-1" />
        <div className="flex items-center" onMouseDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
          <button type="button" className={btn} title={full ? 'Back to a window (Esc)' : 'Full size'} onClick={toggleSize}>
            {full ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <button type="button" className={btn} title="Close" onClick={() => setPanel({ open: null })}><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden">
        <iframe
          key={plugin.id}
          src={frameSrc(plugin)}
          title={plugin.name}
          className="block w-full h-full border-none bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        />
      </div>

      {!full && (
        <div onMouseDown={resizeWindow} title="Drag to resize" className="absolute right-0 bottom-0 w-4 h-4 cursor-nwse-resize" style={{ background: 'linear-gradient(135deg, transparent 50%, rgba(99,102,241,0.5) 50%)' }} />
      )}
      {overlay}
    </div>
  );
}
