"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, Table2, AlertTriangle } from 'lucide-react';
import { formatRun, datasheetCsv, RunDataTable, SectionTitle, cellText, parseServerTime } from '@ivoryos/shared-ui';

/**
 * One record per experiment. A Cloud run is a whole experiment however many devices it spans, so
 * its tasks are shown together: a timeline with one lane per device (steps on the same device
 * share a lane, and lanes share one clock, so overlap between devices is visible), then each
 * step's datasheet, then how each step went.
 *
 * Each device's record is read with the same `formatRun` the edge's Data History uses, so a
 * step's sheet here is the sheet at the bench. Sheets are kept per step by default: two steps'
 * rows are different samples unless the experiment says otherwise, so joining them is opt-in.
 */

type ExperimentSummary = {
  runId: string;
  name: string;
  devices: string[];
  tasks: number;
  status: string;
  updatedAt: string;
};

type TaskRecord = {
  nodeId: string;
  label: string;
  deviceId: string;
  status: string;
  dispatchedAt: string | null;
  updatedAt: string | null;
  result: any | null;
};

const tone = (s?: string | null) =>
  s === 'completed' ? 'text-green-600 dark:text-green-400'
    : s === 'error' ? 'text-red-600 dark:text-red-400'
      : 'text-gray-500';

// Edge times are naive UTC; Cloud's carry a Z. One parser for both (shared-ui serverTime).
const toMs = parseServerTime;

const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`);

/** How many times a step ran its workflow: samples, trials or iterations. */
const timesOf = (sheet: any) => (sheet?.rows?.length || 1);

const download = (csv: string, name: string) => {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export default function ResultsPage() {
  const [list, setList] = useState<ExperimentSummary[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const [record, setRecord] = useState<{ run: any; tasks: TaskRecord[] } | null>(null);
  const [combine, setCombine] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadList = useCallback(async () => {
    try {
      const rows = await (await fetch('/api/results')).json();
      setList(Array.isArray(rows) ? rows : []);
    } catch {
      setError('Cannot reach the Cloud app.');
    }
  }, []);

  useEffect(() => {
    // Read after hydration (AGENTS.md section 11). The canvas links here with ?runId=&nodeId=.
    const q = new URLSearchParams(window.location.search);
    if (q.get('runId')) setRunId(q.get('runId'));
    if (q.get('nodeId')) setFocusNode(q.get('nodeId'));
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (!runId && list.length) setRunId(list[0].runId);
  }, [list, runId]);

  useEffect(() => {
    if (!runId) return;
    setRecord(null);
    window.history.replaceState(null, '', `/results?runId=${encodeURIComponent(runId)}`);
    fetch(`/api/results?runId=${encodeURIComponent(runId)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load this experiment');
        setRecord(data);
        setError('');
      })
      .catch((e) => setError(e.message));
  }, [runId]);

  // Jump to the step the canvas linked to, once it has rendered.
  useEffect(() => {
    if (!record || !focusNode) return;
    document.getElementById(`data-${focusNode}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [record, focusNode]);

  const tasks = record?.tasks || [];
  const withResults = tasks.filter((t) => t.result);
  const sheets = useMemo(
    () => withResults.map((t) => ({ task: t, run: formatRun({ id: t.result.edgeRunId, ...t.result }) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [record],
  );

  // --- timeline geometry: one clock for every lane ---
  const spans = tasks.map((t) => {
    const start = toMs(t.result?.start_time) || toMs(t.dispatchedAt);
    const end = toMs(t.result?.end_time) || (t.status === 'running' || t.status === 'queued' ? Date.now() : toMs(t.updatedAt));
    return { task: t, start, end };
  }).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start);
  const t0 = spans.length ? Math.min(...spans.map((s) => s.start)) : 0;
  const t1 = spans.length ? Math.max(...spans.map((s) => s.end)) : 0;
  const total = Math.max(1, t1 - t0);
  const lanes = [...new Set(tasks.map((t) => t.deviceId))];
  const pos = (ms: number) => `${((ms - t0) / total) * 100}%`;
  const hoveredSpan = spans.find((s) => s.task.nodeId === hovered);

  // --- combined sheet (opt-in): each step's columns side by side, rows by position ---
  const combined = useMemo(() => {
    const variables = sheets.flatMap(({ task, run }) => run.variables.map((v) => `${task.label}.${v}`));
    const n = Math.max(0, ...sheets.map(({ run }) => run.rows.length));
    const rows = Array.from({ length: n }, (_, i) => ({
      row: i + 1,
      status: sheets.some(({ run }) => run.rows[i]?.status === 'error') ? 'error' : 'completed',
      values: sheets.flatMap(({ run }) => run.variables.map((_, j) => run.rows[i]?.values?.[j])),
    }));
    return { variables, rows };
  }, [sheets]);

  const status = record ? (tasks.some((t) => t.status === 'error') ? 'error' : record.run.status) : '';

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <header className="glass-header flex shrink-0 items-center justify-between px-6">
        <div className="flex items-center gap-2">
          <Table2 className="h-5 w-5" />
          <h1 className="text-lg font-semibold">Results</h1>
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>one record per experiment</span>
        </div>
        <button onClick={loadList} title="Refresh" className="rounded p-1.5 hover-bg" style={{ color: 'var(--text-secondary)' }}>
          <RefreshCw className="h-4 w-4" />
        </button>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside className="w-[300px] shrink-0 overflow-y-auto border-r p-3 space-y-1" style={{ borderColor: 'var(--panel-border)' }}>
          {list.length === 0 && (
            <p className="p-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
              Nothing yet. A device sends its data back when a step Cloud dispatched finishes.
            </p>
          )}
          {list.map((e) => {
            const on = runId === e.runId;
            return (
              <button
                key={e.runId}
                onClick={() => { setRunId(e.runId); setFocusNode(null); }}
                className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${on ? 'border-indigo-300 bg-indigo-50/60 dark:border-indigo-500/40 dark:bg-indigo-500/10' : 'hover-bg'}`}
                style={on ? undefined : { borderColor: 'var(--panel-border)' }}
              >
                <div className="text-sm font-semibold truncate" title={e.name}>{e.name}</div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                  <span className="truncate">{e.devices.join(', ')} · {e.tasks} step{e.tasks === 1 ? '' : 's'}</span>
                  <span className={`shrink-0 font-semibold ${tone(e.status)}`}>{e.status}</span>
                </div>
              </button>
            );
          })}
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto p-6">
          {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
          {record && (
            <div className="max-w-5xl mx-auto space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-xl font-bold break-words">{record.run.name}</h2>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                    {tasks.length} step{tasks.length === 1 ? '' : 's'} on {lanes.length} device{lanes.length === 1 ? '' : 's'}
                    {spans.length ? ` · ${new Date(t0).toLocaleString()} · ${seconds(total)}` : ''}
                  </p>
                </div>
                <span className={`shrink-0 text-sm font-bold ${tone(status)}`}>{status}</span>
              </div>

              {/* timeline: a lane per device, all on one clock */}
              {spans.length > 0 && (
                <section>
                  <SectionTitle
                    aside={
                      <span className="text-[11px] font-mono truncate" style={{ color: 'var(--text-secondary)' }}>
                        {hoveredSpan
                          ? `${hoveredSpan.task.label}${timesOf(sheets.find((x) => x.task.nodeId === hoveredSpan.task.nodeId)?.run) > 1 ? ` ×${timesOf(sheets.find((x) => x.task.nodeId === hoveredSpan.task.nodeId)?.run)}` : ''} · ${hoveredSpan.task.deviceId} · ${seconds(hoveredSpan.end - hoveredSpan.start)} · +${seconds(hoveredSpan.start - t0)}`
                          : 'hover a step'}
                      </span>
                    }
                  >
                    timeline
                  </SectionTitle>
                  {/* Scrolls sideways below a floor rather than squeezing the lanes. */}
                  <div className="overflow-x-auto">
                  <div className="min-w-[560px] rounded-xl border p-3 space-y-2" style={{ borderColor: 'var(--panel-border)' }}>
                    {lanes.map((device) => (
                      <div key={device} className="flex items-center gap-3">
                        <span className="w-28 shrink-0 truncate text-xs font-semibold" title={device}>{device}</span>
                        <div className="relative h-8 flex-1 rounded-md bg-gray-100/70 dark:bg-white/5">
                          {[25, 50, 75].map((p) => (
                            <span key={p} className="absolute top-0 bottom-0 w-px bg-gray-200 dark:bg-white/10" style={{ left: `${p}%` }} />
                          ))}
                          {spans.filter((s) => s.task.deviceId === device).map((s) => {
                            const times = timesOf(sheets.find((x) => x.task.nodeId === s.task.nodeId)?.run);
                            const color = s.task.status === 'error' ? 'bg-red-500' : s.task.status === 'completed' ? 'bg-indigo-500' : 'bg-yellow-400';
                            return (
                              <button
                                key={s.task.nodeId}
                                onMouseEnter={() => setHovered(s.task.nodeId)}
                                onMouseLeave={() => setHovered(null)}
                                onClick={() => document.getElementById(`data-${s.task.nodeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                                className={`absolute top-1 bottom-1 min-w-[3px] overflow-hidden rounded ${color} ${hovered === s.task.nodeId ? 'ring-2 ring-offset-1 ring-indigo-300' : ''}`}
                                style={{ left: pos(s.start), width: `${Math.max(((s.end - s.start) / total) * 100, 0.4)}%` }}
                              >
                                {/* One bar per step execution: which step, when, how many times.
                                    What happened inside is the device's Data History's job. */}
                                <span className="relative px-1.5 text-[11px] font-semibold text-white truncate block leading-6">
                                  {s.task.label}{times > 1 ? ` ×${times}` : ''}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <div className="flex justify-between pl-[124px] text-[10px] font-mono" style={{ color: 'var(--text-secondary)' }}>
                      <span>{new Date(t0).toLocaleTimeString()}</span>
                      <span>{seconds(total)}</span>
                      <span>{new Date(t1).toLocaleTimeString()}</span>
                    </div>
                  </div>
                  </div>
                  {lanes.length > 1 && (
                    <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                      Times are each device&apos;s own clock; devices whose clocks disagree will look shifted.
                    </p>
                  )}
                </section>
              )}

              {/* data */}
              <section>
                <SectionTitle
                  aside={sheets.length > 1 ? (
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none" style={{ color: 'var(--text-secondary)' }}>
                      <input type="checkbox" checked={combine} onChange={(e) => setCombine(e.target.checked)} />
                      combine into one sheet (rows by position)
                    </label>
                  ) : undefined}
                >
                  data
                </SectionTitle>
                {sheets.length === 0 && (
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>No device has sent data for this experiment yet.</p>
                )}
                {combine && sheets.length > 1 ? (
                  <div className="space-y-1.5">
                    <div className="flex justify-end">
                      <button
                        onClick={() => download(datasheetCsv(combined), `ivoryos_${record.run.id}.csv`)}
                        className="flex items-center gap-1 text-xs hover:underline" style={{ color: 'var(--text-secondary)' }}
                      >
                        <Download className="h-3.5 w-3.5" /> export
                      </button>
                    </div>
                    <RunDataTable run={combined} title="" maxHeight="60vh" />
                  </div>
                ) : (
                  <div className="space-y-4">
                    {sheets.map(({ task, run }) => (
                      <div key={task.nodeId} id={`data-${task.nodeId}`} className="scroll-mt-4">
                        <div className="flex items-baseline justify-between gap-3 mb-1">
                          <span className={`text-sm font-semibold ${focusNode === task.nodeId ? 'text-indigo-600 dark:text-indigo-400' : ''}`}>
                            {task.label} <span className="font-normal text-xs" style={{ color: 'var(--text-secondary)' }}>· {task.deviceId} · edge run #{task.result.edgeRunId}</span>
                          </span>
                          {run.variables.length > 0 && (
                            <button
                              onClick={() => download(datasheetCsv(run), `ivoryos_${task.deviceId}_run${task.result.edgeRunId}.csv`)}
                              className="flex items-center gap-1 text-xs hover:underline" style={{ color: 'var(--text-secondary)' }}
                            >
                              <Download className="h-3.5 w-3.5" /> export
                            </button>
                          )}
                        </div>
                        {run.variables.length > 0 ? (
                          <RunDataTable run={run} title="" maxHeight="40vh" />
                        ) : (
                          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                            Saved no named values. Give a step a “save output” name to see it here.
                          </p>
                        )}
                        {task.result.truncated && (
                          <p className="mt-1 text-xs text-amber-600">
                            Too large to send in full; the complete record is on {task.deviceId}, run #{task.result.edgeRunId}.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* steps */}
              <section>
                <SectionTitle>steps</SectionTitle>
                <div className="rounded-xl border divide-y" style={{ borderColor: 'var(--panel-border)' }}>
                  {tasks.map((t) => {
                    const steps: any[] = t.result?.steps || [];
                    const sheet = sheets.find((s) => s.task.nodeId === t.nodeId)?.run;
                    const failed = steps.filter((s) => s.status === 'error');
                    const span = spans.find((s) => s.task.nodeId === t.nodeId);
                    return (
                      <div key={t.nodeId} className="px-3 py-2 text-xs" style={{ borderColor: 'var(--panel-border)' }}>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="font-semibold text-sm">{t.label}</span>
                          <span style={{ color: 'var(--text-secondary)' }}>{t.deviceId}</span>
                          <span className={`font-semibold ${tone(t.status)}`}>{t.status}</span>
                          {sheet && sheet.rows.length > 1 && (
                            <span className="font-semibold" title={`${sheet.rows.filter((r) => r.status === 'completed').length} of ${sheet.rows.length} completed`}>
                              ×{sheet.rows.length}
                            </span>
                          )}
                          {steps.length > 0 && (
                            <span style={{ color: 'var(--text-secondary)' }}>
                              {steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length}/{steps.length} calls
                            </span>
                          )}
                          {span && <span className="ml-auto font-mono" style={{ color: 'var(--text-secondary)' }}>{seconds(span.end - span.start)}</span>}
                        </div>
                        {failed.map((s) => (
                          <div key={s.id} className="mt-1.5 flex items-start gap-1.5 text-red-600 dark:text-red-400">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            <span className="min-w-0 break-words">
                              <span className="font-semibold">
                                {s.instrument}.{s.method}{typeof s.parameters?._row === 'number' ? ` (row ${s.parameters._row + 1})` : ''}:
                              </span>{' '}
                              {cellText(s.error) || 'failed'}
                            </span>
                          </div>
                        ))}
                        {!t.result && (
                          <p className="mt-1" style={{ color: 'var(--text-secondary)' }}>
                            {['completed', 'error'].includes(t.status) ? 'Finished before its device could send results.' : 'No results yet.'}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
