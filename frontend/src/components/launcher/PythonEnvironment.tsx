"use client";
import React, { useEffect, useState } from 'react';
import { CheckCircle2, Copy, Loader2, AlertTriangle, FolderPlus, Download } from 'lucide-react';
import { confirmDialog, notify } from '@ivoryos/shared-ui';
import type { DesktopApi, PythonInfo } from '@/desktop';
import { Button, cardClass } from './ui';

/** The edge's own floor (edge_server/pyproject.toml `requires-python`). */
const MIN_PYTHON = [3, 10];

function tooOld(version?: string) {
  const [major, minor] = (version || '0.0').split('.').map(Number);
  return major < MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor < MIN_PYTHON[1]);
}

/**
 * Which Python a profile runs in, stated so it can be used from an editor too. People write their
 * drivers and scripts in PyCharm or VS Code; pointing that editor at the same interpreter gives it
 * the same packages (IvoryOS, the deck's drivers), so imports resolve and "Run" behaves as the
 * launcher's Start does.
 *
 * `python` null means the launcher's own environment. For a script profile, `folder` is where a
 * project `.venv` can be created, and `onChoose` switches the profile to an interpreter.
 */
export default function PythonEnvironment({ api, python, folder, onChoose }: {
  api: DesktopApi;
  python: string | null;
  folder?: string | null;
  onChoose?: (python: string) => void;
}) {
  const [info, setInfo] = useState<PythonInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      setInfo(null);
      api.inspectPython(python).then(i => { if (!cancelled) setInfo(i); })
        .catch((e: Error) => { if (!cancelled) setInfo({ ok: false, python: python || '', error: e.message }); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [api, python, recheck]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); setRecheck(n => n + 1); }
    catch (err) {
      const e = err as Error & { output?: string };
      notify(`${e.message}${e.output ? `\n\n${String(e.output).split('\n').slice(-10).join('\n')}` : ''}`, { title: `Could not ${label.toLowerCase()}`, tone: 'error' });
    }
    finally { setBusy(null); }
  };

  const createVenv = () => folder && act('Create the environment', async () => {
    const ok = await confirmDialog(
      `Create a Python ${MIN_PYTHON.join('.')}+ environment at\n${folder}/.venv\nwith IvoryOS installed, and run this profile in it?\n\nPoint your editor at the same folder's .venv and it will use exactly these packages. An existing .venv there is kept; IvoryOS is added to it.`,
      { title: 'Project environment', confirmLabel: 'Create' },
    );
    if (!ok) return;
    const created = await api.createVenv(folder);
    onChoose?.(created);
  });

  const installEdge = () => info && act('Install IvoryOS', async () => {
    const ok = await confirmDialog(`Install IvoryOS into\n${info.prefix || info.python}?\n\nIt adds the ivoryos-edge package and its requirements to that environment.`, { title: 'Install IvoryOS here?', confirmLabel: 'Install' });
    if (ok) await api.installEdgeInto(info.python);
  });

  return (
    <div className={`${cardClass} p-3 space-y-2 text-sm`}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 flex-1">Python for your editor</span>
        {info?.python && (
          <Button small tone="ghost" title="Copy the interpreter path, to paste into PyCharm or VS Code" onClick={() => api.copy(info.python)}><Copy className="w-3.5 h-3.5" /> Copy path</Button>
        )}
      </div>
      <div className="font-mono text-xs break-all text-gray-700 dark:text-gray-300">{info?.python || python || 'Launcher Python'}</div>
      {info === null ? (
        <div className="flex items-center gap-1.5 text-xs text-gray-500"><Loader2 className="w-3 h-3 animate-spin" /> Checking…</div>
      ) : !info.ok ? (
        <div className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400"><AlertTriangle className="w-3.5 h-3.5 mt-px" /> Not a working Python: {info.error}</div>
      ) : tooOld(info.version) ? (
        <div className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400"><AlertTriangle className="w-3.5 h-3.5 mt-px" /> Python {info.version}: IvoryOS needs {MIN_PYTHON.join('.')} or newer.</div>
      ) : info.edge ? (
        <div className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400"><CheckCircle2 className="w-3.5 h-3.5" /> Python {info.version}, IvoryOS {info.edge} installed</div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5" /> Python {info.version}, but IvoryOS is not installed here, so the script cannot start.
          <Button small disabled={!!busy} onClick={installEdge}>{busy === 'Install IvoryOS' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Install IvoryOS</Button>
        </div>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        In PyCharm: Settings → Python Interpreter → Add → Existing, and paste the path. In VS Code: “Python: Select Interpreter” → Enter path.
      </p>
      {onChoose && folder && (
        <div className="pt-1">
          <Button small disabled={!!busy} onClick={createVenv}>
            {busy === 'Create the environment' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderPlus className="w-3.5 h-3.5" />} Create a .venv in the project folder
          </Button>
        </div>
      )}
    </div>
  );
}
