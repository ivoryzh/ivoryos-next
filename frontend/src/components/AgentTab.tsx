"use client";

/**
 * The right-edge handle for the assistant panel, matching the Prep & Cleanup drawer's tab.
 *
 * The panel itself docks on the left (the right edge belongs to Prep & Cleanup), but the header
 * button is easy to miss and the panel is closed by default. This also carries the count of
 * proposals waiting — without it, a workflow drafted in Claude Desktop lands in a queue nobody
 * is looking at, which is the one way the MCP route quietly fails.
 */

import React, { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { API_BASE } from '@/config';

export default function AgentTab({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    // Only while closed: with the panel open it lists them itself, and two pollers for the
    // same thing is just noise on the server log.
    if (open) { setWaiting(0); return; }
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/agent/proposals?status=pending`);
        const data = await res.json();
        if (!cancelled) setWaiting((data.proposals || []).length);
      } catch { /* the designer works offline; a silent tab is better than an error */ }
    };
    check();
    const timer = setInterval(check, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [open]);

  return (
    <button
      onClick={onToggle}
      title={open ? 'Hide the protocol assistant' : 'Describe a protocol in words and have it drafted against this deck'}
      // Pinned above the Prep & Cleanup label, which is vertically centred in its own strip.
      className={`fixed right-0 top-24 z-30 flex flex-col items-center gap-2 py-3 rounded-l-lg border border-r-0 transition-colors ${
        open
          ? 'bg-purple-50 border-purple-200 text-purple-700 dark:bg-purple-900/40 dark:border-purple-500/30 dark:text-purple-300'
          : 'bg-white border-gray-200 text-gray-500 hover:text-gray-700 dark:bg-[#1a1a1a] dark:border-white/10 dark:text-gray-400 dark:hover:text-gray-200'
      }`}
      style={{ width: '2rem' }}
    >
      <Sparkles className="w-4 h-4 text-purple-500" />
      <span className="text-[10px] font-bold tracking-[0.15em] uppercase" style={{ writingMode: 'vertical-rl' }}>
        Assistant
      </span>
      {waiting > 0 && (
        <span className="min-w-[1.1rem] px-1 py-0.5 rounded-full bg-purple-600 text-white text-[9px] font-bold leading-none">
          {waiting}
        </span>
      )}
    </button>
  );
}
