"use client";
import { Settings2, Key, Radio } from 'lucide-react';
import { useState, useEffect } from 'react';
export default function SettingsPage() {
  const [clientId, setClientId] = useState('');
  const [isPairing, setIsPairing] = useState(false);
  const [pairError, setPairError] = useState('');
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [cloudOrigin, setCloudOrigin] = useState('');

  // Shown alongside the code: on a LAN the device also needs this Cloud's address, and it is the
  // one value the person cannot guess. In an AWS deployment the edge already ships with the
  // production URL, so there it is only reassurance.
  useEffect(() => { setCloudOrigin(window.location.origin); }, []);

  // Shown next to the name field so a collision is visible before you type one, rather than
  // after two devices start fighting over the same MQTT client id.
  const [devices, setDevices] = useState<any[]>([]);
  useEffect(() => {
    const load = () => fetch('/api/devices').then(r => r.json()).then(d => setDevices(Array.isArray(d) ? d : [])).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const nameTaken = !!clientId.trim() && devices.some((d: any) => String(d.id) === clientId.trim());

  // Derived during render from a ticking clock rather than stored: one source of truth for the
  // remaining time, and no state write on mount.
  useEffect(() => {
    if (!pairing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pairing]);
  const secondsLeft = pairing
    ? Math.max(0, Math.round((new Date(pairing.expiresAt).getTime() - now) / 1000))
    : 0;

  const createPairingCode = async () => {
    setPairError('');
    setPairing(null);
    setIsPairing(true);
    try {
      const res = await fetch('/api/pair/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: clientId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create a pairing code.');
      setPairing({ code: data.code, expiresAt: data.expiresAt });
    } catch (e: any) {
      setPairError(e.message);
    } finally {
      setIsPairing(false);
    }
  };

  // --- Cloud broker: which host THIS cloud connects to ---------------------------------------
  // Distinct from the Edge Token Generator below, which configures the broker an *edge device*
  // dials. Saving here only records the intent; the daemon is a separate process that picks the
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
                Generate a short code, then enter it on the edge server&apos;s <strong>Cloud Connect</strong> page.
                The device fetches its own credentials — nothing needs to be copied between machines.
              </p>

              {/* Existing devices, so a name collision is visible before it is typed. */}
              <div className="flex flex-col gap-1">
                <span className="text-xs font-bold uppercase tracking-wider text-gray-500">Registered devices</span>
                {devices.length === 0 ? (
                  <span className="text-sm text-gray-500">None yet.</span>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {devices.map((d: any) => (
                      <span
                        key={d.id}
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono"
                        style={{ background: 'var(--panel-bg)', border: '1px solid var(--panel-border)' }}
                        title={d.last_seen ? `last seen ${new Date(d.last_seen).toLocaleString()}` : 'never connected'}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${String(d.status) === 'online' ? 'bg-green-500' : 'bg-gray-500'}`} />
                        {d.id}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-4 items-end">
                <div className="col-span-2">
                  <label className="block text-sm font-medium mb-1">Device Name</label>
                  <input
                    type="text"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="name this device"
                  />
                </div>
                <button
                  onClick={createPairingCode}
                  disabled={isPairing || !clientId.trim() || nameTaken}
                  className="btn-primary px-4 py-2 rounded font-medium"
                >
                  {isPairing ? 'Generating…' : 'Generate Code'}
                </button>
              </div>

              {nameTaken && (
                <p className="text-sm text-orange-400">
                  <strong>{clientId.trim()}</strong> is already registered. A device name is its MQTT client id —
                  two devices sharing one disconnect each other in a loop, so pick another.
                </p>
              )}

              {pairError && <p className="text-sm text-red-400">{pairError}</p>}

              {pairing && (
                <div className="flex flex-col items-center gap-2 py-4 rounded-lg" style={{ background: 'var(--panel-bg)', border: '1px solid var(--panel-border)' }}>
                  <span className="text-4xl font-mono font-bold tracking-[0.25em] text-blue-400">{pairing.code}</span>
                  {/* A code that has silently expired while you walked to the other machine is the
                      obvious failure here, so the remaining time is shown rather than implied. */}
                  <span className={`text-xs ${secondsLeft > 0 ? 'text-gray-500' : 'text-red-400'}`}>
                    {secondsLeft > 0
                      ? `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')} · single use`
                      : 'Expired — generate a new one'}
                  </span>
                  <span className="text-xs text-gray-500">
                    Enter on the edge server at <strong>Cloud Connect</strong>
                    {cloudOrigin ? <> · this Cloud is <strong>{cloudOrigin}</strong></> : null}
                  </span>
                </div>
              )}
            </div>
          </section>
  
        </div>
      </div>
    </div>
  );
}
