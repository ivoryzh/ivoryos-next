"use client";

import { useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronsUpDown, LogOut, User } from 'lucide-react';
import { TopNavMenu, TopNavMenuItem } from '@ivoryos/shared-ui';

type Workspace = { id: string; kind: 'personal' | 'org'; name: string; role?: string };
type SessionInfo = { user: { id: string; email: string | null; name: string | null }; workspace: Workspace; workspaces: Workspace[] };

/**
 * Which workspace this browser is working in -- your own, or one of your organizations' lab
 * spaces -- and who is signed in. Everything Cloud lists (devices, runs, library, schedules,
 * results) is that workspace's; switching reloads the page so no list keeps another's rows.
 */
export default function WorkspaceSwitcher({ expanded, compact = false }: { expanded: boolean; /** One short line, for the top bar. */ compact?: boolean }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/auth/session', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(body => setInfo(body && body.signedIn ? body : null))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (!info) return null;
  const Icon = info.workspace.kind === 'org' ? Building2 : User;
  const who = info.user.name || info.user.email || 'Signed in';

  const choose = async (id: string) => {
    setOpen(false);
    if (id === info.workspace.id) return;
    await fetch('/api/auth/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    window.location.reload();
  };
  const signOut = async () => {
    await fetch('/api/auth/sign-out', { method: 'POST' });
    window.location.href = '/login';
  };

  // In the top bar: the shared menu pill (shared-ui TopNav.tsx), which keeps its menu clear of
  // whatever the page draws below the bar.
  if (compact) {
    return (
      <TopNavMenu
        label={info.workspace.kind === 'org' ? info.workspace.name : 'Personal'}
        icon={<Icon className="w-4 h-4 shrink-0" />}
        title={`${info.workspace.name} · ${who}`}
      >
        {(close) => (
          <>
            <div className="px-3 pt-1.5 pb-2 mb-1 border-b border-gray-200 dark:border-white/10">
              <div className="text-[11px] text-gray-500 dark:text-gray-400">Signed in as</div>
              <div className="text-sm font-medium truncate">{who}</div>
            </div>
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Workspaces</div>
            {info.workspaces.map(w => (
              <TopNavMenuItem
                key={w.id}
                onClick={() => { close(); choose(w.id); }}
                icon={w.kind === 'org' ? <Building2 className="w-3.5 h-3.5 shrink-0" /> : <User className="w-3.5 h-3.5 shrink-0" />}
                trailing={w.id === info.workspace.id ? <Check className="w-3.5 h-3.5 shrink-0 text-gray-700 dark:text-gray-200" /> : undefined}
              >
                {w.kind === 'org' ? w.name : 'Personal workspace'}
              </TopNavMenuItem>
            ))}
            <div className="my-1 border-t border-gray-200 dark:border-white/10" />
            <TopNavMenuItem onClick={() => { close(); signOut(); }} icon={<LogOut className="w-3.5 h-3.5 shrink-0" />}>Sign out</TopNavMenuItem>
          </>
        )}
      </TopNavMenu>
    );
  }

  return (
    <div ref={box} className="relative px-3">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title={`${info.workspace.name} · ${who}`}
        className="w-full flex items-center gap-2 rounded-lg px-2 py-2 hover-bg"
        style={{ color: 'var(--text-primary)' }}
      >
        <span className="w-6 h-6 shrink-0 rounded-md flex items-center justify-center bg-gray-900/15 dark:bg-white/15 text-gray-500 dark:text-gray-300"><Icon className="w-3.5 h-3.5" /></span>
        {expanded && (
          <>
            <span className="flex-1 min-w-0 text-left">
              <span className="block text-sm font-medium truncate">{info.workspace.kind === 'org' ? info.workspace.name : 'Personal workspace'}</span>
              <span className="block text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>{who}</span>
            </span>
            <ChevronsUpDown className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} />
          </>
        )}
      </button>
      {open && (
        <div className="absolute left-3 right-3 mt-1 z-50 rounded-lg shadow-xl py-1 text-sm" style={{ minWidth: '14rem', background: 'var(--panel-bg-solid, var(--panel-bg))', border: '1px solid var(--panel-border)', backdropFilter: 'blur(12px)' }}>
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Workspaces</div>
          {info.workspaces.map(w => (
            <button key={w.id} type="button" onClick={() => choose(w.id)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover-bg" style={{ color: 'var(--text-primary)' }}>
              {w.kind === 'org' ? <Building2 className="w-3.5 h-3.5" /> : <User className="w-3.5 h-3.5" />}
              <span className="flex-1 truncate">{w.kind === 'org' ? w.name : 'Personal workspace'}</span>
              {w.id === info.workspace.id && <Check className="w-3.5 h-3.5 text-gray-500 dark:text-gray-300" />}
            </button>
          ))}
          <div className="my-1 border-t" style={{ borderColor: 'var(--panel-border)' }} />
          <button type="button" onClick={signOut} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover-bg" style={{ color: 'var(--text-primary)' }}>
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
