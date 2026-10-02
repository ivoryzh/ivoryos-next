"use client";
import React, { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, GitBranch, Loader2, Lock, Search, Sparkles } from 'lucide-react';
import type { DesktopApi, GitConnection, GitImport, GitProvider, GitRepo } from '@/desktop';
import { GitConnections } from './AccountPanel';
import { Button, inputClass } from './ui';
import { addTo, type DeckAccess } from './hubUi';

export type InstrumentSeed = { name: string; import: string; class: string; from: string };

/** `SyringePump` -> `syringe_pump`: a deck name that reads like the other instruments. */
function snake(name: string) {
  const s = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
  return /^[a-z]/.test(s) ? s : `inst_${s}`;
}

/**
 * The private half of "Add from Hub": the lab's own repositories on GitHub or GitLab (Pro).
 * Import downloads the repository at its current commit and installs it into this deck's Python
 * (desktop/src/gitRepos.js explains why it is a download and not `git+https`), then lists the
 * classes it provides; picking one opens the instrument form with it filled in.
 */
export default function PrivateRepos({ api, access, pro, onUpgrade, onPicked }: {
  api: DesktopApi;
  /** The deck the repository is installed into; made on the first import when there is none. */
  access: DeckAccess;
  pro: boolean;
  onUpgrade: () => void;
  onPicked: (seed: InstrumentSeed) => void;
}) {
  const [connections, setConnections] = useState<GitConnection[] | null>(null);
  const [provider, setProvider] = useState<GitProvider | null>(null);
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState<GitRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [imported, setImported] = useState<{ repo: GitRepo; result: GitImport } | null>(null);

  const reloadConnections = () => api.gitList().then(list => {
    setConnections(list);
    const connected = list.filter(c => c.connected);
    setProvider(p => (p && connected.some(c => c.provider === p) ? p : connected[0]?.provider || null));
  }).catch(() => setConnections([]));
  useEffect(() => { if (pro) reloadConnections(); }, [pro]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!provider) { setRepos(null); return; }
    let cancelled = false;
    setRepos(null); setError(null);
    const t = setTimeout(() => {
      api.gitRepos(provider, query).then(r => { if (!cancelled) setRepos(r); })
        .catch((e: Error) => { if (!cancelled) { setError(e.message); setRepos([]); } });
    }, query ? 300 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [api, provider, query]);

  if (!pro) {
    return (
      <div className="max-w-lg mx-auto mt-10 text-center space-y-3">
        <span className="inline-flex w-12 h-12 rounded-2xl bg-gradient-to-br from-accent to-accent-hover text-on-accent items-center justify-center"><Lock className="w-6 h-6" /></span>
        <h3 className="font-semibold">Your lab&apos;s private drivers</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Connect GitHub or GitLab and add drivers from your own private repositories to a deck, installed and pinned the same way as a Hub driver.
        </p>
        <Button tone="primary" onClick={onUpgrade}><Sparkles className="w-4 h-4" /> Upgrade to Pro</Button>
      </div>
    );
  }
  if (connections === null) return <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>;

  if (imported) {
    const { repo, result } = imported;
    const classes = result.scan.classes || [];
    return (
      <div className="space-y-4">
        <div className="text-sm">
          <b>{repo.name}</b> is installed on this deck at <span className="font-mono">{result.ref}@{result.sha.slice(0, 7)}</span>
          {result.scan.distribution && <> as <span className="font-mono">{result.scan.distribution} {result.scan.version}</span></>}.
        </div>
        {result.scan.error && <div className="text-sm text-amber-700 dark:text-amber-300 flex gap-2"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{result.scan.error}</div>}
        {classes.length > 0 ? (
          <>
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Which class is the instrument?</div>
            <ul className="rounded-xl border border-gray-200 dark:border-white/10 divide-y divide-gray-100 dark:divide-white/5 max-h-80 overflow-y-auto">
              {classes.map(c => (
                <li key={`${c.module}.${c.class}`}>
                  <button type="button" className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-white/5" onClick={async () => {
                    const name = access.target ? await api.freeName(access.target.id, snake(c.class)).catch(() => snake(c.class)) : snake(c.class);
                    onPicked({ name, import: c.module, class: c.class, from: repo.name });
                  }}>
                    <span className="font-mono text-sm font-semibold">{c.class}</span>
                    <span className="ml-2 font-mono text-xs text-gray-500">{c.module}</span>
                    {c.doc && <span className="block text-xs text-gray-500 dark:text-gray-400 truncate">{c.doc}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : !result.scan.error && (
          <p className="text-sm text-gray-500 dark:text-gray-400">No classes were found in it. Add the instrument by hand with the module and class name.</p>
        )}
        {(result.scan.errors || []).length > 0 && (
          <details className="text-xs text-gray-500 dark:text-gray-400">
            <summary className="cursor-pointer">{result.scan.errors!.length} module{result.scan.errors!.length === 1 ? '' : 's'} could not be imported</summary>
            <ul className="mt-1 space-y-1 font-mono">{result.scan.errors!.map(e => <li key={e.module}>{e.module}: {e.error}</li>)}</ul>
          </details>
        )}
        <div className="flex gap-2">
          <Button small onClick={() => onPicked({ name: '', import: result.scan.modules?.[0] || '', class: '', from: repo.name })}>Add by hand</Button>
          <Button small tone="ghost" onClick={() => setImported(null)}>Back to repositories</Button>
        </div>
      </div>
    );
  }

  const connected = connections.filter(c => c.connected);
  if (!connected.length) {
    return (
      <div className="max-w-2xl">
        <GitConnections api={api} pro onUpgrade={onUpgrade} />
        <div className="mt-3"><Button small onClick={reloadConnections}>Done</Button></div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {connected.map(c => (
          <button key={c.provider} type="button" onClick={() => setProvider(c.provider)} className={`px-3 py-1.5 rounded-lg text-sm border ${provider === c.provider ? 'border-accent-tint bg-accent-soft text-accent-fg' : 'border-gray-200 dark:border-white/10'}`}>
            {c.label} <span className="text-xs text-gray-500">· {c.login}</span>
          </button>
        ))}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter repositories" className={`${inputClass} !pl-9 !py-2`} />
        </div>
      </div>
      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
      {repos === null ? (
        <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading repositories…</div>
      ) : repos.length === 0 && !error ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No repositories{query ? ` match “${query}”` : ' this token can read'}.</p>
      ) : (
        <ul className="rounded-xl border border-gray-200 dark:border-white/10 divide-y divide-gray-100 dark:divide-white/5">
          {repos.map(r => (
            <li key={r.id} className="px-3 py-2.5 flex items-center gap-3">
              <GitBranch className="w-4 h-4 text-gray-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{r.name}</span>
                  {r.private && <span className="text-[10px] font-bold uppercase tracking-wider px-1 rounded bg-gray-100 dark:bg-white/10 text-gray-500">private</span>}
                  <a href={r.url} target="_blank" rel="noreferrer" className="text-gray-400 hover:text-gray-600"><ExternalLink className="w-3 h-3" /></a>
                </div>
                {r.description && <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{r.description}</div>}
              </div>
              <Button small tone="primary" disabled={!!importing} onClick={async () => {
                setImporting(r.id); setError(null);
                try {
                  await addTo(access, r.name, async deck => { setImported({ repo: r, result: await api.gitImport(deck.id, provider!, r.id) }); });
                } catch (e: any) { setError(e.message); } finally { setImporting(null); }
              }}>
                {importing === r.id ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Installing…</> : `Import ${r.defaultBranch}`}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400">Import installs the branch&apos;s current commit into this deck&apos;s Python and restarts the deck. Import again later to move to a newer commit.</p>
    </div>
  );
}
