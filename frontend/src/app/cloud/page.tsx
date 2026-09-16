"use client";
import { API_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Cloud, Save, CheckCircle2, AlertTriangle } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

export default function CloudSettingsPage() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [token, setToken] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  // 'idle' means "not attempted this session" — distinct from 'disconnected', which means the
  // edge server itself confirmed there's no active broker connection (e.g. token was cleared).
  const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'error' | 'disconnected'>('idle');

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');

    // Fetch current settings
    fetch(`${API_BASE}/api/cloud-settings`)
      .then(res => res.json())
      .then(data => {
        if (data.token !== undefined) setToken(data.token);
        if (data.connection_state) setConnectionState(data.connection_state);
        if (data.connection_error) setError(data.connection_error);
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

  // Validate: the POST below blocks on the edge server actually attempting the connection (up to
  // ~5s — see setup_broker's is_connected() poll) and its response IS the real outcome, so there's
  // no separate "click save, then hope" step — a bad cert or wrong endpoint comes back as an
  // explicit error here, not silence.
  const saveSettings = async () => {
    setIsSaving(true);
    setConnectionState('connecting');
    setError('');

    try {
      const res = await fetch(`${API_BASE}/api/cloud-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();

      if (res.ok) {
        setConnectionState(data.connection_state || 'error');
        // 'disconnected' is a valid, non-error outcome (e.g. the token field was left empty) —
        // only 'error' actually means the connection attempt failed.
        if (data.connection_state === 'error') {
          setError(data.connection_error || 'Failed to connect — check the token and try again.');
        }
      } else {
        setConnectionState('error');
        setError(data.error || 'Failed to save settings.');
      }
    } catch (err: any) {
      setConnectionState('error');
      setError(err.message || 'Network error.');
    } finally {
      setIsSaving(false);
    }
  };

  const disconnectCloud = async () => {
    setIsSaving(true);
    setError('');

    try {
      const res = await fetch(`${API_BASE}/api/cloud-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: "" })
      });

      if (res.ok) {
        setToken("");
        setConnectionState('disconnected');
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
                When connected, this device publishes its status, schema, and saved workflows to the cloud over MQTT.
              </p>
            </div>

            <div className="mb-6 flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                connectionState === 'connected' ? 'bg-green-500' :
                connectionState === 'connecting' ? 'bg-amber-500 animate-pulse' :
                connectionState === 'error' ? 'bg-red-500' :
                'bg-gray-300 dark:bg-gray-600'
              }`} />
              <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
                {connectionState === 'connected' ? 'Connected' :
                 connectionState === 'connecting' ? 'Connecting…' :
                 connectionState === 'error' ? 'Connection failed' :
                 connectionState === 'disconnected' ? 'Disconnected' :
                 'Not configured'}
              </span>
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
                  Connection Token
                </label>
                <textarea 
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  placeholder="Paste your Base64 Connection Token here..."
                  rows={6}
                  className="w-full px-4 py-3 rounded-lg bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all text-sm font-mono"
                />
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  This secure token configures your edge device's connection to the Cloud message broker. It supports both local MQTT testing and AWS IoT Core.
                </p>
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-gray-200 dark:border-white/10 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                {connectionState === 'connected' && !isSaving && (
                  <span className="flex items-center space-x-1.5 text-sm font-medium text-green-600 dark:text-green-400">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Validated — broker connection confirmed</span>
                  </span>
                )}
              </div>
              <div className="flex items-center space-x-3">
                <button 
                  onClick={disconnectCloud}
                  disabled={isSaving || !token}
                  className="flex items-center space-x-2 px-6 py-2.5 rounded-lg font-bold text-sm bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors disabled:opacity-50"
                >
                  <span>Disconnect</span>
                </button>
                <button 
                  onClick={saveSettings}
                  disabled={isSaving}
                  className="flex items-center space-x-2 px-6 py-2.5 rounded-lg font-bold text-sm bg-indigo-600 hover:bg-indigo-700 text-white transition-colors shadow-sm shadow-indigo-500/20 disabled:opacity-50"
                >
                  <Save className="w-4 h-4 shrink-0" />
                  <span>{isSaving ? 'Connecting…' : 'Save & Validate'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
