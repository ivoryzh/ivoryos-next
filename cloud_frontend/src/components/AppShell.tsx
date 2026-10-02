"use client";

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import { useNavPlacement } from '@ivoryos/shared-ui';
import AttentionCenter from '@/components/AttentionCenter';

/**
 * The proxy lets a page load whenever a session cookie is present, but a cookie can outlive its
 * session (expired, signed out elsewhere, the store replaced). Then every call answers 401 while
 * the page looks signed in. So check the session itself on load and on returning to the window,
 * and go to sign-in, clearing the dead cookie, when it is gone.
 */
function useSessionCheck(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const check = async () => {
      const res = await fetch('/api/auth/session').catch(() => null);
      if (res?.status !== 401) return; // signed in, or Cloud unreachable: nothing to do
      await fetch('/api/auth/sign-out', { method: 'POST' }).catch(() => {});
      window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    };
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [enabled]);
}

/**
 * Cloud's frame: the sidebar, the page, and the attention popups. The sign-in page stands alone --
 * without a session there is no workspace to show in the sidebar, and every poll the frame makes
 * (devices, attention) would only answer 401.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLogin = pathname === '/login' || pathname.startsWith('/login/');
  useSessionCheck(!isLogin);
  // Read here as well as in the Sidebar so the frame's direction and the bar agree on first paint.
  const [nav] = useNavPlacement();
  if (isLogin) return <>{children}</>;
  return (
    <>
      <div className={`flex h-screen w-full overflow-hidden ${nav === 'top' ? 'flex-col' : ''}`}>
        <Sidebar />
        <main className="flex-1 overflow-hidden relative">
          {children}
        </main>
      </div>
      <AttentionCenter />
    </>
  );
}
