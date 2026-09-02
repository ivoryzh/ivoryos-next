"use client";

import { useEffect, useState } from 'react';
import { Sun, Moon, Cloud, Menu, Settings2, Book, LayoutTemplate, Server, ChevronDown, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function Sidebar() {
  const pathname = usePathname();
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [isExpanded, setIsExpanded] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('ivoryos_cloud_sidebar_expanded');
      if (saved !== null) return saved === 'true';
    }
    return true;
  });


  useEffect(() => {
    const stored = localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark') {
      setTheme(stored);
    }
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    } else {
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
    }
  };

  const [devices, setDevices] = useState<any[]>([]);
  const [edgeSeqExpanded, setEdgeSeqExpanded] = useState(false);

  const toggleExpanded = () => {
    const next = !isExpanded;
    setIsExpanded(next);
    localStorage.setItem('ivoryos_cloud_sidebar_expanded', String(next));
  };

  useEffect(() => {
    const fetchDevices = async () => {
      try {
        const res = await fetch('/api/devices');
        if (res.ok) {
          const data = await res.json();
          setDevices(data);
        }
      } catch (e) { }
    };
    fetchDevices();
    const interval = setInterval(fetchDevices, 3000);
    return () => clearInterval(interval);
  }, []);

  const navItem = (href: string, label: string, icon: React.ReactNode) => {
    const isActive = pathname === href;
    return (
      <Link
        href={href}
        title={!isExpanded ? label : undefined}
        className={`flex items-center py-3 rounded-lg overflow-hidden mx-3 transition-colors ${!isActive ? 'hover-bg' : ''}`}
        style={{
          background: isActive ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
          color: isActive ? 'var(--accent-color)' : 'var(--text-secondary)'
        }}
      >
        <div className="w-5 h-5 flex justify-center shrink-0 ml-3">
          {icon}
        </div>
        {isExpanded && <span className="ml-4 whitespace-nowrap font-medium text-sm">{label}</span>}
      </Link>
    );
  };

  return (
    <aside
      suppressHydrationWarning
      className="shrink-0 flex flex-col py-6 space-y-6 z-10 overflow-hidden glass-sidebar"
      style={{ width: isExpanded ? '16rem' : '4.5rem', borderRight: '1px solid var(--panel-border)' }}
    >
      <div className="flex items-center w-full px-3">
        <button
          onClick={toggleExpanded}
          className="w-10 h-10 flex items-center justify-center rounded-lg transition-colors hover-bg"
          style={{ color: 'var(--text-secondary)' }}
        >
          <Menu className="w-5 h-5 shrink-0" />
        </button>
        {isExpanded && (
          <div className="flex items-center space-x-3 ml-2 text-primary">
            <div className="flex items-center justify-center bg-blue-500 rounded p-1" style={{ color: '#fff' }}>
              <Cloud className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold tracking-wider" style={{ color: 'var(--text-primary)' }}>Cloud Hub</h1>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-2 w-full overflow-y-auto">
        {navItem('/', 'Orchestrator', <Cloud className="w-5 h-5 shrink-0" />)}
        {navItem('/library', 'Library', <Book className="w-5 h-5 shrink-0" />)}

        {/* Edge Sequence Dropdown */}
        <div className="flex flex-col">
          <button
            onClick={() => {
              if (!isExpanded) setIsExpanded(true);
              setEdgeSeqExpanded(!edgeSeqExpanded);
            }}
            className={`flex items-center justify-between py-3 rounded-lg overflow-hidden mx-3 transition-colors hover-bg ${pathname.startsWith('/edge-sequence') ? 'bg-blue-500/10 text-blue-500' : 'text-gray-500 dark:text-gray-400'}`}
          >
            <div className="flex items-center">
              <div className="w-5 h-5 flex justify-center shrink-0 ml-3">
                <LayoutTemplate className="w-5 h-5 shrink-0" />
              </div>
              {isExpanded && <span className="ml-4 whitespace-nowrap font-medium text-sm">Edge Sequence</span>}
            </div>
            {isExpanded && (
              <div className="mr-3">
                {edgeSeqExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </div>
            )}
          </button>

          {isExpanded && edgeSeqExpanded && (
            <div className="mt-1 flex flex-col space-y-1">
              {/* Offline Builder Fallback */}
              <Link
                href="/edge-sequence"
                className={`flex items-center py-2 rounded-lg overflow-hidden mx-3 ml-8 transition-colors ${pathname === '/edge-sequence' ? 'bg-blue-500/20 text-blue-500' : 'hover-bg text-gray-500 dark:text-gray-400'}`}
              >
                <span className="ml-4 whitespace-nowrap font-medium text-xs">Offline Template</span>
              </Link>

              {/* Connected Devices */}
              {devices.map(device => (
                <Link
                  key={device.id}
                  href={`/edge-sequence?deviceId=${device.id}`}
                  className={`flex items-center py-2 rounded-lg overflow-hidden mx-3 ml-8 transition-colors ${pathname === '/edge-sequence' && typeof window !== 'undefined' && window.location.search.includes(`deviceId=${device.id}`) ? 'bg-blue-500/20 text-blue-500' : 'hover-bg text-gray-500 dark:text-gray-400'}`}
                >
                  <Server className="w-3 h-3 shrink-0 ml-4 opacity-70" />
                  <span className="ml-2 whitespace-nowrap font-medium text-xs truncate max-w-[120px]">{device.id}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </nav>

      <div className="flex flex-col space-y-2 w-full">
        {navItem('/settings', 'Cloud Settings', <Settings2 className="w-5 h-5 shrink-0" />)}
        <button
          onClick={toggleTheme}
          className="flex items-center mx-3 py-3 rounded-lg transition-colors overflow-hidden toolbox-item"
        >
          <div className="w-5 h-5 flex justify-center shrink-0 ml-3">
            {theme === 'light' ? <Moon className="w-5 h-5 shrink-0" /> : <Sun className="w-5 h-5 shrink-0" />}
          </div>
          {isExpanded && <span className="ml-4 text-sm font-medium whitespace-nowrap">{theme === 'light' ? 'Dark Mode' : 'Light Mode'}</span>}
        </button>
      </div>
    </aside>
  );
}
