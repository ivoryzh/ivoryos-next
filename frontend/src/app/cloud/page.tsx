"use client";
import { API_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Cloud, Save, CheckCircle2, AlertTriangle } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

export default function CloudSettingsPage() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [paired, setPaired] = useState(false);
  const [pairedAs, setPairedAs] = useState<{ clientId: string; broker: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  // Pairing replaces carrying the token here by hand. On a LAN the Cloud URL must be supplied
  // (Cloud sits at an arbitrary local address); a hosted deployment is at a fixed URL this device
  // already knows, so there the code is the only input. The token field below stays as a manual
  // fallback for a device that can reach the broker but not Cloud's HTTP port.
  const [pairCode, setPairCode] = useState('');
  const [cloudUrl, setCloudUrl] = useState('');
  const [isPairing, setIsPairing] = useState(false);
  // 'idle' means "not attempted this session" — distinct from 'disconnected', which means the
  // edge server itself confirmed there's no active broker connection (e.g. token was cleared).
  const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'error' | 'disconnected'>('idle');

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');

    // Fetch current settings
    fetch(`${API_BASE}/api/cloud-settings`)
      .then(res => res.json())
      .then(data => {
        setPaired(!!data.paired);
        setPairedAs(data.client_id ? { clientId: data.client_id, broker: data.broker || '' } : null);
        if (data.connection_state) setConnectionState(data.connection_state);
        if (data.connection_error) setError(data.connection_error);
      })
      .catch(err => {
        console.error("Failed to fetch cloud settings", err);
        setError('Failed to connect to local edge server to read settings.');
      });
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  // Validate: the POST below blocks on the edge server actually attempting the connection (up to
  // ~5s — see setup_broker's is_connected() poll) and its response IS the real outcome, so there's
  // no separate "click save, then hope" step — a bad cert or wrong endpoint comes back as an
  // explicit error here, not silence.
  const pairWithCode = async () => {
    setError('');
    setIsPairing(true);
    setConnectionState('connecting');
    try {
      const res = await fetch(`${API_BASE}/api/cloud-settings/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: pairCode, cloud_url: cloudUrl }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Pairing failed.');

      // The edge server applies the redeemed token through the same path a pasted one uses, so
      // the result it reports back is the real broker connection state, not just "code accepted".
      setPaired(true);
      setPairedAs(data.client_id ? { clientId: data.client_id, broker: data.broker || '' } : null);
      setConnectionState(data.connection_state || 'connected');
      if (data.connection_state === 'error') {
        setError(data.connection_error || 'Paired, but the broker connection failed.');
      } else {
        setPairCode('');
      }
    } catch (e: any) {
      setConnectionState('error');
      setError(e.message);
    } finally {
      setIsPairing(false);
    }
  };

  const disconnectCloud = async () => {
    setIsSaving(true);
    setError('');

    try {
      const res = await fetch(`${API_BASE}/api/cloud-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: "" })
      });

      if (res.ok) {
        setPaired(false);
        setPairedAs(null);
        setConnectionState('disconnected');
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to disconnect.');
      }
    } catch (err: any) {
      setError(err.message || 'Network error.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      <main className="flex-1 flex flex-col h-full w-full overflow-y-auto">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center px-8 bg-white dark:bg-black/20 z-10">
          <h2 className="text-base font-medium text-gray-800 dark:text-gray-200">Cloud Connect</h2>
        </header>

        <div className="p-8 max-w-4xl mx-auto w-full">
          <div className="bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-2xl p-8 shadow-sm">
            <div className="mb-8">
              <h2 className="text-xl font-semibold mb-2">Edge-to-Cloud Registration</h2>
              <p className="text-gray-500 dark:text-gray-400 text-sm">
                Configure your edge device to connect to a centralized IvoryOS SaaS Cloud Orchestrator.
                When connected, this device publishes its status, schema, and saved workflows to the cloud over MQTT.
              </p>
            </div>

            <div className="mb-6 flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                connectionState === 'connected' ? 'bg-green-500' :
                connectionState === 'connecting' ? 'bg-amber-500 animate-pulse' :
                connectionState === 'error' ? 'bg-red-500' :
                'bg-gray-300 dark:bg-gray-600'
              }`} />
              <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
                {connectionState === 'connected' ? 'Connected' :
                 connectionState === 'connecting' ? 'Connecting…' :
                 connectionState === 'error' ? 'Connection failed' :
                 connectionState === 'disconnected' ? 'Disconnected' :
                 'Not configured'}
              </span>
            </div>

            {error && (
              <div className="mb-6 p-4 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-500/30 flex items-start space-x-3 text-red-700 dark:text-red-400">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                <span className="text-sm font-medium">{error}</span>
              </div>
            )}

            <div className="space-y-6">
              <div className="p-5 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-500/30">
                <label className="block text-sm font-semibold mb-2 text-gray-700 dark:text-gray-300">
                  Pair with Cloud
                </label>
                <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                  Generate a code in Cloud under <strong>Settings &rarr; Pair a Device</strong>, then enter it here.
                  This device fetches its own credentials — nothing needs to be copied between machines.
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <input
                    value={pairCode}
                    onChange={e => setPairCode(e.target.value)}
                    placeholder="7K4M-9QX2"
                    className="px-4 py-2.5 rounded-lg bg-white dark:bg-black/20 border border-gray-200 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm font-mono tracking-widest uppercase"
                  />
                  <input
                    value={cloudUrl}
                    onChange={e => setCloudUrl(e.target.value)}
                    placeholder="Cloud URL (LAN only)"
                    className="col-span-2 px-4 py-2.5 rounded-lg bg-white dark:bg-black/20 border border-gray-200 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
                  />
                </div>
                <button
                  onClick={pairWithCode}
                  disabled={isPairing || !pairCode.trim()}
                  className="mt-3 px-6 py-2.5 rounded-lg font-bold text-sm bg-indigo-600 hover:bg-indigo-700 text-white transition-colors disabled:opacity-50"
                >
                  {isPairing ? 'Pairing…' : 'Pair'}
                </button>
                <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                  Leave the URL blank on a hosted Cloud — this device already knows it. On a LAN, use the address Cloud shows beside the code.
                </p>
              </div>

              {/* No token field. It used to both accept and *display* CLOUD_TOKEN, which on AWS
                  wraps this device's private key — so opening this page put a private key in the
                  DOM. Pairing replaces the paste path, and CLOUD_TOKEN in .env remains the
                  headless route for image- or config-managed deployments. */}
              <div className="p-4 rounded-lg bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10">
                {paired && pairedAs ? (
                  <div className="text-sm">
                    <span className="text-gray-500 dark:text-gray-400">Paired as </span>
                    <span className="font-mono font-semibold text-gray-800 dark:text-gray-200">{pairedAs.clientId}</span>
                    {pairedAs.broker && (
                      <>
                        <span className="text-gray-500 dark:text-gray-400"> via </span>
                        <span className="font-mono text-gray-700 dark:text-gray-300">{pairedAs.broker}</span>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    Not paired with any Cloud yet.
                  </div>
                )}
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-gray-200 dark:border-white/10 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                {connectionState === 'connected' && !isSaving && (
                  <span className="flex items-center space-x-1.5 text-sm font-medium text-green-600 dark:text-green-400">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Validated — broker connection confirmed</span>
                  </span>
                )}
              </div>
              <div className="flex items-center space-x-3">
                <button 
                  onClick={disconnectCloud}
                  disabled={isSaving || !paired}
                  className="flex items-center space-x-2 px-6 py-2.5 rounded-lg font-bold text-sm bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors disabled:opacity-50"
                >
                  <span>Disconnect</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
