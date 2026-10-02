"use client";
import { useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { inDesktopApp } from '@ivoryos/shared-ui';
import { WS_BASE } from '@/config';
import { askToNotify, declineNotify, notifyDeclined, notifyState } from '@/browserNotify';

/**
 * Browser notifications when a run needs a person: a User input waiting for an answer, or a failed
 * step waiting for retry, skip or stop. The edge decides what those are (`status.attention`,
 * queue.py attention_items, each with a key so it is announced once). Shown only while this page is
 * hidden or not focused; a page in view already has its pop-up. Off inside the desktop app, which
 * sends its own system notifications.
 *
 * The first time a run is under way it asks, with a small card, whether to notify; "Not now" is
 * remembered (Settings can turn it on later). Mounted by the Sidebar, beside RunDecision.
 */
export default function RunNotifier() {
  const [asking, setAsking] = useState(false);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (inDesktopApp() || notifyState() === 'unsupported') return;
    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (!data.status) return;
        // Ask once a run is under way, which is when it is worth knowing.
        if (data.status.active_workflow_id && notifyState() === 'default' && !notifyDeclined()) setAsking(true);
        const items: any[] = Array.isArray(data.status.attention) ? data.status.attention : [];
        const away = document.hidden || !document.hasFocus();
        for (const item of items) {
          if (!item?.key || seen.current.has(item.key)) continue;
          if (away && notifyState() === 'granted') {
            const note = new Notification(item.title, {
              body: item.run_name ? `${item.run_name}: ${item.body}` : item.body,
              tag: item.key, // one per moment, even with this edge open in several tabs
            });
            note.onclick = () => { window.focus(); note.close(); };
          }
        }
        seen.current = new Set(items.map(i => i?.key).filter(Boolean));
      } catch { /* a malformed frame */ }
    };
    return () => ws.close();
  }, []);

  if (!asking) return null;
  return (
    <div className="fixed bottom-4 left-4 z-[150] w-80 rounded-xl border border-gray-200 bg-white p-4 shadow-xl dark:border-white/10 dark:bg-[#1a1a1a]">
      <div className="flex items-start gap-3">
        <Bell className="mt-0.5 w-4 h-4 shrink-0 text-gray-500 dark:text-gray-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Notify you when a run needs you?</p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">When a step waits for your input or fails, even with this tab in the background.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={async () => { await askToNotify(); setAsking(false); }}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">Allow</button>
            <button type="button" onClick={() => { declineNotify(); setAsking(false); }}
              className="rounded-md px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">Not now</button>
          </div>
        </div>
        <button type="button" onClick={() => setAsking(false)} title="Ask later" className="shrink-0 p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><X className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  );
}
