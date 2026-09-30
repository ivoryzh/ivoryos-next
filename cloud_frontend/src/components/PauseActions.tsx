"use client";

import { useState } from 'react';
import { Play, SkipForward, Square, Send } from 'lucide-react';
import { confirmDialog } from '@ivoryos/shared-ui';

/**
 * What a person can do about a task stopped for them, wherever it is shown (the attention panel
 * on every page, and the node on the canvas): answer the question, or retry / skip / stop a failed
 * step -- the bench's own prompt and error bar, offered from Cloud.
 *
 * `cloud` items are Cloud's own User_Input steps, answered through their existing route; the rest
 * are stopped on a device and go through /api/cloud-workflows/control with the pause they were
 * looking at, so a decision about a question the bench already answered changes nothing.
 *
 * Callers key it by the pause: a new pause is a new question, and nothing typed or sent for the
 * last one may carry over.
 */
export type PauseItem = {
  runId: string;
  nodeId: string;
  kind: 'input' | 'error';
  pause: string | null;
  prompt?: string;
  inputType?: string;
  error?: string;
  sent?: string | null;
  cloud?: boolean;
};

const SENT_LABEL: Record<string, string> = {
  input: 'Answer sent', retry: 'Retrying', skip: 'Skipping', stop: 'Stopping',
};

const btn = 'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50';

export default function PauseActions({ item }: { item: PauseItem }) {
  const [value, setValue] = useState<string>('');
  const [sending, setSending] = useState<string | null>(null);
  const [problem, setProblem] = useState('');

  const sent = item.sent || sending;
  const send = async (action: string, answer?: any) => {
    if (sent) return;
    if (action === 'stop' && !(await confirmDialog(
      item.kind === 'error'
        ? 'Stop this run here? The failed step stays failed and nothing after it runs.'
        : 'Stop this run instead of answering? Nothing after this step runs.',
      { title: 'Stop the run', confirmLabel: 'Stop run', tone: 'danger' },
    ))) return;
    setSending(action);
    setProblem('');
    try {
      const res = item.cloud
        ? await fetch('/api/cloud-workflows/input', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: item.runId, nodeId: item.nodeId, value: answer }),
        })
        : await fetch('/api/cloud-workflows/control', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: item.runId, nodeId: item.nodeId, pause: item.pause, action, value: answer }),
        });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setProblem(data.error || 'Could not send that.');
        setSending(null);
      }
    } catch {
      setProblem('Could not reach Cloud.');
      setSending(null);
    }
  };

  const stop = !item.cloud && (
    <button onClick={() => send('stop')} disabled={!!sent} title="Stop the run here" className={`${btn} ml-auto text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10`}>
      <Square className="h-3 w-3" />Stop
    </button>
  );

  let controls: React.ReactNode;
  if (item.kind === 'error') {
    controls = (
      <>
        <button onClick={() => send('retry')} disabled={!!sent} className={`${btn} bg-indigo-600 text-white hover:bg-indigo-700`}>
          <Play className="h-3 w-3" />Retry
        </button>
        <button onClick={() => send('skip')} disabled={!!sent} title="Mark the step skipped and carry on" className={`${btn} border border-gray-300 hover:bg-gray-50 dark:border-white/15 dark:hover:bg-white/5`}>
          <SkipForward className="h-3 w-3" />Skip
        </button>
        {stop}
      </>
    );
  } else if (item.inputType === 'bool') {
    controls = (
      <>
        <button onClick={() => send('input', true)} disabled={!!sent} className={`${btn} bg-amber-500 text-white hover:bg-amber-600`}>Yes</button>
        <button onClick={() => send('input', false)} disabled={!!sent} className={`${btn} border border-gray-300 hover:bg-gray-50 dark:border-white/15 dark:hover:bg-white/5`}>No</button>
        {stop}
      </>
    );
  } else {
    const numeric = item.inputType === 'int' || item.inputType === 'float';
    const submit = () => {
      if (numeric && value.trim() === '') { setProblem('Enter a number.'); return; }
      send('input', numeric ? Number(value) : value);
    };
    controls = (
      <>
        <input
          type={numeric ? 'number' : 'text'} step={item.inputType === 'float' ? 'any' : undefined}
          value={value} disabled={!!sent} placeholder={numeric ? item.inputType : 'answer'}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          className="nodrag min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs outline-none focus:border-amber-500 dark:border-white/15 dark:bg-black/30"
        />
        <button onClick={submit} disabled={!!sent} className={`${btn} shrink-0 bg-amber-500 text-white hover:bg-amber-600`}>
          <Send className="h-3 w-3" />Send
        </button>
        {stop}
      </>
    );
  }

  return (
    <div className="nodrag">
      <div className="flex items-center gap-1.5">{controls}</div>
      {(sent || problem) && (
        <div className={`mt-1 text-[11px] ${problem ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`}>
          {problem || `${SENT_LABEL[sent as string] || 'Sent'} · waiting for ${item.cloud ? 'Cloud' : 'the device'}…`}
        </div>
      )}
    </div>
  );
}
