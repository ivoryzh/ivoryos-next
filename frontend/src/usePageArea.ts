"use client";
import { useEffect, useState } from 'react';

/**
 * The page area beside the nav, which full size covers so the nav stays in sight and usable: below
 * the bar along the top, or right of the sidebar. Each page draws its own nav, and a page can draw
 * it a moment after the address changes (measuring on navigation found none, and full size covered
 * the bar), so the nav element is followed whenever it appears or is replaced, and as it changes
 * size (the sidebar expanding).
 */
export function usePageArea() {
  const [area, setArea] = useState({ top: 0, left: 0 });
  useEffect(() => {
    let nav: Element | null = null;
    const measure = () => {
      const r = nav?.getBoundingClientRect();
      // Along the top it is wider than it is tall; a sidebar is the other way round.
      const next = !r ? { top: 0, left: 0 } : r.width > r.height ? { top: Math.max(0, r.bottom), left: 0 } : { top: 0, left: Math.max(0, r.right) };
      setArea(prev => (prev.top === next.top && prev.left === next.left ? prev : next));
    };
    const sized = new ResizeObserver(measure);
    const follow = () => {
      const found = document.querySelector('[data-ivoryos-nav-bar]');
      if (found === nav) return;
      if (nav) sized.unobserve(nav);
      nav = found;
      if (nav) sized.observe(nav);
      measure();
    };
    const changed = new MutationObserver(follow);
    changed.observe(document.body, { childList: true, subtree: true });
    const frame = requestAnimationFrame(follow);
    window.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(frame); changed.disconnect(); sized.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  return area;
}
