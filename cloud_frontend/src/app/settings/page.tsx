import { Settings2 } from 'lucide-react';

export default function SettingsPage() {
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
            <h2 className="text-xl font-semibold mb-4 border-b pb-2" style={{ borderColor: 'var(--panel-border)' }}>Access Control</h2>
            <div className="space-y-4">
               <div className="flex flex-col space-y-2 p-4 rounded-lg" style={{ background: 'var(--sidebar-hover-bg)' }}>
                  <label className="font-medium">Edge Registration Key</label>
                  <input type="text" defaultValue="edge-default-01" className="p-2 rounded bg-black/10 border border-white/10 w-full max-w-md input-ghost" />
                  <p className="text-xs text-gray-500 mt-2">The secret key required for Edge Devices to register with this Cloud Orchestrator.</p>
               </div>
            </div>
          </section>
  
        </div>
      </div>
    </div>
  );
}
