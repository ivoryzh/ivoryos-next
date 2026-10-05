"use client";
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsUpDown } from 'lucide-react';

/**
 * The top navigation bar (navPlacement.tsx's 'top'), shared so the edge app and Cloud draw one
 * bar rather than two copies that drift apart. Inside the desktop app both show in tabs of the
 * same window, so any difference between them reads as a bug.
 *
 * Pages are compact pills: an icon and a label, the icon alone on a narrow window with the label
 * kept as a tooltip. Groups are split by thin dividers. Each app passes its own router link
 * (next/link), since shared-ui does not depend on Next and a plain <a> would reload the page
 * (which, on the edge, reloads a docked plugin panel too).
 */

/**
 * The IvoryOS mark (desktop/build/logo.png, trimmed). Each app serves it from its own `public/`.
 * It is wider than tall, so size it by height (`h-6 w-auto`): a square box squashes the elephant.
 * Under the app's base path when it has one (the frontend's tour build), since an <img> src does
 * not get one added the way a <Link> does.
 */
export const BRAND_MARK = `${process.env.NEXT_PUBLIC_BASE_PATH || ''}/ivoryos-mark.png`;

const pill = 'flex items-center gap-2 h-8 px-2.5 rounded-lg text-[13px] font-medium whitespace-nowrap transition-colors shrink-0';
const idle = 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-100';
const on = 'bg-accent-soft text-accent-fg';

/** Class names for a control on the bar that is none of the pieces below (a menu button, say). */
export const topNavPill = (active = false) => `${pill} ${active ? on : idle}`;

/** At which width a label appears; below it only the icon shows. */
type LabelFrom = 'sm' | 'md' | 'lg';
const labelClass: Record<LabelFrom, string> = {
  sm: 'hidden sm:inline max-w-[10rem] truncate',
  md: 'hidden md:inline max-w-[10rem] truncate',
  lg: 'hidden lg:inline max-w-[10rem] truncate',
};

/**
 * The bar. `end` sits at the right edge. Only the page list scrolls sideways when the window is
 * too narrow; the bar itself has no `overflow` (Cloud's workspace menu was once cut off by one and
 * looked like it never opened). Menus go through TopNavMenu, which does not depend on the bar's
 * stacking at all; z-40 only keeps the bar under modals.
 */
export function TopNavBar({ brand, children, end }: { brand?: React.ReactNode; children: React.ReactNode; end?: React.ReactNode }) {
  return (
    <header data-ivoryos-nav-bar className="shrink-0 h-12 w-full flex items-center gap-2 px-3 relative z-40 bg-white/85 dark:bg-[#0c0c0c]/85 backdrop-blur-md border-b border-gray-200/80 dark:border-white/[0.08]">
      {brand}
      <nav aria-label="Pages" className="flex items-center gap-0.5 min-w-0 overflow-x-auto [scrollbar-width:none]">
        {children}
      </nav>
      {end && <div className="ml-auto flex items-center gap-1 pl-2 shrink-0">{end}</div>}
    </header>
  );
}

/** A page. */
export function TopNavItem({ link: LinkC, href, label, icon, active, title, labelFrom = 'md' }: {
  link: React.ElementType; href: string; label: string; icon: React.ReactNode; active: boolean; title?: string; labelFrom?: LabelFrom;
}) {
  return (
    <LinkC href={href} title={title ?? label} aria-current={active ? 'page' : undefined} className={topNavPill(active)}>
      {icon}
      <span className={labelClass[labelFrom]}>{label}</span>
    </LinkC>
  );
}

/** Something that is not a page (opening a side panel, say); lit while what it opens is showing. */
export function TopNavButton({ onClick, label, icon, active, title, labelFrom = 'lg' }: {
  onClick: () => void; label: string; icon: React.ReactNode; active: boolean; title?: string; labelFrom?: LabelFrom;
}) {
  return (
    <button type="button" onClick={onClick} title={title ?? label} aria-pressed={active} className={topNavPill(active)}>
      {icon}
      <span className={labelClass[labelFrom]}>{label}</span>
    </button>
  );
}

/**
 * A pill that opens a menu (Cloud's workspace switcher). The menu is portalled to <body> and
 * placed under the pill with fixed coordinates rather than hanging off the bar: some pages give
 * their own header z-50 so its dropdowns clear the canvas, and those headers drew straight over a
 * menu that lived in the bar's stacking context. Raising the bar instead would lift it over
 * modals too. `children` gets a `close` to call after a choice.
 */
export function TopNavMenu({ label, icon, title, children, labelFrom = 'sm', align = 'right' }: {
  label: string; icon: React.ReactNode; title?: string; children: (close: () => void) => React.ReactNode; labelFrom?: LabelFrom; align?: 'left' | 'right';
}) {
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => setPos(null);
  const toggle = () => {
    if (pos) { close(); return; }
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    setPos(align === 'right' ? { top: r.bottom + 6, right: window.innerWidth - r.right } : { top: r.bottom + 6, left: r.left });
  };
  useEffect(() => {
    if (!pos) return;
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !menu.current?.contains(t)) close();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    // Fixed coordinates go stale when the window moves under them; closing is simpler than following.
    window.addEventListener('mousedown', outside);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', outside);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [pos]);
  return (
    <>
      <button ref={button} type="button" onClick={toggle} title={title ?? label} aria-haspopup="menu" aria-expanded={!!pos} className={`${topNavPill(!!pos)} max-w-[14rem]`}>
        {icon}
        <span className={labelClass[labelFrom]}>{label}</span>
        <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-60" />
      </button>
      {pos && typeof document !== 'undefined' && createPortal(
        <div ref={menu} role="menu" style={{ position: 'fixed', top: pos.top, left: pos.left, right: pos.right }}
          className="z-[70] min-w-[14rem] max-w-[20rem] py-1 rounded-lg text-sm shadow-xl bg-white text-gray-800 border border-gray-200 dark:bg-[#16191f] dark:text-gray-100 dark:border-white/10">
          {children(close)}
        </div>,
        document.body,
      )}
    </>
  );
}

/** A row in a TopNavMenu. */
export function TopNavMenuItem({ onClick, icon, children, trailing }: { onClick: () => void; icon?: React.ReactNode; children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-white/[0.06]">
      {icon}
      <span className="flex-1 min-w-0 truncate">{children}</span>
      {trailing}
    </button>
  );
}

/** An icon-only page link for the right end (Settings). */
export function TopNavIconLink({ link: LinkC, href, label, icon, active }: {
  link: React.ElementType; href: string; label: string; icon: React.ReactNode; active: boolean;
}) {
  return (
    <LinkC href={href} title={label} aria-label={label} aria-current={active ? 'page' : undefined}
      className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors shrink-0 ${active ? on : idle}`}>
      {icon}
    </LinkC>
  );
}

export function TopNavDivider() {
  return <span aria-hidden className="mx-1.5 h-5 w-px shrink-0 bg-gray-200 dark:bg-white/10" />;
}

/**
 * The mark at the left, followed by a divider. Left out inside the desktop app, whose own
 * sidebar already names the deck or Cloud tab and where the bar has to fit beside it.
 */
export function TopNavBrand({ link: LinkC, href, name = 'IvoryOS', badge }: {
  link: React.ElementType; href: string; name?: string; badge?: string;
}) {
  return (
    <>
      <LinkC href={href} title={name} className="flex items-center gap-2 px-1.5 shrink-0">
        <img src={BRAND_MARK} alt="" className="h-6 w-auto shrink-0" />
        <span className="hidden xl:inline text-sm font-semibold tracking-wide text-gray-900 dark:text-gray-100">{name}</span>
        {badge && <span className="hidden xl:inline px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white dark:bg-white/10 dark:text-white">{badge}</span>}
      </LinkC>
      <TopNavDivider />
    </>
  );
}
