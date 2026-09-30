"use client";
import React, { useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, Cloud, ExternalLink, Link2, Loader2, Network, Play, Table2, Workflow } from 'lucide-react';
import { promptDialog } from '@ivoryos/shared-ui';
import type { CloudCheck, CloudLink, DesktopApi, Profile } from '@/desktop';
import { Button, StatusDot, cardClass } from './ui';

/**
 * Each running deck's Cloud link, read from its own `/api/cloud-settings` every few seconds.
 * A stopped deck has no answer to give, so it is simply absent.
 */
export function useCloudLinks(profiles: Profile[]): Record<string, CloudLink> {
  const [links, setLinks] = useState<Record<string, CloudLink>>({});
  const key = JSON.stringify(profiles.filter(p => p.status.state === 'running' && p.status.url).map(p => [p.id, p.status.url]));
  useEffect(() => {
    const running = JSON.parse(key) as [string, string][];
    let cancelled = false;
    const poll = async () => {
      const next: Record<string, CloudLink> = {};
      await Promise.all(running.map(async ([id, url]) => {
        try {
          const res = await fetch(`${url}/api/cloud-settings`);
          if (res.ok) next[id] = await res.json();
        } catch { /* starting up or just stopped: no answer this round */ }
      }));
      if (!cancelled) setLinks(next);
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [key]);
  return links;
}

const BENEFITS = [
  { icon: Network, title: 'Every deck, one screen', text: 'See which decks are online, what each is running, and which one is waiting for someone, from any computer.' },
  { icon: Workflow, title: 'Workflows across instruments', text: 'Run one workflow over decks on different computers or in different rooms, each step in order.' },
  { icon: CalendarClock, title: 'Schedules and repeats', text: 'Start runs at set times, or repeat a step every 20 minutes, without anyone at the bench.' },
  { icon: Table2, title: 'Results in one place', text: 'Every run’s data from every deck, as tables and CSV, in one history.' },
];

/**
 * The launcher's entry point to IvoryOS Cloud. Signing in happens on Cloud, in the browser: the
 * desktop app never asks for a password. A deck joins with a short pairing code made on Cloud and
 * typed into that deck's Cloud Connect page, which this page opens in the deck's tab.
 */
export default function CloudPanel({ api, profiles, links, cloudUrl, run }: {
  api: DesktopApi;
  profiles: Profile[];
  links: Record<string, CloudLink>;
  cloudUrl: string;
  run: (fn: () => Promise<unknown>) => void;
}) {
  const connected = profiles.filter(p => links[p.id]?.paired && links[p.id]?.connection_state === 'connected').length;
  // Whether the Cloud address answers, re-checked when it changes: the hosted Cloud is not live
  // yet, and a button that opens a page which never loads is worse than saying so.
  const [reach, setReach] = useState<CloudCheck | null>(null);
  const [recheck, setRecheck] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setReach(null);
    api.checkCloud().then(r => { if (!cancelled) setReach(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [api, cloudUrl, recheck]);

  const setAddress = async () => {
    const url = await promptDialog(
      'The address of the Cloud your decks pair with. Change it only if your lab runs its own Cloud on its network. Each deck uses the new address from its next start.',
      { title: 'Cloud address', defaultValue: cloudUrl },
    );
    if (url !== null && url !== undefined) run(() => api.setCloudUrl(url.trim()));
  };

  const connect = (p: Profile) => run(async () => {
    if (p.status.state !== 'running') await api.start(p.id);
    await api.open(p.id, '/cloud/');
  });

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="rounded-2xl p-6 bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-sm">
        <div className="flex items-center gap-2 text-sm font-medium text-indigo-100">
          <Cloud className="w-4 h-4" /> Cloud
          <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/15">Early access</span>
        </div>
        <h2 className="mt-2 text-2xl font-semibold">Manage every deck from one place</h2>
        <p className="mt-1 text-sm text-indigo-100 max-w-2xl">
          Everything here keeps working on this computer without an account. Cloud adds the view across decks, computers and labs.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" disabled={reach?.reachable === false} onClick={() => run(() => api.openCloud())} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-indigo-700 text-sm font-semibold hover:bg-indigo-50 disabled:opacity-60 disabled:cursor-not-allowed">
            <Cloud className="w-3.5 h-3.5" /> Open Cloud
          </button>
          <button type="button" disabled={reach?.reachable === false} title="Open it in your web browser instead" onClick={() => run(() => api.openCloudInBrowser())} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/15 text-white text-sm font-medium hover:bg-white/25 disabled:opacity-60 disabled:cursor-not-allowed">
            <ExternalLink className="w-3.5 h-3.5" /> Browser
          </button>
          <span className="text-xs text-indigo-100">
            {reach === null ? 'Checking the Cloud address…' : reach.reachable ? `Opens ${cloudUrl.replace(/^https?:\/\//, '')} as a tab here, beside your decks.` : 'Not reachable right now: see below.'}
          </span>
        </div>
      </div>

      {reach && !reach.reachable && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-900/10 p-4 flex gap-3 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1 space-y-1 text-amber-900 dark:text-amber-200">
            <p className="font-medium">Cloud is not answering at {cloudUrl}.</p>
            {reach.suggestion ? (
              <p className="text-amber-800/90 dark:text-amber-200/80">
                Found one at <span className="font-mono">{reach.suggestion.url}</span>. {reach.suggestion.reason}
              </p>
            ) : (
              <p className="text-amber-800/90 dark:text-amber-200/80">
                The hosted Cloud is not open yet. If your lab runs its own Cloud, set its address; one on this computer
                is usually <span className="font-mono">http://localhost:3000</span>. {reach.error ? `(${reach.error})` : ''}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5 shrink-0">
            {reach.suggestion && <Button small tone="primary" onClick={() => run(() => api.setCloudUrl(reach.suggestion!.url))}>Use {reach.suggestion.url.replace(/^https?:\/\//, '')}</Button>}
            <Button small onClick={setAddress}>Set Cloud address</Button>
            <Button small tone="ghost" onClick={() => setRecheck(n => n + 1)}>Check again</Button>
          </div>
        </div>
      )}
      {reach?.reachable && reach.isCloud === false && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-900/10 p-4 text-sm text-amber-900 dark:text-amber-200">
          Something answers at {cloudUrl}, but it does not look like IvoryOS Cloud. Check the address.
        </div>
      )}
      {reach?.reachable && !!reach.problems?.length && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-900/10 p-4 flex gap-3 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1 text-amber-900 dark:text-amber-200">
            <p className="font-medium">Cloud is up at {cloudUrl}, but reports a problem on its side:</p>
            <ul className="mt-1 list-disc pl-5 space-y-0.5 text-amber-800/90 dark:text-amber-200/80">
              {reach.problems.map(p => <li key={p}>{p}</li>)}
            </ul>
          </div>
          <Button small tone="ghost" onClick={() => setRecheck(n => n + 1)}>Check again</Button>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        {BENEFITS.map(b => (
          <div key={b.title} className={`${cardClass} p-4 flex gap-3`}>
            <span className="w-9 h-9 shrink-0 rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300 flex items-center justify-center"><b.icon className="w-4 h-4" /></span>
            <div>
              <div className="text-sm font-semibold">{b.title}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{b.text}</div>
            </div>
          </div>
        ))}
      </div>

      <div className={`${cardClass} overflow-hidden`}>
        <div className="px-4 py-3 border-b border-gray-100 dark:border-white/10 flex items-center gap-3">
          <div className="flex-1">
            <h3 className="text-sm font-semibold">Your decks</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {connected} of {profiles.length} connected. To connect one, make a pairing code in Cloud’s Settings, then enter it on the deck’s Cloud Connect page.
            </p>
          </div>
          <Button small tone="ghost" onClick={setAddress} title="Only for a Cloud your lab runs itself">{cloudUrl.replace(/^https?:\/\//, '')}</Button>
        </div>
        {profiles.length === 0 ? (
          <p className="p-4 text-sm text-gray-500">Create a deck or script profile first.</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-white/5">
            {profiles.map(p => {
              const link = links[p.id];
              return (
                <li key={p.id} className="px-4 py-3 flex items-center gap-3">
                  <StatusDot status={p.status} />
                  <span className="text-sm font-medium flex-1 truncate">{p.name}</span>
                  <LinkState running={p.status.state === 'running'} link={link} />
                  <Button small tone={link?.paired ? 'ghost' : 'default'} disabled={['starting', 'stopping', 'installing'].includes(p.status.state)} onClick={() => connect(p)}>
                    {p.status.state !== 'running' ? <><Play className="w-3.5 h-3.5" /> Start and connect</> : link?.paired ? 'Cloud settings' : <><Link2 className="w-3.5 h-3.5" /> Connect</>}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function LinkState({ running, link }: { running: boolean; link?: CloudLink }) {
  const base = 'inline-flex items-center gap-1.5 text-xs';
  if (!running) return <span className={`${base} text-gray-400`}>Start the deck to see its link</span>;
  if (!link) return <span className={`${base} text-gray-400`}><Loader2 className="w-3 h-3 animate-spin" /> Checking</span>;
  if (!link.paired) return <span className={`${base} text-gray-500 dark:text-gray-400`}>Not connected</span>;
  if (link.connection_state === 'connected') return <span className={`${base} text-green-700 dark:text-green-400`}><CheckCircle2 className="w-3.5 h-3.5" /> Connected{link.client_id ? ` as ${link.client_id}` : ''}</span>;
  if (link.connection_state === 'error') return <span title={link.connection_error || ''} className={`${base} text-red-600 dark:text-red-400`}><AlertTriangle className="w-3.5 h-3.5" /> Paired, cannot reach Cloud</span>;
  return <span className={`${base} text-amber-600 dark:text-amber-400`}><Loader2 className="w-3 h-3 animate-spin" /> Connecting</span>;
}
