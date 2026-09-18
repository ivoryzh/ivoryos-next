"use client";

import { useEffect, useState } from 'react';
import { API_BASE } from '@/config';

/**
 * How many agent proposals are waiting on a person.
 *
 * Shown on whatever opens the assistant panel, because a workflow drafted in Claude Desktop
 * lands in a queue that is otherwise invisible until someone thinks to look — the one way the
 * MCP route quietly fails.
 *
 * Polls only while `enabled`, which callers set false once the panel is open: the panel lists
 * the proposals itself, and two pollers for the same thing is just noise in the server log.
 */
export function useWaitingProposals(enabled: boolean): number {
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    if (!enabled) { setWaiting(0); return; }
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/agent/proposals?status=pending`);
        const data = await res.json();
        if (!cancelled) setWaiting((data.proposals || []).length);
      } catch { /* the designer works offline; a silent count beats an error */ }
    };
    check();
    const timer = setInterval(check, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [enabled]);

  return waiting;
}
