"use client";
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CheckCircle2, Copy, ExternalLink, Loader2, Send } from 'lucide-react';
import { chooseDialog } from '@ivoryos/shared-ui';
import type { DesktopApi, ReportFailure } from '@/desktop';
import { Button, Modal, inputClass, labelClass } from './ui';

type Phase =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'sent'; id: string }
  | { phase: 'failed'; error: string; issueUrl?: string };

/**
 * "Send to IvoryOS" (desktop/src/problemReport.js), offered where something failed for reasons
 * the person may not be able to fix: a deck that would not start or stopped, and a Hub install.
 * They read exactly what will be sent and can edit or delete any of it; tokens, keys, emails and
 * their home folder are already masked. Nothing leaves the machine until Send.
 */
export function ReportProblem({ api, profileId, failure, onClose }: { api: DesktopApi; profileId: string | null; failure?: ReportFailure; onClose: () => void }) {
  const [details, setDetails] = useState<string | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [kind, setKind] = useState('other');
  const [account, setAccount] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [reply, setReply] = useState(true);
  const [email, setEmail] = useState('');
  const [state, setState] = useState<Phase>({ phase: 'idle' });

  useEffect(() => {
    let live = true;
    api.prepareReport(profileId, failure)
      .then(r => { if (live) { setDetails(r.details); setKind(r.kind); setAccount(r.email); } })
      .catch(e => { if (live) setPrepError(e.message); });
    return () => { live = false; };
    // Prepared once, for the failure it was opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, profileId]);

  const contact = account ? (reply ? account : null) : (email.trim() || null);
  const send = async () => {
    setState({ phase: 'sending' });
    try {
      const { id } = await api.sendReport({ description, details: details || '', kind, contactEmail: contact });
      setState({ phase: 'sent', id });
    } catch (e: any) {
      setState({ phase: 'failed', error: e.message, issueUrl: e.output });
    }
  };
  const copy = () => api.copy([description.trim() && `What happened:\n${description.trim()}`, details].filter(Boolean).join('\n\n'));

  const footer = state.phase === 'sent' ? (
    <Button tone="primary" onClick={onClose}>Done</Button>
  ) : state.phase === 'failed' ? (
    <>
      <Button onClick={copy}><Copy className="w-4 h-4" /> Copy report</Button>
      {state.issueUrl && (
        <Button onClick={() => window.open(state.issueUrl, '_blank')} title="GitHub issues are public: read the report through first">
          <ExternalLink className="w-4 h-4" /> Open a GitHub issue
        </Button>
      )}
      <Button tone="primary" onClick={send}><Send className="w-4 h-4" /> Try again</Button>
    </>
  ) : (
    <>
      <Button onClick={copy} disabled={details === null}><Copy className="w-4 h-4" /> Copy</Button>
      <Button onClick={onClose}>Cancel</Button>
      <Button tone="primary" onClick={send} disabled={details === null || state.phase === 'sending'}>
        {state.phase === 'sending' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send
      </Button>
    </>
  );

  return (
    <Modal title="Send to IvoryOS" onClose={onClose} wide footer={footer}>
      {state.phase === 'sent' ? (
        <div className="flex items-start gap-3 py-2">
          <CheckCircle2 className="w-5 h-5 mt-0.5 text-green-600 dark:text-green-400 shrink-0" />
          <div className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
            <p className="font-medium text-gray-900 dark:text-gray-100">Sent. Thank you.</p>
            <p>Reference <span className="font-mono">{state.id.slice(0, 8)}</span>{contact ? <> · we will reply to {contact}</> : null}</p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className={labelClass} htmlFor="report-what">What happened</label>
            <textarea id="report-what" autoFocus rows={3} value={description} onChange={e => setDescription(e.target.value)}
              placeholder="What were you doing when it went wrong? (optional)" className={`${inputClass} resize-y`} />
          </div>
          {account ? (
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={reply} onChange={e => setReply(e.target.checked)} className="accent-accent" />
              Reply to {account}
            </label>
          ) : (
            <div>
              <label className={labelClass} htmlFor="report-email">Email for a reply</label>
              <input id="report-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="optional" className={inputClass} />
            </div>
          )}
          <div>
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <span className={labelClass + ' mb-0'}>What will be sent</span>
              <span className="text-[11px] text-gray-400">Keys, tokens, emails and your home folder are masked. Edit anything else.</span>
            </div>
            {prepError ? (
              <p className="text-sm text-red-600 dark:text-red-400">{prepError}</p>
            ) : details === null ? (
              <div className="h-64 flex items-center justify-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Collecting the log and the Python environment…
              </div>
            ) : (
              <textarea value={details} onChange={e => setDetails(e.target.value)} spellCheck={false}
                className={`${inputClass} h-64 font-mono text-[11px] leading-relaxed resize-y`} />
            )}
          </div>
          {state.phase === 'failed' && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {state.error} {state.issueUrl ? 'You can copy the report, or open it as a GitHub issue (public).' : ''}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Open the report from anywhere, a callback included: it mounts on its own, like dialogs.tsx. */
export function openReport(api: DesktopApi, profileId: string | null, failure?: ReportFailure) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => { root.unmount(); host.remove(); };
  root.render(<ReportProblem api={api} profileId={profileId} failure={failure} onClose={close} />);
}

/**
 * A Hub install that failed: its message and the end of pip's output, with the choice to send it.
 * `deckId` is the deck it was going into, or null when it was a new one that has been removed.
 */
export async function installFailed(api: DesktopApi, title: string, e: any, deckId: string | null) {
  const output = e?.output ? String(e.output) : '';
  const choice = await chooseDialog({
    title,
    message: `${e?.message || e}${output ? `\n\n${output.split('\n').slice(-12).join('\n')}` : ''}`,
    tone: 'error',
    actions: [{ id: 'send', label: 'Send to IvoryOS' }, { id: 'ok', label: 'Close', kind: 'primary' }],
  });
  if (choice === 'send') openReport(api, deckId, { message: `Install failed: ${e?.message || e}`, output, kind: 'install' });
}
