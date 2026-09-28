"use client";
import React, { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Maximize2, Minus, PanelLeft, PanelRight, PictureInPicture2, Plug, X } from 'lucide-react';
import { API_BASE } from '@/config';
import { isPanelPlugin, loadPanel, openInPanel, setPanel, usePanel, type PanelState } from '@/pluginPanel';

type PluginInfo = { id: string; name: string; url: string; placement?: string };
type Rect = { x: number; y: number; w: number; h: number };

const MIN_W = 280;
const MIN_H = 200;
const HEADER = 36;
/** The minimized window: small, but still the live plugin, scaled down. */
const MINI_W = 300;
const MINI_BODY_H = 220;
/** The width the plugin is laid out at inside the minimized window, before being scaled down to
 * MINI_W. Fixed rather than the docked width: a narrow dock would otherwise scale it *up*. */
const MINI_LAYOUT_W = 440;

function frameSrc(p: PluginInfo) {
  return p.url.startsWith('http') ? p.url : `${API_BASE}${p.url}`;
}

/**
 * The plugin panel: a plugin shown beside every page, docked left or right, floating over the
 * pages, or minimized to a small floating window, so a live view (the bench animation, a camera,
 * a running plot) stays in sight while you click through the app and while a workflow runs.
 *
 * Two rules keep the plugin running without interruption:
 * - It lives in the root layout, around the pages, not in any page: client-side navigation
 *   keeps the layout mounted, so moving between pages never reloads the plugin.
 * - It is ONE fixed-position element in every state; docking, floating, minimizing and changing
 *   sides only change its style. React therefore keeps the same iframe throughout, where
 *   rendering a different element per state would reload the plugin on every change. Docking
 *   makes room by padding the page area, which is likewise always the same element, so the page
 *   underneath is never remounted either.
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
  const docked = !!plugin && panel.mode === 'dock' && !panel.minimized;
  const padLeft = docked && panel.side === 'left' ? panel.width : 0;
  const padRight = docked && panel.side === 'right' ? panel.width : 0;

  // Fixed-position things pinned to the right edge (the queue status pill) move aside for a
  // panel docked there.
  useEffect(() => {
    document.documentElement.style.setProperty('--ivoryos-dock-right', `${padRight}px`);
  }, [padRight]);

  const choices = plugins.filter(p => isPanelPlugin(p) || p.id === panel.open);

  return (
    <>
      <div className="h-screen w-full overflow-hidden" style={{ paddingLeft: padLeft, paddingRight: padRight }}>
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
  const { start, overlay } = useDrag();
  // While dragging, the live geometry is held here and saved once, on release.
  const [live, setLive] = useState<Partial<{ width: number; float: Rect; mini: { x: number; y: number } }>>({});
  const state: 'dock' | 'float' | 'mini' = panel.minimized ? 'mini' : panel.mode;
  const right = panel.side === 'right';

  const width = live.width ?? panel.width;

  // Floating: kept reachable, since a position saved on a larger screen must not strand it.
  const f = live.float ?? panel.float;
  const fw = clamp(f.w, MIN_W, vp.w - 16);
  const fh = clamp(f.h, MIN_H, vp.h - 16);
  const float = { x: clamp(f.x < 0 ? vp.w - fw - 24 : f.x, 8, vp.w - fw - 8), y: clamp(f.y, 8, vp.h - fh - 8), w: fw, h: fh };

  // Minimized: bottom right by default, clear of the queue status card (taller while a run is on).
  const m = live.mini ?? panel.mini;
  const miniH = HEADER + MINI_BODY_H;
  const mini = { x: clamp(m.x < 0 ? vp.w - MINI_W - 16 : m.x, 8, vp.w - MINI_W - 8), y: clamp(m.y < 0 ? vp.h - miniH - 110 : m.y, 8, vp.h - miniH - 8) };

  const box: React.CSSProperties =
    state === 'dock' ? { top: 0, bottom: 0, width, ...(right ? { right: 0 } : { left: 0 }) }
    : state === 'float' ? { left: float.x, top: float.y, width: float.w, height: float.h }
    : { left: mini.x, top: mini.y, width: MINI_W, height: miniH };

  // The minimized window shows the plugin laid out at its normal width, scaled down to fit, so
  // the whole view stays visible rather than its top-left corner.
  const scale = MINI_W / MINI_LAYOUT_W;
  const frameStyle: React.CSSProperties = state === 'mini'
    ? { width: MINI_LAYOUT_W, height: MINI_BODY_H / scale, transform: `scale(${scale})`, transformOrigin: 'top left' }
    : { width: '100%', height: '100%' };

  const resizeDock = (e: React.MouseEvent) => {
    let w = panel.width;
    start(e, 'col-resize', (dx) => { w = clamp(panel.width + (right ? -dx : dx), MIN_W, vp.w * 0.7); setLive({ width: w }); },
      () => { setPanel({ width: Math.round(w) }); setLive({}); });
  };
  const moveFloat = (e: React.MouseEvent) => {
    let next = float;
    start(e, 'move', (dx, dy) => { next = { ...float, x: float.x + dx, y: float.y + dy }; setLive({ float: next }); },
      () => { setPanel({ float: next }); setLive({}); });
  };
  const resizeFloat = (e: React.MouseEvent) => {
    let next = float;
    start(e, 'nwse-resize', (dx, dy) => { next = { ...float, w: Math.max(MIN_W, float.w + dx), h: Math.max(MIN_H, float.h + dy) }; setLive({ float: next }); },
      () => { setPanel({ float: next }); setLive({}); });
  };
  const moveMini = (e: React.MouseEvent) => {
    let next = mini;
    start(e, 'move', (dx, dy) => { next = { x: mini.x + dx, y: mini.y + dy }; setLive({ mini: next }); },
      () => { setPanel({ mini: next }); setLive({}); });
  };

  const btn = 'p-1 rounded text-gray-400 hover:text-gray-800 hover:bg-gray-100 dark:hover:text-gray-100 dark:hover:bg-white/10';
  const dragHandle = state === 'float' ? moveFloat : state === 'mini' ? moveMini : undefined;

  return (
    <div
      className={`fixed flex flex-col bg-white dark:bg-[#0d0d0d] border-gray-200 dark:border-white/15 ${
        state === 'dock' ? `z-[140] ${right ? 'border-l' : 'border-r'}` : 'z-[150] border rounded-xl overflow-hidden shadow-2xl'
      }`}
      style={box}
    >
      <div
        onMouseDown={dragHandle}
        onDoubleClick={state === 'mini' ? () => setPanel({ minimized: false }) : undefined}
        className={`shrink-0 flex items-center gap-1 pl-3 pr-1.5 border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.03] ${dragHandle ? 'cursor-move select-none' : ''}`}
        style={{ height: HEADER }}
      >
        <Plug className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
        {choices.length > 1 && state !== 'mini' ? (
          <select
            value={plugin.id}
            onMouseDown={e => e.stopPropagation()}
            onChange={e => setPanel({ open: e.target.value })}
            className="min-w-0 flex-1 bg-transparent text-xs font-semibold text-gray-700 dark:text-gray-200 focus:outline-none"
          >
            {choices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-700 dark:text-gray-200">{plugin.name}</span>
        )}
        <div className="flex items-center" onMouseDown={e => e.stopPropagation()}>
          {state === 'dock' && (
            <>
              <button type="button" className={btn} title={right ? 'Dock on the left' : 'Dock on the right'} onClick={() => setPanel({ side: right ? 'left' : 'right' })}>
                {right ? <PanelLeft className="w-3.5 h-3.5" /> : <PanelRight className="w-3.5 h-3.5" />}
              </button>
              <button type="button" className={btn} title="Float over the page" onClick={() => setPanel({ mode: 'float' })}><PictureInPicture2 className="w-3.5 h-3.5" /></button>
            </>
          )}
          {state === 'float' && (
            <button type="button" className={btn} title={`Dock on the ${panel.side}`} onClick={() => setPanel({ mode: 'dock' })}>
              {right ? <PanelRight className="w-3.5 h-3.5" /> : <PanelLeft className="w-3.5 h-3.5" />}
            </button>
          )}
          {state === 'mini' ? (
            <button type="button" className={btn} title={panel.mode === 'dock' ? `Restore (docked on the ${panel.side})` : 'Restore'} onClick={() => setPanel({ minimized: false })}><Maximize2 className="w-3.5 h-3.5" /></button>
          ) : (
            <button type="button" className={btn} title="Minimize to a small window (keeps running)" onClick={() => setPanel({ minimized: true })}><Minus className="w-3.5 h-3.5" /></button>
          )}
          <button type="button" className={btn} title="Close" onClick={() => setPanel({ open: null })}><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden">
        <iframe
          key={plugin.id}
          src={frameSrc(plugin)}
          title={plugin.name}
          className="block border-none bg-white"
          style={frameStyle}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        />
      </div>

      {state === 'dock' && (
        <div
          onMouseDown={resizeDock}
          title="Drag to resize"
          className={`absolute top-0 bottom-0 ${right ? '-left-1' : '-right-1'} w-2 cursor-col-resize hover:bg-indigo-400/30`}
        />
      )}
      {state === 'float' && (
        <div onMouseDown={resizeFloat} title="Drag to resize" className="absolute right-0 bottom-0 w-4 h-4 cursor-nwse-resize" style={{ background: 'linear-gradient(135deg, transparent 50%, rgba(99,102,241,0.5) 50%)' }} />
      )}
      {overlay}
    </div>
  );
}
