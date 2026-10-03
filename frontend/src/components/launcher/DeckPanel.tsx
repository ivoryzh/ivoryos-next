"use client";
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileJson, Package, Pencil, Plus, Store, Trash2 } from 'lucide-react';
import { confirmDialog, notify } from '@ivoryos/shared-ui';
import type { Deck, DeckInstrument, DesktopApi, HubLinkRequest, Profile } from '@/desktop';
import HubBrowser, { type HubKind } from './HubBrowser';
import InstrumentEditor from './InstrumentEditor';
import type { InstrumentSeed } from './PrivateRepos';
import { Button, cardClass } from './ui';

type LoadState = { loaded: Set<string>; errors: Record<string, string> } | null;

/** One deck profile's instruments: what is on it, whether each loaded, and how to change it. */
export default function DeckPanel({ api, profile, hubUrl, pro, onUpgrade, onOpenProfile, browsing, setBrowsing, hubKind, hubLink, seed: handedSeed, onSeedTaken }: {
  api: DesktopApi; profile: Profile; hubUrl: string; pro: boolean; onUpgrade: () => void;
  /** A private-repository class picked in the sidebar's Hub browser before this deck existed: open the form with it. */
  seed?: InstrumentSeed | null;
  onSeedTaken?: () => void;
  /** Show another profile, e.g. the deck a Hub platform was just installed as. */
  onOpenProfile: (id: string) => void;
  /** Whether the Hub browser is open: owned by the launcher so its sidebar can open it too. */
  browsing: boolean;
  setBrowsing: (open: boolean) => void;
  /** The Hub section to open on when the launcher opened the browser. */
  hubKind?: HubKind;
  /** An install link from the Hub website the browser opens on. */
  hubLink?: HubLinkRequest | null;
}) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [load, setLoad] = useState<LoadState>(null);
  // A handed seed opens the form as this panel mounts (the launcher mounts a fresh panel per deck).
  const [editing, setEditing] = useState<DeckInstrument | null | 'new'>(handedSeed ? 'new' : null);
  const [seed, setSeed] = useState<InstrumentSeed | null>(handedSeed ?? null);
  const running = profile.status.state === 'running';
  useEffect(() => { if (handedSeed) onSeedTaken?.(); }, [handedSeed, onSeedTaken]);

  const refresh = useCallback(() => {
    api.deck(profile.id).then(setDeck).catch(e => notify(e.message, { tone: 'error' }));
  }, [api, profile.id]);
  useEffect(refresh, [refresh, profile.status.state]);

  // While the deck runs, ask its edge which instruments actually loaded (deck_config.py reports
  // the ones that did not, with the reason).
  useEffect(() => {
    if (!running || !profile.status.url) { setLoad(null); return; }
    let cancelled = false;
    fetch(`${profile.status.url}/api/status`).then(r => r.json()).then(s => {
      if (cancelled) return;
      const errors: Record<string, string> = {};
      for (const e of s.instrument_errors || []) if (e.name) errors[e.name] = `${e.error}`;
      setLoad({ loaded: new Set(Object.keys(s.instruments || {})), errors });
    }).catch(() => { if (!cancelled) setLoad(null); });
    return () => { cancelled = true; };
  }, [running, profile.status.url, deck]);

  // What the Hub added is on disk, not in the edge: a running deck was restarted to load it
  // (manager.js), a stopped one loads it when started. Say which, so nobody wonders why the
  // Designer does not list the new instrument yet.
  const added = () => {
    refresh();
    notify(running
      ? `${profile.name} is restarting to load it. Its page reloads once it is back.`
      : `It is on the deck now and loads when ${profile.name} starts.`,
      { title: 'Added to the deck' });
  };
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); refresh(); } catch (e: any) { await notify(e.message, { title: 'Could not change the deck', tone: 'error' }); }
  };

  const instruments = deck?.instruments || [];
  const hubTarget = useMemo(() => ({ id: profile.id, name: profile.name }), [profile.id, profile.name]);
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        <Button tone="primary" onClick={() => setBrowsing(true)}><Store className="w-4 h-4" /> Add from Hub</Button>
        <Button onClick={() => { setSeed(null); setEditing('new'); }}><Plus className="w-4 h-4" /> Add by hand</Button>
        <Button onClick={() => act(() => api.installFromFile())}><FileJson className="w-4 h-4" /> Install from deck file…</Button>
        {running && <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">Changes restart this deck.</span>}
      </div>

      {instruments.length === 0 ? (
        <div className={`${cardClass} p-8 text-center text-sm text-gray-500 dark:text-gray-400`}>
          No instruments on this deck yet. Add one from the Hub, or by hand if its driver is your own code.
        </div>
      ) : (
        <ul className={`${cardClass} divide-y divide-gray-100 dark:divide-white/5 overflow-hidden`}>
          {instruments.map(inst => {
            const off = inst.enabled === false;
            const error = load?.errors[inst.name];
            const loaded = load?.loaded.has(inst.name);
            const args = Object.entries(inst.args || {}).filter(([, v]) => typeof v !== 'object' || v === null);
            return (
              <li key={inst.name} className={`px-4 py-3 flex items-start gap-3 ${off ? 'opacity-60' : ''}`}>
                <div className="mt-0.5 w-4">
                  {!off && error ? <AlertTriangle className="w-4 h-4 text-red-500" />
                    : !off && loaded ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">{inst.name}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{inst.hub?.name || `${inst.import}.${inst.class}`}</span>
                    {off && <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">off</span>}
                  </div>
                  {args.length > 0 && (
                    <div className="mt-0.5 text-xs font-mono text-gray-500 dark:text-gray-400 truncate">
                      {args.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ')}
                    </div>
                  )}
                  {!off && error && <div className="mt-1 text-xs text-red-600 dark:text-red-400 break-words">{error}</div>}
                </div>
                <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 cursor-pointer" title="Switched off instruments stay on the deck but are not loaded, e.g. while unplugged">
                  <input type="checkbox" checked={!off} onChange={e => act(() => api.setInstrumentEnabled(profile.id, inst.name, e.target.checked))} className="accent-accent" />
                  on
                </label>
                <Button small tone="ghost" title="Edit" onClick={() => setEditing(inst)}><Pencil className="w-3.5 h-3.5" /></Button>
                <Button small tone="ghost" title="Remove from the deck" onClick={async () => {
                  if (await confirmDialog(`Remove ${inst.name} from this deck? Its driver stays installed, and workflows that use it will stop matching the deck.`, { title: 'Remove instrument?', confirmLabel: 'Remove', tone: 'danger' })) {
                    act(() => api.removeInstrument(profile.id, inst.name));
                  }
                }}><Trash2 className="w-3.5 h-3.5 text-red-500" /></Button>
              </li>
            );
          })}
        </ul>
      )}

      {(deck?.packages || []).length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5"><Package className="w-3.5 h-3.5" /> Driver packages</div>
          <div className="flex flex-wrap gap-1.5">
            {deck!.packages!.map(p => <span key={p} className="px-2 py-0.5 rounded-md bg-gray-100 dark:bg-white/10 text-xs font-mono text-gray-600 dark:text-gray-300">{p}</span>)}
          </div>
        </div>
      )}

      {editing && (
        <InstrumentEditor api={api} profileId={profile.id} entry={editing === 'new' ? null : editing} seed={editing === 'new' ? seed : null} running={running} onClose={() => { setEditing(null); setSeed(null); }} onSaved={refresh} />
      )}
      {browsing && (
        <HubBrowser
          api={api} profile={hubTarget} hubUrl={hubUrl} pro={pro} onUpgrade={onUpgrade}
          onPrivatePicked={s => { refresh(); setSeed(s); setEditing('new'); }}
          initialKind={hubKind}
          initialLink={hubLink}
          onClose={() => setBrowsing(false)} onAdded={added} onOpenProfile={onOpenProfile}
        />
      )}
    </div>
  );
}
