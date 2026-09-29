"use client";
import React, { useState } from 'react';
import { Check, Cloud, GitBranch, Lock, Sparkles } from 'lucide-react';
import { notify } from '@ivoryos/shared-ui';
import type { AccountInfo, DesktopApi } from '@/desktop';
import { Button, Modal } from './ui';

/** What a Pro-only surface was trying to open, so the dialog can lead with it. */
export type UpgradeReason = 'cloud' | 'private' | null;

const FREE = [
  'Run decks and Python scripts on this computer',
  'Designer, Optimize, Execution and Data History',
  'Every public driver on the Hub',
];
const PRO = [
  { icon: Cloud, text: 'IvoryOS Cloud: see and run every deck from anywhere' },
  { icon: Lock, text: 'Private Hub: drivers only your lab can see' },
  { icon: GitBranch, text: 'Import private repositories from GitHub or GitLab' },
];

/**
 * The plan picker. A preview: "Upgrade" switches the account to Pro without any payment (the plan
 * is stored on the account, see desktop/src/account.js), so the Pro features can be tried and
 * the upgrade flow judged before billing exists.
 */
export default function UpgradeDialog({ api, account, reason, onClose, onSignIn }: {
  api: DesktopApi;
  account: AccountInfo;
  reason: UpgradeReason;
  onClose: () => void;
  onSignIn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const pro = account.plan === 'pro';

  const choose = async (plan: 'free' | 'pro') => {
    setBusy(true);
    try {
      await api.setPlan(plan);
      onClose();
    } catch (e: any) {
      await notify(e.message, { title: 'Could not change the plan', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const lead = reason === 'cloud' ? 'IvoryOS Cloud is part of Pro.'
    : reason === 'private' ? 'Private drivers and repositories are part of Pro.'
      : pro ? 'You are on Pro.' : 'Do more with IvoryOS Pro.';

  return (
    <Modal wide title={<span className="flex items-center gap-2"><Sparkles className="w-4 h-4 text-violet-500" /> Plans</span>} onClose={onClose}>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">{lead}</p>
      <div className="grid grid-cols-2 gap-4">
        <div className={`rounded-xl border p-4 ${!pro ? 'border-indigo-300 dark:border-indigo-500/40' : 'border-gray-200 dark:border-white/10'}`}>
          <div className="flex items-baseline justify-between">
            <h3 className="font-semibold">Free</h3>
            <span className="text-sm text-gray-500">$0</span>
          </div>
          <ul className="mt-3 space-y-2 text-sm text-gray-600 dark:text-gray-300">
            {FREE.map(t => <li key={t} className="flex gap-2"><Check className="w-4 h-4 mt-0.5 shrink-0 text-green-500" />{t}</li>)}
          </ul>
          <div className="mt-4">
            {!account.signedIn || !pro ? <span className="text-xs text-gray-500 dark:text-gray-400">{account.signedIn ? 'Your plan' : 'No account needed'}</span>
              : <Button small disabled={busy} onClick={() => choose('free')}>Switch to Free</Button>}
          </div>
        </div>
        <div className={`rounded-xl border p-4 bg-gradient-to-br from-indigo-50 to-violet-50 dark:from-indigo-500/10 dark:to-violet-500/10 ${pro ? 'border-violet-400 dark:border-violet-500/50' : 'border-violet-200 dark:border-violet-500/30'}`}>
          <div className="flex items-baseline justify-between">
            <h3 className="font-semibold">Pro</h3>
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-600 text-white">Preview</span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Everything in Free, plus:</p>
          <ul className="mt-2 space-y-2 text-sm text-gray-700 dark:text-gray-200">
            {PRO.map(({ icon: Icon, text }) => <li key={text} className="flex gap-2"><Icon className="w-4 h-4 mt-0.5 shrink-0 text-violet-500" />{text}</li>)}
          </ul>
          <div className="mt-4">
            {pro ? <span className="text-xs font-medium text-violet-700 dark:text-violet-300">Your plan</span>
              : account.signedIn ? <Button tone="primary" disabled={busy} onClick={() => choose('pro')}><Sparkles className="w-4 h-4" /> Upgrade to Pro</Button>
                : <Button tone="primary" onClick={() => { onClose(); onSignIn(); }}>Sign in to upgrade</Button>}
          </div>
        </div>
      </div>
      <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
        Preview: upgrading is free while plans are being designed, and no payment details are asked for. The plan is saved on your account.
      </p>
    </Modal>
  );
}
