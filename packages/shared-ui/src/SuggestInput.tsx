"use client";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type Suggestion = string | { value: string; label?: string };

/**
 * A text field with its own suggestion list, in place of `<input list>` + `<datalist>`.
 *
 * Native suggestion popups (a datalist, and the browser's own "values you typed here before") are
 * drawn by the browser shell, not the page, and inside the desktop app the page lives in a view
 * offset by the launcher's sidebar and tab bar: the popup was placed as if the page started at
 * the window's corner, so it opened over the toolbox instead of under the field. This list is
 * page content, portalled to <body> and pinned to the field with fixed coordinates, so it is
 * where the field is in every host, and it is styled like the rest of the app. The browser's
 * field history is switched off for the same reason (`autoComplete="off"`).
 *
 * Choosing a suggestion sets the value through the input's own setter and fires a real `input`
 * event, so the caller's `onChange` receives it exactly as if it had been typed.
 */
export const SuggestInput = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'list'> & {
  suggestions: Suggestion[];
  /**
   * `value` (default): suggestions complete the whole field. `word`: they complete the name being
   * typed at the end, for an expression such as an If condition (`yield_pct > 40`), where the
   * whole text never equals a variable.
   */
  mode?: 'value' | 'word';
}>(function SuggestInput({ suggestions, mode = 'value', onFocus, onBlur, onKeyDown, ...rest }, forwarded) {
  const own = useRef<HTMLInputElement | null>(null);
  const setRef = (el: HTMLInputElement | null) => {
    own.current = el;
    if (typeof forwarded === 'function') forwarded(el);
    else if (forwarded) forwarded.current = el;
  };
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  const items = useMemo(() => suggestions.map(s => (typeof s === 'string' ? { value: s } : s)), [suggestions]);
  const raw = String(rest.value ?? '');
  const fragment = mode === 'word' ? (raw.match(/[A-Za-z_]\w*$/)?.[0] ?? '') : raw.trim();
  const typed = fragment.toLowerCase();
  // An exact match shows every choice, so a field already holding one can still be switched,
  // the way a select would; otherwise only what contains the typed text. In word mode a finished
  // name needs nothing more.
  const exact = items.some(i => i.value.toLowerCase() === typed);
  const shown = !typed ? items
    : exact ? (mode === 'word' ? [] : items)
      : items.filter(i => i.value.toLowerCase().includes(typed));

  const place = () => {
    const r = own.current?.getBoundingClientRect();
    if (r) setBox({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 160) });
  };
  useLayoutEffect(() => { if (open) place(); }, [open, typed]);
  useEffect(() => {
    if (!open) return;
    // Follow the field while anything under it scrolls or the window resizes.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);
  useEffect(() => { setActive(-1); }, [typed]);

  const pick = (value: string) => {
    const el = own.current;
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, mode === 'word' ? raw.slice(0, raw.length - fragment.length) + value : value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setOpen(false);
  };

  const visible = open && shown.length > 0 && box;
  return (
    <>
      <input
        ref={setRef}
        {...rest}
        autoComplete="off"
        aria-autocomplete={items.length ? 'list' : undefined}
        aria-expanded={items.length ? !!visible : undefined}
        onFocus={(e) => { if (items.length) setOpen(true); onFocus?.(e); }}
        onBlur={(e) => { setOpen(false); onBlur?.(e); }}
        onInput={() => { if (items.length) setOpen(true); }}
        onKeyDown={(e) => {
          if (visible) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(shown.length - 1, a + 1)); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); return; }
            if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(shown[active].value); return; }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
          } else if (e.key === 'ArrowDown' && items.length) {
            e.preventDefault(); setOpen(true); return;
          }
          onKeyDown?.(e);
        }}
      />
      {visible && typeof document !== 'undefined' && createPortal(
        <div
          role="listbox"
          data-ivoryos-popover
          // Keep focus in the field: a click here must not blur it before the choice lands.
          onMouseDown={(e) => e.preventDefault()}
          style={{ position: 'fixed', top: box!.top, left: box!.left, minWidth: box!.width }}
          className="z-[80] max-w-[22rem] max-h-56 overflow-y-auto py-1 rounded-lg text-[12px] shadow-xl bg-white text-gray-800 border border-gray-200 dark:bg-[#1c1c1f] dark:text-gray-100 dark:border-white/10"
        >
          {shown.map((s, i) => (
            <button
              key={s.value}
              type="button"
              role="option"
              aria-selected={i === active}
              onClick={() => pick(s.value)}
              onMouseEnter={() => setActive(i)}
              className={`w-full flex items-baseline gap-3 px-2.5 py-1 text-left ${i === active ? 'bg-accent-soft text-accent-fg' : ''}`}
            >
              <span className={`font-mono truncate ${s.value.startsWith('#') ? 'font-semibold' : ''}`}>{s.value}</span>
              {s.label && <span className="ml-auto shrink-0 text-[11px] text-gray-400 dark:text-gray-500">{s.label}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
});
