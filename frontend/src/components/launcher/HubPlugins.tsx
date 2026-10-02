"use client";
import React, { useState } from 'react';
import { Ban, Loader2, PanelsTopLeft, Puzzle } from 'lucide-react';
import { confirmDialog } from '@ivoryos/shared-ui';
import type { Deck, DesktopApi, HubPlugin } from '@/desktop';
import { Button } from './ui';
import { addTo, deckLabel, CatalogCard, Notice, VisibilityBadge, type DeckAccess } from './hubUi';
import { installFailed } from './ReportProblem';

/**
 * Plugins are added only when they are v2 (an `ivoryos_edge.plugins.Plugin`). A v1 plugin is a
 * Flask blueprint for the original IvoryOS: this IvoryOS cannot run it at all, and a deck that
 * listed one would only report "a Blueprint, not a Plugin" at startup. So a v1 card says so on
 * its face, and its page explains why and offers nothing to click. The Hub refuses to build a deck
 * entry for one as well (`entry.blocked`), so the rule does not rest on this page alone.
 */
export function isV2(plugin: HubPlugin): boolean {
  return plugin.plugin_api === 'v2' && !plugin.entry.blocked;
}

export function PluginApiBadge({ plugin }: { plugin: HubPlugin }) {
  return isV2(plugin)
    ? <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-300">v2</span>
    : <span title="A Flask blueprint for the original IvoryOS: this IvoryOS cannot run it" className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400"><Ban className="w-3 h-3" /> v1, not supported</span>;
}

export function PluginCard({ plugin, onPick }: { plugin: HubPlugin; onPick: () => void }) {
  return (
    <CatalogCard onPick={onPick} muted={!isV2(plugin)}>
      <div className="h-24 bg-gradient-to-br from-gray-50 to-gray-100 text-gray-700 dark:text-gray-200 dark:from-white/5 dark:to-white/10 dark:text-white flex items-center justify-center relative">
        {plugin.screenshot_urls?.[0]
          // eslint-disable-next-line @next/next/no-img-element -- a remote Hub image in a static export
          ? <img src={plugin.screenshot_urls[0]} alt="" loading="lazy" className="w-full h-full object-cover" />
          : <Puzzle className="w-9 h-9 opacity-80" strokeWidth={1.5} />}
        <span className="absolute top-2 right-2"><PluginApiBadge plugin={plugin} /></span>
      </div>
      <div className="p-3 flex-1 flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate group-hover:text-accent-fg">{plugin.name.trim()}</span>
          <VisibilityBadge row={plugin} />
        </div>
        <div className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate">{plugin.pip_name}</div>
        {plugin.description && <div className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{plugin.description}</div>}
      </div>
    </CatalogCard>
  );
}

/** One plugin: what it is, and "Add to deck" when it is v2. */
export function PluginDetail({ api, access, deck, plugin, onDone }: {
  api: DesktopApi; access: DeckAccess; deck: Deck | null; plugin: HubPlugin; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const entry = plugin.entry;
  const already = !entry.blocked && entry.plugins.every(ref => (deck?.plugins || []).includes(ref));
  // A plugin made for particular drivers (not "agnostic") reaches instruments by name; say when
  // this deck has none of the Hub drivers it was made for, without refusing.
  const deckModules = new Set((deck?.instruments || []).map(i => Number(i.hub?.moduleId)).filter(Number.isFinite));
  const madeForOthers = !plugin.is_agnostic && (plugin.module_ids || []).length > 0 && !(plugin.module_ids || []).some(id => deckModules.has(Number(id)));

  const add = async () => {
    if (entry.blocked) return;
    const ok = await confirmDialog(
      [
        `Install ${entry.packages.join(', ') || 'nothing new'} and add the plugin ${entry.plugins.join(', ')} to ${deckLabel(access.target)}.`,
        ...(madeForOthers ? ['It was made for other instruments than this deck has, so parts of it may not find what they look for.'] : []),
        'Plugins run on this computer with access to your instruments. The deck restarts to load it.',
      ].join('\n\n'),
      { title: 'Install and add plugin?', confirmLabel: 'Install and add' },
    );
    if (!ok) return;
    setBusy(true);
    try {
      if (!await addTo(access, plugin.name.trim(), deck => api.install(deck.id, { packages: entry.packages, instruments: [], plugins: entry.plugins }))) return;
      onDone();
    } catch (e: any) {
      await installFailed(api, 'Could not add the plugin', e, access.target?.id ?? null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-12 h-12 shrink-0 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-200 dark:bg-white/10 dark:text-white flex items-center justify-center"><Puzzle className="w-6 h-6" /></div>
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{plugin.name.trim()}</h3>
            <PluginApiBadge plugin={plugin} />
            <VisibilityBadge row={plugin} />
          </div>
          {plugin.description && <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-line">{plugin.description}</p>}
          <p className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">pip install {plugin.pip_name} · {plugin.import_path}:{plugin.module_name}</p>
        </div>
      </div>

      {(plugin.screenshot_urls || []).length > 0 && (
        <div className="flex gap-2 overflow-x-auto">
          {/* eslint-disable-next-line @next/next/no-img-element -- remote Hub images in a static export */}
          {plugin.screenshot_urls!.map(url => <img key={url} src={url} alt="" loading="lazy" className="h-40 rounded-lg border border-gray-200 dark:border-white/10" />)}
        </div>
      )}

      {entry.blocked ? (
        <Notice tone="red">
          <div className="font-semibold mb-0.5">This plugin cannot be added</div>
          {entry.blocked}
        </Notice>
      ) : (
        <>
          {madeForOthers && <Notice>Made for instruments this deck does not have. You can still add it; parts of it may not find what they look for.</Notice>}
          <div className="flex items-center justify-end gap-3">
            {already && <span className="text-xs text-gray-500 dark:text-gray-400">Already on this deck.</span>}
            <Button tone="primary" disabled={busy || already} onClick={add}>
              {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Installing…</> : <><PanelsTopLeft className="w-4 h-4" /> Add to deck</>}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
