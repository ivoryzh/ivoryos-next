"use client";
import React, { useEffect, useState } from 'react';
import { ExternalLink, GitBranch, KeyRound, Loader2, LogOut, Mail, Sparkles, Unplug, UserRound } from 'lucide-react';
import { confirmDialog, notify } from '@ivoryos/shared-ui';
import type { AccountInfo, DesktopApi, GitConnection, GitProvider } from '@/desktop';
import { Button, Field, cardClass, inputClass } from './ui';

export type AuthMode = 'sign-in' | 'sign-up';

/** Initials for an account without a picture. */
export function initials(account: AccountInfo) {
  const source = account.user?.name || account.user?.email || '?';
  const words = source.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] || '?') + (words[1]?.[0] || '')).toUpperCase();
}

export function Avatar({ account, size = 32 }: { account: AccountInfo; size?: number }) {
  const [broken, setBroken] = useState(false);
  const url = account.user?.avatarUrl;
  return url && !broken ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" onError={() => setBroken(true)} style={{ width: size, height: size }} className="rounded-full object-cover shrink-0" />
  ) : (
    <span style={{ width: size, height: size, fontSize: size * 0.4 }} className="rounded-full shrink-0 bg-gradient-to-br from-indigo-500 to-violet-500 text-white font-semibold flex items-center justify-center">
      {account.signedIn ? initials(account) : <UserRound style={{ width: size * 0.55, height: size * 0.55 }} />}
    </span>
  );
}

/**
 * The account page: the Hub's accounts, so one sign-in works on the Hub website and here. Signed
 * out, it is the sign-in / sign-up form; signed in, the profile the Hub shows, the password, the
 * plan, and the GitHub/GitLab connections private drivers come from.
 */
export default function AccountPanel({ api, account, secretsPersist, mode, setMode, onUpgrade }: {
  api: DesktopApi;
  account: AccountInfo;
  secretsPersist: boolean;
  mode: AuthMode;
  setMode: (m: AuthMode) => void;
  onUpgrade: () => void;
}) {
  return (
    <div className="p-6 max-w-3xl space-y-5">
      <h2 className="text-xl font-semibold">{account.signedIn ? 'Account' : mode === 'sign-up' ? 'Create your IvoryOS account' : 'Sign in to IvoryOS'}</h2>
      {account.signedIn
        ? <SignedIn api={api} account={account} onUpgrade={onUpgrade} />
        : <SignInForm api={api} mode={mode} setMode={setMode} />}
      {!secretsPersist && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          This computer has no keychain the app can use, so you will need to sign in again each time the app starts.
        </p>
      )}
    </div>
  );
}

function SignInForm({ api, mode, setMode }: { api: DesktopApi; mode: AuthMode; setMode: (m: AuthMode) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what); setError(null); setSent(null);
    try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    attempt('submit', async () => {
      if (mode === 'sign-in') { await api.signIn(email, password); return; }
      const res = await api.signUp(email, password, name);
      if (res.confirmEmail) setSent(`We sent a confirmation link to ${res.email}. Open it, then sign in here.`);
    });
  };

  return (
    <div className={`${cardClass} p-6 max-w-md space-y-4`}>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        The same account as the IvoryOS Hub website. You do not need one to run decks; it is for Cloud, private drivers and your Hub profile.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Button disabled={!!busy} onClick={() => attempt('github', () => api.signInWith('github'))}>
          {busy === 'github' ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />} GitHub
        </Button>
        <Button disabled={!!busy} onClick={() => attempt('google', () => api.signInWith('google'))}>
          {busy === 'google' ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="font-bold text-sm">G</span>} Google
        </Button>
      </div>
      {(busy === 'github' || busy === 'google') && (
        <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
          Finish signing in in your browser.
          <button type="button" className="text-indigo-600 dark:text-indigo-400 hover:underline" onClick={() => api.cancelSignIn()}>Cancel</button>
        </div>
      )}
      <div className="flex items-center gap-3 text-xs text-gray-400"><span className="h-px flex-1 bg-gray-200 dark:bg-white/10" />or with email<span className="h-px flex-1 bg-gray-200 dark:bg-white/10" /></div>
      <form onSubmit={submit} className="space-y-3">
        {mode === 'sign-up' && (
          <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} autoComplete="name" className={inputClass} /></Field>
        )}
        <Field label="Email"><input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" autoFocus className={inputClass} /></Field>
        <Field label="Password">
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} className={inputClass} />
        </Field>
        {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
        {sent && <div className="text-sm text-green-700 dark:text-green-400 flex gap-2"><Mail className="w-4 h-4 mt-0.5 shrink-0" />{sent}</div>}
        <Button type="submit" tone="primary" className="w-full" disabled={!!busy}>
          {busy === 'submit' && <Loader2 className="w-4 h-4 animate-spin" />} {mode === 'sign-in' ? 'Sign in' : 'Create account'}
        </Button>
      </form>
      <div className="flex items-center justify-between text-xs">
        {mode === 'sign-in' ? (
          <>
            <button type="button" className="text-indigo-600 dark:text-indigo-400 hover:underline" onClick={() => { setMode('sign-up'); setError(null); }}>Create an account</button>
            <button type="button" className="text-gray-500 hover:underline" disabled={!!busy} onClick={() => attempt('reset', async () => {
              await api.resetPassword(email);
              setSent(`If ${email} has an account, a link to set a new password is on its way.`);
            })}>Forgot password?</button>
          </>
        ) : (
          <button type="button" className="text-indigo-600 dark:text-indigo-400 hover:underline" onClick={() => { setMode('sign-in'); setError(null); }}>I already have an account</button>
        )}
      </div>
    </div>
  );
}

function SignedIn({ api, account, onUpgrade }: { api: DesktopApi; account: AccountInfo; onUpgrade: () => void }) {
  const user = account.user!;
  const [name, setName] = useState(user.name || '');
  const [lab, setLab] = useState(user.lab || '');
  const [saving, setSaving] = useState(false);
  const [password, setPassword] = useState('');
  useEffect(() => { setName(user.name || ''); setLab(user.lab || ''); }, [user.name, user.lab]);
  const dirty = name !== (user.name || '') || lab !== (user.lab || '');
  const hasPassword = user.providers.includes('email');
  const pro = account.plan === 'pro';

  const save = async () => {
    setSaving(true);
    try { await api.updateProfile({ full_name: name, lab_info: lab }); } catch (e: any) { notify(e.message, { title: 'Could not save', tone: 'error' }); } finally { setSaving(false); }
  };

  return (
    <>
      <div className={`${cardClass} p-5`}>
        <div className="flex items-center gap-4">
          <Avatar account={account} size={52} />
          <div className="min-w-0 flex-1">
            <div className="font-semibold truncate">{user.name || user.email}</div>
            <div className="text-sm text-gray-500 dark:text-gray-400 truncate">{user.email}</div>
            <div className="text-xs text-gray-400 mt-0.5">Signed in with {user.providers.map(p => (p === 'email' ? 'email' : p[0].toUpperCase() + p.slice(1))).join(', ')}</div>
          </div>
          <Button small tone="ghost" onClick={() => api.openHub('profile')} title="Your profile on the Hub website (picture, public page)"><ExternalLink className="w-3.5 h-3.5" /> Hub profile</Button>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-5">
          <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} className={inputClass} /></Field>
          <Field label="Lab"><input value={lab} onChange={e => setLab(e.target.value)} placeholder="e.g. Hein Lab, UBC" className={inputClass} /></Field>
        </div>
        <div className="mt-3 flex justify-end">
          <Button small tone="primary" disabled={!dirty || saving} onClick={save}>{saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save</Button>
        </div>
      </div>

      <div className={`${cardClass} p-5 flex items-center gap-4`}>
        <span className={`w-10 h-10 rounded-xl flex items-center justify-center ${pro ? 'bg-gradient-to-br from-indigo-500 to-violet-500 text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-500'}`}><Sparkles className="w-5 h-5" /></span>
        <div className="flex-1">
          <div className="font-medium">{pro ? 'IvoryOS Pro' : 'Free plan'} <span className="ml-1 text-[10px] font-bold uppercase tracking-wider text-violet-600 dark:text-violet-300">preview</span></div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{pro ? 'Cloud, private drivers and private repositories are on.' : 'Upgrade for Cloud, a private Hub and private repositories.'}</div>
        </div>
        <Button tone={pro ? 'default' : 'primary'} onClick={onUpgrade}>{pro ? 'Change plan' : 'Upgrade'}</Button>
      </div>

      <GitConnections api={api} pro={pro} onUpgrade={onUpgrade} />

      {hasPassword && (
        <div className={`${cardClass} p-5`}>
          <h3 className="text-sm font-semibold flex items-center gap-2 mb-3"><KeyRound className="w-4 h-4" /> Password</h3>
          <div className="flex gap-2">
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="New password (6+ characters)" autoComplete="new-password" className={inputClass} />
            <Button disabled={password.length < 6} onClick={async () => {
              try { await api.changePassword(password); setPassword(''); notify('Your password was changed.', { title: 'Password changed' }); } catch (e: any) { notify(e.message, { tone: 'error' }); }
            }}>Change</Button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500 dark:text-gray-400">Deleting the account and changing the email are done on the Hub website.</span>
        <Button tone="danger" onClick={async () => {
          if (await confirmDialog('Sign out of IvoryOS on this computer? Running decks keep running.', { title: 'Sign out?', confirmLabel: 'Sign out' })) api.signOut();
        }}><LogOut className="w-4 h-4" /> Sign out</Button>
      </div>
    </>
  );
}

/** GitHub / GitLab personal access tokens, for importing private drivers (Pro). */
export function GitConnections({ api, pro, onUpgrade }: { api: DesktopApi; pro: boolean; onUpgrade: () => void }) {
  const [list, setList] = useState<GitConnection[] | null>(null);
  const [adding, setAdding] = useState<GitProvider | null>(null);
  const [token, setToken] = useState('');
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.gitList().then(setList).catch(() => setList([])); }, [api]);

  const connect = async () => {
    if (!adding) return;
    setBusy(true); setError(null);
    try { setList(await api.gitConnect(adding, token, host || undefined)); setAdding(null); setToken(''); setHost(''); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className={`${cardClass} p-5`}>
      <h3 className="text-sm font-semibold flex items-center gap-2"><GitBranch className="w-4 h-4" /> Private repositories</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 mb-3">
        Connect GitHub or GitLab to add your lab&apos;s private drivers to a deck (Add from Hub → Private repositories). The token stays on this computer, encrypted.
      </p>
      {!pro ? (
        <Button small tone="primary" onClick={onUpgrade}><Sparkles className="w-3.5 h-3.5" /> Upgrade to connect</Button>
      ) : (
        <div className="space-y-2">
          {(list || []).map(c => (
            <div key={c.provider} className="flex items-center gap-3 text-sm">
              <span className="w-16 font-medium">{c.label}</span>
              {c.connected ? (
                <>
                  <span className="flex-1 text-gray-600 dark:text-gray-300 truncate">Connected as <b>{c.login}</b>{c.host !== (c.provider === 'github' ? 'https://github.com' : 'https://gitlab.com') ? ` on ${c.host}` : ''}</span>
                  <Button small tone="ghost" onClick={async () => setList(await api.gitDisconnect(c.provider))}><Unplug className="w-3.5 h-3.5" /> Disconnect</Button>
                </>
              ) : adding === c.provider ? null : (
                <>
                  <span className="flex-1 text-gray-400">Not connected</span>
                  <Button small onClick={() => { setAdding(c.provider); setError(null); }}>Connect</Button>
                </>
              )}
            </div>
          ))}
          {adding && (() => {
            const c = list!.find(x => x.provider === adding)!;
            return (
              <div className="mt-2 rounded-lg border border-gray-200 dark:border-white/10 p-3 space-y-2">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Create {c.scopes}, then paste it here.{' '}
                  <button type="button" className="text-indigo-600 dark:text-indigo-400 hover:underline" onClick={() => api.gitTokenPage(c.provider)}>Create a {c.label} token</button>
                </div>
                <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Personal access token" autoFocus className={`${inputClass} font-mono`} />
                <input value={host} onChange={e => setHost(e.target.value)} placeholder={`Server (optional, for self-hosted ${c.label}): ${c.host}`} className={inputClass} />
                {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
                <div className="flex justify-end gap-2">
                  <Button small tone="ghost" onClick={() => { setAdding(null); setToken(''); setError(null); }}>Cancel</Button>
                  <Button small tone="primary" disabled={!token.trim() || busy} onClick={connect}>{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Connect</Button>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
