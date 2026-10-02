"use client";
import { Settings2, Radio } from 'lucide-react';
import { useState, useEffect } from 'react';
import AgentTokens from '@/components/AgentTokens';
import { NavPlacementChoice, ThemeChoice, inDesktopApp, useNavPlacement, useThemePreference } from '@ivoryos/shared-ui';
export default function SettingsPage() {
  const [themePref, setThemePref] = useThemePreference();
  const [nav, setNav] = useNavPlacement();
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

  // Short sections, one line of help at most. Pairing lives on Devices; the "Global
  // Orchestration" switches that used to sit here were never wired to anything.
  const card = 'rounded-xl border px-5 py-4';
  const cardStyle = { background: 'var(--panel-bg)', borderColor: 'var(--panel-border)' };
  const muted = { color: 'var(--text-secondary)' };
  const onLan = health?.mode === 'local';
  return (
    <div className="flex-1 flex flex-col h-full w-full overflow-y-auto">
      <header data-ivoryos-page-header="title" className="h-16 shrink-0 border-b flex items-center px-8 z-10 glass-header" style={{ borderColor: 'var(--panel-border)' }}>
        <h1 className="flex items-center gap-2 text-lg font-semibold" style={{ color: 'var(--text-primary)' }}><Settings2 className="w-5 h-5" style={muted} /> Settings</h1>
      </header>

      <div className="px-8 py-6 max-w-2xl w-full mx-auto space-y-4">
        {/* Inside the desktop app the theme and the layout follow the app. */}
        {!desktop && (
          <section className={card} style={cardStyle}>
            <div className="flex items-center justify-between gap-4 pb-3"><span className="text-sm font-medium">Theme</span><ThemeChoice value={themePref} onChange={setThemePref} /></div>
            <div className="flex items-center justify-between gap-4 pt-3 border-t" style={{ borderColor: 'var(--panel-border)' }}><span className="text-sm font-medium">Navigation</span><NavPlacementChoice value={nav} onChange={setNav} /></div>
          </section>
        )}

        <section className={card} style={cardStyle}>
          <h2 className="flex items-center gap-2 text-sm font-semibold mb-3"><Radio className="w-4 h-4" style={muted} /> Broker</h2>
          {onLan ? (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex-1 min-w-[10rem] text-xs" style={muted}>Host
                  <input type="text" value={brokerHost} onChange={(e) => setBrokerHost(e.target.value)} className="mt-1"
                    placeholder={brokerFallback ? brokerFallback.replace(/^mqtts?:\/\//, '').split(':')[0] : '127.0.0.1'} />
                </label>
                <label className="w-24 text-xs" style={muted}>Port
                  <input type="number" value={brokerPort} onChange={(e) => setBrokerPort(Number(e.target.value))} placeholder="1883" className="mt-1" />
                </label>
                <button onClick={saveBroker} disabled={brokerSaving || !brokerHost} className="btn-primary px-4 py-2 rounded-md text-sm font-medium">
                  {brokerSaving ? 'Saving…' : 'Connect'}
                </button>
              </div>
              {brokerError && <p className="mt-2 text-sm text-red-500">{brokerError}</p>}
              {cloudOrigin && <p className="mt-3 text-xs" style={muted}>Devices on this network pair with <span className="font-mono">{cloudOrigin}</span></p>}
            </>
          ) : (
            <p className="text-sm" style={muted}>AWS IoT Core</p>
          )}
          {/* Live state, not save state: a saved host that refuses connections must not look like success. */}
          {health && (
            <p className={`mt-2 text-xs flex items-center gap-1.5 ${health.daemon?.brokerConnected ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${health.daemon?.brokerConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              {health.daemon?.brokerConnected
                ? `Connected${onLan && health.daemon?.brokerUrl ? ` to ${health.daemon.brokerUrl}` : ''}`
                : (health.daemon?.running ? 'Not connected' : 'Daemon not running')}
            </p>
          )}
        </section>

        <AgentTokens />
      </div>
    </div>
  );
}
