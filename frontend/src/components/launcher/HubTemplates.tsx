"use client";
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileText, Library, Loader2 } from 'lucide-react';
import { notify } from '@ivoryos/shared-ui';
import type { Deck, DesktopApi, HubTemplate, Profile } from '@/desktop';
import { repointInstruments, templateFit } from '@/hubCatalog';
import { Button, Field, inputClass } from './ui';
import { addTo, CatalogCard, Notice, VisibilityBadge, type DeckAccess } from './hubUi';

function stepCount(t: HubTemplate) {
  return t.steps.prep + t.steps.script + t.steps.cleanup;
}

export function templateTitle(t: HubTemplate) {
  return (t.title || t.workflowName || `Template ${t.id}`).trim();
}

export function TemplateCard({ template, deck, onPick }: { template: HubTemplate; deck: Deck | null; onPick: () => void }) {
  const fit = templateFit(template, deck);
  return (
    <CatalogCard onPick={onPick}>
      <div className="p-3 flex-1 flex flex-col gap-1.5 min-w-0">
        <div className="flex items-start gap-2 min-w-0">
          <FileText className="w-4 h-4 mt-0.5 shrink-0 text-gray-400" />
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 line-clamp-2 group-hover:text-accent-fg">{templateTitle(template)}</span>
        </div>
        {template.description && <div className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{template.description}</div>}
        <div className="mt-auto pt-1 flex items-center gap-2 flex-wrap text-[11px] text-gray-500 dark:text-gray-400">
          <span>{stepCount(template)} step{stepCount(template) === 1 ? '' : 's'}</span>
          {fit.fits
            ? <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400" title="Every instrument it calls is on this deck"><CheckCircle2 className="w-3 h-3" /> Fits this deck</span>
            : <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400" title={`Not on this deck: ${fit.missing.join(', ')}`}><AlertTriangle className="w-3 h-3" /> Needs {fit.missing.length} more</span>}
          <VisibilityBadge row={template} />
        </div>
      </div>
    </CatalogCard>
  );
}

/**
 * One template, added to the deck's workflow library. A template written for other instruments is
 * allowed on purpose: it is a starting point, its steps can be re-pointed in the Designer, and the
 * Library marks each step the deck cannot run until then. So an unfit template is added after a
 * warning, never refused.
 */
export function TemplateDetail({ api, access, deck, template, onDone }: {
  api: DesktopApi; access: DeckAccess; deck: Deck | null; template: HubTemplate; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // A workflow is a starting point, so it may go to any profile that can take one: every deck,
  // and a Python-script profile while it runs (its library is reached through its own API) or
  // when it has a data folder of its own (library.js). The chosen profile's instruments decide
  // the fit shown below; a script's come from its live /api/status, since it has no deck file.
  const [decks, setDecks] = useState<Profile[]>([]);
  const [targetId, setTargetId] = useState<string>(access.target?.id || '');
  const [targetDeck, setTargetDeck] = useState<Deck | null>(deck);
  useEffect(() => {
    api.snapshot()
      .then(s => setDecks(s.profiles.filter(p => p.kind === 'deck' || p.status.state === 'running' || !!p.dataDir)))
      .catch(() => {});
  }, [api]);
  useEffect(() => {
    if (!targetId) { setTargetDeck(null); return; }
    if (targetId === access.target?.id) { setTargetDeck(deck); return; }
    let cancelled = false;
    const profile = decks.find(d => d.id === targetId);
    const read = profile?.kind === 'script'
      ? (profile.status.url
        ? fetch(`${profile.status.url}/api/status`).then(r => r.json()).then(s => ({ instruments: Object.keys(s.instruments || {}).map(name => ({ name, import: '', class: '' })) }) as Deck)
        : Promise.resolve(null))
      : api.deck(targetId);
    read.then(d => { if (!cancelled) setTargetDeck(d); }).catch(() => { if (!cancelled) setTargetDeck(null); });
    return () => { cancelled = true; };
  }, [api, targetId, access.target?.id, deck, decks]);
  const fit = useMemo(() => templateFit(template, targetDeck), [template, targetDeck]);
  // Where each missing name should point on the chosen deck. Prefilled only when there is
  // exactly one unclaimed instrument of the template's modules for exactly one missing name.
  const [mapping, setMapping] = useState<Record<string, string>>({});
  useEffect(() => {
    const next: Record<string, string> = {};
    if (fit.missing.length === 1 && fit.sameDriver[fit.missing[0]]?.length === 1) next[fit.missing[0]] = fit.sameDriver[fit.missing[0]][0];
    setMapping(next);
  }, [fit]);
  const pointed = fit.missing.filter(n => mapping[n]);
  const stillMissing = fit.missing.filter(n => !mapping[n]);
  const targetName = decks.find(d => d.id === targetId)?.name || access.target?.name || null;

  const add = async () => {
    setBusy(true);
    try {
      const { template: full } = await api.hubTemplate(template.id);
      const body = repointInstruments((full.workflow || {}) as Record<string, unknown>, mapping);
      const out: { saved?: { requested: string; saved: string }; into?: string } = {};
      const save = async (d: { id: string; name: string }) => {
        out.into = d.name;
        [out.saved] = await api.addWorkflows(d.id, [{ name: full.workflowName || templateTitle(full), body }]);
      };
      // A chosen existing deck is used as is; with none (an empty launcher) the browser's
      // deck access creates one, naming it after the workflow.
      const chosen = targetId && targetId !== access.target?.id ? decks.find(d => d.id === targetId) : null;
      const done = chosen ? (await save({ id: chosen.id, name: chosen.name }), true) : await addTo(access, templateTitle(full), save);
      const { saved, into } = out;
      if (!done || !saved) return;
      await notify(
        saved.saved === saved.requested
          ? `Saved to ${into}'s library as “${saved.saved}”.`
          : `A workflow called “${saved.requested}” already exists, so this one was saved as “${saved.saved}”.`,
        { title: 'Workflow added' },
      );
      onDone();
    } catch (e: any) {
      await notify(e.message, { title: 'Could not add the workflow', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{templateTitle(template)}</h3>
          <VisibilityBadge row={template} />
        </div>
        {template.description && <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-line">{template.description}</p>}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {template.steps.prep} prep · {template.steps.script} main · {template.steps.cleanup} cleanup step{template.steps.cleanup === 1 ? '' : 's'}
        </p>
      </div>

      {(decks.length > 1 || (decks.length === 1 && decks[0].id !== access.target?.id)) && (
        <Field label="Add to" hint="Any deck, or a running Python script; the fit below is checked against the one you pick.">
          <select value={targetId} onChange={e => setTargetId(e.target.value)} className={inputClass}>
            {access.target && !decks.some(d => d.id === access.target!.id) && <option value={access.target.id}>{access.target.name}</option>}
            {decks.map(d => <option key={d.id} value={d.id}>{d.name}{d.kind === 'script' ? ' (script)' : ''}</option>)}
          </select>
        </Field>
      )}

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5">Instruments it calls</div>
        {template.instruments.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400">None: only Flow Control steps.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {template.instruments.map(name => {
              const missing = fit.missing.includes(name);
              const to = mapping[name];
              return (
                <span key={name} className={`px-2 py-0.5 rounded-md text-xs font-mono ${!missing || to ? 'bg-green-50 text-green-800 dark:bg-green-500/10 dark:text-green-200' : 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200'}`}>
                  {name}{to ? ` → ${to}` : missing ? ' (not on this deck)' : ''}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {fit.missing.length > 0 && targetDeck && (targetDeck.instruments || []).length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-white/10 p-3 space-y-2">
          <div className="text-xs text-gray-600 dark:text-gray-300">
            Point the steps at {targetName ? `${targetName}'s` : 'this deck\'s'} instruments. The check matches by instrument <em>name</em>; a deck often
            has the same driver under another name, and those are listed first.
          </div>
          {fit.missing.map(name => {
            const same = fit.sameDriver[name] || [];
            const others = (targetDeck.instruments || []).filter(i => i.enabled !== false && !same.includes(i.name)).map(i => i.name);
            return (
              <div key={name} className="flex items-center gap-2 text-xs">
                <span className="font-mono w-40 truncate" title={name}>{name}</span>
                <span className="text-gray-400">→</span>
                <select value={mapping[name] || ''} onChange={e => setMapping(m => ({ ...m, [name]: e.target.value }))} className={`${inputClass} !py-1 !text-xs flex-1`}>
                  <option value="">leave as “{name}” (fix later in the Designer)</option>
                  {same.length > 0 && <optgroup label="Same driver from the Hub">{same.map(n => <option key={n} value={n}>{n}</option>)}</optgroup>}
                  {others.length > 0 && <optgroup label="Other instruments">{others.map(n => <option key={n} value={n}>{n}</option>)}</optgroup>}
                </select>
              </div>
            );
          })}
        </div>
      )}

      {stillMissing.length > 0 && (
        <Notice>
          <div className="font-semibold mb-0.5">Not compatible with {targetName || 'an empty deck'} as it is</div>
          It calls {stillMissing.join(', ')}, which this deck does not have. You can still add it: the Library marks the steps
          that cannot run, and you can point them at this deck&apos;s instruments in the Designer.
        </Notice>
      )}

      <div className="flex justify-end">
        <Button tone="primary" disabled={busy} onClick={add}>
          {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Adding…</> : <><Library className="w-4 h-4" /> {stillMissing.length === 0 ? (pointed.length ? 'Point steps and add' : 'Add to library') : 'Add anyway'}</>}
        </Button>
      </div>
    </div>
  );
}
