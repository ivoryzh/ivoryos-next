"use client";
import React, { useState } from 'react';
import { CheckCircle2, Cloud, ExternalLink, Loader2 } from 'lucide-react';
import type { DesktopApi } from '@/desktop';
import { Button, Modal, inputClass, labelClass } from './ui';

/**
 * What the Cloud row opens in a release that does not offer Cloud yet (`snapshot.cloudComingSoon`,
 * main.js CLOUD_COMING_SOON): a sign-up for early access instead of the plans. The address goes to
 * the IvoryOS team as a Hub contact inquiry; if that cannot be reached, the Hub's contact page is
 * offered instead. Everything Cloud stays in the app for the build that offers it.
 */
export default function CloudEarlyAccess({ api, email: known, name: knownName, onClose }: {
  api: DesktopApi; email?: string | null; name?: string | null; onClose: () => void;
}) {
  const [email, setEmail] = useState(known || '');
  const [state, setState] = useState<{ phase: 'idle' | 'sending' | 'done' } | { phase: 'failed'; error: string; contact?: string }>({ phase: 'idle' });

  const send = async () => {
    setState({ phase: 'sending' });
    try {
      await api.joinEarlyAccess({ email, name: knownName || undefined });
      setState({ phase: 'done' });
    } catch (e: any) {
      setState({ phase: 'failed', error: e.message, contact: e.output });
    }
  };

  const footer = state.phase === 'done' ? (
    <Button tone="primary" onClick={onClose}>Done</Button>
  ) : (
    <>
      {state.phase === 'failed' && state.contact && (
        <Button onClick={() => window.open(state.contact, '_blank')}><ExternalLink className="w-4 h-4" /> Contact page</Button>
      )}
      <Button onClick={onClose}>Not now</Button>
      <Button tone="primary" onClick={send} disabled={state.phase === 'sending' || !email.trim()}>
        {state.phase === 'sending' && <Loader2 className="w-4 h-4 animate-spin" />} Sign up for early access
      </Button>
    </>
  );

  return (
    <Modal title="IvoryOS Cloud" onClose={onClose} footer={footer}>
      {state.phase === 'done' ? (
        <div className="flex items-start gap-3 py-1">
          <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0 text-green-600 dark:text-green-400" />
          <p className="text-sm text-gray-700 dark:text-gray-300">You are on the list. We will write to <b className="font-semibold">{email.trim()}</b> when early access opens.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-white/10 flex items-center justify-center shrink-0">
              <Cloud className="w-5 h-5 text-gray-700 dark:text-gray-200" />
            </div>
            <div className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
              <p className="font-semibold text-gray-900 dark:text-gray-100">Coming soon</p>
              <p>Watch and run the decks in every lab from one place: one workflow across several instruments, schedules, and every result together.</p>
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="early-access-email">Email</label>
            <input id="early-access-email" type="email" autoFocus value={email} onChange={e => setEmail(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && email.trim()) send(); }} placeholder="you@lab.org" className={inputClass} />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Only to tell you when early access opens.</p>
          </div>
          {state.phase === 'failed' && (
            <p className="text-sm text-red-600 dark:text-red-400">{state.error}{state.contact ? ' You can reach us through the contact page instead.' : ''}</p>
          )}
        </div>
      )}
    </Modal>
  );
}
