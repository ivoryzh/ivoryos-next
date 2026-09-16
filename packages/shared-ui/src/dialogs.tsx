"use client";

/**
 * In-app replacements for `window.alert` / `confirm` / `prompt`.
 *
 * Those are not merely ugly here — they are **unavailable**. In the desktop app's embedded webview
 * `confirm()` returns false immediately without ever showing anything, `prompt()` throws
 * "prompt() is not supported", and `alert()` is a silent no-op. Every confirm-gated action
 * therefore did nothing when clicked, every error message was invisible, and saving an unnamed
 * workflow died on an unhandled exception. A destructive action that silently does nothing is the
 * worst of both worlds: the user cannot tell whether it worked.
 *
 * These mount their own React root on first use, so there is nothing to wire up in a page — call
 * them from anywhere, including from inside shared components.
 */

import React, { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AlertTriangle, Info } from 'lucide-react';

export type DialogTone = 'default' | 'danger' | 'error';

export type DialogAction = {
  id: string;
  label: string;
  /** 'primary' is the default-focused action; 'danger' is red; 'cancel' dismisses. */
  kind?: 'primary' | 'danger' | 'cancel';
};

export type DialogSpec = {
  title?: string;
  message: string;
  actions: DialogAction[];
  /** Adds a single-line text field; its value comes back as `value`. */
  input?: { defaultValue?: string; placeholder?: string };
  tone?: DialogTone;
};

export type DialogResult = { action: string | null; value: string | null };

type Pending = { spec: DialogSpec; resolve: (r: DialogResult) => void };

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let notifySubscriber: ((p: Pending | null) => void) | null = null;
const queue: Pending[] = [];

function pump() {
  if (notifySubscriber) notifySubscriber(queue[0] ?? null);
}

function ensureMounted() {
  if (root || typeof document === 'undefined') return;
  container = document.createElement('div');
  container.setAttribute('data-ivoryos-dialogs', '');
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<DialogHost />);
}

/** The general form. Resolves with the chosen action id (null if dismissed) and any input value. */
export function openDialog(spec: DialogSpec): Promise<DialogResult> {
  if (typeof document === 'undefined') {
    return Promise.resolve({ action: null, value: null });
  }
  ensureMounted();
  return new Promise<DialogResult>(resolve => {
    queue.push({ spec, resolve });
    // The host may not have subscribed yet on the very first call; it pumps the queue on mount.
    pump();
  });
}

export async function notify(message: string, opts: { title?: string; tone?: DialogTone } = {}) {
  await openDialog({
    message,
    title: opts.title,
    tone: opts.tone,
    actions: [{ id: 'ok', label: 'OK', kind: 'primary' }],
  });
}

export async function confirmDialog(
  message: string,
  opts: { title?: string; confirmLabel?: string; cancelLabel?: string; tone?: DialogTone } = {},
): Promise<boolean> {
  const res = await openDialog({
    message,
    title: opts.title,
    tone: opts.tone,
    actions: [
      { id: 'cancel', label: opts.cancelLabel || 'Cancel', kind: 'cancel' },
      {
        id: 'ok',
        label: opts.confirmLabel || 'OK',
        kind: opts.tone === 'danger' ? 'danger' : 'primary',
      },
    ],
  });
  return res.action === 'ok';
}

export async function promptDialog(
  message: string,
  opts: { title?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string } = {},
): Promise<string | null> {
  const res = await openDialog({
    message,
    title: opts.title,
    input: { defaultValue: opts.defaultValue, placeholder: opts.placeholder },
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'cancel' },
      { id: 'ok', label: opts.confirmLabel || 'OK', kind: 'primary' },
    ],
  });
  if (res.action !== 'ok') return null;
  const value = (res.value || '').trim();
  return value ? value : null;
}

/** Three-or-more-way choice. Resolves with the chosen action id, or null if dismissed. */
export async function chooseDialog(spec: Omit<DialogSpec, 'input'>): Promise<string | null> {
  return (await openDialog(spec)).action;
}

function DialogHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    notifySubscriber = setPending;
    pump();
    return () => { notifySubscriber = null; };
  }, []);

  useEffect(() => {
    if (!pending) return;
    setValue(pending.spec.input?.defaultValue ?? '');
    // Focus what the user is most likely to act on — the field if there is one, else the
    // default button, so Enter and Escape both do the obvious thing without a mouse.
    const id = window.setTimeout(() => {
      if (pending.spec.input) {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        primaryRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [pending]);

  if (!pending) return null;

  const { spec } = pending;

  const settle = (action: string | null) => {
    const entry = queue.shift();
    entry?.resolve({ action, value: spec.input ? value : null });
    pump();
  };

  const cancelId = spec.actions.find(a => a.kind === 'cancel')?.id ?? null;
  const primary = spec.actions.find(a => a.kind === 'primary' || a.kind === 'danger');

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); settle(cancelId); }
    if (e.key === 'Enter' && primary) { e.preventDefault(); settle(primary.id); }
  };

  const isAlarming = spec.tone === 'danger' || spec.tone === 'error';

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) settle(cancelId); }}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md bg-white dark:bg-[#111] rounded-2xl shadow-2xl border border-gray-200 dark:border-white/10 overflow-hidden">
        <div className="px-5 pt-5 pb-4 flex gap-3">
          <div className={`shrink-0 mt-0.5 ${isAlarming ? 'text-red-500' : 'text-indigo-500'}`}>
            {isAlarming ? <AlertTriangle className="w-5 h-5" /> : <Info className="w-5 h-5" />}
          </div>
          <div className="min-w-0 flex-1">
            {spec.title && (
              <h2 className="text-sm font-bold text-gray-900 dark:text-white mb-1">{spec.title}</h2>
            )}
            {/* Messages carry newlines (lists of affected workflows, server error paths), so keep
                them rather than collapsing the whitespace. */}
            <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap break-words">
              {spec.message}
            </p>
            {spec.input && (
              <input
                ref={inputRef}
                type="text"
                value={value}
                placeholder={spec.input.placeholder}
                onChange={(e) => setValue(e.target.value)}
                className="mt-3 w-full px-3 py-2 rounded-lg text-sm bg-white dark:bg-black/40 border border-gray-300 dark:border-white/10 text-gray-800 dark:text-gray-100 focus:outline-none focus:border-indigo-400"
              />
            )}
          </div>
        </div>
        <div className="px-5 py-3 bg-gray-50 dark:bg-white/[0.03] border-t border-gray-200 dark:border-white/10 flex flex-wrap justify-end gap-2">
          {spec.actions.map(action => {
            const isPrimary = action.kind === 'primary';
            const isDanger = action.kind === 'danger';
            return (
              <button
                key={action.id}
                ref={action === primary ? primaryRef : undefined}
                onClick={() => settle(action.id)}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  isDanger
                    ? 'bg-red-600 text-white hover:bg-red-700'
                    : isPrimary
                      ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                      : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-100 dark:bg-white/5 dark:border-white/10 dark:text-gray-200 dark:hover:bg-white/10'
                }`}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
