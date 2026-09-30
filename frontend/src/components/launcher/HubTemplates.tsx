"use client";
import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, FileText, Library, Loader2 } from 'lucide-react';
import { notify } from '@ivoryos/shared-ui';
import type { Deck, DesktopApi, HubTemplate } from '@/desktop';
import { templateFit } from '@/hubCatalog';
import { Button } from './ui';
import { CatalogCard, Notice, VisibilityBadge } from './hubUi';

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
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 line-clamp-2 group-hover:text-indigo-700 dark:group-hover:text-indigo-300">{templateTitle(template)}</span>
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
export function TemplateDetail({ api, profileId, profileName, deck, template, onDone }: {
  api: DesktopApi; profileId: string; profileName: string; deck: Deck | null; template: HubTemplate; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const fit = templateFit(template, deck);

  const add = async () => {
    setBusy(true);
    try {
      const { template: full } = await api.hubTemplate(template.id);
      const [saved] = await api.addWorkflows(profileId, [{ name: full.workflowName || templateTitle(full), body: full.workflow }]);
      await notify(
        saved.saved === saved.requested
          ? `Saved to ${profileName}'s library as “${saved.saved}”.`
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

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5">Instruments it calls</div>
        {template.instruments.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400">None: only Flow Control steps.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {template.instruments.map(name => {
              const missing = fit.missing.includes(name);
              return (
                <span key={name} className={`px-2 py-0.5 rounded-md text-xs font-mono ${missing ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200' : 'bg-green-50 text-green-800 dark:bg-green-500/10 dark:text-green-200'}`}>
                  {name}{missing ? ' (not on this deck)' : ''}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {!fit.fits && (
        <Notice>
          <div className="font-semibold mb-0.5">Not compatible with {profileName} as it is</div>
          It calls {fit.missing.join(', ')}, which this deck does not have. You can still add it: the Library marks the steps
          that cannot run, and you can point them at this deck&apos;s instruments in the Designer.
        </Notice>
      )}

      <div className="flex justify-end">
        <Button tone="primary" disabled={busy} onClick={add}>
          {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Adding…</> : <><Library className="w-4 h-4" /> {fit.fits ? 'Add to library' : 'Add anyway'}</>}
        </Button>
      </div>
    </div>
  );
}
