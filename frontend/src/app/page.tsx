"use client";
import { API_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

export default function Home() {
  const [edgeStatus, setEdgeStatus] = useState<any>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');

    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => setEdgeStatus(data))
      .catch(err => console.error("Failed to fetch edge status:", err));
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {/* Sidebar - Glassmorphism */}
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden bg-gray-100 dark:bg-transparent">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300 ">Dashboard</h2>
        </header>

        {/* Content Wrapper */}
        <div className="flex-1 overflow-y-auto p-8 bg-gray-100 dark:bg-transparent">
          <div className="max-w-6xl mx-auto space-y-8">
            {/* Hero Section */}
            <div className="relative overflow-hidden rounded-2xl bg-white dark:bg-gradient-to-br dark:from-blue-900/40 dark:to-purple-900/40 border border-gray-200 dark:border-white/10 p-8 shadow-sm dark:shadow-none">
              <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-5 dark:opacity-10 mix-blend-overlay"></div>
              <h1 className="text-3xl font-bold mb-3 text-gray-900 dark:text-white">Welcome to IvoryOS NextGen</h1>
              <p className="text-gray-600 dark:text-gray-300 max-w-xl font-medium">
                The distributed edge execution platform for Self-Driving Labs.
                Design locally, orchestrate globally.
              </p>
            </div>

            {/* Grid layout for stats/info */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[
                { label: "Active Workflows", value: "0" },
                { label: "Connected Devices", value: "1 Local" },
                { label: "Cloud Sync", value: edgeStatus?.cloud_connected ? 'Active' : 'Pending' }
              ].map((stat, i) => (
                <div key={i} className="p-6 rounded-2xl bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 dark:backdrop-blur-md hover:bg-gray-50 dark:hover:bg-white/10 transition-all shadow-sm dark:shadow-none">
                  <div className="text-gray-500 dark:text-gray-400 text-sm font-semibold mb-1 uppercase tracking-wider">{stat.label}</div>
                  <div className="text-2xl font-bold text-gray-800 dark:text-white">{stat.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
