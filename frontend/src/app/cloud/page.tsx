"use client";
import { confirmDialog, notify, useDocumentTheme } from '@ivoryos/shared-ui';
import { API_BASE } from '@/config';

import { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, ExternalLink, Loader2 } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

type Pairing = {
  state: 'waiting' | 'approved' | 'connected' | 'denied' | 'expired' | 'error' | 'cancelled';
  code: string;
  approve_url: string;
  cloud_url: string;
  expires_at: string | null;
  error: string | null;
};

type Settings = {
  paired: boolean;
  client_id: string | null;
  broker: string | null;
  connection_state: string;
  connection_error: string | null;
  pairing: Pairing | null;
  paused?: boolean;
  device_id?: string | null;
  /** Whether saved workflows go to Cloud by themselves ('always') or only on Sync now ('manual'). */
  sync_workflows?: 'always' | 'manual';
  /** When workflows were last sent since this edge started (epoch seconds), or null. */
  last_workflow_sync?: number | null;
  workflow_count?: number;
};

/**
 * Pair this edge with Cloud: it shows a code, and a person approves it on Cloud. Nothing is typed
 * here from Cloud, and the credentials never pass through this page: the edge collects them itself
 * with a secret it keeps (ivoryos_edge/cloud_pairing.py).
 */
export default function CloudSettingsPage() {
  const theme = useDocumentTheme();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [name, setName] = useState('');
  const [cloudUrl, setCloudUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    fetch(`${API_BASE}/api/cloud-settings`)
      .then(res => res.json())
      .then(setSettings)
      .catch(() => setError('Could not read this edge’s Cloud settings.'));
  }, []);

  useEffect(() => { load(); }, [load]);

  const pairing = settings?.pairing;
  const pending = pairing?.state === 'waiting' || pairing?.state === 'approved';
  // Follow a pairing in progress, and tick the countdown.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => { load(); setNow(Date.now()); }, 2000);
    return () => clearInterval(t);
  }, [pending, load]);

  const secondsLeft = pairing?.expires_at ? Math.max(0, Math.round((new Date(pairing.expires_at).getTime() - now) / 1000)) : null;

  const call = async (method: string, path: string, body?: object): Promise<any> => {
    setError(''); setBusy(true);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || 'That did not work.');
      return data;
    } catch (e: any) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
      load();
    }
  };

  const startPairing = () => call('POST', '/api/cloud-settings/pair', { name, cloud_url: cloudUrl });
  const cancelPairing = () => call('DELETE', '/api/cloud-settings/pair');
  // Pause: stay paired, stop connecting (Cloud shows it paused). Resume: reconnect, no pairing.
  const pause = () => call('POST', '/api/cloud-settings/pause');
  // Workflows: sent to Cloud by themselves, or only when asked. The instruments are always sent.
  const setSyncMode = (mode: 'always' | 'manual') => call('POST', '/api/cloud-settings/sync-mode', { mode });
  const syncNow = async () => {
    const result = await call('POST', '/api/cloud-settings/sync-now');
    if (result) await notify(`Sent ${result.sent} workflow${result.sent === 1 ? '' : 's'} to Cloud.`, { title: 'Workflows synced' });
  };
  const resume = () => call('POST', '/api/cloud-settings/resume');
  // Remove: leave Cloud for good. Cloud forgets this device; it keeps its id, so pairing again
  // later reconnects the same device.
  const remove = async () => {
    const ok = await confirmDialog(
      'Remove this edge from Cloud? Cloud forgets it and it stops syncing; its past runs and the workflows it sent stay on Cloud as a record. '
      + 'This edge forgets its credentials, so it can pair with any Cloud. To step away for a while instead, use Pause.',
      { title: 'Remove from Cloud?', confirmLabel: 'Remove', tone: 'danger' },
    );
    if (!ok) return;
    const result = await call('POST', '/api/cloud-settings/remove');
    if (result && !result.told_cloud) {
      await notify('Cloud could not be reached, so it was not told. This edge has forgotten its pairing; remove the device on Cloud’s Devices page too.', { title: 'Removed here only' });
    }
  };

  const state = settings?.connection_state || 'disconnected';
  const dot = settings?.paused ? 'bg-gray-500' : state === 'connected' ? 'bg-green-500' : state === 'connecting' || state === 'reconnecting' ? 'bg-amber-500 animate-pulse'
    : state === 'error' || state === 'conflict' ? 'bg-red-500' : 'bg-gray-300 dark:bg-gray-600';
  const label = !settings?.paired ? 'Not paired' : settings.paused ? 'Paused' : state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting…'
    : state === 'reconnecting' ? 'Reconnecting…' : state === 'conflict' ? 'Identity in use elsewhere' : state === 'error' ? 'Connection failed' : 'Disconnected';
  const problem = error || (pairing && ['denied', 'expired', 'error'].includes(pairing.state) ? pairing.error : '') || settings?.connection_error || '';

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      <Sidebar />

      <main className="flex-1 flex flex-col h-full w-full overflow-y-auto">
        <header data-ivoryos-page-header="title" className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center px-8 bg-white dark:bg-black/20 z-10">
          <h2 className="text-base font-medium text-gray-800 dark:text-gray-200">Cloud Connect</h2>
        </header>

        <div className="p-8 max-w-3xl mx-auto w-full space-y-6">
          <div className="bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-2xl p-8 shadow-sm space-y-6">
            <div>
              <h2 className="text-xl font-semibold mb-2">Connect this edge to Cloud</h2>
              <p className="text-gray-500 dark:text-gray-400 text-sm">
                Once connected, this edge shares its status, instruments and saved workflows with IvoryOS Cloud, and can run
                workflows sent from there. It keeps working on its own if the connection drops.
              </p>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
              <span className="font-medium text-gray-700 dark:text-gray-300">{label}</span>
              {settings?.paired && settings.client_id && (
                <span className="text-gray-500 dark:text-gray-400">as <span className="font-mono">{settings.client_id}</span>
                  {settings.broker && <> via <span className="font-mono">{settings.broker}</span></>}</span>
              )}
            </div>

            {problem && (
              <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-500/30 flex items-start gap-3 text-red-700 dark:text-red-400">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                <span className="text-sm font-medium">{problem}</span>
              </div>
            )}

            {pending && pairing ? (
              <div className="p-6 rounded-xl bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/15 dark:border-white/20 flex flex-col items-center gap-3 text-center">
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-900 dark:text-white">Pairing code</span>
                <span className="text-4xl font-mono font-bold tracking-[0.25em] text-gray-900 dark:text-white">{pairing.code}</span>
                <p className="text-sm text-gray-600 dark:text-gray-300 max-w-md">
                  On Cloud, open <strong>Pair a device</strong> and enter this code, or follow the link. Approve it there, and this edge connects on its own.
                </p>
                <a href={pairing.approve_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-fg hover:underline">
                  Approve on Cloud <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {pairing.state === 'approved' ? 'Approved. Connecting…'
                    : secondsLeft !== null ? `Waiting for approval · expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
                    : 'Waiting for approval'}
                </span>
                <button onClick={cancelPairing} disabled={busy} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
              </div>
            ) : !settings?.paired && (
              <div className="p-5 rounded-lg bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 space-y-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="text-sm">
                    <span className="block font-medium mb-1 text-gray-700 dark:text-gray-300">Device name</span>
                    <input value={name} onChange={e => setName(e.target.value)} placeholder="This computer's name"
                      className="w-full px-3 py-2 rounded-lg bg-white dark:bg-black/20 border border-gray-200 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50" />
                  </label>
                  <label className="text-sm">
                    <span className="block font-medium mb-1 text-gray-700 dark:text-gray-300">Cloud address</span>
                    <input value={cloudUrl} onChange={e => setCloudUrl(e.target.value)} placeholder="Hosted Cloud (leave blank)"
                      className="w-full px-3 py-2 rounded-lg bg-white dark:bg-black/20 border border-gray-200 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50" />
                  </label>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Fill in the address only for a Cloud your lab runs itself; its Settings page shows it. The name can be changed when you approve.
                </p>
                <button onClick={startPairing} disabled={busy}
                  className="px-5 py-2.5 rounded-lg font-semibold text-sm bg-accent hover:bg-accent-hover text-on-accent transition-colors disabled:opacity-50">
                  {busy ? 'Starting…' : 'Connect to Cloud'}
                </button>
                {settings?.device_id && (
                  <p className="text-xs text-gray-400">This edge is <span className="font-mono">{settings.device_id}</span> on Cloud; pairing it again reconnects the same device.</p>
                )}
              </div>
            )}

            {pairing?.state === 'connected' && (
              <p className="flex items-center gap-1.5 text-sm font-medium text-green-600 dark:text-green-400">
                <CheckCircle2 className="w-4 h-4" /> Paired and connected.
              </p>
            )}

            {settings?.paired && (
              <div className="pt-4 border-t border-gray-200 dark:border-white/10 space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Workflows on Cloud</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Cloud always knows this edge’s instruments. Whether it also gets the workflows saved here is up to you.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {([
                    ['always', 'Send automatically', 'Every saved workflow goes to Cloud when this edge connects and each time one is saved.'],
                    ['manual', 'Only when I choose', 'Nothing is sent until you press Sync now. Cloud keeps what it was sent before.'],
                  ] as const).map(([mode, title, hint]) => {
                    const on = (settings.sync_workflows || 'always') === mode;
                    return (
                      <button key={mode} type="button" onClick={() => !on && setSyncMode(mode)} disabled={busy} aria-pressed={on}
                        className={`text-left rounded-lg border px-3 py-2.5 transition-colors disabled:opacity-60 ${on
                          ? 'border-accent-tint bg-accent-soft'
                          : 'border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5'}`}>
                        <span className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
                          <span className={`w-3 h-3 rounded-full border ${on ? 'border-accent bg-accent' : 'border-gray-400'}`} />
                          {title}
                        </span>
                        <span className="block text-xs text-gray-500 dark:text-gray-400 mt-1">{hint}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button onClick={syncNow} disabled={busy || settings.paused || settings.connection_state !== 'connected'}
                    title={settings.connection_state === 'connected' && !settings.paused ? 'Send every saved workflow to Cloud now' : 'This edge is not connected to Cloud right now'}
                    className="px-4 py-2 rounded-lg font-semibold text-sm bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/15 disabled:opacity-50">
                    Sync now
                  </button>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {settings.workflow_count ?? 0} saved here
                    {settings.last_workflow_sync
                      ? ` · last sent ${new Date(settings.last_workflow_sync * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                      : (settings.sync_workflows || 'always') === 'manual' ? ' · not sent since this edge started' : ''}
                  </span>
                </div>
                <p className="text-xs text-gray-400">
                  A workflow sent here from Cloud is saved on this edge either way, and deleting one here removes Cloud’s copy.
                </p>
              </div>
            )}

            {settings?.paired && (
              <div className="pt-4 border-t border-gray-200 dark:border-white/10 flex flex-wrap items-center gap-3">
                <p className="text-xs text-gray-500 dark:text-gray-400 flex-1 min-w-[16rem]">
                  {settings.paused
                    ? 'Paused: still paired, not connected. Cloud shows this edge as paused and sends it nothing.'
                    : 'Pause to step away from Cloud for a while and keep the pairing. Remove to leave it for good.'}
                </p>
                {settings.paused ? (
                  <button onClick={resume} disabled={busy}
                    className="px-5 py-2 rounded-lg font-semibold text-sm bg-accent hover:bg-accent-hover text-on-accent disabled:opacity-50">
                    Resume
                  </button>
                ) : (
                  <button onClick={pause} disabled={busy}
                    className="px-5 py-2 rounded-lg font-semibold text-sm bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/15 disabled:opacity-50">
                    Pause
                  </button>
                )}
                <button onClick={remove} disabled={busy}
                  className="px-5 py-2 rounded-lg font-semibold text-sm bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 disabled:opacity-50">
                  Remove from Cloud
                </button>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
