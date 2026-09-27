"use client";
import React, { useMemo, useState } from 'react';
import { notify } from '@ivoryos/shared-ui';
import type { DesktopApi, DeckInstrument } from '@/desktop';
import { fromForm, parseLiteral, showLiteral, toForm, type FormValues } from '@/launcherArgs';
import ArgsForm from './ArgsForm';
import { Button, Field, KeyValueRows, Modal, inputClass, labelClass } from './ui';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Edit one instrument on a deck: its name, where its driver comes from, and its constructor
 * arguments -- which is where a COM port or an IP address lives. An instrument added from the Hub
 * brings the Hub's argument form with it; anything else gets name/value rows.
 */
export default function InstrumentEditor({ api, profileId, entry, running, onClose, onSaved }: {
  api: DesktopApi;
  profileId: string;
  entry: DeckInstrument | null; // null = a new, hand-written entry
  running: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const defs = useMemo(() => entry?.hub?.init_args || [], [entry]);
  const defNames = new Set(defs.map(d => d.name));
  const [name, setName] = useState(entry?.name || '');
  const [importPath, setImportPath] = useState(entry?.import || '');
  const [className, setClassName] = useState(entry?.class || '');
  const [form, setForm] = useState<FormValues>(() => toForm(defs, entry?.args || {}));
  const [extra, setExtra] = useState<Record<string, string>>(() => Object.fromEntries(
    Object.entries(entry?.args || {}).filter(([k]) => !defNames.has(k)).map(([k, v]) => [k, showLiteral(v)]),
  ));
  const [saving, setSaving] = useState(false);

  const renamed = entry && name !== entry.name;
  const problems = [
    !NAME_RE.test(name) && 'The name uses letters, digits and underscores, and starts with a letter.',
    !importPath.trim() && 'Say which module the driver is imported from.',
    !className.trim() && 'Say which class to create.',
  ].filter(Boolean) as string[];

  const save = async () => {
    setSaving(true);
    try {
      const args = { ...fromForm(defs, form), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, parseLiteral(v)])) };
      const next: DeckInstrument = { ...(entry || {}), name, import: importPath.trim(), class: className.trim() } as DeckInstrument;
      if (Object.keys(args).length) next.args = args; else delete next.args;
      await api.saveInstrument(profileId, entry ? entry.name : null, next);
      onSaved();
      onClose();
    } catch (e: any) {
      await notify(e.message, { title: 'Could not save', tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={entry ? `Edit ${entry.name}` : 'Add an instrument by hand'}
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button tone="primary" disabled={saving || problems.length > 0} onClick={save}>
          {saving ? 'Saving…' : running ? 'Save and restart' : 'Save'}
        </Button>
      </>}
    >
      <div className="space-y-4">
        <Field label="Name" hint={renamed ? 'Saved workflows refer to instruments by name: steps using the old name will need updating.' : 'How workflows and the Designer refer to it.'}>
          <input value={name} onChange={e => setName(e.target.value)} className={`${inputClass} font-mono`} />
        </Field>
        {entry?.hub ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            From the Hub: <span className="font-medium text-gray-700 dark:text-gray-200">{entry.hub.name}</span>
            <span className="font-mono"> · {entry.import}.{entry.class}</span>
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Import from"><input value={importPath} onChange={e => setImportPath(e.target.value)} placeholder="vendor_pumps.syringe" className={`${inputClass} font-mono`} /></Field>
            <Field label="Class"><input value={className} onChange={e => setClassName(e.target.value)} placeholder="SyringePump" className={`${inputClass} font-mono`} /></Field>
          </div>
        )}
        {defs.length > 0 && (
          <div>
            <div className={labelClass}>Settings</div>
            <ArgsForm defs={defs} values={form} onChange={setForm} />
          </div>
        )}
        <div>
          <div className={labelClass}>{defs.length ? 'Connection and other arguments' : 'Arguments'}</div>
          <KeyValueRows
            value={extra}
            onChange={setExtra}
            resetKey={entry?.name || 'new'}
            keyPlaceholder="port"
            valuePlaceholder="COM3"
            keyPattern={/^[A-Za-z_][A-Za-z0-9_]*$/}
            addLabel="Add argument"
          />
          <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
            Passed to the constructor. Numbers and true/false are typed; put a value in quotes to keep it as text.
          </p>
        </div>
        {problems.length > 0 && (name || importPath || className) && (
          <ul className="text-xs text-red-600 dark:text-red-400 list-disc pl-4">{problems.map(p => <li key={p}>{p}</li>)}</ul>
        )}
      </div>
    </Modal>
  );
}
