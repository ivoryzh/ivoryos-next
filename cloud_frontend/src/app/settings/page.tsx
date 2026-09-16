"use client";
import { Settings2, Key, Copy, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
export default function SettingsPage() {
  const [brokerType, setBrokerType] = useState<'local' | 'aws'>('local');
  const [endpoint, setEndpoint] = useState('localhost');
  const [clientId, setClientId] = useState('edge-device-01');
  const [generatedToken, setGeneratedToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState('');

  const handleGenerateToken = async () => {
    setProvisionError('');
    setGeneratedToken('');

    if (brokerType === 'local') {
      // No real credentials needed for local/dev MQTT — this can stay a pure client-side encode.
      const config = {
        protocol: 'mqtt',
        endpoint,
        port: 1883,
        client_id: clientId,
        topic_prefix: "ivoryos/edge",
      };
      setGeneratedToken(btoa(JSON.stringify(config)));
      setCopied(false);
      return;
    }

    // AWS IoT mode actually mints a real Thing + certificate via the server (see
    // src/lib/aws-iot.ts) — there's no way to fabricate a working cert client-side, which is
    // exactly what the old placeholder version of this button used to do.
    setIsProvisioning(true);
    try {
      const res = await fetch('/api/devices/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: clientId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to provision device.');
      setGeneratedToken(data.token);
      setCopied(false);
    } catch (err: any) {
      setProvisionError(err.message || 'Failed to provision device.');
    } finally {
      setIsProvisioning(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(generatedToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
              <Key className="w-5 h-5 text-blue-400" />
              Edge Token Generator
            </h2>
            <div className="space-y-6">
               <div className="flex flex-col space-y-4 p-6 rounded-lg" style={{ background: 'var(--sidebar-hover-bg)' }}>
                  <p className="text-sm text-gray-400">Generate a secure Base64 connection token to deploy a new Edge Server. Paste the resulting token into the Edge Server's "Cloud Connect" dashboard.</p>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">Broker Type</label>
                      <select 
                        value={brokerType} 
                        onChange={(e) => setBrokerType(e.target.value as 'local' | 'aws')}
                        className="w-full p-2 rounded bg-black/20 border border-white/10 text-sm focus:ring-1 focus:ring-blue-500"
                      >
                        <option value="local">Local MQTT (Testing)</option>
                        <option value="aws">AWS IoT Core (Production)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Device Name</label>
                      <input
                        type="text"
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        className="w-full p-2 rounded bg-black/20 border border-white/10 text-sm focus:ring-1 focus:ring-blue-500"
                      />
                      {brokerType === 'aws' && (
                        <p className="text-xs text-gray-500 mt-1">A label — the real AWS IoT Thing name gets a random suffix appended for uniqueness.</p>
                      )}
                    </div>
                    {brokerType === 'local' ? (
                      <div className="col-span-2">
                        <label className="block text-sm font-medium mb-1">Endpoint URL</label>
                        <input
                          type="text"
                          value={endpoint}
                          onChange={(e) => setEndpoint(e.target.value)}
                          placeholder="localhost"
                          className="w-full p-2 rounded bg-black/20 border border-white/10 text-sm focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                    ) : (
                      <div className="col-span-2 flex items-center text-xs text-gray-500">
                        Endpoint and certificate are provisioned automatically from this Cloud instance's own AWS IoT account — nothing to fill in.
                      </div>
                    )}
                  </div>

                  {provisionError && (
                    <div className="text-sm text-red-400 bg-red-950/30 border border-red-500/30 rounded-md px-3 py-2">
                      {provisionError}
                    </div>
                  )}

                  <button
                    onClick={handleGenerateToken}
                    disabled={isProvisioning}
                    className="self-start px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-md text-sm font-medium transition-colors"
                  >
                    {isProvisioning ? 'Provisioning device in AWS IoT…' : 'Generate Token'}
                  </button>

                  {generatedToken && (
                    <div className="mt-4 animate-in fade-in slide-in-from-top-2 duration-300">
                      <label className="block text-sm font-medium text-green-400 mb-2">Connection Token Generated!</label>
                      <div className="relative">
                        <textarea 
                          readOnly 
                          value={generatedToken}
                          rows={4}
                          className="w-full p-3 pr-12 rounded bg-black/40 border border-green-500/30 text-xs font-mono text-gray-300 resize-none focus:outline-none"
                        />
                        <button 
                          onClick={copyToClipboard}
                          className="absolute right-2 top-2 p-2 bg-black/60 hover:bg-gray-800 rounded text-gray-300 transition-colors"
                          title="Copy to clipboard"
                        >
                          {copied ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                      <p className="text-xs text-yellow-500/80 mt-2">
                        * Copy this Base64 string and paste it into the local Edge UI.
                      </p>
                    </div>
                  )}
               </div>
            </div>
          </section>
  
        </div>
      </div>
    </div>
  );
}
