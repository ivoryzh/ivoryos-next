"use client";
import React, { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { ProfileStatus } from '@/desktop';

export const cardClass = 'bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl';
export const inputClass = 'w-full px-2.5 py-1.5 rounded-lg text-sm bg-white border border-gray-200 text-gray-800 placeholder:text-gray-400 focus:outline-none focus:border-indigo-400 dark:bg-black/40 dark:border-white/10 dark:text-gray-100 dark:placeholder:text-gray-600';
export const labelClass = 'block text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'default' | 'danger' | 'ghost'; small?: boolean };

export function Button({ tone = 'default', small, className = '', ...props }: ButtonProps) {
  const tones = {
    primary: 'bg-indigo-600 hover:bg-indigo-700 text-white border-indigo-600',
    default: 'bg-white hover:bg-gray-50 text-gray-700 border-gray-200 dark:bg-white/5 dark:hover:bg-white/10 dark:text-gray-200 dark:border-white/10',
    danger: 'bg-white hover:bg-red-50 text-red-600 border-gray-200 dark:bg-white/5 dark:hover:bg-red-900/20 dark:text-red-400 dark:border-white/10',
    ghost: 'bg-transparent hover:bg-gray-100 text-gray-600 border-transparent dark:hover:bg-white/10 dark:text-gray-300',
  };
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${small ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'} ${tones[tone]} ${className}`}
    />
  );
}

const DOT: Record<string, string> = {
  running: 'bg-green-500',
  starting: 'bg-amber-400 animate-pulse',
  installing: 'bg-amber-400 animate-pulse',
  stopping: 'bg-gray-400 animate-pulse',
  crashed: 'bg-red-500',
  error: 'bg-red-500',
  stopped: 'bg-gray-300 dark:bg-gray-600',
};

export const STATE_LABEL: Record<string, string> = {
  running: 'Running', starting: 'Starting', installing: 'Installing', stopping: 'Stopping',
  crashed: 'Stopped unexpectedly', error: 'Could not start', stopped: 'Stopped',
};

export function StatusDot({ status, className = '' }: { status?: Pick<ProfileStatus, 'state'>; className?: string }) {
  return <span title={STATE_LABEL[status?.state || 'stopped']} className={`inline-block w-2 h-2 rounded-full shrink-0 ${DOT[status?.state || 'stopped']} ${className}`} />;
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      {children}
      {hint && <span className="block mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</span>}
    </label>
  );
}

/**
 * Editable name/value rows (environment variables, free-form arguments). Rows keep their own
 * state so a half-typed name does not vanish, and are re-seeded only when `resetKey` changes.
 */
export function KeyValueRows({ value, onChange, resetKey, keyPlaceholder = 'NAME', valuePlaceholder = 'value', keyPattern, addLabel = 'Add' }: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  resetKey: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  keyPattern?: RegExp;
  addLabel?: string;
}) {
  const seed = () => Object.entries(value).map(([k, v], i) => ({ id: i, k, v }));
  const [rows, setRows] = useState(seed);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setRows(seed()), [resetKey]);
  const commit = (next: typeof rows) => {
    setRows(next);
    const out: Record<string, string> = {};
    next.forEach(r => { if (r.k.trim()) out[r.k.trim()] = r.v; });
    onChange(out);
  };
  return (
    <div className="space-y-1.5">
      {rows.map(r => {
        const bad = keyPattern && r.k.trim() !== '' && !keyPattern.test(r.k.trim());
        return (
          <div key={r.id} className="flex items-center gap-2">
            <input
              value={r.k}
              placeholder={keyPlaceholder}
              onChange={e => commit(rows.map(x => (x.id === r.id ? { ...x, k: e.target.value } : x)))}
              className={`${inputClass} font-mono !w-2/5 ${bad ? '!border-red-400' : ''}`}
            />
            <span className="text-gray-400">=</span>
            <input
              value={r.v}
              placeholder={valuePlaceholder}
              onChange={e => commit(rows.map(x => (x.id === r.id ? { ...x, v: e.target.value } : x)))}
              className={`${inputClass} font-mono flex-1`}
            />
            <button type="button" title="Remove" onClick={() => commit(rows.filter(x => x.id !== r.id))} className="p-1 text-gray-400 hover:text-red-500">
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => setRows([...rows, { id: Date.now(), k: '', v: '' }])}
        className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
      >
        <Plus className="w-3.5 h-3.5" /> {addLabel}
      </button>
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: {
  title: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-6" onMouseDown={onClose}>
      <div
        onMouseDown={e => e.stopPropagation()}
        className={`w-full ${wide ? 'max-w-4xl' : 'max-w-xl'} max-h-full flex flex-col bg-white dark:bg-[#141414] border border-gray-200 dark:border-white/10 rounded-2xl shadow-2xl`}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-white/10">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
          <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-gray-100 dark:border-white/10 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
