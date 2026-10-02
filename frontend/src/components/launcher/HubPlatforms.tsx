"use client";
import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Cpu, ExternalLink, FileText, Layers, Loader2, Puzzle, TrendingUp } from 'lucide-react';
import { confirmDialog } from '@ivoryos/shared-ui';
import type { Deck, DeckInstrument, DesktopApi, HubModule, HubPlatform, HubPlugin, OptimizerChoice } from '@/desktop';
import { emptyFields, toForm, type FormValues } from '@/launcherArgs';
import { preferV2, templateFit, uniqueNames, unionPackages } from '@/hubCatalog';
import ArgsForm from './ArgsForm';
import { isV2, PluginApiBadge } from './HubPlugins';
import { templateTitle } from './HubTemplates';
import { Button, Field, inputClass } from './ui';
import { CatalogCard, ErrorBox, Loading, Notice, SectionTitle, VisibilityBadge, type DeckAccess } from './hubUi';
import { installFailed } from './ReportProblem';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export function PlatformCard({ platform, onPick }: { platform: HubPlatform; onPick: () => void }) {
  const count = Array.isArray(platform.modules) ? platform.modules.length : 0;
  return (
    <CatalogCard onPick={onPick}>
      <div className="h-28 bg-gradient-to-br from-teal-50 to-teal-100 text-teal-600 dark:from-teal-500/10 dark:to-teal-500/20 dark:text-teal-300 flex items-center justify-center overflow-hidden">
        {platform.image_url
          // eslint-disable-next-line @next/next/no-img-element -- a remote Hub image in a static export
          ? <img src={platform.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
          : <Layers className="w-10 h-10 opacity-80" strokeWidth={1.5} />}
      </div>
      <div className="p-3 flex-1 flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate group-hover:text-accent-fg">{platform.name}</span>
          <VisibilityBadge row={platform} />
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{count} instrument{count === 1 ? '' : 's'}</div>
        {platform.description && <div className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{platform.description}</div>}
      </div>
    </CatalogCard>
  );
}

type Row = { module: HubModule; include: boolean; name: string; form: FormValues; open: boolean };

/**
 * A platform is a whole deck: its drivers, the plugins made for it and its workflows. It goes
 * either onto the deck the browser was opened from, or into a new deck profile of its own (the
 * usual choice for a demo or teaching platform, which should not mix with a real bench).
 *
 * Each driver still gets its own name and settings here, exactly as when added alone: the
 * platform says which drivers, not which COM port this computer gives them. v1 plugins are listed
 * but cannot be ticked (see HubPlugins.tsx); templates are ticked by default and, being made for
 * this platform, fit the deck they are installed with.
 */
export function PlatformDetail({ api, access, deck, platformId, onDone }: {
  api: DesktopApi; access: DeckAccess; deck: Deck | null; platformId: number;
  /** `newProfileId` when the platform became a new deck, so the launcher can open it. */
  onDone: (newProfileId: string | null) => void;
}) {
  const [platform, setPlatform] = useState<(HubPlatform & { modules: HubModule[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.hubPlatform(platformId)
      .then(r => { if (!cancelled) setPlatform(r.platform); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [api, platformId]);

  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!platform) return <Loading what="the platform" />;
  return <PlatformForm api={api} access={access} deck={deck} platform={platform} onDone={onDone} />;
}

function PlatformForm({ api, access, deck, platform, onDone }: {
  api: DesktopApi; access: DeckAccess; deck: Deck | null;
  platform: HubPlatform & { modules: HubModule[] }; onDone: (newProfileId: string | null) => void;
}) {
  // Opened without a deck, a platform can only become one; "append" needs a deck to append to.
  const existing = access.target;
  const profileName = existing?.name || '';
  const targets = existing ? (['new', 'append'] as const) : (['new'] as const);
  const [target, setTarget] = useState<'new' | 'append'>(existing && !(deck?.instruments || []).length ? 'append' : 'new');
  const [deckName, setDeckName] = useState(platform.name);
  // Names are chosen against the deck they will land on: nothing when it is a new deck, the
  // current instruments when appending.
  const namesFor = (t: 'new' | 'append') => uniqueNames(platform.modules.map(m => m.name), t === 'append' ? (deck?.instruments || []).map(i => i.name) : []);
  const [rows, setRows] = useState<Row[]>(() => {
    const names = namesFor(target);
    return platform.modules.map((module, i) => ({ module, include: true, name: names[i], form: toForm(module.init_args || [], {}), open: false }));
  });
  const plugins = preferV2(platform.plugins || []);
  const templates = platform.templates || [];
  const [pluginIds, setPluginIds] = useState<Set<number>>(() => new Set(plugins.filter(isV2).map(p => p.id)));
  const [templateIds, setTemplateIds] = useState<Set<number>>(() => new Set(templates.map(t => t.id)));
  const [busy, setBusy] = useState<string | null>(null);
  // Optimizers for the Optimize page, chosen here so a new deck does not need a trip to its
  // Settings afterwards (OptimizerSettings.tsx is the same choice, later). `picked` maps an
  // optimizer id to the version to add; what the deck already lists is shown, not offered.
  const [optimizers, setOptimizers] = useState<{ catalog: OptimizerChoice[]; selected: Record<string, string | null>; installed: Record<string, string | null> } | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    api.optimizers(existing?.id ?? null).then(o => { if (live) setOptimizers(o); }).catch(() => {});
    return () => { live = false; };
  }, [api, existing?.id]);
  const onDeck = (id: string) => (target === 'append' ? optimizers?.selected[id] : null) || null;
  const pickedOptimizers = (optimizers?.catalog || []).filter(o => picked[o.id] && !onDeck(o.id));

  // Switching the target renames the drivers for the deck they will now land on; settings stay.
  const chooseTarget = (t: 'new' | 'append') => {
    const names = namesFor(t);
    setTarget(t);
    setRows(rs => rs.map((r, i) => ({ ...r, name: names[i] })));
  };

  const update = (i: number, patch: Partial<Row>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const chosen = rows.filter(r => r.include);
  const names = chosen.map(r => r.name);
  const clash = names.find((n, i) => names.indexOf(n) !== i)
    || (target === 'append' ? names.find(n => (deck?.instruments || []).some(inst => inst.name === n)) : undefined);
  const badName = names.find(n => !NAME_RE.test(n));
  const blockedPlugins = plugins.filter(p => !isV2(p));
  const pickedPlugins = plugins.filter(p => isV2(p) && pluginIds.has(p.id));
  const pickedTemplates = templates.filter(t => templateIds.has(t.id));

  const install = async () => {
    setBusy('Preparing…');
    let created: string | null = null;
    try {
      const entries = await Promise.all(chosen.map(r => api.hubEntry({ moduleId: r.module.id, name: r.name, connection: { args: r.form } })));
      const instruments: DeckInstrument[] = entries.map(e => e.instrument);
      const packages = unionPackages(
        ...entries.map(e => e.packages),
        ...pickedPlugins.map(p => p.entry.packages),
        // Pinned to the tested version, installed in the same resolution as the drivers.
        pickedOptimizers.map(o => `${o.package}==${picked[o.id]}`),
      );
      const pluginRefs = pickedPlugins.flatMap(p => p.entry.plugins);
      const empty = chosen.flatMap(r => emptyFields(r.module.init_args || [], r.form).map(f => `${r.name}.${f}`));
      const warnings = entries.flatMap(e => e.warnings);
      const where = target === 'new' ? `a new deck “${deckName.trim()}”` : `“${profileName}”`;

      setBusy(null);
      const ok = await confirmDialog(
        [
          `Into ${where}:`,
          `Install ${packages.join(', ') || 'nothing new'}.`,
          instruments.length ? `Add instruments: ${instruments.map(i => i.name).join(', ')}.` : 'No instruments.',
          ...(pluginRefs.length ? [`Add plugins: ${pickedPlugins.map(p => p.name.trim()).join(', ')}.`] : []),
          ...(pickedTemplates.length ? [`Add workflows: ${pickedTemplates.map(templateTitle).join(', ')}.`] : []),
          ...(pickedOptimizers.length ? [`Add optimizers: ${pickedOptimizers.map(o => `${o.name} ${picked[o.id]}`).join(', ')}.`] : []),
          ...(blockedPlugins.length ? [`Skipped, v1 plugins this IvoryOS cannot run: ${blockedPlugins.map(p => p.name.trim()).join(', ')}.`] : []),
          ...(empty.length ? [`Left empty, so not passed to the driver: ${empty.join(', ')}. If a driver needs them it will not load; you can fill them in later with Edit.`] : []),
          ...warnings,
          'Drivers and plugins run on this computer with access to your instruments.',
        ].join('\n\n'),
        { title: 'Install platform?', confirmLabel: 'Install' },
      );
      if (!ok) return;

      setBusy('Installing drivers…');
      let deckId = existing?.id || '';
      if (target === 'new' || !deckId) {
        const profile = await api.createProfile({ kind: 'deck', name: deckName.trim() });
        created = profile.id;
        deckId = profile.id;
      }
      await api.install(deckId, { name: target === 'new' ? deckName.trim() : undefined, packages, instruments, plugins: pluginRefs });

      if (pickedTemplates.length) {
        setBusy('Adding workflows…');
        const bodies = await Promise.all(pickedTemplates.map(t => api.hubTemplate(t.id)));
        await api.addWorkflows(deckId, bodies.map(({ template: t }) => ({ name: t.workflowName || templateTitle(t), body: t.workflow })));
      }
      onDone(created);
    } catch (e: any) {
      // A new deck that did not install is an empty profile nobody asked for; the one the browser
      // was opened on is left as the failed install left it (manager.js writes nothing on failure).
      if (created) await api.removeProfile(created).catch(() => {});
      await installFailed(api, 'Could not install the platform', e, created ? null : (existing?.id ?? null));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (set: Set<number>, id: number, on: boolean) => { const next = new Set(set); if (on) next.add(id); else next.delete(id); return next; };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex gap-4">
        {platform.image_url && (
          // eslint-disable-next-line @next/next/no-img-element -- a remote Hub image in a static export
          <img src={platform.image_url} alt="" className="w-40 h-28 shrink-0 rounded-xl object-cover border border-gray-200 dark:border-white/10" />
        )}
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{platform.name}</h3>
            <VisibilityBadge row={platform} />
          </div>
          {platform.description && <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-line">{platform.description}</p>}
          {platform.demo_url && (
            <a href={platform.demo_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent-fg hover:underline">View demo <ExternalLink className="w-3 h-3" /></a>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className={`grid gap-2 ${targets.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {targets.map(t => (
            <label key={t} className={`rounded-xl border p-3 cursor-pointer text-sm ${target === t ? 'border-accent-tint bg-accent-soft' : 'border-gray-200 dark:border-white/10'}`}>
              <div className="flex items-center gap-2 font-medium text-gray-900 dark:text-gray-100">
                <input type="radio" checked={target === t} onChange={() => chooseTarget(t)} className="accent-accent" />
                {t === 'new' ? 'As a new deck' : `Add to ${profileName}`}
              </div>
              <div className="mt-1 pl-5 text-xs text-gray-500 dark:text-gray-400">
                {t === 'new' ? 'Its own profile, runs, workflows and port. Nothing on your other decks changes.' : `Its instruments join the ${(deck?.instruments || []).length} already on this deck, which restarts.`}
              </div>
            </label>
          ))}
        </div>
        {target === 'new' && (
          <Field label="New deck name"><input value={deckName} onChange={e => setDeckName(e.target.value)} className={inputClass} /></Field>
        )}
      </div>

      <section>
        <SectionTitle icon={Cpu} count={`${chosen.length}/${rows.length}`}>Instruments</SectionTitle>
        {(platform.hiddenModules || []).length > 0 && (
          <div className="mb-2"><Notice>{platform.hiddenModules!.length} driver{platform.hiddenModules!.length === 1 ? '' : 's'} in this platform {platform.hiddenModules!.length === 1 ? 'is' : 'are'} private to someone else and will not be installed.</Notice></div>
        )}
        <ul className="rounded-xl border border-gray-200 dark:border-white/10 divide-y divide-gray-100 dark:divide-white/5">
          {rows.map((r, i) => {
            const defs = r.module.init_args || [];
            const bad = r.include && (!NAME_RE.test(r.name) || r.name === clash);
            return (
              <li key={r.module.id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={r.include} onChange={e => update(i, { include: e.target.checked })} className="accent-accent" />
                  <input value={r.name} disabled={!r.include} onChange={e => update(i, { name: e.target.value })} className={`${inputClass} font-mono !w-44 ${bad ? '!border-red-400' : ''}`} />
                  <span className="min-w-0 flex-1 text-xs text-gray-500 dark:text-gray-400 truncate">{r.module.name} · {r.module.pip_name}</span>
                  <VisibilityBadge row={r.module} />
                  {defs.length > 0 && (
                    <button type="button" disabled={!r.include} onClick={() => update(i, { open: !r.open })} className="inline-flex items-center gap-0.5 text-xs text-gray-900 dark:text-white disabled:opacity-40">
                      {r.open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} Settings
                    </button>
                  )}
                </div>
                {r.open && r.include && <div className="mt-3 mb-1 pl-6"><ArgsForm defs={defs} values={r.form} onChange={form => update(i, { form })} /></div>}
              </li>
            );
          })}
        </ul>
        {clash && <div className="mt-1 text-xs text-red-600 dark:text-red-400">Two instruments would be called “{clash}”.</div>}
      </section>

      {plugins.length > 0 && (
        <section>
          <SectionTitle icon={Puzzle} count={pickedPlugins.length}>Plugins</SectionTitle>
          <ul className="rounded-xl border border-gray-200 dark:border-white/10 divide-y divide-gray-100 dark:divide-white/5">
            {plugins.map((p: HubPlugin) => (
              <li key={p.id} className={`px-3 py-2 ${isV2(p) ? '' : 'opacity-70'}`}>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" disabled={!isV2(p)} checked={isV2(p) && pluginIds.has(p.id)} onChange={e => setPluginIds(s => toggle(s, p.id, e.target.checked))} className="accent-accent" />
                  <span className="text-gray-900 dark:text-gray-100">{p.name.trim()}</span>
                  <PluginApiBadge plugin={p} />
                </label>
                {!isV2(p) && <div className="pl-6 mt-0.5 text-xs text-gray-500 dark:text-gray-400">{p.entry.blocked}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {templates.length > 0 && (
        <section>
          <SectionTitle icon={FileText} count={pickedTemplates.length}>Workflows</SectionTitle>
          <ul className="rounded-xl border border-gray-200 dark:border-white/10 divide-y divide-gray-100 dark:divide-white/5">
            {templates.map(t => {
              // Checked against the deck as it will be: the chosen names, plus the deck's own when appending.
              const after = { instruments: [...(target === 'append' ? deck?.instruments || [] : []), ...chosen.map(r => ({ name: r.name, import: '', class: '' }))] };
              const fit = templateFit(t, after);
              return (
                <li key={t.id} className="px-3 py-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={templateIds.has(t.id)} onChange={e => setTemplateIds(s => toggle(s, t.id, e.target.checked))} className="accent-accent" />
                    <span className="text-gray-900 dark:text-gray-100">{templateTitle(t)}</span>
                    {!fit.fits && <span className="text-[11px] text-amber-700 dark:text-amber-400" title="Its steps call these by name; rename the instruments above to match, or re-point the steps in the Designer">calls {fit.missing.join(', ')}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {optimizers && optimizers.catalog.length > 0 && (
        <section>
          <SectionTitle icon={TrendingUp} count={pickedOptimizers.length || undefined}>Optimizers</SectionTitle>
          <ul className="rounded-xl border border-gray-200 dark:border-white/10 divide-y divide-gray-100 dark:divide-white/5">
            {optimizers.catalog.map(o => {
              const has = onDeck(o.id);
              const installed = optimizers.installed[o.id];
              // A version already installed on this computer is the natural one to pick.
              const version = picked[o.id] || (installed && o.versions.includes(installed) ? installed : o.versions[0]);
              return (
                <li key={o.id} className="px-3 py-2 flex items-center gap-2 text-sm">
                  {has ? (
                    <>
                      <span className="w-4" />
                      <span className="w-16 text-gray-900 dark:text-gray-100">{o.name}</span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">On this deck{has !== 'any' ? ` · ${has}` : ''}</span>
                    </>
                  ) : (
                    <>
                      <input type="checkbox" checked={!!picked[o.id]} aria-label={`Add ${o.name}`}
                        onChange={e => setPicked(p => { const next = { ...p }; if (e.target.checked) next[o.id] = version; else delete next[o.id]; return next; })}
                        className="accent-accent" />
                      <span className="w-16 text-gray-900 dark:text-gray-100">{o.name}</span>
                      <select value={version} disabled={!picked[o.id]} aria-label={`${o.name} version`}
                        onChange={e => setPicked(p => ({ ...p, [o.id]: e.target.value }))}
                        className={`${inputClass} !w-52 !py-1 disabled:opacity-50`}>
                        {o.versions.map((v, i) => <option key={v} value={v}>{v}{i === 0 ? ' · recommended' : ''}</option>)}
                      </select>
                      {installed && <span className="text-xs text-gray-500 dark:text-gray-400">installed {installed}</span>}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">For the Optimize page. Versions tested with IvoryOS; PyTorch installs without GPU support.</p>
        </section>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        {badName && <span className="text-xs text-red-600 dark:text-red-400">“{badName}” is not a valid name: letters, digits and underscores, starting with a letter.</span>}
        <Button tone="primary" disabled={!!busy || !!clash || !!badName || (target === 'new' && !deckName.trim()) || (!chosen.length && !pickedPlugins.length && !pickedTemplates.length)} onClick={install}>
          {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> {busy}</> : target === 'new' ? 'Create deck and install' : `Install into ${profileName}`}
        </Button>
      </div>
    </div>
  );
}
