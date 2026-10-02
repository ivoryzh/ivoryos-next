"use client";

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Cloud, Loader2 } from 'lucide-react';

/**
 * Sign in to Cloud with an IvoryOS account, or create one. The account is the same one the Hub
 * and the desktop app use; this Cloud keeps only a session (lib/auth.ts).
 */
export default function LoginPage() {
  return <Suspense><Login /></Suspense>;
}

function Login() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/';
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // An OAuth sign-in that failed comes back here with ?error=.
  const [error, setError] = useState<string | null>(() => params.get('error'));
  const [confirm, setConfirm] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'sign-in' ? { email, password } : { email, password, name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Signing in failed.');
      if (body.confirmEmail) { setConfirm(body.email || email); return; }
      router.replace(next.startsWith('/') ? next : '/');
      router.refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full px-3 py-2 rounded-lg text-sm bg-transparent border outline-none focus:border-accent';
  const inputStyle = { borderColor: 'var(--panel-border)', color: 'var(--text-primary)' } as const;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl p-7 space-y-5" style={{ background: 'var(--panel-bg)', border: '1px solid var(--panel-border)' }}>
        <div className="flex items-center gap-2">
          <Cloud className="w-6 h-6 text-gray-500 dark:text-gray-300" />
          <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>IvoryOS Cloud</h1>
        </div>

        {confirm ? (
          <div className="space-y-3 text-sm" style={{ color: 'var(--text-primary)' }}>
            <p>We sent a confirmation link to <b>{confirm}</b>. Open it, then sign in here.</p>
            <button type="button" className="font-medium text-accent-fg underline-offset-2 hover:underline" onClick={() => { setConfirm(null); setMode('sign-in'); }}>Back to sign in</button>
          </div>
        ) : (
          <>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {mode === 'sign-in' ? 'Sign in with your IvoryOS account.' : 'Create an IvoryOS account. The same account works on the Hub and in the IvoryOS app.'}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {(['github', 'google'] as const).map(p => (
                <a key={p} href={`/api/auth/oauth?provider=${p}&next=${encodeURIComponent(next)}`}
                  className="text-center px-3 py-2 rounded-lg text-sm font-medium border hover:opacity-80" style={inputStyle}>
                  {p === 'github' ? 'GitHub' : 'Google'}
                </a>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <span className="flex-1 border-t" style={{ borderColor: 'var(--panel-border)' }} /> or with email <span className="flex-1 border-t" style={{ borderColor: 'var(--panel-border)' }} />
            </div>
            <form onSubmit={submit} className="space-y-3">
              {mode === 'sign-up' && <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" className={input} style={inputStyle} />}
              <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" autoFocus className={input} style={inputStyle} />
              <input type="password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" className={input} style={inputStyle} />
              {error && <div className="text-sm text-red-500">{error}</div>}
              <button type="submit" disabled={busy} className="w-full py-2 rounded-lg text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover disabled:opacity-50 flex items-center justify-center gap-2">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                {mode === 'sign-in' ? 'Sign in' : 'Create account'}
              </button>
            </form>
            <button type="button" className="text-sm font-medium text-accent-fg underline-offset-2 hover:underline" onClick={() => { setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in'); setError(null); }}>
              {mode === 'sign-in' ? 'Create an IvoryOS account' : 'I already have an account'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
