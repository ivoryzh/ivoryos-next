"use client";

import { useEffect, useState } from 'react';
import { Cloud, Menu, Settings, Settings2, Library, LayoutTemplate, Server, ChevronDown, ChevronRight, CalendarClock, Table2, MonitorCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import { inDesktopApp, useNavPlacement, TopNavBar, TopNavBrand, TopNavItem, TopNavIconLink, TopNavDivider, BRAND_MARK } from '@ivoryos/shared-ui';

export default function Sidebar() {
  const pathname = usePathname();
  // A fixed default, corrected after mount (AGENTS.md section 11). Reading localStorage in the
  // initializer made the first client render disagree with the server's whenever the sidebar had
  // been collapsed, which React reports as a hydration failure and re-renders the whole tree.
  const [isExpanded, setIsExpanded] = useState(true);
  useEffect(() => {
    const saved = localStorage.getItem('ivoryos_cloud_sidebar_expanded');
    if (saved !== null) setIsExpanded(saved === 'true');
  }, []);



  const [devices, setDevices] = useState<any[]>([]);
  const [edgeSeqExpanded, setEdgeSeqExpanded] = useState(false);
  // Sidebar or top bar (shared-ui navPlacement.tsx); AppShell turns the frame into a column.
  const [placement] = useNavPlacement();
  // Inside the desktop app the top bar leaves out the wordmark. Read after mount, like the rest.
  const [desktop, setDesktop] = useState(false);
  useEffect(() => { setDesktop(inDesktopApp()); }, []);

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
          background: isActive ? 'var(--accent-soft)' : 'transparent',
          color: isActive ? 'var(--accent-soft-text)' : 'var(--text-secondary)'
        }}
      >
        <div className="w-5 h-5 flex justify-center shrink-0 ml-3">
          {icon}
        </div>
        {isExpanded && <span className="ml-4 whitespace-nowrap font-medium text-sm">{label}</span>}
      </Link>
    );
  };

  if (placement === 'top') {
    // The same bar the edge app draws (shared-ui TopNav.tsx): the pages in working order, then
    // the lab; the workspace and settings at the right.
    const icon = 'w-4 h-4 shrink-0';
    return (
      <TopNavBar
        brand={!desktop && <TopNavBrand link={Link} href="/" badge="Cloud" />}
        end={
          <>
            <WorkspaceSwitcher expanded compact />
            <TopNavIconLink link={Link} href="/settings" label="Cloud Settings" icon={<Settings className={icon} />} active={pathname === '/settings'} />
          </>
        }
      >
        <TopNavItem link={Link} href="/library" label="Library" icon={<Library className={icon} />} active={pathname === '/library'} />
        <TopNavItem link={Link} href="/" label="Orchestrator" icon={<Cloud className={icon} />} active={pathname === '/'} />
        <TopNavItem link={Link} href="/schedules" label="Schedules" icon={<CalendarClock className={icon} />} active={pathname === '/schedules'} />
        <TopNavItem link={Link} href="/results" label="Results" icon={<Table2 className={icon} />} active={pathname === '/results'} />
        <TopNavDivider />
        {/* No Edge Sequence entry: its editor works on one device's library, so it opens from that
            device (its card on Devices, or a workflow in the Library), not from a page of its own. */}
        <TopNavItem link={Link} href="/devices" label="Devices" icon={<MonitorCheck className={icon} />} active={pathname === '/devices' || pathname.startsWith('/edge-sequence')} />
      </TopNavBar>
    );
  }

  return (
    <aside
      data-ivoryos-nav-bar
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
          <div className="flex items-center space-x-3 ml-2 min-w-0">
            {/* The same mark as the edge app, so the two read as one product. */}
            <img src={BRAND_MARK} alt="IvoryOS" className="h-7 w-auto shrink-0" />
            <h1 className="text-xl font-bold tracking-wider" style={{ color: 'var(--text-primary)' }}>IvoryOS</h1>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white border border-gray-200 dark:border-white/15 dark:bg-white/10 dark:text-white dark:border-white/20">Cloud</span>
          </div>
        )}
      </div>

      <WorkspaceSwitcher expanded={isExpanded} />

      <nav className="flex-1 space-y-2 w-full overflow-y-auto">
        {navItem('/library', 'Library', <Library className="w-5 h-5 shrink-0" />)}
        {navItem('/', 'Orchestrator', <Cloud className="w-5 h-5 shrink-0" />)}
        {navItem('/schedules', 'Schedules', <CalendarClock className="w-5 h-5 shrink-0" />)}
        {navItem('/results', 'Results', <Table2 className="w-5 h-5 shrink-0" />)}
        {navItem('/devices', 'Devices', <MonitorCheck className="w-5 h-5 shrink-0" />)}

        {/* Edge Sequence Dropdown */}
        <div className="flex flex-col">
          <button
            onClick={() => {
              if (!isExpanded) setIsExpanded(true);
              setEdgeSeqExpanded(!edgeSeqExpanded);
            }}
            className={`flex items-center justify-between py-3 rounded-lg overflow-hidden mx-3 transition-colors hover-bg ${pathname.startsWith('/edge-sequence') ? 'bg-accent-soft text-accent-fg' : 'text-gray-500 dark:text-gray-400'}`}
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

              {/* Connected Devices */}
              {devices.map(device => (
                <Link
                  key={device.id}
                  href={`/edge-sequence?deviceId=${device.id}`}
                  className={`flex items-center py-2 rounded-lg overflow-hidden mx-3 ml-8 transition-colors ${pathname === '/edge-sequence' && typeof window !== 'undefined' && window.location.search.includes(`deviceId=${device.id}`) ? 'bg-accent-soft text-accent-fg' : 'hover-bg text-gray-500 dark:text-gray-400'}`}
                >
                  <Server className="w-3 h-3 shrink-0 ml-4 opacity-70" />
                  <span className="ml-2 whitespace-nowrap font-medium text-xs truncate max-w-[120px]" title={device.id}>{device.name || device.id}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </nav>

      <div className="flex flex-col space-y-2 w-full">
        {navItem('/settings', 'Cloud Settings', <Settings2 className="w-5 h-5 shrink-0" />)}
      </div>
    </aside>
  );
}
