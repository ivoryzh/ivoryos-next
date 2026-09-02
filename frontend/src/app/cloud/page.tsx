"use client";
import { API_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Cloud, Save, CheckCircle2, AlertTriangle } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

export default function CloudSettingsPage() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [cloudUrl, setCloudUrl] = useState('http://localhost:3000');
  const [registrationKey, setRegistrationKey] = useState('edge-default-01');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');

    // Fetch current settings
    fetch(`${API_BASE}/api/cloud-settings`)
      .then(res => res.json())
      .then(data => {
        if (data.cloudUrl) setCloudUrl(data.cloudUrl);
        if (data.registrationKey) setRegistrationKey(data.registrationKey);
      })
      .catch(err => {
        console.error("Failed to fetch cloud settings", err);
        setError('Failed to connect to local edge server to read settings.');
      });
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const saveSettings = async () => {
    setIsSaving(true);
    setSaveSuccess(false);
    setError('');

    try {
      const res = await fetch(`${API_BASE}/api/cloud-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudUrl, registrationKey })
      });
      
      if (res.ok) {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to save settings.');
      }
    } catch (err: any) {
      setError(err.message || 'Network error.');
    } finally {
      setIsSaving(false);
    }
  };

  const disconnectCloud = async () => {
    setIsSaving(true);
    setSaveSuccess(false);
    setError('');

    try {
      const res = await fetch(`${API_BASE}/api/cloud-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudUrl: "", registrationKey })
      });
      
      if (res.ok) {
        setCloudUrl("");
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to disconnect.');
      }
    } catch (err: any) {
      setError(err.message || 'Network error.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      <main className="flex-1 flex flex-col h-full w-full overflow-y-auto">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center px-8 bg-white dark:bg-black/20 z-10">
          <h2 className="text-base font-medium text-gray-800 dark:text-gray-200">Cloud Connect</h2>
        </header>

        <div className="p-8 max-w-4xl mx-auto w-full">
          <div className="bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-2xl p-8 shadow-sm">
            <div className="mb-8">
              <h2 className="text-xl font-semibold mb-2">Edge-to-Cloud Registration</h2>
              <p className="text-gray-500 dark:text-gray-400 text-sm">
                Configure your edge device to connect to a centralized IvoryOS SaaS Cloud Orchestrator. 
                When connected, this device will securely poll the cloud for distributed execution tasks.
              </p>
            </div>

            {error && (
              <div className="mb-6 p-4 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-500/30 flex items-start space-x-3 text-red-700 dark:text-red-400">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                <span className="text-sm font-medium">{error}</span>
              </div>
            )}

            <div className="space-y-6">
              <div>
                <label className="block text-sm font-semibold mb-2 text-gray-700 dark:text-gray-300">
                  Cloud Orchestrator URL
                </label>
                <input 
                  type="text" 
                  value={cloudUrl}
                  onChange={e => setCloudUrl(e.target.value)}
                  placeholder="https://cloud.ivoryos.com"
                  className="w-full px-4 py-2 rounded-lg bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all text-sm"
                />
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  The base URL of your organization's IvoryOS Cloud instance (e.g. <code>http://localhost:3000</code>).
                </p>
              </div>

              <div>
                <label className="block text-sm font-semibold mb-2 text-gray-700 dark:text-gray-300">
                  Device Registration Key
                </label>
                <input 
                  type="text" 
                  value={registrationKey}
                  onChange={e => setRegistrationKey(e.target.value)}
                  placeholder="edge-device-unique-id"
                  className="w-full px-4 py-2 rounded-lg bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all text-sm"
                />
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  A unique identifier and secret token for this edge device to authenticate with the cloud.
                </p>
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-gray-200 dark:border-white/10 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                {saveSuccess && (
                  <span className="flex items-center space-x-1.5 text-sm font-medium text-green-600 dark:text-green-400">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Settings saved</span>
                  </span>
                )}
              </div>
              <div className="flex items-center space-x-3">
                <button 
                  onClick={disconnectCloud}
                  disabled={isSaving || !cloudUrl}
                  className="flex items-center space-x-2 px-6 py-2.5 rounded-lg font-bold text-sm bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors disabled:opacity-50"
                >
                  <span>Disconnect</span>
                </button>
                <button 
                  onClick={saveSettings}
                  disabled={isSaving}
                  className="flex items-center space-x-2 px-6 py-2.5 rounded-lg font-bold text-sm bg-blue-600 hover:bg-blue-700 text-white transition-colors shadow-sm shadow-blue-500/20 disabled:opacity-50"
                >
                  <Save className="w-4 h-4 shrink-0" />
                  <span>{isSaving ? 'Saving...' : 'Save Configuration'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
