import { API_BASE } from '@/config';
import { confirmDialog, notify } from '@ivoryos/shared-ui';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Restart the edge server and reload this page once it is back.
 *
 * The server serves this page, so the request is the last thing it answers: it restarts a moment
 * later (itself, or via the desktop app -- see /api/system/restart), and the page waits for
 * /api/status to answer again. A restart reloads the deck file and retries every instrument that
 * failed to load, which is the point of offering it here.
 *
 * Returns false if nothing was restarted (declined, or refused by the server).
 */
export async function restartEdge(): Promise<boolean> {
  let res = await fetch(`${API_BASE}/api/system/restart`, { method: 'POST' });
  if (res.status === 409) {
    const ok = await confirmDialog(
      'A run is in progress. Restarting now stops it mid-step, on real hardware.',
      { title: 'Restart anyway?', confirmLabel: 'Stop the run and restart', tone: 'danger' },
    );
    if (!ok) return false;
    res = await fetch(`${API_BASE}/api/system/restart?force=true`, { method: 'POST' });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await notify(body.error || `The server refused to restart (${res.status}).`, { title: 'Restart failed', tone: 'error' });
    return false;
  }

  // Give the old process time to go away before polling, or the first answer comes from it.
  await sleep(1500);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const status = await fetch(`${API_BASE}/api/status`, { cache: 'no-store' });
      if (status.ok) {
        window.location.reload();
        return true;
      }
    } catch { /* still restarting */ }
    await sleep(700);
  }
  await notify('The edge server has not come back after 90 seconds. Check the terminal or the desktop app for its log.', {
    title: 'Still restarting', tone: 'error',
  });
  return false;
}
