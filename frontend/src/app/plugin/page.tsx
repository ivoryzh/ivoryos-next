"use client";
import { API_BASE } from '@/config';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Sun, Moon, Loader2 } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

function PluginContent() {
  const searchParams = useSearchParams();
  const pluginId = searchParams.get('id');

  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [plugin, setPlugin] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Check localStorage for theme
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  };

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
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden bg-white dark:bg-transparent">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300">
             {plugin ? plugin.name : 'Loading Plugin...'}
          </h2>
        </header>

        <div className="flex-1 overflow-hidden relative bg-white dark:bg-[#0a0a0a]">
            {loading ? (
                <div className="flex items-center justify-center h-full">
                    <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
                </div>
            ) : plugin ? (
                <iframe 
                    src={plugin.url}
                    className="w-full h-full border-none"
                    title={plugin.name}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
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
        <Suspense fallback={<div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-[#0a0a0a]"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>}>
            <PluginContent />
        </Suspense>
    );
}
