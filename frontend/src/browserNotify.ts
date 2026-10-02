"use client";

/**
 * Browser notifications for an edge opened in a plain browser (RunNotifier). Inside the desktop
 * app the app sends system notifications itself (desktop/src/attention.js), so these stay off there.
 *
 * Asking is the browser's own prompt, which a browser only shows after a click; "Not now" is
 * remembered so the card does not come back on every run, and Settings can still turn it on.
 */

const DECLINED_KEY = 'ivoryos_notify_declined';

export type NotifyState = 'unsupported' | 'granted' | 'denied' | 'default';

export function notifyState(): NotifyState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission as NotifyState;
}

export function notifyDeclined(): boolean {
  try { return localStorage.getItem(DECLINED_KEY) === '1'; } catch { return false; }
}

export function declineNotify() {
  try { localStorage.setItem(DECLINED_KEY, '1'); } catch { /* not remembered */ }
}

/** Ask the browser (call from a click). Resolves to what the person chose. */
export async function askToNotify(): Promise<NotifyState> {
  if (notifyState() === 'unsupported') return 'unsupported';
  try { localStorage.removeItem(DECLINED_KEY); } catch { /* nothing stored */ }
  return (await Notification.requestPermission()) as NotifyState;
}
