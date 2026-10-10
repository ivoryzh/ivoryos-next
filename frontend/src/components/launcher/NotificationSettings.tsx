"use client";
import React, { useEffect, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import { notify } from '@ivoryos/shared-ui';
import type { DesktopApi, NotificationEvent, NotificationPrefs, Snapshot } from '@/desktop';
import { Button } from './ui';

// Mirrors the switches in desktop/src/notifyPrefs.js, which decides what is announced.
const GROUPS: { title: string; events: { key: NotificationEvent; label: string; hint?: string }[] }[] = [
  {
    title: 'Needs you',
    events: [
      { key: 'input', label: 'A run waits for your input or is paused for you' },
      { key: 'failed', label: 'A step failed and waits for retry, skip or stop' },
      { key: 'crashed', label: 'A deck stopped unexpectedly' },
    ],
  },
  {
    title: 'When a run ends',
    events: [
      { key: 'finished', label: 'A run finished', hint: 'A set of stages is announced once, when its last stage ends.' },
      { key: 'stopped', label: 'A run was stopped or ended with an error' },
    ],
  },
  {
    title: 'Heads up',
    events: [
      { key: 'ready', label: 'A deck you started is ready, or could not start', hint: 'Only while you are in another app.' },
      { key: 'installed', label: 'An install finished or failed', hint: 'Only while you are in another app.' },
    ],
  },
];

const DEFAULTS: NotificationPrefs = {
  events: { input: true, failed: true, crashed: true, finished: true, stopped: false, ready: true, installed: true },
  minRunMinutes: 5,
  sound: true,
};

/**
 * What reaches the person when they are not looking at a deck: one switch per kind of moment, a
 * length below which a finished run is not news, sound for what needs them, and which decks speak
 * at all. The system can refuse the app's notifications without saying so to the person, so this
 * says it (snap.notifyHealth), with the way to allow them and a test to check.
 */
export default function NotificationSettings({ api, snap }: { api: DesktopApi; snap: Snapshot }) {
  const prefs = snap.notifications || DEFAULTS;
  const [minutes, setMinutes] = useState(String(prefs.minRunMinutes));
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ shown: boolean | null; error?: string } | null>(null);
  useEffect(() => setMinutes(String(prefs.minRunMinutes)), [prefs.minRunMinutes]);

  const change = (patch: Parameters<DesktopApi['setNotifications']>[0]) => api.setNotifications(patch).catch(e => notify(e.message, { tone: 'error' }));
  const commitMinutes = () => {
    const n = Number(minutes);
    if (Number.isFinite(n) && n >= 0 && n !== prefs.minRunMinutes) change({ minRunMinutes: n });
    else setMinutes(String(prefs.minRunMinutes));
  };
  const runTest = async () => {
    setTesting(true);
    try { setTest(await api.testNotification()); } catch (e: any) { setTest({ shown: false, error: e.message }); } finally { setTesting(false); }
  };

  const isMac = snap.platform === 'darwin';
  const blocked = snap.notifyHealth && snap.notifyHealth.ok === false;
  const system = isMac ? 'macOS' : snap.platform === 'win32' ? 'Windows' : 'Your desktop';
  const decks = snap.profiles;

  return (
    <div className="space-y-4 text-sm text-gray-700 dark:text-gray-200">
      {blocked && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-900/10 p-3 text-amber-900 dark:text-amber-200">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">{system} is not showing IvoryOS notifications.</p>
            <p className="mt-0.5 text-xs">
              Allow them in {isMac ? 'System Settings → Notifications' : 'the system notification settings'}, under IvoryOS
              {isMac ? ' (“Electron” when running from source)' : ''}. Until then the {isMac ? 'Dock icon bounces' : 'taskbar button flashes'} when something needs you.
            </p>
          </div>
          {snap.platform !== 'linux' && (
            <Button small onClick={() => api.openNotificationSettings().catch(e => notify(e.message, { tone: 'error' }))}><ExternalLink className="w-3.5 h-3.5" /> Open settings</Button>
          )}
        </div>
      )}

      {GROUPS.map(group => (
        <div key={group.title}>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">{group.title}</p>
          <div className="space-y-2">
            {group.events.map(ev => (
              <label key={ev.key} className="flex items-start gap-2">
                <input type="checkbox" className="accent-accent mt-0.5" checked={prefs.events[ev.key]} onChange={e => change({ events: { [ev.key]: e.target.checked } })} />
                <span className="flex-1">
                  {ev.label}
                  {ev.key === 'finished' && prefs.events.finished && (
                    <span className="ml-1 text-gray-500 dark:text-gray-400">
                      if it took at least{' '}
                      <input
                        value={minutes} inputMode="numeric" aria-label="Minutes"
                        onChange={e => setMinutes(e.target.value.replace(/[^\d.]/g, ''))}
                        onBlur={commitMinutes} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        className="w-12 rounded border border-gray-200 dark:border-white/15 bg-transparent px-1 py-0 text-center text-sm"
                      />{' '}min
                    </span>
                  )}
                  {ev.hint && <span className="block text-xs text-gray-500 dark:text-gray-400">{ev.hint}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}

      <label className="flex items-start gap-2">
        <input type="checkbox" className="accent-accent mt-0.5" checked={prefs.sound} onChange={e => change({ sound: e.target.checked })} />
        <span>Play a sound when something needs you<span className="block text-xs text-gray-500 dark:text-gray-400">Everything else arrives silently.</span></span>
      </label>

      {decks.length > 1 && (
        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">From these decks</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {decks.map(p => (
              <label key={p.id} className="flex items-center gap-2">
                <input type="checkbox" className="accent-accent" checked={!p.muteNotifications}
                  onChange={e => api.updateProfile(p.id, { muteNotifications: !e.target.checked }).catch(err => notify(err.message, { tone: 'error' }))} />
                {p.name}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap pt-1">
        <Button small onClick={runTest} disabled={testing}>
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />} Send a test notification
        </Button>
        {test && (test.shown === true
          ? <span className="flex items-center gap-1 text-xs text-green-700 dark:text-green-400"><CheckCircle2 className="w-3.5 h-3.5" /> Shown. If you did not see it, check Focus or Do Not Disturb.</span>
          : test.shown === false
            ? <span className="text-xs text-amber-700 dark:text-amber-300">Not shown: {system} refused it.</span>
            : <span className="text-xs text-gray-500 dark:text-gray-400">The system did not answer. Did it appear?</span>)}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Focus and Do Not Disturb on your computer apply as usual. Nothing is sent about a deck while you are looking at it.
      </p>
    </div>
  );
}
