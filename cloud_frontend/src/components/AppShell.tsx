"use client";

import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import AttentionCenter from '@/components/AttentionCenter';

/**
 * Cloud's frame: the sidebar, the page, and the attention popups. The sign-in page stands alone --
 * without a session there is no workspace to show in the sidebar, and every poll the frame makes
 * (devices, attention) would only answer 401.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/login' || pathname.startsWith('/login/')) return <>{children}</>;
  return (
    <>
      <div className="flex h-screen w-full overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden relative">
          {children}
        </main>
      </div>
      <AttentionCenter />
    </>
  );
}
