"use client";
import { useDocumentTheme } from '@ivoryos/shared-ui';
import { API_BASE } from '@/config';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, PanelRight } from 'lucide-react';
import { openInPanel } from '@/pluginPanel';
import Sidebar from '@/components/Sidebar';

function PluginContent() {
  const searchParams = useSearchParams();
  const pluginId = searchParams.get('id');

  const theme = useDocumentTheme();
  const [plugin, setPlugin] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Check localStorage for theme


  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/plugins`)
      .then(res => res.json())
      .then(data => {
          if (data.plugins) {
              const p = data.plugins.find((p: any) => p.id === pluginId);
              setPlugin(p);
          }
          setLoading(false);
      })
      .catch(err => {
          console.error(err);
          setLoading(false);
      });
  }, [pluginId]);

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden bg-white dark:bg-transparent">
        <header data-ivoryos-page-header="mixed" className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 data-ivoryos-page-title className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300">
             {plugin ? plugin.name : 'Loading Plugin...'}
          </h2>
          {plugin && (
            <button
              type="button"
              onClick={() => openInPanel(plugin.id, plugin.placement)}
              title="Keep this plugin beside every page, e.g. to watch it while a workflow runs"
              className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5"
            >
              <PanelRight className="w-3.5 h-3.5" /> Show beside pages
            </button>
          )}
        </header>

        <div className="flex-1 overflow-hidden relative bg-white dark:bg-[#0a0a0a]">
            {loading ? (
                <div className="flex items-center justify-center h-full">
                    <Loader2 className="w-8 h-8 animate-spin text-gray-700 dark:text-gray-200" />
                </div>
            ) : plugin ? (
                <iframe
                    src={plugin.url.startsWith('http') ? plugin.url : `${API_BASE}${plugin.url}`}
                    className="w-full h-full border-none"
                    title={plugin.name}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
                />
            ) : (
                <div className="flex items-center justify-center h-full flex-col space-y-4">
                    <div className="text-gray-500 dark:text-gray-400">Plugin not found or inactive.</div>
                </div>
            )}
        </div>
      </main>
    </div>
  );
}

export default function PluginPage() {
    return (
        <Suspense fallback={<div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-[#0a0a0a]"><Loader2 className="w-8 h-8 animate-spin text-gray-700 dark:text-gray-200" /></div>}>
            <PluginContent />
        </Suspense>
    );
}
