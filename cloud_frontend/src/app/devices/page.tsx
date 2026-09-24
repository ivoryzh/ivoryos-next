"use client";

import { useCallback, useEffect, useState } from 'react';
import { Server, RefreshCw, AlertTriangle, CalendarClock, Table2 } from 'lucide-react';

/**
 * Every paired device at a glance: up or down, busy or free, what it is running for Cloud and how
 * far along, what Cloud is holding for it, and what it last sent back. Built entirely from what
 * devices already report (/api/device-overview); nothing here asks a device anything.
 */

type Overview = {
  id: string;
  name: string;
  status: string;
  busy: boolean;
  lastSeen: string | null;
  deckVersion: number | null;
  instruments: number;
  optimizers: number;
  workflows: number;
  brokenWorkflows: number;
  current: { runId: string; nodeId: string; runName: string; status: string; progress: any } | null;
  waiting: number;
  lastResult: { runId: string; nodeId: string; name: string; status: string; at: string } | null;
  nextSchedule: { name: string; at: string } | null;
};

function ago(iso: string | null) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(s)) return '—';
  if (s < 60) return `${Math.max(s, 0)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
}

const edgeTime = (v?: string | null) => {
  if (!v) return NaN;
  return Date.parse(/([zZ]|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}Z`);
};

export default function DevicesPage() {
  const [devices, setDevices] = useState<Overview[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/device-overview');
      const data = await res.json();
      setDevices(Array.isArray(data) ? data : []);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <header className="glass-header flex shrink-0 items-center justify-between px-6">
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5" />
          <h1 className="text-lg font-semibold">Devices</h1>
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {devices.filter((d) => d.status === 'online').length} of {devices.length} online
          </span>
        </div>
        <button onClick={load} title="Refresh" className="rounded p-1.5 hover-bg" style={{ color: 'var(--text-secondary)' }}>
          <RefreshCw className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {loaded && devices.length === 0 && (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm" style={{ borderColor: 'var(--panel-border)', color: 'var(--text-secondary)' }}>
            No devices yet. Pair one from Cloud Settings.
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
          {devices.map((d) => {
            const online = d.status === 'online';
            const pr = d.current?.progress;
            const pct = pr?.total ? Math.round((pr.done / pr.total) * 100) : 0;
            return (
              <div key={d.id} className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'var(--panel-border)', background: 'var(--panel-bg, transparent)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${!online ? 'bg-gray-400' : d.busy ? 'bg-amber-400' : 'bg-green-500'}`} />
                      <h2 className="text-base font-bold truncate">{d.name}</h2>
                    </div>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {!online ? `offline · last seen ${ago(d.lastSeen)}` : d.busy ? 'busy' : 'idle'}
                      {d.deckVersion ? ` · deck v${d.deckVersion}` : ''}
                    </p>
                  </div>
                  <div className="text-right text-xs shrink-0" style={{ color: 'var(--text-secondary)' }}>
                    <div>{d.instruments} instruments</div>
                    <div>
                      {d.workflows} workflows
                      {d.brokenWorkflows > 0 && (
                        <span className="ml-1 inline-flex items-center gap-0.5 text-red-500" title="Won't run on the current deck">
                          <AlertTriangle className="h-3 w-3" />{d.brokenWorkflows}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {d.current ? (
                  <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--panel-border)' }}>
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="font-semibold truncate">{d.current.runName}</span>
                      <span className="shrink-0 text-xs font-bold tabular-nums">{pr ? `${pr.done}/${pr.total}` : d.current.status}</span>
                    </div>
                    {pr && (
                      <>
                        <div className="mt-1.5 h-1.5 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
                          <div className={`h-full ${pr.state === 'waiting_input' || pr.state === 'paused' ? 'bg-amber-400' : pr.state === 'error' ? 'bg-red-500' : 'bg-yellow-400'}`} style={{ width: `${pct}%` }} />
                        </div>
                        <p className="mt-1 text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>
                          {[
                            pr.budget ? `iteration ${pr.iteration}/${pr.budget}` : pr.rows_total ? `sample ${Math.min(pr.rows_done + 1, pr.rows_total)}/${pr.rows_total}` : '',
                            pr.state === 'waiting_input' ? 'waiting for input' : pr.state === 'paused' ? 'paused' : pr.step ? String(pr.step).replace(/_/g, ' ') : '',
                          ].filter(Boolean).join(' · ')}
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {d.busy ? 'Running something started at the bench.' : 'No Cloud task running.'}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <span title="Held in Cloud until this device is free">{d.waiting} waiting in Cloud</span>
                  {d.nextSchedule && (
                    <span className="inline-flex items-center gap-1" title={d.nextSchedule.at}>
                      <CalendarClock className="h-3 w-3" />
                      {d.nextSchedule.name} at {new Date(d.nextSchedule.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  {d.lastResult && (
                    <a
                      href={`/results?runId=${encodeURIComponent(d.lastResult.runId)}&nodeId=${encodeURIComponent(d.lastResult.nodeId)}`}
                      className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 hover:underline"
                      title={`Last result: ${d.lastResult.name} (${d.lastResult.status})`}
                    >
                      <Table2 className="h-3 w-3" />
                      last result {Number.isNaN(edgeTime(d.lastResult.at)) ? '' : ago(new Date(edgeTime(d.lastResult.at)).toISOString())}
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
