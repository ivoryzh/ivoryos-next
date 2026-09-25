"use client";

/**
 * Right-hand drawer showing the steps behind a *linked* block.
 *
 * A link is one card standing in for a whole protocol, and its steps are otherwise invisible until
 * the run is already underway. Unlike a copy — which can simply be expanded in place, because its
 * steps genuinely belong to this workflow — a link's steps belong to a different workflow and are
 * read-only here. A drawer rather than a modal so the canvas stays visible beside it: the point is
 * usually to compare the linked steps against what surrounds them.
 */

import React, { useEffect } from 'react';
import { AlertTriangle, Layers, Link2, PencilLine, Scissors, X } from 'lucide-react';

import { flattenSavedBody, type SavedWorkflowBody } from './workflowBody';

export type WorkflowPeekTarget = {
  name: string;
  version?: number;
  mode?: 'pinned' | 'latest';
  /** Values the caller filled in for the workflow's `#vars`, so the preview shows real numbers. */
  params?: Record<string, any>;
};

type Props = {
  target: WorkflowPeekTarget | null;
  body: SavedWorkflowBody | null;
  isLoading?: boolean;
  error?: string | null;
  /** Head version, when newer than the pinned one. */
  latestVersion?: number;
  onClose: () => void;
  onDetach?: () => void;
  onUpdate?: () => void;
  /** Opens the linked workflow itself for editing. Host-provided: only the page knows how to
   *  deal with whatever is currently unsaved on the canvas. */
  onEdit?: () => void;
  /** Where Edit goes, for the button's text. Cloud edits in Edge Sequence, not the Designer. */
  editLabel?: string;
  /** Replaces the default read-only note, which talks about detaching (a Designer action). */
  note?: React.ReactNode;
};

const PHASES: { key: 'prep' | 'script' | 'cleanup'; label: string }[] = [
  { key: 'prep', label: 'Prep' },
  { key: 'script', label: 'Main' },
  { key: 'cleanup', label: 'Cleanup' },
];

function phaseBlocks(body: SavedWorkflowBody | null, key: 'prep' | 'script' | 'cleanup') {
  if (!body) return [];
  if (key === 'script') return body.script || body.sequence || [];
  return body[key] || [];
}

/** flattenSavedBody takes an optional body; null is this component's "nothing loaded" state. */
function stepCount(body: SavedWorkflowBody | null) {
  return flattenSavedBody(body ?? undefined).length;
}

/** Substitute the caller's values for `#var` placeholders, matching what expansion will do. */
function resolved(value: any, params: Record<string, any>) {
  if (typeof value === 'string' && value.startsWith('#')) {
    const supplied = params[value.substring(1)];
    if (supplied !== undefined && supplied !== '') return supplied;
  }
  return value;
}

export function WorkflowPeek({
  target, body, isLoading, error, latestVersion, onClose, onDetach, onUpdate, onEdit, editLabel, note,
}: Props) {
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, onClose]);

  if (!target) return null;

  const params = target.params || {};
  const total = stepCount(body);
  const tracksLatest = target.mode === 'latest';
  const isStale = !!(latestVersion && target.version && latestVersion > target.version && !tracksLatest);

  return (
    <>
      {/* Deliberately light: the canvas behind stays legible, since the reason to open this is to
          read the linked steps against the steps around them. */}
      <div className="fixed inset-0 z-[110] bg-black/20" onClick={onClose} />

      <aside className="fixed inset-y-0 right-0 z-[120] w-full max-w-sm flex flex-col bg-white dark:bg-[#111] border-l border-gray-200 dark:border-white/10 shadow-2xl">
        <header className="shrink-0 px-4 py-3.5 border-b border-gray-200 dark:border-white/10">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                <Link2 className="w-3.5 h-3.5 shrink-0" />
                <span className="text-[10px] font-bold uppercase tracking-wider">Linked workflow</span>
              </div>
              {/* Verbatim — a user-chosen workflow name, not an introspected identifier. */}
              <h2 className="text-base font-bold text-gray-900 dark:text-white mt-0.5 break-words">
                {target.name}
              </h2>
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                {tracksLatest
                  ? 'Tracks the latest saved version'
                  : target.version ? `Pinned to v${target.version}` : 'Resolves to the latest version'}
                {total ? ` · ${total} step${total === 1 ? '' : 's'}` : ''}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 -mr-1 shrink-0 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <p className="mt-2.5 text-[11px] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1.5">
            {note ?? (
              <>
                These steps belong to <strong className="font-semibold">{target.name}</strong> and are read-only
                here. Editing that workflow changes this one too — detach to get an editable copy.
              </>
            )}
          </p>

          {isStale && (
            <button
              onClick={onUpdate}
              className="mt-2 w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border text-[11px] font-bold bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100 dark:bg-amber-500/20 dark:border-amber-700/40 dark:text-amber-300"
            >
              <AlertTriangle className="w-3 h-3" />
              v{latestVersion} is available — update this step
            </button>
          )}
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {isLoading && <p className="text-sm text-gray-400 py-8 text-center">Loading…</p>}

          {error && !isLoading && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-500/30">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <p className="text-xs text-red-600 dark:text-red-300 break-words">{error}</p>
            </div>
          )}

          {!isLoading && !error && total === 0 && (
            <p className="text-sm text-gray-400 py-8 text-center">This workflow has no steps.</p>
          )}

          {!isLoading && !error && PHASES.map(({ key, label }) => {
            const blocks = phaseBlocks(body, key);
            if (!blocks.length) return null;
            return (
              <section key={key} className="mb-4 last:mb-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <div className="h-px bg-gray-200 dark:bg-white/10 flex-1" />
                  <span className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">
                    {label} · {blocks.length}
                  </span>
                  <div className="h-px bg-gray-200 dark:bg-white/10 flex-1" />
                </div>
                <div className="space-y-1">
                  {blocks.map((block: any, i: number) => {
                    const args = Object.entries(block.args || block.params || {});
                    const isBatch = !!(block.batch_action ?? block.isBatchAction);
                    const instrument = block.instrument || block.module || '';
                    const method = block.action || block.method || '';
                    return (
                      <div key={i} className="px-2.5 py-1.5 rounded-lg bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                        <div className="flex items-start gap-2">
                          <span className="text-[10px] font-mono text-gray-400 dark:text-gray-600 w-4 shrink-0 text-right pt-0.5">
                            {i + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 dark:bg-white/10 dark:text-gray-300 capitalize">
                                {String(instrument).replace(/_/g, ' ')}
                              </span>
                              <span className="text-xs font-medium text-gray-800 dark:text-gray-100 capitalize">
                                {String(method).replace(/_/g, ' ')}
                              </span>
                              {key === 'script' && isBatch && (
                                <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-200 dark:bg-teal-500/20 dark:text-teal-300 dark:border-teal-700/40">
                                  <Layers className="w-2.5 h-2.5" /> Batch
                                </span>
                              )}
                            </div>
                            {args.length > 0 && (
                              <p className="text-[11px] text-gray-500 dark:text-gray-400 font-mono mt-0.5 break-words">
                                {args.map(([k, v]) => {
                                  const value = resolved(v, params);
                                  const substituted = value !== v;
                                  return (
                                    <span key={k} className={substituted ? 'text-indigo-600 dark:text-indigo-400' : ''}>
                                      {k}={typeof value === 'object' ? JSON.stringify(value) : String(value)}{' '}
                                    </span>
                                  );
                                })}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        {(onDetach || onEdit) && (
          <footer className="shrink-0 px-4 py-3 border-t border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02] space-y-2">
            {onEdit && (
              <>
                <button
                  onClick={onEdit}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:bg-white/5 dark:border-indigo-700/40 dark:text-indigo-300 dark:hover:bg-white/10"
                >
                  <PencilLine className="w-4 h-4" />
                  Edit {target.name} in {editLabel || 'the Designer'}
                </button>
                <p className="text-[10px] text-gray-400 dark:text-gray-500 text-center">
                  Opens the linked workflow itself. Changes there affect every workflow linking to it.
                </p>
              </>
            )}
            {onDetach && (
              <>
                <button
                  onClick={onDetach}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:bg-white/5 dark:border-emerald-700/40 dark:text-emerald-300 dark:hover:bg-white/10"
                >
                  <Scissors className="w-4 h-4" />
                  Detach into this workflow
                </button>
                <p className="text-[10px] text-gray-400 dark:text-gray-500 text-center">
                  Inlines these steps here as an editable copy, and stops tracking {target.name}.
                </p>
              </>
            )}
          </footer>
        )}
      </aside>
    </>
  );
}

export default WorkflowPeek;
