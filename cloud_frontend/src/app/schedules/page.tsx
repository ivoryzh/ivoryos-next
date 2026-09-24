"use client";

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Pause, Play, Trash2, RefreshCw } from 'lucide-react';
import { confirmDialog } from '@ivoryos/shared-ui';

/**
 * Standing triggers: what is set to run on its own, when it next fires, and how it is going.
 *
 * One line per schedule with the detail on hover, rather than a card per schedule — a lab with a
 * handful of standing experiments wants to see all of them at once and check that nothing has
 * quietly stopped firing, which is exactly what a wall of cards makes hard.
 */

interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  triggerType: string;
  everyMs: number;
  maxRuns: number;
  runsFired: number;
  nextFireAt: string | null;
  lastFireAt: string | null;
  lastRunId: string | null;
  stepCount: number;
}

const formatInterval = (ms: number) => {
  if (!ms) return 'once';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `every ${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `every ${hours} h` : `every ${(hours).toFixed(1)} h`;
};

/** "in 4 min" / "3 min ago" — an absolute timestamp answers the wrong question for a cadence. */
function relative(iso: string | null): string {
  if (!iso) return '—';
  const delta = Date.parse(iso) - Date.now();
  if (Number.isNaN(delta)) return '—';
  const minutes = Math.round(Math.abs(delta) / 60_000);
  const size = minutes < 1 ? 'under a minute' : minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
  return delta >= 0 ? `in ${size}` : `${size} ago`;
}

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/schedules');
      setSchedules(await res.json());
      setError('');
    } catch {
      setError('Cannot reach the Cloud app.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    // Firing is the daemon's job, so this page only ever reports. A slow poll is enough: the
    // smallest cadence it can show is a minute.
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  const setEnabled = async (id: string, enabled: boolean) => {
    await fetch(`/api/schedules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    load();
  };

  const remove = async (schedule: Schedule) => {
    // Not window.confirm: it returns false without showing anything in the desktop app's webview
    // (AGENTS.md section 13), which made this button silently do nothing.
    const ok = await confirmDialog('Runs it already started are kept.', {
      title: `Delete "${schedule.name}"?`, confirmLabel: 'Delete', tone: 'danger',
    });
    if (!ok) return;
    await fetch(`/api/schedules/${encodeURIComponent(schedule.id)}`, { method: 'DELETE' });
    load();
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <header className="glass-header flex shrink-0 items-center justify-between px-6">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5" />
          <h1 className="text-lg font-semibold">Schedules</h1>
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {schedules.length} standing trigger{schedules.length === 1 ? '' : 's'}
          </span>
        </div>
        <button
          onClick={load}
          title="Refresh"
          className="rounded p-1.5 hover-bg"
          style={{ color: 'var(--text-secondary)' }}
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {error && <p className="mb-3 text-sm text-red-500">{error}</p>}

        {loaded && schedules.length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm" style={{ borderColor: 'var(--panel-border)', color: 'var(--text-secondary)' }}>
            <p className="font-medium">Nothing is scheduled.</p>
            <p className="mt-1">
              Configure a run on the Orchestrator, then choose <strong>Schedule…</strong> instead of Run.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--panel-border)' }}>
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                  <th className="p-3">Name</th>
                  <th className="p-3">Cadence</th>
                  <th className="p-3">Next</th>
                  <th className="p-3">Fired</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id} className="border-t" style={{ borderColor: 'var(--panel-border)' }}>
                    <td className="p-3">
                      <div className="font-medium">{s.name}</div>
                      <div className="text-xs" style={{ color: 'var(--text-secondary)' }} title={s.id}>
                        {s.stepCount} step{s.stepCount === 1 ? '' : 's'}
                        {s.lastRunId ? ` · last run ${s.lastRunId}` : ''}
                      </div>
                    </td>
                    <td className="p-3">{formatInterval(s.everyMs)}</td>
                    <td className="p-3" title={s.nextFireAt || 'not scheduled'}>
                      {s.enabled ? relative(s.nextFireAt) : <span style={{ color: 'var(--text-secondary)' }}>paused</span>}
                    </td>
                    <td className="p-3" title={s.lastFireAt ? `last fired ${relative(s.lastFireAt)}` : 'never fired'}>
                      {s.runsFired}{s.maxRuns ? ` / ${s.maxRuns}` : ''}
                    </td>
                    <td className="p-3">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => setEnabled(s.id, !s.enabled)}
                          title={s.enabled ? 'Pause' : 'Resume (next firing is one interval from now)'}
                          className="rounded p-1.5 hover-bg"
                        >
                          {s.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                        </button>
                        <button
                          onClick={() => remove(s)}
                          title="Delete this trigger"
                          className="rounded p-1.5 text-red-500 hover-bg"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
