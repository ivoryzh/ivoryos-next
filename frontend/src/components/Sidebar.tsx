"use client";
import { API_BASE } from '@/config';

import { useEffect, useState } from 'react';
import { Sun, Moon, LayoutDashboard, Library, Blocks, Play, History, Database, ListTodo, PanelLeftClose, PanelLeftOpen, Settings2, Plug, Gamepad2, Zap, Menu, Cloud } from 'lucide-react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

interface SidebarProps {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

export default function Sidebar({ theme, toggleTheme }: SidebarProps) {
  const [edgeStatus, setEdgeStatus] = useState<any>(null);
  const [plugins, setPlugins] = useState<any[]>([]);
  const [isExpanded, setIsExpanded] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('ivoryos_sidebar_expanded');
      if (saved !== null) return saved === 'true';
    }
    return true;
  });
  const pathname = usePathname();

  const toggleExpanded = () => {
    const next = !isExpanded;
    setIsExpanded(next);
    localStorage.setItem('ivoryos_sidebar_expanded', String(next));
  };

  useEffect(() => {
    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => setEdgeStatus(data))
      .catch(err => console.error(err));

    fetch(`${API_BASE}/api/plugins`)
      .then(res => res.json())
      .then(data => {
          if (data.plugins) {
              setPlugins(data.plugins);
          }
      })
      .catch(err => console.error(err));
  }, []);

  const navItem = (href: string, label: string, icon: React.ReactNode) => {
    const isActive = pathname === href;
    return (
      <Link 
        href={href} 
        title={!isExpanded ? label : undefined}
        className={`flex items-center py-3 rounded-lg overflow-hidden mx-3 ${
          isActive 
            ? 'bg-blue-50 dark:bg-white/10 text-blue-600 dark:text-white' 
            : 'hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-white'
        }`}
      >
        <div className="w-5 h-5 flex justify-center shrink-0 ml-3">
          {icon}
        </div>
        {isExpanded && <span className="ml-4 whitespace-nowrap">{label}</span>}
      </Link>
    );
  };

  return (
    <aside suppressHydrationWarning className={`shrink-0 bg-white dark:bg-white/5 backdrop-blur-md border-r border-gray-200 dark:border-white/10 flex flex-col py-6 space-y-6 z-10 overflow-hidden ${isExpanded ? 'w-64' : 'w-[72px]'}`}>
      <div className="flex items-center w-full px-3">
        <button onClick={toggleExpanded} className="w-[44px] h-[44px] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 flex items-center justify-center rounded-lg transition-colors">
          <Menu className="w-5 h-5 shrink-0" />
        </button>
        {isExpanded && (
          <div className="flex items-center space-x-3 ml-2">
            <img src="/favicon.ico" alt="Logo" className="w-8 h-8 shrink-0" />
            <h1 className="text-xl font-bold tracking-wider">IvoryOS</h1>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-2 text-sm font-medium text-gray-600 dark:text-gray-400 overflow-y-auto w-full">
        {navItem('/', 'Dashboard', <LayoutDashboard className="w-5 h-5 shrink-0" />)}
        {navItem('/library', 'Library', <Library className="w-5 h-5 shrink-0" />)}
        {navItem('/designer', 'Designer', <Blocks className="w-5 h-5 shrink-0" />)}
        {navItem('/execution', 'Configure', <Settings2 className="w-5 h-5 shrink-0" />)}
        {navItem('/optimize', 'Optimize', <Zap className="w-5 h-5 shrink-0" />)}
        {navItem('/queue', 'Queue', <ListTodo className="w-5 h-5 shrink-0" />)}
        {navItem('/data', 'Data History', <Database className="w-5 h-5 shrink-0" />)}
        {navItem('/instruments', 'Instruments', <Gamepad2 className="w-5 h-5 shrink-0" />)}
        {plugins.length > 0 && (
            <div className="pt-4 border-t border-gray-200 dark:border-white/10 mt-4">
                {isExpanded && <div className="px-4 mb-2 text-[10px] font-bold tracking-wider uppercase text-gray-400">Plugins</div>}
                <div className="space-y-2">
                    {plugins.map(p => (
                        <div key={p.id}>
                            {navItem(`/plugin?id=${p.id}`, p.name, <Plug className="w-5 h-5 shrink-0" />)}
                        </div>
                    ))}
                </div>
            </div>
        )}
      </nav>

      <div className="flex flex-col space-y-4 w-full">
        <div className="mx-3">
          <div className={`flex items-center justify-between py-2 px-3 rounded-lg bg-gray-50 dark:bg-black/20 border border-gray-100 dark:border-white/5`}>
            <div className="flex items-center min-w-0">
              <div className={`w-2 h-2 rounded-full shrink-0 ${edgeStatus?.cloud_connected ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'}`}></div>
              {isExpanded && (
                  <div className="flex flex-col ml-3 min-w-0">
                    <span className="text-xs font-bold text-gray-700 dark:text-gray-300">Cloud Connect</span>
                    <span className="text-[10px] text-gray-500 truncate">{edgeStatus?.cloud_connected ? 'Connected' : 'Offline'}</span>
                  </div>
              )}
            </div>
            {isExpanded && (
              <Link href="/cloud" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors ml-2">
                <Settings2 className="w-4 h-4" />
              </Link>
            )}
          </div>
        </div>

        <button 
            onClick={toggleTheme}
            className={`mx-3 flex items-center py-3 px-3 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors overflow-hidden`}
        >
            <div className="w-5 h-5 flex justify-center shrink-0">
                {theme === 'light' ? <Moon className="w-5 h-5 shrink-0" /> : <Sun className="w-5 h-5 shrink-0" />}
            </div>
            {isExpanded && <span className="ml-4 text-sm font-medium whitespace-nowrap">{theme === 'light' ? 'Dark Mode' : 'Light Mode'}</span>}
        </button>
      </div>
    </aside>
  );
}
