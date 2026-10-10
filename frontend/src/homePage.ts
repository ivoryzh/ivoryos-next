/**
 * The Home page is hidden for now (2026-10). It is a dashboard of what is plugged in, what is
 * running or queued, what is saved and what ran recently (app/page.tsx), and it did not help much:
 * each card repeats a page that acts on the same thing (Instruments, the queue, Library, Data).
 * Its code is kept. While hidden it has no nav entry, and `/`, which is where a deck opens in the
 * desktop app and in a browser, goes to LANDING_PAGE instead. Set HOME_PAGE_SHOWN to true to bring
 * it back.
 */
export const HOME_PAGE_SHOWN = false;

/** Where `/` goes while the Home page is hidden. */
export const LANDING_PAGE = '/designer';

/** Where "home" (the brand mark) points. */
export const HOME_HREF = HOME_PAGE_SHOWN ? '/' : LANDING_PAGE;
