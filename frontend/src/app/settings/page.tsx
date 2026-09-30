"use client";
import React, { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import { ThemeChoice, inDesktopApp, useThemePreference } from '@ivoryos/shared-ui';
import Sidebar from '@/components/Sidebar';

/**
 * This edge's settings as seen in a browser. The theme used to be a toggle on every page; it is
 * one choice now, made here, or -- inside the desktop app -- in the app's own Settings, which every
 * page it shows follows (packages/shared-ui/src/theme.tsx).
 */
export default function SettingsPage() {
  const [pref, setPref] = useThemePreference();
  // Read after hydration (AGENTS.md section 11): the server render cannot know.
  const [desktop, setDesktop] = useState(false);
  useEffect(() => { setDesktop(inDesktopApp()); }, []);

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-8">
        <h1 className="flex items-center gap-2 text-xl font-semibold mb-6"><Settings className="w-5 h-5 text-gray-400" /> Settings</h1>
        <section className="max-w-2xl bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl p-5">
          <h2 className="text-sm font-semibold mb-1">Appearance</h2>
          {desktop ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Follows the IvoryOS app. Change it in the app&apos;s Settings, and every deck and Cloud change with it.
            </p>
          ) : (
            <>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">Every page of this edge uses this theme. System follows your computer.</p>
              <ThemeChoice value={pref} onChange={setPref} />
            </>
          )}
        </section>
      </main>
    </div>
  );
}
