"use client";
import React, { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Trash2 } from 'lucide-react';
import { confirmDialog, notify } from '@ivoryos/shared-ui';
import type { DesktopApi, Profile, CloudLink } from '@/desktop';
import PythonEnvironment from './PythonEnvironment';
import CloudConnection from './CloudConnection';
import OptimizerSettings from './OptimizerSettings';
import { Button, Field, KeyValueRows, cardClass, inputClass } from './ui';

type Draft = Pick<Profile, 'name' | 'port' | 'listenOnNetwork' | 'autoStart' | 'env' | 'script' | 'cwd' | 'args' | 'python' | 'dataDir'>;

const draftOf = (p: Profile): Draft => ({
  name: p.name, port: p.port, listenOnNetwork: p.listenOnNetwork, autoStart: p.autoStart, env: p.env,
  script: p.script, cwd: p.cwd, args: p.args, python: p.python, dataDir: p.dataDir,
});

/**
 * How a profile starts. For a script this is where its instruments are configured too: a script
 * reads its serial port from an environment variable set here (`os.environ["PUMP_PORT"]`), since
 * the launcher cannot reach inside the Python code. Saved explicitly, and applied on the next
 * start, so half-typed values never restart a running bench.
 */
export default function ProfileSettings({ api, profile, link, sharedWith, onRemoved, cloudOffered = true }: {
  api: DesktopApi; profile: Profile; link?: CloudLink; sharedWith: Profile[]; onRemoved: () => void;
  /** False in a release without Cloud (snapshot.cloudComingSoon): no Cloud connection card. */
  cloudOffered?: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(profile));
  const [argsText, setArgsText] = useState((profile.args || []).join(' '));
  const [saving, setSaving] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setDraft(draftOf(profile)); setArgsText((profile.args || []).join(' ')); }, [profile.id]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(d => ({ ...d, [key]: value }));
  const running = profile.status.state === 'running';
  const script = profile.kind === 'script';
  // How many of the Advanced settings hold something, so a value in use is never folded away unseen.
  const advancedInUse = [Object.keys(draft.env || {}).length > 0, argsText.trim() !== '', !!draft.python].filter(Boolean).length;
  // Open or folded is decided once per profile: following the live count would fold the section
  // under the cursor the moment its last value was cleared.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const advancedStartsOpen = useMemo(() => advancedInUse > 0, [profile.id]);

  const save = async () => {
    setSaving(true);
    try {
      // Arguments split like a shell would for the simple case; quote a value that has spaces.
      const args = (argsText.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(a => a.replace(/^["']|["']$/g, ''));
      await api.updateProfile(profile.id, { ...draft, port: Number(draft.port), args });
      if (running && await confirmDialog('Saved. Restart now so the running edge uses these settings?', { title: 'Restart?', confirmLabel: 'Restart' })) {
        await api.restart(profile.id);
      }
    } catch (e: any) {
      await notify(e.message, { title: 'Could not save', tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const pick = async (kind: 'script' | 'python' | 'folder', apply: (path: string) => void) => {
    const chosen = await api.pick(kind);
    if (chosen) apply(chosen);
  };

  return (
    <div className="space-y-5 max-w-2xl">
      {script && (
        <section className={`${cardClass} p-4 space-y-4`}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Script</h3>
          <Field label="Python file" hint="Any script that ends with ivoryos_edge.run(__name__), like example/demo.py.">
            <div className="flex gap-2">
              <input value={draft.script || ''} onChange={e => set('script', e.target.value)} className={`${inputClass} font-mono`} />
              <Button onClick={() => pick('script', p => setDraft(d => ({ ...d, script: p, cwd: d.cwd || p.replace(/[\\/][^\\/]*$/, '') })))}>Browse…</Button>
            </div>
          </Field>
          {/* For people who wire a script up by hand. Most scripts set their ports in the code or
              come from the Hub, so these stay folded unless one is already in use. */}
          <details key={profile.id} open={advancedStartsOpen} className="rounded-lg border border-gray-200 dark:border-white/10">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200">
              Advanced{advancedInUse > 0 && <span className="ml-1.5 text-xs font-normal text-gray-500 dark:text-gray-400">{advancedInUse} set</span>}
            </summary>
            <div className="px-3 pb-3 space-y-4">
            <Field label="Python interpreter" hint="Empty: the launcher’s own Python, which has the edge and every driver installed from the Hub. Choose another to use a project’s own virtual environment.">
              <div className="flex gap-2">
                <input value={draft.python || ''} onChange={e => set('python', e.target.value || null)} placeholder="Launcher Python" className={`${inputClass} font-mono`} />
                <Button onClick={() => pick('python', p => set('python', p))}>Browse…</Button>
              </div>
            </Field>
            <PythonEnvironment
              api={api}
              python={draft.python || null}
              folder={draft.cwd || (draft.script ? draft.script.replace(/[\\/][^\\/]*$/, '') : null)}
              onChoose={p => set('python', p)}
            />
            <Field label="Working folder">
              <div className="flex gap-2">
                <input value={draft.cwd || ''} onChange={e => set('cwd', e.target.value)} className={`${inputClass} font-mono`} />
                <Button onClick={() => pick('folder', p => set('cwd', p))}>Browse…</Button>
              </div>
            </Field>
            <Field label="Environment variables" hint={<>Where a script’s COM ports and addresses go: read them with <code className="font-mono">os.environ[&quot;PUMP_PORT&quot;]</code>. Applied on the next start.</>}>
              <KeyValueRows value={draft.env || {}} onChange={v => set('env', v)} resetKey={profile.id} keyPlaceholder="PUMP_PORT" valuePlaceholder="COM3" keyPattern={/^[A-Za-z_][A-Za-z0-9_]*$/} addLabel="Add variable" />
            </Field>
            <Field label="Arguments" hint="Passed after the script name. Quote a value that contains spaces.">
              <input value={argsText} onChange={e => setArgsText(e.target.value)} placeholder="--simulate" className={`${inputClass} font-mono`} />
            </Field>
            </div>
          </details>
          <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
            <input type="checkbox" checked={!draft.dataDir} onChange={async e => {
              if (e.target.checked) set('dataDir', null);
              else await pick('folder', p => set('dataDir', p));
            }} className="mt-1 accent-accent" />
            <span>
              Keep the script’s own runs and workflows
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                {draft.dataDir ? <>Stored in <span className="font-mono">{draft.dataDir}</span></> : 'The same history as when you run it from a terminal. Untick to give this profile a separate data folder.'}
              </span>
            </span>
          </label>
        </section>
      )}

      <section className={`${cardClass} p-4 space-y-4`}>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">General</h3>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2"><Field label="Name"><input value={draft.name} onChange={e => set('name', e.target.value)} className={inputClass} /></Field></div>
          <Field label="Port"><input value={String(draft.port)} onChange={e => set('port', Number(e.target.value.replace(/\D/g, '')) || 0)} className={`${inputClass} font-mono`} /></Field>
        </div>
        <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
          <input type="checkbox" checked={draft.autoStart} onChange={e => set('autoStart', e.target.checked)} className="mt-1 accent-accent" />
          <span>Start when the launcher opens</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
          <input type="checkbox" checked={draft.listenOnNetwork} onChange={e => set('listenOnNetwork', e.target.checked)} className="mt-1 accent-accent" />
          <span>
            Reachable from other computers on the network
            <span className="block text-xs text-gray-500 dark:text-gray-400">Anyone who can reach this port can drive the instruments. Off, only this computer can.</span>
          </span>
        </label>
        {!script && <PythonEnvironment api={api} python={null} />}
        {!script && (
          <div className="flex gap-2 flex-wrap">
            <Button small onClick={() => api.reveal(profile.id, 'deck').catch(e => notify(e.message))}><FolderOpen className="w-3.5 h-3.5" /> Show deck file</Button>
            <Button small onClick={() => api.reveal(profile.id, 'data').catch(e => notify(e.message))}><FolderOpen className="w-3.5 h-3.5" /> Show data folder</Button>
          </div>
        )}
      </section>

      {!script && <OptimizerSettings api={api} profile={profile} />}

      {cloudOffered && <CloudConnection api={api} profile={profile} link={link} sharedWith={sharedWith} />}

      <div className="flex items-center justify-between">
        <Button tone="danger" onClick={async () => {
          if (await confirmDialog(`Remove the profile “${profile.name}”? Its deck file and data stay on disk.`, { title: 'Remove profile?', confirmLabel: 'Remove', tone: 'danger' })) {
            try { await api.removeProfile(profile.id); onRemoved(); } catch (e: any) { notify(e.message, { tone: 'error' }); }
          }
        }}><Trash2 className="w-4 h-4" /> Remove profile</Button>
        <Button tone="primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}
