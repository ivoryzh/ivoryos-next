"use client";
import { useEffect, useState } from 'react';
import { WS_BASE } from '@/config';

/** Statuses of a run that is queued or under way, so a new one would wait behind it. */
const BUSY = new Set(['pending', 'running', 'paused', 'pausing', 'cancelling', 'waiting_input']);

/**
 * Whether a run started now would wait in the queue: anything queued or under way, including a
 * run waiting at a User input. One check for every page that starts a run (Designer, Once and
 * Iterate, Optimize), which each ask "Add to queue?" when it is true. The Optimize page had none,
 * and the copies on the others missed a run waiting for input.
 */
export function useQueueBusy(): boolean {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // The server sends the current queue as soon as a page subscribes, then on every change.
    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (Array.isArray(data.runs)) setBusy(data.runs.some((r: any) => BUSY.has(r.status)));
      } catch { /* not a queue message */ }
    };
    return () => ws.close();
  }, []);
  return busy;
}
