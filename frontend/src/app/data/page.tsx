"use client";
import { API_BASE, WS_BASE } from '@/config';

import React, { useState, useEffect, useRef } from 'react';
import { Table2, Download, Trash2, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import {
  ResultView, RunDataTable, readNamedOutput, SectionTitle, parseServerTime, serverDate, formatRun, datasheetCsv, cellText, isFlowStep, aggregateStatus, toDetail, phaseOf, issuesLabel, failedThenSkipped, useDocumentTheme, confirmDialog, notify } from '@ivoryos/shared-ui';

// Every step's outputs get wrapped as {"result": <value>} regardless of what the method actually
// returned, so unwrap that one key before handing the value to ResultView — otherwise every result
// renders under a pointless "Result" heading.
const stepResultValue = (outputs: unknown): unknown => {
  if (outputs === null || outputs === undefined) return outputs;
  if (typeof outputs === 'object' && !Array.isArray(outputs)) {
    // `attempts` is the step's record of failures before it succeeded (shown on the row, see
    // StepList), not part of what it returned.
    const { attempts: _attempts, ...rest } = outputs as Record<string, unknown>;
    const keys = Object.keys(rest);
    if (keys.length === 0) return undefined;
    if (keys.length === 1 && keys[0] === 'result') return rest.result;
    return rest;
  }
  return outputs;
};

// The optimizer backends return each plot as a Plotly HTML fragment generated with
// include_plotlyjs=False, so it needs its own Plotly.js and its own document to run in —
// an iframe srcDoc executes <script> tags normally, unlike dangerouslySetInnerHTML in the main page.
const PlotFrame = ({ html }: { html: string }) => {
  const doc = `<!doctype html><html><head><meta charset="utf-8"/><script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script><style>body{margin:0;font-family:sans-serif;}</style></head><body>${html}</body></html>`;
  return (
    <iframe
      srcDoc={doc}
      sandbox="allow-scripts"
      className="w-full h-[420px] border border-gray-100 dark:border-white/5 rounded-lg bg-white"
    />
  );
};

// A horizontal, time-scaled bar per logged step (Sequence steps, or every row's flattened
// details for Spreadsheet/Optimization runs) so it's obvious at a glance which steps dominated
// the run's wall-clock time and where errors landed, instead of only reading it out of a list.
const STATUS_BAR_COLOR: Record<string, string> = {
  completed: 'bg-green-500',
  error: 'bg-red-500',
  running: 'bg-accent animate-pulse',
};

type TimelineStep = {
  instrument?: string;
  method?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  /**
   * Which trial/row this step belonged to, for runs that repeat the same sequence -- or 'prep' /
   * 'cleanup' for the steps that ran once around them.
   */
  iteration?: BandKey;
  /** The spreadsheet row, when bands are batches: rows in a batch interleave, so the step's own
   *  row is what tells two `pump.dispense` bars apart. */
  row?: number;
};

type BandKey = number | 'prep' | 'cleanup';

const secondsBetween = (a?: string, b?: string) => {
  if (!a || !b) return '';
  const ms = parseServerTime(b) - parseServerTime(a);
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s` : '';
};

// 'not_run' (and a step 'skipped' with no error of its own): the run ended before it, after a
// graceful stop. A hollow grey ring, so it reads as "never happened" rather than as pending or done.
// 'failed' (and a step 'skipped' that carries an error): it failed and a person skipped it. Amber,
// like a run that completed with issues: the run went on, but this is not a result.
const StatusDot = ({ status, error }: { status?: string; error?: string }) => {
  const notRun = status === 'not_run' || (status === 'skipped' && !error);
  const failed = status === 'failed' || (status === 'skipped' && !!error);
  return (
    <span
      title={notRun ? 'not run: the run stopped before it' : failed ? 'failed, and skipped' : status}
      className={`w-2 h-2 rounded-full shrink-0 ${notRun ? 'border border-gray-400 dark:border-gray-500'
        : failed ? 'bg-amber-500'
        : status === 'completed' ? 'bg-green-500'
        : status === 'error' ? 'bg-red-500'
          : status === 'running' || status === 'waiting_input' ? 'bg-accent animate-pulse'
            : 'bg-gray-300 dark:bg-gray-600'}`}
    />
  );
};

type ArgItem = { key: string; value: unknown; text: string; source?: string };

/**
 * A step's arguments as passed (bookkeeping keys like `_row`/`_phase` dropped), each marked with
 * where it came from when it was a `#name`: runs record that as `_vars` (see `dynamicArgumentsOf`
 * in shared-ui), and a value still reading `#name` was resolved on the edge from an earlier
 * step's output. Runs submitted before `_vars` existed simply show no marks.
 */
const argumentsOf = (step: any): ArgItem[] => {
  const params: Record<string, any> = step.params || {};
  const vars: Record<string, string> = params._vars || {};
  return Object.entries(params)
    .filter(([k]) => !k.startsWith('_'))
    .map(([key, value]) => {
      const text = cellText(value);
      const ref = typeof value === 'string' ? /^#(\w+)$/.exec(value.trim())?.[1] : undefined;
      return { key, value, text, source: vars[key] ?? ref };
    });
};

/** The outputs this step was told to save (its return bindings / return var), with their values. */
const savedOutputsOf = (step: any): { name: string; value: unknown }[] => {
  const params: Record<string, any> = step.params || {};
  const bindings: any[] = params._return_bindings || [];
  const names: string[] = bindings.length
    ? bindings.map(b => b?.var).filter(Boolean)
    : String(params._return_var || '').split(',').map(v => v.trim()).filter(Boolean);
  if (names.length === 0) return [];
  const template = [{ instrument: step.instrument, method: step.method, returnVar: params._return_var || null, returnBindings: bindings.length ? bindings : null }];
  return names.map(name => ({ name, value: readNamedOutput(name, template as any, [{ outputs: step.result }] as any) }));
};

/** Long values are cut in the one-line view; the expanded table has them whole. */
const clip = (text: string, max = 28) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * A flow-control step as a line of log. An If/While shows its condition, the values it read, and
 * the outcome -- every outcome, for a While -- which the edge records on the step
 * (`condition_record` in queue.py).
 */
const summarizeFlowStep = (step: any): { label: string; args: string; outcome: string } => {
  const params: Record<string, any> = step.params || {};
  const outputs: any = step.result || {};
  switch (step.method) {
    case 'If':
    case 'While': {
      const read = Object.entries(outputs.variables || {}).map(([k, v]) => `${k}=${cellText(v)}`).join(', ');
      const history: boolean[] = outputs.history || [];
      const outcome = step.method === 'While' && history.length > 1
        ? history.map(b => (b ? 'true' : 'false')).join(', ')
        : outputs.result === undefined ? '' : String(outputs.result);
      return { label: `${step.method} ${params.condition ?? ''}`.trim(), args: read, outcome };
    }
    case 'Sleep':
      return { label: 'Sleep', args: `${params.duration_seconds ?? ''}s`, outcome: '' };
    case 'Comment':
      // The interpolated message once it has run; the raw template (with its #names) otherwise.
      return outputs.message !== undefined
        ? { label: 'Comment', args: '', outcome: cellText(outputs.message) }
        : { label: 'Comment', args: cellText(params.message ?? ''), outcome: '' };
    case 'User_Input':
      // Without a name it was a pause: nothing was asked, someone pressed Continue.
      if (!String(params.variable_name || '').trim()) {
        return { label: 'Pause', args: cellText(params.prompt ?? ''), outcome: outputs.acknowledged ? 'continued' : '' };
      }
      return {
        label: 'User Input',
        args: String(params.variable_name || ''),
        outcome: outputs.result === undefined ? '' : cellText(outputs.result),
      };
    default:
      return { label: String(step.method).replace(/_/g, ' '), args: '', outcome: '' };
  }
};

const DYNAMIC = 'text-teal-600 dark:text-teal-400';

/** A step's full arguments and output, as tables. What a click on a log line opens. */
const StepDetail = ({ args, value }: { args: ArgItem[]; value: unknown }) => (
  <div className="space-y-2">
    {args.length > 0 && (
      <div>
        <div className="text-[10px] uppercase tracking-wider font-bold text-gray-400 mb-0.5">Arguments</div>
        <table className="w-full text-xs border-collapse">
          <tbody>
            {args.map(a => (
              <tr key={a.key} className="border-b last:border-b-0 border-gray-100 dark:border-white/5 align-top">
                <td className="py-1 pr-4 font-mono text-gray-500 dark:text-gray-400 whitespace-nowrap w-0">{a.key}</td>
                <td className={`py-1 font-mono break-words ${a.source ? DYNAMIC : 'text-gray-800 dark:text-gray-200'}`} style={{ overflowWrap: 'anywhere' }}>{a.text}</td>
                <td className="py-1 pl-4 text-[10px] whitespace-nowrap w-0 text-right">
                  {a.source && <span className={DYNAMIC}>from #{a.source}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
    {value !== undefined && value !== null && value !== '' && (
      <div>
        <div className="text-[10px] uppercase tracking-wider font-bold text-gray-400 mb-0.5">Output</div>
        <ResultView value={value} />
      </div>
    )}
  </div>
);

/**
 * Steps as log lines: what was called and with what. Arguments from a `#name` are coloured; the
 * output shows on the line only when the step saves it to a named variable, since that is the value
 * the run is about -- everything else is one click away, as tables.
 */
const StepList = ({ steps, start = 0 }: { steps: any[]; start?: number }) => {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="divide-y divide-gray-100 dark:divide-white/5 min-w-0">
      {steps.map((step: any, i: number) => {
        const isOpen = open === i;
        const flow = isFlowStep(step);
        const flowSummary = flow ? summarizeFlowStep(step) : null;
        const args = flow ? [] : argumentsOf(step);
        const saved = flow ? [] : savedOutputsOf(step);
        const value = flow ? undefined : stepResultValue(step.result);
        const hasValue = value !== undefined && value !== null && value !== '';
        const hasMore = !!step.error || (!flow && (args.length > 0 || hasValue));
        const label = flowSummary ? flowSummary.label : `${step.instrument}.${step.method}`;
        return (
          <div key={i} className={`min-w-0 ${step.status === 'skipped' && !step.error ? 'opacity-50' : ''}`}>
            <div
              onClick={() => hasMore && setOpen(isOpen ? null : i)}
              className={`flex items-center gap-2 px-3 py-1 text-xs font-mono min-w-0 ${hasMore ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-white/[0.03]' : ''}`}
            >
              <span className="w-6 text-right text-[10px] text-gray-400 shrink-0">{start + i + 1}</span>
              <StatusDot status={step.status} error={step.error} />
              <span className="text-gray-900 dark:text-white font-semibold truncate shrink-0 max-w-[40%]" title={label}>{label}</span>
              {flowSummary ? (
                <>
                  <span className="text-gray-500 dark:text-gray-400 truncate min-w-0 flex-1" title={flowSummary.args}>{flowSummary.args}</span>
                  {flowSummary.outcome !== '' && (
                    <span className="text-gray-800 dark:text-gray-200 truncate shrink-0 max-w-[35%]" title={flowSummary.outcome}>{flowSummary.outcome}</span>
                  )}
                </>
              ) : (
                <>
                  <span className="text-gray-500 dark:text-gray-400 truncate min-w-0 flex-1">
                    {args.map((a, n) => (
                      <span key={a.key} title={a.source ? `${a.key}=${a.text} (from #${a.source})` : `${a.key}=${a.text}`}>
                        {n > 0 && ', '}
                        {a.key}=<span className={a.source ? DYNAMIC : 'text-gray-600 dark:text-gray-300'}>{clip(a.text)}</span>
                      </span>
                    ))}
                  </span>
                  {saved.length > 0 && (
                    <span className="truncate shrink-0 max-w-[35%]" title={saved.map(o => `${o.name}=${cellText(o.value)}`).join(', ')}>
                      {saved.map((o, n) => (
                        <span key={o.name}>
                          {n > 0 && ', '}
                          <span className="text-amber-600 dark:text-amber-400">{o.name}</span>
                          <span className="text-gray-800 dark:text-gray-200">={clip(cellText(o.value), 16)}</span>
                        </span>
                      ))}
                    </span>
                  )}
                </>
              )}
              {hasMore && !step.error && (isOpen
                ? <ChevronUp className="w-3 h-3 text-gray-400 shrink-0" />
                : <ChevronDown className="w-3 h-3 text-gray-400 shrink-0" />)}
              {/* Failed attempts before this outcome: retried, skipped or stopped at. */}
              {(step.result?.attempts?.length || 0) > 0 && (
                <span
                  className="shrink-0 rounded px-1 text-[10px] font-sans font-semibold text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/10"
                  title={step.result.attempts.map((a: any, n: number) => `Attempt ${n + 1} failed${a.resolution ? ` (${a.resolution})` : ''}: ${a.error}`).join('\n')}
                >
                  failed ×{step.result.attempts.length}
                </span>
              )}
              <span className="text-[10px] text-gray-400 w-12 text-right shrink-0">{secondsBetween(step.start_time, step.end_time)}</span>
            </div>
            {step.error && (
              <pre
                onClick={() => setOpen(isOpen ? null : i)}
                className="ml-11 mr-3 mb-1 px-2 py-1 rounded text-[11px] whitespace-pre-wrap break-all cursor-pointer bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-400 max-h-48 overflow-auto"
                style={{ overflowWrap: 'anywhere' }}
              >
                {isOpen ? step.error : String(step.error).split('\n')[0]}
              </pre>
            )}
            {isOpen && !step.error && (
              <div className="ml-11 mr-3 mb-1.5 p-2 rounded border text-xs bg-gray-50 dark:bg-white/[0.02] border-gray-100 dark:border-white/5 text-gray-600 dark:text-gray-300 overflow-hidden">
                <StepDetail args={args} value={value} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * One collapsible line of a repeated run: a row or trial, or the Prep/Cleanup that ran once
 * around them. Prep and cleanup used to be folded into row 1 (the first row's slice of the flat
 * step list started with them), which is why they are groups of their own.
 */
const iterationLabelOf = (run: any) => (run.type === 'Optimization' ? 'Trial' : run.type === 'Spreadsheet' ? 'Row' : 'Run');

const LogGroup = ({ label, summary, steps, muted, defaultOpen }: {
  label: string; summary?: string; steps: any[]; muted?: boolean; defaultOpen?: boolean;
}) => {
  const [open, setOpen] = useState(!!defaultOpen);
  if (steps.length === 0) return null;
  const first = steps.find(s => s.start_time)?.start_time;
  const last = [...steps].reverse().find(s => s.end_time)?.end_time;
  const status = aggregateStatus(steps);
  // After a graceful stop: a sample, or the cleanup, that never ran.
  const notRun = status === 'not_run';
  return (
    <div className={`min-w-0 ${notRun ? 'opacity-60' : ''}`}>
      <div
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-3 px-3 py-1.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-white/[0.03] min-w-0 ${muted ? 'bg-gray-50/60 dark:bg-white/[0.02]' : ''}`}
      >
        <StatusDot status={status} />
        <span className={`text-xs font-semibold shrink-0 w-16 ${muted ? 'text-gray-500 dark:text-gray-400' : 'text-gray-700 dark:text-gray-200'}`}>{label}</span>
        <span className="text-[11px] font-mono text-gray-500 dark:text-gray-400 truncate min-w-0 flex-1" title={notRun ? 'The run stopped before this' : summary}>{notRun ? 'not run' : summary}</span>
        <span className="text-[10px] text-gray-400 shrink-0">
          {steps.length} step{steps.length === 1 ? '' : 's'}{first && last ? ` · ${secondsBetween(first, last)}` : ''}
        </span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-gray-400 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
      </div>
      {open && (
        <div className="border-t border-gray-100 dark:border-white/5 bg-gray-50/40 dark:bg-white/[0.01]">
          <StepList steps={steps} />
        </div>
      )}
    </div>
  );
};

const LogCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="min-w-0">
    <SectionTitle>{title}</SectionTitle>
    <div className="bg-white dark:bg-black/40 rounded-xl border border-gray-200 dark:border-white/10 shadow-sm min-w-0 overflow-hidden divide-y divide-gray-100 dark:divide-white/5">
      {children}
    </div>
  </div>
);

const stepLabel = (step: TimelineStep) =>
  (step.instrument === 'Flow_Control' || step.instrument === 'Flow Control')
    ? String(step.method)
    : `${step.instrument}.${step.method}`;

const ExecutionTimeline = ({ steps, iterationLabel }: { steps: TimelineStep[]; iterationLabel?: string }) => {
  const [hovered, setHovered] = useState<number | null>(null);
  const [hoveredIteration, setHoveredIteration] = useState<BandKey | null>(null);
  // Which iteration the step track is showing. null = the whole run.
  const [zoom, setZoom] = useState<BandKey | null>(null);

  const timed = steps.filter(s => s.start_time);

  // A step that failed and was retried starts afresh on the edge, so its own start is the last
  // attempt's. Its earlier attempts are on its record (`attempts`): drawn from the first of them,
  // the failures and the waits for a person are part of the step, not a gap before it.
  const startOf = (s: TimelineStep) => {
    const own = parseServerTime(s.start_time!);
    const first = parseServerTime((s as any).result?.attempts?.[0]?.start_time ?? '');
    return Number.isFinite(first) && first < own ? first : own;
  };
  const endOf = (s: TimelineStep) => parseServerTime(s.end_time || s.start_time!);

  const unit = iterationLabel || 'Iteration';
  const present = new Set(timed.map(s => s.iteration).filter(v => v !== undefined));
  const rowNumbers = ([...present].filter(v => typeof v === 'number') as number[]).sort((a, b) => a - b);
  // Prep and cleanup get bands of their own, either side of the rows. Without them the ribbon is
  // laid out against the whole run but only draws the rows, so the time spent in prep showed up
  // as an unexplained empty stretch before row 1.
  const bandKeys: BandKey[] = [
    ...(present.has('prep') ? ['prep' as const] : []),
    ...rowNumbers,
    ...(present.has('cleanup') ? ['cleanup' as const] : []),
  ];
  const hasIterations = bandKeys.length > 1;
  const isPhase = (k: BandKey) => typeof k !== 'number';
  const bandName = (k: BandKey) => (k === 'prep' ? 'Prep' : k === 'cleanup' ? 'Cleanup' : `${unit} ${k}`);

  // One band per repetition of the sequence, which is the unit a repeated run is actually read
  // in: "trial 7 was the slow one" is the question, not "the 41st bar was the slow one".
  const bands = bandKeys.map(n => {
    const own = timed.filter(s => s.iteration === n);
    return {
      n,
      steps: own,
      start: Math.min(...own.map(startOf)),
      end: Math.max(...own.map(endOf)),
      errors: own.filter(s => s.status === 'error').length,
      // Failed and skipped: the row went on without them.
      skippedFailures: own.filter(failedThenSkipped).length,
    };
  });

  // Zooming filters the step track *and* rescales it, so one trial out of fifty fills the width
  // instead of staying the two-pixel sliver it was in the full run.
  const view = zoom === null ? timed : timed.filter(s => s.iteration === zoom);
  const viewSteps = view.length > 0 ? view : timed;

  const starts = viewSteps.map(startOf);
  const ends = viewSteps.map(endOf);
  const minStart = starts.length ? Math.min(...starts) : 0;
  const maxEnd = ends.length ? Math.max(...ends) : 1;
  const totalMs = Math.max(maxEnd - minStart, 1);

  // The full run's own extent, which the iteration ribbon is always laid out against — the
  // ribbon must not move when you zoom, or clicking through trials becomes a guessing game.
  const runStart = timed.length ? Math.min(...timed.map(startOf)) : 0;
  const runEnd = timed.length ? Math.max(...timed.map(endOf)) : 1;
  const runMs = Math.max(runEnd - runStart, 1);

  // Steps are drawn when they can be told apart: a single sequence, or one iteration zoomed in.
  // Zoomed out over fifty trials the per-step bars were a grey smear that answered nothing, so
  // the bands stand in for them until you pick one.
  // With a single iteration there is nothing to pick between, so the steps are always drawn; the
  // ribbon above still marks where prep and cleanup sat around it.
  const showSteps = rowNumbers.length <= 1 || zoom !== null;

  // Where the time went, over whatever is currently in view.
  const byLabel = new Map<string, number>();
  viewSteps.forEach((step, i) => {
    byLabel.set(stepLabel(step), (byLabel.get(stepLabel(step)) || 0) + (ends[i] - starts[i]));
  });
  const slowest = [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  if (timed.length === 0) return null;

  const active = hovered !== null ? viewSteps[hovered] : null;
  const activeBand = hoveredIteration !== null ? bands.find(b => b.n === hoveredIteration) : null;
  const rowBands = bands.filter(b => !isPhase(b.n));
  // Rows in one batch run together (the walk is block-major: every row's first step, then every
  // row's second), so their spans genuinely overlap. On a single line they were drawn over each
  // other and read as misplaced; each overlapping band gets the first lane that is free by then.
  const laneEnds: number[] = [];
  const laneOf = new Map<BandKey, number>();
  [...bands].sort((a, b) => a.start - b.start).forEach(band => {
    let lane = laneEnds.findIndex(end => end <= band.start);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(band.end); } else laneEnds[lane] = band.end;
    laneOf.set(band.n, lane);
  });
  const BAND_H = 22;
  const BAND_GAP = 3;
  const slowestBand = rowBands.length > 1
    ? rowBands.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a))
    : null;

  // A floor on the width: squeezed into a narrow window the bands overlapped their own labels and
  // the time readout wrapped, so below it the timeline scrolls sideways instead.
  return (
    <div className="overflow-x-auto">
    <div className="min-w-[560px]">
      <div className="flex items-baseline justify-between mb-1.5 gap-3">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 shrink-0">timeline</h3>
        {/* A fixed readout rather than a native title: a 0.6%-wide bar is close to
            unhoverable, and the browser tooltip needs a hover to be held still on top of it
            before it appears at all — so the information was effectively unreachable. */}
        <div className="text-[11px] font-mono truncate text-right flex-1 min-w-0">
          {activeBand ? (
            <span className="text-gray-700 dark:text-gray-200">
              <span className="text-gray-900 dark:text-white font-bold">{bandName(activeBand.n)}</span>
              <span className="text-gray-400">
                {' · '}{((activeBand.end - activeBand.start) / 1000).toFixed(2)}s
                {' · '}{activeBand.steps.length} step{activeBand.steps.length === 1 ? '' : 's'}
                {' · +'}{((activeBand.start - runStart) / 1000).toFixed(1)}s
              </span>
              {activeBand.errors > 0 && <span className="text-red-500">{' · '}{activeBand.errors} failed</span>}
              {activeBand.skippedFailures > 0 && <span className="text-amber-600 dark:text-amber-400">{' · '}{activeBand.skippedFailures} failed and skipped</span>}
            </span>
          ) : active ? (
            <span className="text-gray-700 dark:text-gray-200">
              {active.iteration !== undefined && (
                <span className="text-gray-900 dark:text-white font-bold">{bandName(active.iteration)} · </span>
              )}
              {active.row !== undefined && unit === 'Batch' && (
                <span className="text-teal-600 dark:text-teal-400">row {active.row} · </span>
              )}
              {stepLabel(active)}
              <span className="text-gray-400">
                {' · '}{((endOf(active) - startOf(active)) / 1000).toFixed(2)}s
                {' · +'}{((startOf(active) - minStart) / 1000).toFixed(1)}s
              </span>
              {active.status !== 'completed' && (
                <span className={active.status === 'error' ? ' text-red-500' : ' text-gray-700 dark:text-gray-200'}>
                  {' · '}{active.status}
                </span>
              )}
            </span>
          ) : (
            <span className="text-gray-400 dark:text-gray-600">
              {rowNumbers.length > 1
                ? `click a ${unit.toLowerCase()} to see its steps`
                : 'hover a bar for details'}
            </span>
          )}
        </div>
      </div>

      {hasIterations && (
        <>
          {/* The outer bracket: every repetition, labelled and to scale, so you can see which
              stretch of the run is which before deciding where to look. */}
          <div className="relative mb-1" style={{ height: laneEnds.length * (BAND_H + BAND_GAP) - BAND_GAP }}>
            {bands.map(band => {
              const leftPct = ((band.start - runStart) / runMs) * 100;
              const widthPct = Math.max(((band.end - band.start) / runMs) * 100, 0.8);
              const selected = zoom === band.n;
              return (
                <button
                  key={String(band.n)}
                  type="button"
                  onClick={() => setZoom(selected ? null : band.n)}
                  onMouseEnter={() => setHoveredIteration(band.n)}
                  onMouseLeave={() => setHoveredIteration(null)}
                  title={`${bandName(band.n)} — ${((band.end - band.start) / 1000).toFixed(2)}s, ${band.steps.length} step${band.steps.length === 1 ? '' : 's'}`}
                  className={`absolute rounded-md border text-[10px] font-bold overflow-hidden transition-colors ${selected
                      ? 'bg-accent border-accent text-on-accent z-20'
                      : band.errors > 0
                        ? 'bg-red-100 border-red-300 text-red-700 hover:bg-red-200 dark:bg-red-500/20 dark:border-red-500/40 dark:text-red-300'
                      : band.skippedFailures > 0
                        ? 'bg-amber-100 border-amber-300 text-amber-800 hover:bg-amber-200 dark:bg-amber-500/20 dark:border-amber-500/40 dark:text-amber-300'
                        : isPhase(band.n)
                          ? 'bg-gray-50 border-dashed border-gray-300 text-gray-500 hover:bg-gray-100 dark:bg-white/[0.03] dark:border-white/20 dark:text-gray-400 dark:hover:bg-white/[0.06]'
                          : 'bg-accent-soft border-accent-tint/60 text-accent-fg hover:bg-accent-tint/30'
                    } ${hoveredIteration === band.n && !selected ? 'ring-1 ring-inset ring-accent' : ''}`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%`, top: (laneOf.get(band.n) || 0) * (BAND_H + BAND_GAP), height: BAND_H }}
                >
                  {/* Only when it fits. A hundred-row run is a ribbon of unlabelled blocks, and
                      the readout above names whichever one you are pointing at. */}
                  {widthPct > 4 ? (isPhase(band.n) ? bandName(band.n) : band.n) : ''}
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between text-[10px] text-gray-400 mb-1">
            <span>
              {rowBands.length} {unit.toLowerCase()}{rowBands.length === 1 ? '' : /(s|sh|ch|x)$/i.test(unit) ? 'es' : 's'}
              {slowestBand && <> · slowest {unit.toLowerCase()} {slowestBand.n} at {((slowestBand.end - slowestBand.start) / 1000).toFixed(1)}s</>}
            </span>
            {zoom !== null && (
              <button
                type="button"
                onClick={() => { setZoom(null); setHovered(null); }}
                className="font-semibold text-accent-fg hover:underline"
              >
                ← whole run
              </button>
            )}
          </div>
        </>
      )}

      {showSteps ? (
        /* Hover is resolved against the whole track rather than per bar. One slow step squeezes
           the rest to a few pixels each — in a typical run a 4s hold sits beside six sub-50ms
           calls — so a per-bar hover target makes exactly the steps you want to inspect the ones
           you cannot hit. Picking the step nearest the cursor's position in time makes every bar
           reachable regardless of how thin it was drawn. */
        <div
          className="relative h-6 rounded-md bg-gray-100 dark:bg-white/5 overflow-hidden cursor-crosshair"
          onMouseLeave={() => setHovered(null)}
          onMouseMove={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (rect.width === 0) return;
            const at = minStart + ((e.clientX - rect.left) / rect.width) * totalMs;
            let best = 0;
            let bestDistance = Infinity;
            for (let i = 0; i < viewSteps.length; i++) {
              // Zero when the cursor is inside the step's own span, so a real hit always wins.
              const distance = at < starts[i] ? starts[i] - at : at > ends[i] ? at - ends[i] : 0;
              if (distance < bestDistance) { bestDistance = distance; best = i; }
            }
            setHovered(best);
          }}
        >
          {viewSteps.map((step, idx) => {
            const leftPct = ((starts[idx] - minStart) / totalMs) * 100;
            // A near-instant step would otherwise round to an invisible sliver — floor its width
            // so every logged action stays hoverable, not just the slow ones.
            const widthPct = Math.max(((ends[idx] - starts[idx]) / totalMs) * 100, 0.6);
            return (
              <div
                key={idx}
                className={`absolute top-0 h-full pointer-events-none ${failedThenSkipped(step) ? 'bg-amber-500' : STATUS_BAR_COLOR[step.status || ''] || 'bg-gray-400'} transition-opacity border-r border-white/60 dark:border-black/40 ${hovered === idx ? 'opacity-100 ring-2 ring-inset ring-black/50 dark:ring-white/70 z-20' : 'opacity-90'
                  }`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              />
            );
          })}
        </div>
      ) : (
        <p className="h-6 flex items-center justify-center rounded-md bg-gray-50 dark:bg-white/[0.03] text-[11px] text-gray-400 dark:text-gray-500">
          Pick a {unit.toLowerCase()} above to see its steps
        </p>
      )}

      <div className="flex justify-between text-[10px] text-gray-400 mt-1 gap-2">
        <span>{new Date(minStart).toLocaleTimeString()}</span>
        <span className="text-center">
          {((maxEnd - minStart) / 1000).toFixed(1)}s
          {zoom !== null ? ` in ${bandName(zoom).toLowerCase()}` : ' total'}
          {' · '}{viewSteps.length} step{viewSteps.length === 1 ? '' : 's'}
        </span>
        <span>{new Date(maxEnd).toLocaleTimeString()}</span>
      </div>

      {showSteps && slowest.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[10px] text-gray-500 dark:text-gray-400">
          <span className="font-semibold text-gray-400">most time</span>
          {slowest.map(([label, ms]) => (
            <span key={label} className="font-mono">
              {label}
              <span className="text-gray-400"> {(ms / 1000).toFixed(1)}s ({Math.round((ms / totalMs) * 100)}%)</span>
            </span>
          ))}
        </div>
      )}
    </div>
    </div>
  );
};

/**
 * Which batch each row ran in, or null when the run was not batched.
 *
 * Rows in one batch run interleaved -- every row's first step, then every row's second -- so per
 * row the timeline drew overlapping bars that read as misplaced. A batched run is drawn as its
 * batches instead (5 rows at batch size 2 is 3 bands); the data and steps stay per row.
 * `batch_size` is recorded on runs since it existed; older ones are grouped by overlap, which is
 * exactly what sharing a batch looks like in time.
 */
function batchOfRows(run: any): Map<number, number> | null {
  if (run.type !== 'Spreadsheet' || (run.rows?.length || 0) < 2) return null;
  const map = new Map<number, number>();
  const size = Number(run.batchSize) || 0;
  if (size) {
    for (const r of run.rows) map.set(r.row, Math.ceil(r.row / size));
  } else {
    const spans = run.rows
      .map((r: any) => {
        const starts = (r.details || []).map((d: any) => parseServerTime(d.start_time)).filter(Number.isFinite);
        const ends = (r.details || []).map((d: any) => parseServerTime(d.end_time || d.start_time)).filter(Number.isFinite);
        return starts.length ? { row: r.row, start: Math.min(...starts), end: Math.max(...ends) } : null;
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.start - b.start);
    let batch = 0;
    let end = -Infinity;
    for (const s of spans) {
      if (s.start >= end) batch += 1;
      end = Math.max(end, s.end);
      map.set(s.row, batch);
    }
  }
  return new Set(map.values()).size < run.rows.length ? map : null;
}

const PAGE_SIZE = 50;

const SORTS: { value: string; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'duration', label: 'Longest first' },
];

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'completed', label: 'Completed' },
  { value: 'error', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'active', label: 'Queued / running' },
];

const LIST_DOT: Record<string, string> = {
  completed: 'bg-green-500',
  error: 'bg-red-500',
  cancelled: 'bg-gray-400',
  running: 'bg-accent animate-pulse',
  waiting_input: 'bg-amber-500 animate-pulse',
};

export default function DataPage() {
  // The list is one page of summaries from /api/queue/history; only the selected run is loaded
  // with its steps. Loading every run with every step made this page -- and every step of every
  // run, since the queue broadcast carried the same payload -- slower as the history grew.
  const [summaries, setSummaries] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState('newest');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [query, setQuery] = useState('');
  const [listLoaded, setListLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const theme = useDocumentTheme();
  const [edgeStatus, setEdgeStatus] = useState<any>(null);
  const [selectedRun, setSelectedRun] = useState<any>(null);
  const [plots, setPlots] = useState<Record<string, string> | null>(null);
  const [plotsError, setPlotsError] = useState<string | null>(null);
  const [plotsLoading, setPlotsLoading] = useState(false);
  // Deleting many: "Select" puts a checkbox on every card until "Done". Off, a card has only its
  // trash icon (one run). The checkboxes used to appear on hover, pushing the name aside as the
  // pointer crossed the list.
  const [selecting, setSelecting] = useState(false);
  // Runs ticked for deletion, from the page of the list that is showing.
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [listVersion, setListVersion] = useState(0);
  const selectedIdRef = useRef<number | null>(null);
  selectedIdRef.current = selectedId;

  // Typing searches the server, so wait for a pause rather than querying per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setQuery(searchQuery.trim()); setPage(0); }, 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), q: query, sort, status: statusFilter,
    });
    fetch(`${API_BASE}/api/queue/history?${params}`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        setSummaries(data.runs || []);
        setTotal(data.total || 0);
        setListLoaded(true);
        // Open the first run on arrival, and keep whatever is open while paging or filtering.
        if (selectedIdRef.current === null && data.runs?.length) setSelectedId(data.runs[0].id);
      })
      .catch(() => { if (!cancelled) setListLoaded(true); });
    return () => { cancelled = true; };
  }, [page, query, sort, statusFilter, listVersion]);

  // One reading of a run record, shared with Cloud's view of synced results.
  useEffect(() => {
    if (selectedId === null) { setSelectedRun(null); return; }
    let cancelled = false;
    fetch(`${API_BASE}/api/queue/runs/${selectedId}`)
      .then(res => (res.ok ? res.json() : null))
      .then(run => { if (!cancelled) setSelectedRun(run ? formatRun(run) : null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedId]);

  useEffect(() => {

    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => setEdgeStatus(data))
      .catch(err => console.error(err));

    // The broadcast carries live and recent runs with their steps: enough to keep an open run
    // current as it executes. The list itself is refreshed at most every couple of seconds --
    // the broadcast fires after every step.
    let lastListRefresh = 0;
    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.status) setEdgeStatus(data.status);
        if (data.runs) {
          const open = data.runs.find((r: any) => r.id === selectedIdRef.current);
          if (open) setSelectedRun(formatRun(open));
          if (Date.now() - lastListRefresh > 2000) {
            lastListRefresh = Date.now();
            setListVersion(v => v + 1);
          }
        }
      } catch (e) { }
    };

    return () => {
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedRun || selectedRun.type !== 'Optimization') {
      setPlots(null);
      setPlotsError(null);
      return;
    }
    let cancelled = false;
    setPlots(null);
    setPlotsError(null);
    setPlotsLoading(true);
    fetch(`${API_BASE}/api/queue/runs/${selectedRun.id}/plots`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        if (data && typeof data === 'object' && data.error) {
          setPlotsError(data.error);
        } else if (data && typeof data === 'object') {
          setPlots(data);
        } else {
          setPlotsError('Plots are not viewable in the browser for this optimizer.');
        }
      })
      .catch(() => { if (!cancelled) setPlotsError('Failed to load plots.'); })
      .finally(() => { if (!cancelled) setPlotsLoading(false); });
    return () => { cancelled = true; };
  }, [selectedRun?.id, selectedRun?.type]);


  // A ticked run that leaves the page (paging, a filter, a search) is no longer ticked: deleting
  // something the person can no longer see would be a surprise.
  useEffect(() => {
    setChecked(prev => {
      const visible = new Set(summaries.map((r: any) => r.id));
      const next = new Set([...prev].filter(id => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [summaries]);

  const toggleChecked = (id: number) => setChecked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allChecked = summaries.length > 0 && summaries.every((r: any) => checked.has(r.id));
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(summaries.map((r: any) => r.id)));

  // One run or many, through the same per-run delete: the edge refuses a run that is still going
  // (cancel it instead, so its partial results stay on record), and that refusal is reported
  // rather than stopping the rest.
  const stopSelecting = () => { setSelecting(false); setChecked(new Set()); };
  const deleteChecked = () => deleteRuns(summaries.filter((r: any) => checked.has(r.id)));
  const deleteRuns = async (runs: any[]) => {
    if (!runs.length) return;
    const ok = await confirmDialog(
      runs.length === 1
        ? `"${String(runs[0].name).split(' - ')[0]}" and its recorded data will be permanently removed.`
        : `${runs.length} runs and their recorded data will be permanently removed.`,
      { title: runs.length === 1 ? 'Delete this run?' : `Delete ${runs.length} runs?`, confirmLabel: 'Delete', tone: 'danger' },
    );
    if (!ok) return;
    setIsDeleting(true);
    const failed: string[] = [];
    for (const run of runs) {
      try {
        const res = await fetch(`${API_BASE}/api/queue/runs/${run.id}`, { method: 'DELETE' });
        if (!res.ok) failed.push(`${String(run.name).split(' - ')[0]}: ${(await res.json().catch(() => ({}))).error || res.status}`);
        else if (selectedIdRef.current === run.id) setSelectedId(null);
      } catch (e: any) {
        failed.push(`${String(run.name).split(' - ')[0]}: ${e.message}`);
      }
    }
    setIsDeleting(false);
    stopSelecting();
    setListVersion(v => v + 1);
    if (failed.length) await notify(failed.join('\n'), { title: `${failed.length} not deleted`, tone: 'error' });
  };

  const downloadRunDataCSV = (run: any) => {
    if (!run || !run.variables?.length) return;

    // Row values are kept as an array rather than a comma-joined string: joining and splitting
    // again broke every value that contained a comma (any structured result) into extra columns.
    // A Blob rather than an encodeURI'd data: URL, which silently truncated the file at the
    // first '#' in any value.
    const url = URL.createObjectURL(new Blob([datasheetCsv(run)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `ivoryos_data_${run.id}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const downloadRunLogCSV = (run: any) => {
    if (!run || !run.steps) return;

    const paramKeys = new Set<string>();
    const outputKeys = new Set<string>();

    const flattenObj = (obj: any, prefix = ''): Record<string, string> => {
      const res: Record<string, string> = {};
      if (!obj) return res;
      Object.entries(obj).forEach(([k, v]) => {
        const newKey = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          Object.assign(res, flattenObj(v, newKey));
        } else {
          res[newKey] = String(v);
        }
      });
      return res;
    };

    run.steps.forEach((step: any) => {
      const params = { ...(step.parameters || {}) };
      delete params._phase;
      const flatParams = flattenObj(params);
      Object.keys(flatParams).forEach(k => paramKeys.add(`Param:${k}`));

      const flatOutputs = flattenObj(step.outputs);
      Object.keys(flatOutputs).forEach(k => outputKeys.add(`Output:${k}`));
    });

    const pKeys = Array.from(paramKeys).sort();
    const oKeys = Array.from(outputKeys).sort();

    const header = ["Step Index", "Phase", "Iteration", "Instrument", "Method", "Status", "Start Time", "End Time", "Error", ...pKeys, ...oKeys].join(',');

    let phaseCounts: Record<string, number> = {};
    let currentPhaseStr = '';

    const csvRows = run.steps.map((step: any, idx: number) => {
      const params = { ...(step.parameters || {}) };
      const phase = params._phase || 'Main';
      delete params._phase;

      if (phase !== currentPhaseStr) {
        currentPhaseStr = phase;
        phaseCounts = {};
      }

      const stepKey = `${step.instrument}.${step.method}`;
      phaseCounts[stepKey] = (phaseCounts[stepKey] || 0) + 1;
      const iteration = phaseCounts[stepKey];

      const escapeCSV = (s: any) => {
        if (s === null || s === undefined) return '';
        const str = String(s);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const flatParams = flattenObj(params);
      const flatOutputs = flattenObj(step.outputs);

      const pVals = pKeys.map(k => escapeCSV(flatParams[k.replace('Param:', '')]));
      const oVals = oKeys.map(k => escapeCSV(flatOutputs[k.replace('Output:', '')]));

      const formatDate = (dateString: string) => {
        if (!dateString) return '';
        try {
          const d = serverDate(dateString);
          const pad = (n: number) => n.toString().padStart(2, '0');
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        } catch (e) {
          return dateString;
        }
      };

      return [
        idx + 1,
        phase,
        iteration,
        step.instrument,
        step.method,
        step.status,
        formatDate(step.start_time),
        formatDate(step.end_time),
        escapeCSV(step.error),
        ...pVals,
        ...oVals
      ].join(',');
    });

    const csvContent = "data:text/csv;charset=utf-8," + header + "\n" + csvRows.join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `ivoryos_log_${run.id}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden min-w-0">
        <div className="w-80 min-w-[20rem] max-w-[20rem] flex-none border-r border-gray-200 dark:border-white/10 bg-white/50 dark:bg-black/20 flex flex-col">
          {/* No title: the page is named by the navigation, and the list explains itself. The row
              keeps the height of the selected run's header beside it, so the two borders meet. */}
          <div className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-2.5 px-4 bg-white/80 dark:bg-black/20 backdrop-blur-md z-10">
            {selecting && (
              <input
                type="checkbox"
                checked={allChecked}
                ref={el => { if (el) el.indeterminate = checked.size > 0 && !allChecked; }}
                onChange={toggleAll}
                disabled={summaries.length === 0}
                title={allChecked ? 'Clear the selection' : 'Select every run on this page'}
                className="w-4 h-4 shrink-0 accent-accent cursor-pointer disabled:cursor-default"
              />
            )}
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search runs..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoComplete="off"
                title="Every word must match the run name, its columns or values, or an instrument or method it used"
                className="w-full pl-9 pr-3 py-2 bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/50"
              />
            </div>
            <button
              type="button"
              onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
              disabled={!selecting && summaries.length === 0}
              title={selecting ? 'Stop selecting' : 'Select runs to delete several at once'}
              className="shrink-0 px-2 py-1.5 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-white/10 dark:hover:text-white"
            >
              {selecting ? 'Done' : 'Select'}
            </button>
          </div>
          <div className="px-4 pt-3 space-y-2">
            <div className="flex gap-2">
              <select
                value={sort}
                onChange={(e) => { setSort(e.target.value); setPage(0); }}
                title="Sort order"
                className="flex-1 min-w-0 px-2 py-1.5 bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-lg text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-accent/50"
              >
                {SORTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select
                value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
                title="Show only runs with this status"
                className="flex-1 min-w-0 px-2 py-1.5 bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-lg text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-accent/50"
              >
                {STATUS_FILTERS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            {selecting && (
              <div className="flex items-center gap-2 rounded-lg bg-gray-100 dark:bg-white/10 px-2.5 py-1.5 text-xs">
                <span className={checked.size ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}>
                  {checked.size ? `${checked.size} selected` : 'Tick the runs to delete'}
                </span>
                <button
                  type="button"
                  onClick={deleteChecked}
                  disabled={isDeleting || checked.size === 0}
                  className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold text-red-600 hover:bg-red-100 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-500/15"
                >
                  <Trash2 className="w-3.5 h-3.5" /> {isDeleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {summaries.length === 0 ? (
              <div className="text-gray-500 dark:text-gray-600 italic text-sm text-center mt-10">
                {!listLoaded ? 'Loading…' : query || statusFilter !== 'all' ? 'No runs match.' : 'No history found.'}
              </div>
            ) : (
              summaries.map(run => (
                <div
                  key={run.id}
                  onClick={() => setSelectedId(run.id)}
                  className={`group p-3 rounded-lg border cursor-pointer transition-all ${selectedId === run.id ? 'bg-accent-soft border-accent-tint' : 'bg-white dark:bg-white/5 border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/10'}`}
                >
                  <div className="flex justify-between items-center mb-1 gap-2">
                    <span className="flex items-center gap-1.5 min-w-0">
                      {selecting && (
                        <input
                          type="checkbox"
                          checked={checked.has(run.id)}
                          onChange={() => toggleChecked(run.id)}
                          onClick={(e) => e.stopPropagation()}
                          title="Select this run"
                          className="w-3.5 h-3.5 shrink-0 accent-accent cursor-pointer"
                        />
                      )}
                      {/* Completed, but only after retries or skipping a failed step: not the
                          same outcome as a clean run, so not the same green. */}
                      <span
                        title={run.issues ? `${run.status} · ${issuesLabel(run.issues)}` : run.status}
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${run.status === 'completed' && run.issues ? 'bg-amber-500' : LIST_DOT[run.status] || 'bg-gray-300 dark:bg-gray-600'}`}
                      />
                      <span className="text-xs font-bold text-gray-800 dark:text-gray-200 truncate">{String(run.name).split(' - ')[0]}</span>
                    </span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[10px] text-gray-500">{run.start_time ? serverDate(run.start_time).toLocaleString() : ''}</span>
                      {/* Fades in on hover without taking or giving up space, so nothing moves. */}
                      {!selecting && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); deleteRuns([run]); }}
                          disabled={isDeleting}
                          title="Delete this run"
                          aria-label="Delete this run"
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-opacity"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </span>
                  </div>
                  {/* What kind of run, and no more: the instruments it touched are on the run
                      itself, and search still finds runs by them. */}
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                    {/* The stage's name too: it sits at the end of the run's name, where the card cuts it off. */}
                    {run.group && <span title={`Stage ${run.group.index} of ${run.group.total} of ${run.group.name}`}>{run.group.index}/{run.group.total} {run.group.stage} • </span>}
                    {run.row_count != null ? `${run.variable_count} variables • ${run.row_count} rows` : run.type === 'Optimization' ? 'optimization' : 'single run'}
                  </div>
                </div>
              ))
            )}
          </div>
          {total > PAGE_SIZE && (
            <div className="shrink-0 flex items-center justify-between px-4 py-2 border-t border-gray-200 dark:border-white/10 text-xs text-gray-500 dark:text-gray-400">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage(p => Math.max(0, p - 1))}
                className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Newer
              </button>
              <span>{page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total}</span>
              <button
                type="button"
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => setPage(p => p + 1)}
                className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Older <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 flex flex-col relative z-0 min-w-0 overflow-hidden">
          {selectedRun ? (
            <>
              {/* A long name truncates; the two downloads keep their size and one line. */}
              <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between gap-3 px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
                <div className="flex items-center gap-3 min-w-0">
                  <Table2 className="w-5 h-5 shrink-0 text-gray-700 dark:text-gray-200" />
                  <h2 className="min-w-0 truncate text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300" title={selectedRun.name.split(' - ')[0]}>{selectedRun.name.split(' - ')[0]}</h2>
                  {selectedRun.deckVersion != null && (
                    <span
                      title="The version of the instruments' schema this run executed against (Instruments → deck history)"
                      className="shrink-0 whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400"
                    >
                      deck v{selectedRun.deckVersion}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {selectedRun.variables?.length > 0 && (
                    <button
                      onClick={() => downloadRunDataCSV(selectedRun)}
                      title="Download the data table (CSV): one row per sample or trial, inputs and outputs"
                      className="flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded text-sm font-medium transition-all bg-green-50 border border-green-200 text-green-700 hover:bg-green-100 dark:bg-green-900/30 dark:border-green-500/30 dark:text-green-300 dark:hover:bg-green-900/50"
                    >
                      <Download className="w-4 h-4" />
                      <span>Data</span>
                    </button>
                  )}
                  <button
                    onClick={() => downloadRunLogCSV(selectedRun)}
                    title="Download the step log (CSV): every step with its arguments, result and times"
                    className="flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded text-sm font-medium transition-all bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/15 text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-white/10 dark:bg-white/15 dark:border-white/20 dark:text-white dark:hover:bg-white/15"
                  >
                    <Download className="w-4 h-4" />
                    <span>Log</span>
                  </button>
                </div>
              </header>
              {/* One stage of a design run in stages: each stage is its own run with its own table,
                  and this strip is what shows them as the one experiment they were. */}
              {(() => {
                const group = summaries.find(s => s.id === selectedId)?.group;
                if (!group) return null;
                const siblings = summaries.filter(s => s.group?.id === group.id).sort((a, b) => a.group.index - b.group.index);
                return (
                  <div className="shrink-0 flex flex-wrap items-center gap-1.5 border-b border-gray-200 bg-white/60 px-6 py-2 text-xs dark:border-white/10 dark:bg-white/[0.02]">
                    <span className="mr-1 font-semibold text-gray-600 dark:text-gray-300" title="This run is one stage of a design run in stages">{group.name}</span>
                    {siblings.map(s => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelectedId(s.id)}
                        title={s.issues ? `${s.status} · ${issuesLabel(s.issues)}` : s.status}
                        className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-medium ${s.id === selectedId ? 'border-accent-tint bg-accent-soft text-accent-fg' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10'}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${s.status === 'completed' ? (s.issues ? 'bg-amber-500' : 'bg-green-500') : s.status === 'error' ? 'bg-red-500' : s.status === 'cancelled' ? 'bg-gray-400' : 'bg-amber-500'}`} />
                        {s.group.index}. {s.group.stage}
                      </button>
                    ))}
                    {siblings.length < group.total && (
                      <button type="button" onClick={() => setSearchQuery(group.id)} className="text-gray-500 underline-offset-2 hover:underline dark:text-gray-400">
                        show all {group.total} stages
                      </button>
                    )}
                  </div>
                );
              })()}
              <div className="p-8 flex-1 overflow-y-auto overflow-x-hidden pb-24 min-w-0 w-full relative">
                <div className="max-w-5xl mx-auto space-y-3 w-full min-w-0">
                  {selectedRun.type === 'Optimization' && selectedRun.config && (
                    <div className="bg-white dark:bg-black/40 rounded-xl border border-gray-200 dark:border-white/10 p-5 shadow-sm min-w-0">
                      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-4">configuration</h3>
                      <div className="flex flex-wrap gap-x-8 gap-y-3 mb-4">
                        <div>
                          <div className="text-[10px] uppercase font-bold text-gray-400">Optimizer</div>
                          <div className="text-sm font-mono text-gray-800 dark:text-gray-200">{selectedRun.config.optimizer || '—'}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase font-bold text-gray-400">Budget</div>
                          <div className="text-sm font-mono text-gray-800 dark:text-gray-200">{selectedRun.config.budget ?? '—'}</div>
                        </div>
                        {/* Only runs from before failures always waited for a person recorded one. */}
                        {selectedRun.config.error_recovery && (
                          <div>
                            <div className="text-[10px] uppercase font-bold text-gray-400">Error Recovery</div>
                            <div className="text-sm font-mono text-gray-800 dark:text-gray-200">{selectedRun.config.error_recovery}</div>
                          </div>
                        )}
                        {Object.entries(selectedRun.config.optimizer_config || {}).map(([stepKey, stepDef]: [string, any]) => (
                          <div key={stepKey}>
                            <div className="text-[10px] uppercase font-bold text-gray-400">{stepKey.replace('_', ' ')}</div>
                            <div className="text-sm font-mono text-gray-800 dark:text-gray-200">{stepDef?.model}{stepDef?.num_samples !== undefined ? ` (${stepDef.num_samples})` : ''}</div>
                          </div>
                        ))}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                        {selectedRun.config.parameter_space.map((p: any) => (
                          <div key={p.name} className="flex flex-col space-y-1 p-3 bg-gray-50/50 dark:bg-white/[0.02] rounded-lg border border-gray-100 dark:border-white/5">
                            <span className="text-[11px] font-bold text-gray-700 dark:text-gray-200 font-mono truncate">#{p.name}</span>
                            <span className="text-xs text-gray-600 dark:text-gray-300">
                              {p.type === 'choice' ? `choice: ${(p.bounds || []).join(', ')}` : `range: ${p.bounds?.[0]} – ${p.bounds?.[1]}`}
                              <span className="text-gray-400"> ({p.value_type})</span>
                            </span>
                          </div>
                        ))}
                        {selectedRun.config.objective_config.map((o: any) => (
                          <div key={o.name} className="flex flex-col space-y-1 p-3 bg-gray-50/50 dark:bg-white/[0.02] rounded-lg border border-gray-100 dark:border-white/5">
                            <span className="text-[11px] font-bold text-green-500 font-mono truncate">{o.name}</span>
                            <span className="text-xs text-gray-600 dark:text-gray-300">objective — {o.minimize ? 'minimize' : 'maximize'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedRun.type === 'Optimization' && (
                    <div className="bg-white dark:bg-black/40 rounded-xl border border-gray-200 dark:border-white/10 p-5 shadow-sm min-w-0">
                      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-4">optimizer plots</h3>
                      {plotsLoading ? (
                        <div className="text-sm text-gray-400 dark:text-gray-500">Loading plots…</div>
                      ) : plotsError ? (
                        <div className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5 rounded-lg p-3">
                          {plotsError}
                          {plotsError.toLowerCase().includes('no optimizer plots available') && (
                            <div className="mt-1 text-xs text-gray-400">Plots are only kept in memory for the most recently completed optimization run in this server session — run this optimization again to see fresh plots here.</div>
                          )}
                        </div>
                      ) : plots ? (
                        <div className="space-y-6">
                          {Object.entries(plots).map(([plotName, plotHtml]) => (
                            <div key={plotName}>
                              <div className="text-[10px] uppercase font-bold text-gray-400 mb-2">{plotName}</div>
                              <PlotFrame html={plotHtml} />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-sm text-gray-400 dark:text-gray-500">No plots available.</div>
                      )}
                    </div>
                  )}
                  {/* Timeline, then data, then steps: when it ran, what it produced, how. */}
                  {(() => {
                    const batches = batchOfRows(selectedRun);
                    return (
                  <>
                  <ExecutionTimeline
                    iterationLabel={batches ? 'Batch' : iterationLabelOf(selectedRun)}
                    steps={[
                        ...(selectedRun.prep || []).map((d: any) => ({ ...d, iteration: 'prep' as const })),
                        ...selectedRun.rows.flatMap((r: any) =>
                          (r.details || []).map((d: any) => ({ ...d, row: r.row, iteration: batches ? (batches.get(r.row) ?? r.row) : r.row }))),
                        ...(selectedRun.cleanup || []).map((d: any) => ({ ...d, iteration: 'cleanup' as const })),
                      ]}
                  />
                  <RunDataTable run={selectedRun} batchOf={batches} />
                    <LogCard title="steps">
                      <LogGroup label="Prep" summary="ran once" steps={selectedRun.prep || []} muted />
                      {selectedRun.rows.map((row: any, idx: number) => {
                        const batch = batches?.get(row.row);
                        const startsBatch = batch !== undefined && (idx === 0 || batches?.get(selectedRun.rows[idx - 1].row) !== batch);
                        const batchRows = batch === undefined ? [] : selectedRun.rows.filter((r: any) => batches?.get(r.row) === batch);
                        return (
                        <React.Fragment key={`${selectedRun.id}-${row.row}`}>
                        {/* The same divider the Configure spreadsheet draws: these rows ran together,
                            step by step, rather than one after another. */}
                        {startsBatch && (
                          <div className="flex items-center gap-2 px-3 py-1 bg-purple-50/60 dark:bg-purple-500/[0.06] border-t-2 border-t-purple-300 dark:border-t-purple-700/60">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-purple-600 dark:text-purple-400">Batch {batch}</span>
                            <span className="text-[10px] text-purple-700/70 dark:text-purple-300/60">
                              rows {batchRows[0]?.row}–{batchRows[batchRows.length - 1]?.row} · ran together, step by step
                            </span>
                          </div>
                        )}
                        <LogGroup
                          defaultOpen={selectedRun.rows.length === 1}
                          label={selectedRun.rows.length === 1 && selectedRun.type === 'Sequence'
                            ? 'Run'
                            : `${iterationLabelOf(selectedRun)} ${row.row}`}
                          summary={selectedRun.variables
                            .map((v: string, i: number) => `${v}=${cellText(row.values?.[i])}`)
                            .join('  ')}
                          steps={row.details || []}
                        />
                        </React.Fragment>
                        );
                      })}
                      <LogGroup label="Cleanup" summary="ran once" steps={selectedRun.cleanup || []} muted />
                    </LogCard>
                  </>
                    );
                  })()}
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm">
              Select a run from the history list to view details.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
