"use client";

import { useEffect, useRef, useState } from 'react';
import { BellRing, ChevronDown, MessageSquareText, AlertTriangle } from 'lucide-react';
import DeviceAvatar from './DeviceAvatar';
import PauseActions, { type PauseItem } from './PauseActions';
import { useDeviceName } from '@/lib/deviceNames';

/**
 * Every run stopped for a person, on every page: a question to answer or a failed step to decide
 * about, whichever device (or Cloud itself) it is on. The edge has this as its global input modal
 * and error bar; Cloud had only an amber progress bar on one canvas card, so a run could sit
 * waiting for hours with nobody knowing.
 *
 * Opens by itself when something new stops, counts in the tab title, and -- once allowed -- raises
 * a desktop notification, since the person is usually not looking at this tab when it happens.
 */

type Item = PauseItem & {
  key: string;
  deviceId: string | null;
  deviceImage: string | null;
  runName: string;
  step: string;
  row: number | null;
};

const POLL_MS = 3000;
const TITLE_PREFIX = /^\(\d+\)\s+/;

const canNotify = () => typeof window !== 'undefined' && 'Notification' in window;

export default function AttentionCenter() {
  const deviceName = useDeviceName();
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState(true);
  const [permission, setPermission] = useState<string>('unsupported');
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (canNotify()) setPermission(Notification.permission);
  }, []);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch('/api/attention', { cache: 'no-store' });
        const data = await res.json();
        if (stopped || !Array.isArray(data)) return;
        const fresh = data.filter((i: Item) => seen.current && !seen.current.has(i.key));
        // The first load only records what is already waiting: reloading the page should not
        // re-announce questions that were there before it.
        seen.current = new Set(data.map((i: Item) => i.key));
        setItems(data);
        if (fresh.length) {
          setOpen(true);
          if (canNotify() && Notification.permission === 'granted') {
            for (const i of fresh) {
              try {
                new Notification(i.kind === 'error' ? 'A run stopped on an error' : 'A run is waiting for input', {
                  body: `${deviceName(i.deviceId) || 'Cloud'} · ${i.runName}\n${i.kind === 'error' ? i.error : i.prompt || 'Continue?'}`,
                  tag: i.key,
                });
              } catch { /* some embedded browsers expose the API but refuse to show one */ }
            }
          }
        }
      } catch { /* the next poll tries again */ }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => { stopped = true; clearInterval(t); };
  }, []);

  // The count in the tab title is what a person notices from another tab.
  useEffect(() => {
    const base = document.title.replace(TITLE_PREFIX, '');
    document.title = items.length ? `(${items.length}) ${base}` : base;
  }, [items.length]);

  if (!items.length) return null;

  const errors = items.filter(i => i.kind === 'error').length;
  const summary = [
    errors && `${errors} error${errors === 1 ? '' : 's'}`,
    items.length - errors && `${items.length - errors} waiting for input`,
  ].filter(Boolean).join(' · ');

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full px-3.5 py-2 text-xs font-semibold text-white shadow-lg ${errors ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-500 hover:bg-amber-600'}`}
        title="Runs stopped for a person"
      >
        <BellRing className="h-4 w-4" />{summary}
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-h-[70vh] w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white/95 shadow-2xl backdrop-blur dark:border-white/10 dark:bg-[#15171b]/95">
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-white/10">
        <BellRing className={`h-4 w-4 ${errors ? 'text-red-500' : 'text-amber-500'}`} />
        <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{summary}</span>
        <div className="ml-auto flex items-center gap-1">
          {permission === 'default' && (
            <button
              onClick={async () => setPermission(await Notification.requestPermission())}
              className="rounded px-1.5 py-0.5 text-[11px] font-medium text-accent-fg hover:bg-accent-soft"
              title="Get a desktop notification when a run stops, even when this tab is in the background"
            >
              Desktop alerts
            </button>
          )}
          <button onClick={() => setOpen(false)} title="Minimise" className="rounded p-0.5 text-gray-400 hover:bg-black/5 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200">
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 divide-y divide-gray-100 overflow-y-auto dark:divide-white/5">
        {items.map(i => {
          const text = i.kind === 'error' ? i.error : i.prompt || 'Continue?';
          // `instrument.method` is shown as the driver spells it; a bare Flow Control name
          // (User_Input) reads better spaced.
          const step = i.step && (String(i.step).includes('.') ? i.step : String(i.step).replace(/_/g, ' '));
          const where = [step, i.row && `row ${i.row}`].filter(Boolean).join(' · ');
          return (
            <div key={i.key} className="space-y-2 px-3 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                {i.deviceId
                  ? <DeviceAvatar id={i.deviceId} version={i.deviceImage} size={22} />
                  : <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-600 dark:bg-amber-500/15"><MessageSquareText className="h-3.5 w-3.5" /></span>}
                <div className="min-w-0 flex-1 truncate text-xs" title={`${deviceName(i.deviceId) || 'Cloud'} · ${i.runName}${where ? ` · ${where}` : ''}`}>
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{deviceName(i.deviceId) || 'Cloud'}</span>
                  <span style={{ color: 'var(--text-secondary)' }}> · {i.runName}{where ? ` · ${where}` : ''}</span>
                </div>
              </div>
              <div
                className={`flex items-start gap-1.5 text-xs ${i.kind === 'error' ? 'text-red-600 dark:text-red-400' : ''}`}
                style={i.kind === 'error' ? undefined : { color: 'var(--text-primary)' }}
                title={text}
              >
                {i.kind === 'error' && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                <span className="min-w-0 break-words line-clamp-3">{text}</span>
              </div>
              <PauseActions key={i.key} item={{ ...i, cloud: !i.deviceId }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
