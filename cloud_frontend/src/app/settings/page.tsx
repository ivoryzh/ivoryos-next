"use client";
import { Settings2, Key, Radio } from 'lucide-react';
import { useState, useEffect } from 'react';
import { ThemeChoice, inDesktopApp, useThemePreference } from '@ivoryos/shared-ui';
export default function SettingsPage() {
  const [themePref, setThemePref] = useThemePreference();
  const [desktop, setDesktop] = useState(false);
  useEffect(() => { setDesktop(inDesktopApp()); }, []);
  // On a LAN a device needs this Cloud's address to start pairing, the one value it cannot guess.
  const [cloudOrigin, setCloudOrigin] = useState('');
  useEffect(() => { setCloudOrigin(window.location.origin); }, []);

  // --- Cloud broker: which host THIS cloud connects to ---------------------------------------
  // Distinct from the broker handed to *edge devices* when they pair (src/lib/provision.ts).
  // Saving here only records the intent; the daemon is a separate process that picks the
  // change up within ~3s and reconnects, so the live state comes from /api/health rather than
  // from whether the save succeeded.
  const [brokerHost, setBrokerHost] = useState('');
  const [brokerPort, setBrokerPort] = useState(1883);
  const [brokerSaving, setBrokerSaving] = useState(false);
  const [brokerError, setBrokerError] = useState('');
  const [brokerFallback, setBrokerFallback] = useState('');
  const [health, setHealth] = useState<any>(null);

  useEffect(() => {
    fetch('/api/broker-config').then(r => r.json()).then(cfg => {
      if (cfg.host) setBrokerHost(cfg.host);
      if (cfg.port) setBrokerPort(cfg.port);
      setBrokerFallback(cfg.fallbackUrl || '');
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const check = () => fetch('/api/health').then(r => r.json()).then(setHealth).catch(() => {});
    check();
    const t = setInterval(check, 3000);
    return () => clearInterval(t);
  }, []);

  const saveBroker = async () => {
    setBrokerError('');
    setBrokerSaving(true);
    try {
      const res = await fetch('/api/broker-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: brokerHost, port: Number(brokerPort) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save broker config.');
    } catch (e: any) {
      setBrokerError(e.message);
    } finally {
      setBrokerSaving(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full w-full overflow-y-auto">
      <header className="h-16 shrink-0 border-b flex items-center px-8 z-10 glass-header" style={{ borderColor: 'var(--panel-border)' }}>
        <div className="flex items-center space-x-3 text-blue-400">
          <Settings2 className="w-5 h-5" />
          <h1 className="text-xl font-bold tracking-wider" style={{ color: 'var(--text-primary)' }}>Cloud Settings</h1>
        </div>
      </header>

      <div className="pt-4 px-8 pb-8 max-w-4xl mx-auto w-full">
        <div className="glass-panel p-8 rounded-xl space-y-8" style={{ background: 'var(--panel-bg)', border: '1px solid var(--panel-border)' }}>
          
          <section>
            <h2 className="text-xl font-semibold mb-4 border-b pb-2" style={{ borderColor: 'var(--panel-border)' }}>Appearance</h2>
            {desktop ? (
              <p className="text-sm text-gray-500">Follows the IvoryOS app. Change it in the app&apos;s Settings.</p>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-gray-500">One theme for every page. System follows your computer.</p>
                <ThemeChoice value={themePref} onChange={setThemePref} />
              </div>
            )}
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4 border-b pb-2" style={{ borderColor: 'var(--panel-border)' }}>Global Orchestration</h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 rounded-lg" style={{ background: 'var(--sidebar-hover-bg)' }}>
                <div>
                  <h3 className="font-medium">Strict Sequence Enforcement</h3>
                  <p className="text-sm text-gray-500 mt-1">If enabled, devices must completely finish their assigned graph node before the next device in the graph is notified.</p>
                </div>
                <input type="checkbox" className="w-5 h-5 rounded text-blue-500" defaultChecked />
              </div>
              
              <div className="flex items-center justify-between p-4 rounded-lg" style={{ background: 'var(--sidebar-hover-bg)' }}>
                <div>
                  <h3 className="font-medium">Auto-Recovery</h3>
                  <p className="text-sm text-gray-500 mt-1">Automatically attempt to re-dispatch a node if the target edge device disconnects during execution.</p>
                </div>
                <input type="checkbox" className="w-5 h-5 rounded text-blue-500" defaultChecked />
              </div>
            </div>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold mb-4 border-b pb-2 flex items-center gap-2" style={{ borderColor: 'var(--panel-border)' }}>
              <Radio className="w-5 h-5 text-blue-400" />
              Cloud Broker
            </h2>
            <div className="flex flex-col space-y-4 p-6 rounded-lg" style={{ background: 'var(--sidebar-hover-bg)' }}>
              <p className="text-sm text-gray-400">
                The MQTT broker this Cloud connects to. On a LAN this is the machine running mosquitto — 127.0.0.1 if it is this one.
                The daemon applies a change within a few seconds; no restart needed.
              </p>

              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm font-medium mb-1">Host</label>
                  <input
                    type="text"
                    value={brokerHost}
                    onChange={(e) => setBrokerHost(e.target.value)}
                    placeholder={brokerFallback ? brokerFallback.replace(/^mqtts?:\/\//, '').split(':')[0] : '127.0.0.1'}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Port</label>
                  <input
                    type="number"
                    value={brokerPort}
                    onChange={(e) => setBrokerPort(Number(e.target.value))}
                    placeholder="1883"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button onClick={saveBroker} disabled={brokerSaving || !brokerHost} className="btn-primary px-4 py-2 rounded font-medium">
                  {brokerSaving ? 'Saving…' : 'Connect'}
                </button>
                {/* Live state, not save state — a saved host that refuses connections must not look like success. */}
                {health && (
                  <span className={`text-sm ${health.daemon?.brokerConnected ? 'text-green-500' : 'text-orange-400'}`}>
                    {health.daemon?.brokerConnected
                      ? `Connected to ${health.daemon.brokerUrl}`
                      : (health.daemon?.running ? 'Daemon running, broker not connected' : 'Daemon not running')}
                  </span>
                )}
              </div>

              {brokerError && <p className="text-sm text-red-400">{brokerError}</p>}
              {!brokerHost && brokerFallback && (
                <p className="text-xs text-gray-500">Unset — falling back to {brokerFallback} from the environment.</p>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4 border-b pb-2 flex items-center gap-2" style={{ borderColor: 'var(--panel-border)' }}>
              <Key className="w-5 h-5 text-blue-400" />
              Pair a Device
            </h2>
            <div className="flex flex-col space-y-4 p-6 rounded-lg" style={{ background: 'var(--sidebar-hover-bg)' }}>
              <p className="text-sm text-gray-400">
                Start pairing on the device (its <strong>Cloud Connect</strong> page, <strong>Connect</strong> in the IvoryOS app,
                or <code>ivoryos-edge pair</code>). It shows a code; approve it here. The device then fetches its own
                credentials. Nothing is copied between machines, and nothing typed here is ever sent to a device.
              </p>
              {cloudOrigin && (
                <p className="text-xs text-gray-500">
                  On a lab network the device also needs this Cloud&apos;s address: <strong>{cloudOrigin}</strong>
                </p>
              )}
              <a href="/pair" className="btn-primary self-start px-4 py-2 rounded font-medium">Enter a device&apos;s code</a>
            </div>
          </section>
  
        </div>
      </div>
    </div>
  );
}
