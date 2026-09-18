"use client";

/**
 * The assistant toggle, pinned to the bottom of the module toolbox.
 *
 * It sits below the instrument list because that column is already the answer to "what can I
 * put in this workflow?" — dragging a module in and describing what you want are the same
 * question answered two ways, so they belong together rather than in the page chrome.
 */

import React from 'react';
import { Sparkles } from 'lucide-react';
import { useWaitingProposals } from './useWaitingProposals';

export default function AgentToolboxButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const waiting = useWaitingProposals(!open);

  return (
    <button
      onClick={onToggle}
      title={open ? 'Hide the protocol assistant' : 'Describe a protocol in words and have it drafted against this deck'}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
        open
          ? 'bg-purple-50 border-purple-200 text-purple-700 dark:bg-purple-900/30 dark:border-purple-500/30 dark:text-purple-300'
          : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50 hover:text-gray-800 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10'
      }`}
    >
      <Sparkles className="w-4 h-4 shrink-0 text-purple-500" />
      <span className="flex-1 text-left">Assistant</span>
      {waiting > 0 && (
        <span className="min-w-[1.25rem] px-1.5 py-0.5 rounded-full bg-purple-600 text-white text-[10px] font-bold leading-none">
          {waiting}
        </span>
      )}
    </button>
  );
}
