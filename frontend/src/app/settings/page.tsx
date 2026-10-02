"use client";
import React, { useEffect, useState } from 'react';
import { NavPlacementChoice, ThemeChoice, inDesktopApp, useNavPlacement, useThemePreference } from '@ivoryos/shared-ui';
import Sidebar from '@/components/Sidebar';
import { askToNotify, notifyState, type NotifyState } from '@/browserNotify';

/**
 * Theme and layout, for an edge opened in a browser. Inside the desktop app both follow the app
 * (packages/shared-ui theme.tsx, navPlacement.tsx) and the top bar has no link here.
 */
export default function SettingsPage() {
  const [pref, setPref] = useThemePreference();
  const [nav, setNav] = useNavPlacement();
  // Read after hydration (AGENTS.md section 11): the server render cannot know.
  const [desktop, setDesktop] = useState(false);
  const [notify, setNotify] = useState<NotifyState>('unsupported');
  useEffect(() => { setDesktop(inDesktopApp()); setNotify(notifyState()); }, []);

  const row = 'flex items-center justify-between gap-4 py-3';
  return (
    <div className="flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-8">
        <section className="max-w-xl bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl px-5 divide-y divide-gray-100 dark:divide-white/10">
          {desktop ? (
            <p className="py-4 text-sm text-gray-500 dark:text-gray-400">Theme and layout follow the IvoryOS app, which also sends the notifications.</p>
          ) : (
            <>
              <div className={row}><span className="text-sm font-medium">Theme</span><ThemeChoice value={pref} onChange={setPref} /></div>
              <div className={row}><span className="text-sm font-medium">Navigation</span><NavPlacementChoice value={nav} onChange={setNav} /></div>
              <div className={row}>
                <span className="text-sm font-medium">Notifications<span className="block text-xs font-normal text-gray-500 dark:text-gray-400">When a run waits for input or a step fails</span></span>
                {notify === 'granted' ? <span className="text-sm text-gray-500 dark:text-gray-400">On</span>
                  : notify === 'denied' ? <span className="text-sm text-gray-500 dark:text-gray-400">Blocked in this browser&apos;s site settings</span>
                  : notify === 'unsupported' ? <span className="text-sm text-gray-500 dark:text-gray-400">Not available here</span>
                  : <button type="button" onClick={async () => setNotify(await askToNotify())} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-white/10 dark:hover:bg-white/10">Turn on</button>}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
