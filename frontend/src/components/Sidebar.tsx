"use client";
import { API_BASE } from '@/config';

import { useEffect, useState } from 'react';
import { Sun, Moon, LayoutDashboard, Library, Blocks, Play, History, Database, ListTodo } from 'lucide-react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

interface SidebarProps {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

export default function Sidebar({ theme, toggleTheme }: SidebarProps) {
  const [edgeStatus, setEdgeStatus] = useState<any>(null);
  const pathname = usePathname();

  useEffect(() => {
    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => setEdgeStatus(data))
      .catch(err => console.error(err));
  }, []);

  const navItem = (href: string, label: string) => {
    const isActive = pathname === href;
    return (
      <Link 
        href={href} 
        className={`block px-4 py-2 rounded-lg transition-all ${
          isActive 
            ? 'bg-blue-50 dark:bg-white/10 text-blue-600 dark:text-white' 
            : 'hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-white'
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <aside className="w-64 shrink-0 bg-white dark:bg-white/5 backdrop-blur-md border-r border-gray-200 dark:border-white/10 flex flex-col p-6 space-y-8 z-10">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <img src="/favicon.ico" alt="Logo" className="w-8 h-8" />
          <h1 className="text-xl font-bold tracking-wider">IvoryOS</h1>
        </div>
        <button onClick={toggleTheme} className="p-2 rounded-lg bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300">
          {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </button>
      </div>

      <nav className="flex-1 space-y-4 text-sm font-medium text-gray-600 dark:text-gray-400">
        {navItem('/', 'Dashboard')}
        {navItem('/library', 'Library')}
        {navItem('/designer', 'Designer')}
        {navItem('/execution', 'Execution')}
        {navItem('/queue', 'Queue')}
        {navItem('/data', 'Data History')}
        {navItem('/instruments', 'Instruments')}
      </nav>

      {/* Status indicator */}
      <div className="p-4 rounded-xl bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-white/5 flex flex-col space-y-2">
        <div className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">Edge Status</div>
        <div className="flex items-center space-x-2">
          <span className={`w-2.5 h-2.5 rounded-full ${edgeStatus?.status === 'running' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-500'}`}></span>
          <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{edgeStatus?.status === 'running' ? 'Online' : 'Offline'}</span>
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-500 mt-2 font-medium">
          Cloud: {edgeStatus?.cloud_connected ? <span className="text-green-600 dark:text-green-400">Connected</span> : <span className="text-yellow-600 dark:text-yellow-500">Disconnected</span>}
        </div>
      </div>
    </aside>
  );
}
