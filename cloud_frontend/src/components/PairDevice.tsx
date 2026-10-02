"use client";
import { useEffect, useState } from 'react';
import { CheckCircle2, Cpu, ShieldAlert, XCircle } from 'lucide-react';

type Workspace = { id: string; name: string; kind: string };
type Request = {
  code: string; name: string; instruments: string[]; createdAt: string; expiresAt: string;
  // The device's lasting id, and whether Cloud knows it: new, the same device paired again into
  // one of your workspaces ('reattach'), or someone else's ('foreign', which cannot be approved).
  deviceId: string | null; identity: 'new' | 'reattach' | 'foreign'; known: { name: string; workspace: string | null } | null;
};
type Done = { approved: boolean; name?: string; workspace?: string };

/**
 * Approve a device that is asking to join. The device shows a code (its Cloud Connect page, the
 * desktop app, or `ivoryos-edge pair` in a terminal); typing it here shows what is asking, and
 * approving it lets that device collect its credentials. It never works the other way round:
 * nothing typed here is ever sent to a device.
 *
 * Shown as a pop-up over Devices (DevicesPage) and as the /pair page, which is where the link a
 * device shows with its code leads. `onClose` (the pop-up) replaces the link back to Devices.
 */
export default function PairDevice({ onApproved, onClose }: { onApproved?: () => void; onClose?: () => void }) {
  const [code, setCode] = useState('');
  const [request, setRequest] = useState<Request | null>(null);
  const [name, setName] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  useEffect(() => {
    fetch('/api/auth/session').then(r => r.json()).then(s => {
      if (Array.isArray(s.workspaces)) setWorkspaces(s.workspaces);
      if (s.workspace?.id) setWorkspace(s.workspace.id);
    }).catch(() => {});
    // A device's link carries its code (?code=), so following it goes straight to the device.
    const fromLink = new URLSearchParams(window.location.search).get('code');
    if (fromLink) { setCode(fromLink); lookUp(fromLink); }
  }, []);

  async function lookUp(value = code) {
    setError(''); setRequest(null); setDone(null);
    if (!value.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/pair/request?code=${encodeURIComponent(value.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not look that code up.');
      setRequest(data);
      // The same device paired again keeps its name and workspace unless changed here.
      setName(data.known?.name || data.name || '');
      if (data.known?.workspace) setWorkspace(data.known.workspace);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'approve' | 'deny') {
    if (!request) return;
    setError(''); setBusy(true);
    try {
      const res = await fetch('/api/pair/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: request.code, decision, name, workspace }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'That did not work.');
      setDone(decision === 'approve'
        ? { approved: true, name: data.name, workspace: data.workspace?.name }
        : { approved: false });
      if (decision === 'approve') onApproved?.();
      setRequest(null);
      setCode('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const panel = { background: 'var(--panel-bg)', border: '1px solid var(--panel-border)' };

  return (
      <div className="space-y-5">
        <p className="text-sm text-gray-500">
          Start pairing on the device: its <strong>Cloud Connect</strong> page, <strong>Connect</strong> in the IvoryOS app,
          or <code>ivoryos-edge pair</code> in a terminal. It shows a code. Enter it here to see what is asking to join.
        </p>

        <div className="flex gap-3">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') lookUp(); }}
            placeholder="7K4M-9QX2"
            autoFocus
            className="flex-1 font-mono text-lg tracking-widest uppercase"
          />
          <button onClick={() => lookUp()} disabled={busy || !code.trim()} className="btn-primary px-5 py-2 rounded font-medium">
            {busy && !request ? 'Looking…' : 'Look up'}
          </button>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {done && (
          <div className="rounded-xl p-5 flex items-start gap-3" style={panel}>
            {done.approved ? <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" /> : <XCircle className="w-5 h-5 text-gray-400 shrink-0 mt-0.5" />}
            <div className="text-sm">
              {done.approved ? (
                <>
                  <p className="font-medium"><strong>{done.name}</strong> is approved{done.workspace ? <> into <strong>{done.workspace}</strong></> : null}.</p>
                  <p className="text-gray-500 mt-1">
                    It connects within a few seconds and then appears {onClose ? 'in the list' : <>under <a href="/devices" className="font-medium text-accent-fg underline-offset-2 hover:underline">Devices</a></>}.
                  </p>
                  {onClose && (
                    <button type="button" onClick={onClose} className="mt-3 btn-primary px-4 py-1.5 rounded text-sm font-medium">Done</button>
                  )}
                </>
              ) : (
                <p className="font-medium">Declined. The device is told pairing was refused.</p>
              )}
            </div>
          </div>
        )}

        {request && (
          <div className="rounded-xl p-6 space-y-5" style={panel}>
            <div className="flex items-start gap-3">
              <Cpu className="w-5 h-5 text-gray-500 dark:text-gray-300 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold">A device is asking to join</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Code <span className="font-mono">{request.code}</span> · asked {new Date(request.createdAt).toLocaleTimeString()}
                </p>
                <div className="mt-3">
                  <span className="text-xs font-bold uppercase tracking-wider text-gray-500">Its instruments</span>
                  {request.instruments.length ? (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {request.instruments.map((i) => (
                        <span key={i} className="px-2 py-0.5 rounded text-xs font-mono" style={{ background: 'var(--sidebar-hover-bg)' }}>{i}</span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 mt-1">None loaded yet.</p>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2 text-xs rounded-lg p-3 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/15">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>Approve only a device you started pairing yourself, and whose code you can see on its screen. If someone sent you this code, choose <strong>Not mine</strong>.</span>
            </div>

            {request.identity === 'reattach' && request.known && (
              <p className="text-sm rounded-lg p-3" style={{ background: 'var(--sidebar-hover-bg)' }}>
                This is <strong>{request.known.name}</strong>, paired with this Cloud before. Approving reconnects it, with its history.
              </p>
            )}
            {request.identity === 'foreign' && (
              <p className="text-sm rounded-lg p-3 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/15">
                This device is already in a workspace you are not in, so it cannot be approved here. Someone in that workspace has to remove it from Cloud first.
              </p>
            )}

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} />
                <p className="text-xs text-gray-500 mt-1">
                  What Cloud shows for it; no other device in the workspace may have it. You can rename it later on Devices.
                  {request.deviceId && <> Its id, <span className="font-mono">{request.deviceId}</span>, stays fixed.</>}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Workspace</label>
                <select value={workspace} onChange={(e) => setWorkspace(e.target.value)} className="w-full">
                  {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button onClick={() => decide('approve')} disabled={busy || !name.trim() || request.identity === 'foreign'} className="btn-primary px-5 py-2 rounded font-medium">
                {busy ? 'Working…' : request.identity === 'reattach' ? 'Approve and reconnect' : 'Approve'}
              </button>
              <button onClick={() => decide('deny')} disabled={busy} className="px-4 py-2 rounded text-sm font-medium hover-bg" style={{ color: 'var(--text-secondary)' }}>
                Not mine
              </button>
            </div>
          </div>
                )}
      </div>
  );
}
