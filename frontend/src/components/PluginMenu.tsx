"use client";
import React, { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Maximize2, PictureInPicture2, X } from 'lucide-react';
import { openInPanel, setPanel, usePanel } from '@/pluginPanel';

export type PluginMenuAt = { plugin: { id: string; name: string; placement?: string }; x: number; y: number };

/**
 * A plugin entry's right-click menu in the nav: where to show it. Any plugin can open in the
 * window or full size (PluginPanel), or as a page of its own, whatever its placement says it
 * opens as on a plain click.
 */
export default function PluginMenu({ at, onClose }: { at: PluginMenuAt; onClose: () => void }) {
  const router = useRouter();
  const panel = usePanel();
  const box = useRef<HTMLDivElement>(null);
  const { plugin } = at;
  const showing = panel.open === plugin.id;

  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const pick = (fn: () => void) => () => { fn(); onClose(); };
  const item = 'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10';
  // Kept on screen near the right and bottom edges.
  const left = Math.min(at.x, window.innerWidth - 200);
  const top = Math.min(at.y, window.innerHeight - 150);

  return (
    <div
      ref={box}
      role="menu"
      style={{ left, top }}
      className="fixed z-[10002] w-48 py-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] shadow-xl"
    >
      <div className="px-3 pt-1 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400 truncate">{plugin.name}</div>
      <button type="button" role="menuitem" className={item} onClick={pick(() => openInPanel(plugin.id, plugin.placement, 'window'))}>
        <PictureInPicture2 className="w-3.5 h-3.5" /> Open in a window
      </button>
      <button type="button" role="menuitem" className={item} onClick={pick(() => openInPanel(plugin.id, plugin.placement, 'full'))}>
        <Maximize2 className="w-3.5 h-3.5" /> Open full size
      </button>
      <button type="button" role="menuitem" className={item} onClick={pick(() => router.push(`/plugin?id=${plugin.id}`))}>
        <FileText className="w-3.5 h-3.5" /> Open as a page
      </button>
      {showing && (
        <button type="button" role="menuitem" className={item} onClick={pick(() => setPanel({ open: null }))}>
          <X className="w-3.5 h-3.5" /> Close
        </button>
      )}
    </div>
  );
}
