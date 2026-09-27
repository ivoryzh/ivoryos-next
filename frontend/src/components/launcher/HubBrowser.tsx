"use client";
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, Loader2, Search } from 'lucide-react';
import { confirmDialog, notify } from '@ivoryos/shared-ui';
import type { ArgDef, DesktopApi, HubModule } from '@/desktop';
import { toForm, type FormValues } from '@/launcherArgs';
import ArgsForm from './ArgsForm';
import { Button, Field, Modal, inputClass, labelClass } from './ui';

/**
 * Browse the Hub's drivers and add one to a deck: search, pick, fill in its settings (the Hub's
 * own argument form), confirm, and the launcher installs the package and restarts the deck. The
 * Hub turns the choice into a deck entry (/api/catalog/deck-entry), so a driver added here is
 * the same entry the Hub's "Open in IvoryOS" button would send.
 */
export default function HubBrowser({ api, profileId, profileName, hubUrl, onClose, onAdded }: {
  api: DesktopApi;
  profileId: string;
  profileName: string;
  hubUrl: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HubModule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<HubModule | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const t = setTimeout(() => {
      api.hubSearch(query)
        .then(r => { if (!cancelled) setResults(r.modules); })
        .catch(e => { if (!cancelled) { setError(e.message); setResults([]); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [api, query]);

  return (
    <Modal wide onClose={onClose} title={chosen
      ? <span className="flex items-center gap-2"><button type="button" onClick={() => setChosen(null)} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><ArrowLeft className="w-4 h-4" /></button>Add {chosen.name} to {profileName}</span>
      : `Add an instrument from the Hub to ${profileName}`}
    >
      {chosen ? (
        <Configure api={api} profileId={profileId} module={chosen} onDone={() => { onAdded(); onClose(); }} />
      ) : (
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search drivers: pump, balance, Keithley…" className={`${inputClass} !pl-9 !py-2`} />
          </div>
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 rounded-lg p-3">
              {error} <span className="text-gray-500 dark:text-gray-400">Hub: {hubUrl}</span>
            </div>
          )}
          {results === null ? (
            <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="w-4 h-4 animate-spin" /> Searching the Hub…</div>
          ) : results.length === 0 && !error ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No drivers match “{query}”.</p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-white/5 border border-gray-100 dark:border-white/10 rounded-xl overflow-hidden">
              {results.map(m => (
                <li key={m.id}>
                  <button type="button" onClick={() => setChosen(m)} className="w-full text-left px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-white/[0.04] flex items-start gap-3">
                    <span className="text-lg leading-none mt-0.5 w-6 text-center">{m.icon_emoji || '🔌'}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{m.name}</span>
                        {m.is_tested_with_ivoryos && <span title="Tested with IvoryOS" className="text-green-600 dark:text-green-400"><CheckCircle2 className="w-3.5 h-3.5" /></span>}
                        {m.devices?.vendor && <span className="text-xs text-gray-400 truncate">{m.devices.vendor.trim()}</span>}
                      </span>
                      {m.description && <span className="block text-xs text-gray-500 dark:text-gray-400 line-clamp-1">{m.description}</span>}
                    </span>
                    <span className="text-[11px] font-mono text-gray-400 truncate max-w-[14rem]">{m.pip_name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Text settings left empty, by dotted name: they are left out of the constructor call. */
function emptyFields(defs: ArgDef[], values: FormValues, prefix = ''): string[] {
  return defs.flatMap(def => {
    const v = values[def.name];
    if (def.type === 'object') return emptyFields(def.args || [], (v as FormValues) || {}, `${prefix}${def.name}.`);
    if (def.type === 'bool') return [];
    return v === undefined || v === null || String(v).trim() === '' ? [`${prefix}${def.name}`] : [];
  });
}

function Configure({ api, profileId, module, onDone }: { api: DesktopApi; profileId: string; module: HubModule; onDone: () => void }) {
  const defs = useMemo(() => module.init_args || [], [module]);
  const connections = module.connection || [];
  const [name, setName] = useState('');
  const [form, setForm] = useState<FormValues>(() => toForm(defs, {}));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.freeName(profileId, module.name).then(setName).catch(() => setName('device'));
  }, [api, profileId, module.name]);

  const add = async () => {
    setBusy(true);
    try {
      const { instrument, packages, warnings } = await api.hubEntry({
        moduleId: module.id,
        name,
        // Settings come only from the driver's own init arguments, as on the Hub's Connect step:
        // its connection types are labels, not fields. An extra "Port" box here once duplicated
        // an init argument called `port`, and whichever box was left empty won silently.
        connection: { args: form },
      });
      const empty = emptyFields(defs, form);
      const ok = await confirmDialog(
        [
          `Install ${packages.join(', ') || 'nothing new'} and add “${instrument.name}” (${instrument.import}.${instrument.class}).`,
          ...(empty.length ? [`Left empty, so not passed to the driver: ${empty.join(', ')}. If the driver needs them it will not load; you can fill them in later with Edit.`] : []),
          ...warnings,
          'Drivers run on this computer with access to your instruments. The deck restarts to load it.',
        ].join('\n\n'),
        { title: 'Install and add?', confirmLabel: 'Install and add' },
      );
      if (!ok) return;
      await api.install(profileId, { packages, instruments: [instrument] });
      onDone();
    } catch (e: any) {
      await notify(`${e.message}${e.output ? `\n\n${String(e.output).split('\n').slice(-12).join('\n')}` : ''}`, { title: 'Could not add the instrument', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {module.description && <p className="text-sm text-gray-600 dark:text-gray-300">{module.description}</p>}
      <p className="text-xs font-mono text-gray-500 dark:text-gray-400">pip install {module.pip_name} · {module.module_path}.{module.module_name}</p>
      <Field label="Instrument name" hint="How workflows refer to it. Letters, digits and underscores.">
        <input value={name} onChange={e => setName(e.target.value)} className={`${inputClass} font-mono`} />
      </Field>
      {connections.length > 0 && (
        <div className="flex items-center gap-2">
          <span className={labelClass + ' !mb-0'}>Connects over</span>
          {connections.map(c => (
            <span key={c} className="px-2 py-0.5 rounded-md border border-gray-200 dark:border-white/10 text-[11px] font-medium text-gray-600 dark:text-gray-300">{c.toUpperCase()}</span>
          ))}
        </div>
      )}
      {defs.length > 0 && (
        <div>
          <div className={labelClass}>Settings</div>
          <ArgsForm defs={defs} values={form} onChange={setForm} />
        </div>
      )}
      <div className="flex justify-end pt-2">
        <Button tone="primary" disabled={busy || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)} onClick={add}>
          {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Installing…</> : 'Add to deck'}
        </Button>
      </div>
    </div>
  );
}
