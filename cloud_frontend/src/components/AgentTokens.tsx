"use client";
import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';

type Row = { id: string; label: string; created_at: string; last_used_at: string | null };

/**
 * Tokens for agents outside the browser: an MCP client (Claude Desktop, Claude Code) or a script
 * sends one as `Authorization: Bearer ivc_...` and may then read this workspace's devices and
 * workflows and file proposals, which a person accepts in the Orchestrator. A token cannot
 * accept, run or switch workspace. Shown once at minting; only its hash is kept.
 */
export default function AgentTokens() {
  const [rows, setRows] = useState<Row[]>([]);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { fetch('/api/agent/tokens').then(r => (r.ok ? r.json() : { tokens: [] })).then(d => setRows(d.tokens || [])).catch(() => {}); }, []);
  useEffect(load, [load]);
  const mint = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/agent/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: label || 'MCP client' }) });
      const d = await r.json();
      if (d.token) { setFresh(d.token); setLabel(''); load(); }
    } finally { setBusy(false); }
  };
  const revoke = async (id: string) => { await fetch(`/api/agent/tokens?id=${id}`, { method: 'DELETE' }); load(); };
  return (
    <section className="rounded-xl border px-5 py-4" style={{ background: 'var(--panel-bg)', borderColor: 'var(--panel-border)' }}>
      <h2 className="flex items-center gap-2 text-sm font-semibold mb-1"><KeyRound className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} /> Agent access</h2>
      <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
        Tokens for MCP clients such as Claude Desktop. They can read and propose; they never run anything.
      </p>
      <div className="flex items-center gap-2 mb-3">
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label, e.g. Claude Desktop" className="flex-1 rounded-md border px-3 py-1.5 text-sm bg-transparent" style={{ borderColor: 'var(--panel-border)' }} />
        <button type="button" onClick={mint} disabled={busy} className="btn-primary flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50"><Plus className="w-4 h-4" /> New token</button>
      </div>
      {fresh && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 p-3 text-sm">
          <div className="font-semibold text-amber-800 dark:text-amber-200 mb-1">Copy this token now. It is not shown again.</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs break-all">{fresh}</code>
            <button type="button" onClick={() => navigator.clipboard.writeText(fresh)} title="Copy" className="p-1.5 rounded-md hover:bg-amber-100 dark:hover:bg-amber-500/20"><Copy className="w-4 h-4" /></button>
          </div>
          <div className="mt-2 text-xs text-amber-800/80 dark:text-amber-200/80">Set <code className="font-mono">IVORYOS_CLOUD_URL</code> to this Cloud&apos;s address and <code className="font-mono">IVORYOS_CLOUD_TOKEN</code> to the token where the MCP server runs.</div>
        </div>
      )}
      {rows.length === 0 ? <p className="text-xs text-gray-500">No tokens yet.</p> : (
        <ul className="divide-y rounded-lg border" style={{ borderColor: 'var(--panel-border)' }}>
          {rows.map(r => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="flex-1 min-w-0 truncate">{r.label || 'untitled'}</span>
              <span className="text-xs text-gray-500">{r.last_used_at ? `used ${new Date(r.last_used_at).toLocaleString()}` : 'never used'}</span>
              <button type="button" onClick={() => revoke(r.id)} title="Revoke" className="p-1 rounded-md text-gray-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
