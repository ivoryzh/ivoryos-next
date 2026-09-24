"use client";
import { API_BASE, WS_BASE } from '@/config';

import { useState, useEffect } from 'react';
import { Database, Download, Sun, Moon, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import {
  ResultView, RunDataTable, SectionTitle, parseServerTime, serverDate, formatRun, datasheetCsv, cellText, isFlowStep, aggregateStatus, toDetail, phaseOf,
} from '@ivoryos/shared-ui';

// Every step's outputs get wrapped as {"result": <value>} regardless of what the method actually
// returned. When that value is a plain scalar — the overwhelmingly common case, since that's the
// only thing an optimizer can ever act on — show it bare instead of as a one-key JSON object.
// A dataclass/dict/list result (multiple fields, or a non-scalar 'result') still gets the full dump.
// Every step's outputs get wrapped as {"result": <value>} regardless of what the method actually
// returned, so unwrap that one key before handing the value to ResultView — otherwise every result
// renders under a pointless "Result" heading.
const stepResultValue = (outputs: unknown): unknown => {
  if (outputs === null || outputs === undefined) return outputs;
  if (typeof outputs === 'object' && !Array.isArray(outputs)) {
    const keys = Object.keys(outputs as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === 'result') return (outputs as Record<string, unknown>).result;
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
  running: 'bg-indigo-500 animate-pulse',
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
};

type BandKey = number | 'prep' | 'cleanup';

const secondsBetween = (a?: string, b?: string) => {
  if (!a || !b) return '';
  const ms = parseServerTime(b) - parseServerTime(a);
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s` : '';
};

const StatusDot = ({ status }: { status?: string }) => (
  <span
    title={status}
    className={`w-2 h-2 rounded-full shrink-0 ${status === 'completed' ? 'bg-green-500'
      : status === 'error' ? 'bg-red-500'
        : status === 'running' || status === 'waiting_input' ? 'bg-indigo-500 animate-pulse'
          : 'bg-gray-300 dark:bg-gray-600'}`}
  />
);

/**
 * One step as a line of log: what was called, with what, and what came back. Arguments are the
 * ones actually passed (bookkeeping keys like `_row`/`_phase` dropped). An If/While shows its
 * condition, the values it read, and the outcome -- every outcome, for a While -- which the edge
 * records on the step (`condition_record` in queue.py).
 */
const summarizeStep = (step: any): { label: string; args: string; outcome: string } => {
  const params: Record<string, any> = step.params || {};
  const outputs: any = step.result || {};
  const visibleArgs = Object.entries(params)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => `${k}=${cellText(v)}`)
    .join(', ');

  if (!isFlowStep(step)) {
    const value = stepResultValue(step.result);
    return {
      label: `${step.instrument}.${step.method}`,
      args: visibleArgs,
      outcome: value === undefined || value === null ? '' : cellText(value),
    };
  }

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
      return {
        label: 'User Input',
        args: String(params.variable_name || ''),
        outcome: outputs.result === undefined ? '' : cellText(outputs.result),
      };
    default:
      return { label: String(step.method).replace(/_/g, ' '), args: '', outcome: '' };
  }
};

/** Steps as log lines. Click a line for the full result or error. */
const StepList = ({ steps, start = 0 }: { steps: any[]; start?: number }) => {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="divide-y divide-gray-100 dark:divide-white/5 min-w-0">
      {steps.map((step: any, i: number) => {
        const { label, args, outcome } = summarizeStep(step);
        const isOpen = open === i;
        const hasMore = !!step.error || (!isFlowStep(step) && step.result && outcome.length > 0);
        return (
          <div key={i} className={`min-w-0 ${step.status === 'skipped' ? 'opacity-50' : ''}`}>
            <div
              onClick={() => hasMore && setOpen(isOpen ? null : i)}
              className={`flex items-center gap-2 px-3 py-1 text-xs font-mono min-w-0 ${hasMore ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-white/[0.03]' : ''}`}
            >
              <span className="w-6 text-right text-[10px] text-gray-400 shrink-0">{start + i + 1}</span>
              <StatusDot status={step.status} />
              <span className="text-indigo-600 dark:text-indigo-400 font-semibold truncate shrink-0 max-w-[40%]" title={label}>{label}</span>
              <span className="text-gray-500 dark:text-gray-400 truncate min-w-0 flex-1" title={args}>{args}</span>
              {outcome !== '' && (
                <span className="text-gray-800 dark:text-gray-200 truncate shrink-0 max-w-[35%]" title={outcome}>&rarr; {outcome}</span>
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
                <ResultView value={stepResultValue(step.result)} />
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
  return (
    <div className="min-w-0">
      <div
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-3 px-3 py-1.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-white/[0.03] min-w-0 ${muted ? 'bg-gray-50/60 dark:bg-white/[0.02]' : ''}`}
      >
        <StatusDot status={aggregateStatus(steps)} />
        <span className={`text-xs font-semibold shrink-0 w-16 ${muted ? 'text-gray-500 dark:text-gray-400' : 'text-gray-700 dark:text-gray-200'}`}>{label}</span>
        <span className="text-[11px] font-mono text-gray-500 dark:text-gray-400 truncate min-w-0 flex-1" title={summary}>{summary}</span>
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

  const startOf = (s: TimelineStep) => parseServerTime(s.start_time!);
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
              <span className="text-indigo-600 dark:text-indigo-400 font-bold">{bandName(activeBand.n)}</span>
              <span className="text-gray-400">
                {' · '}{((activeBand.end - activeBand.start) / 1000).toFixed(2)}s
                {' · '}{activeBand.steps.length} step{activeBand.steps.length === 1 ? '' : 's'}
                {' · +'}{((activeBand.start - runStart) / 1000).toFixed(1)}s
              </span>
              {activeBand.errors > 0 && <span className="text-red-500">{' · '}{activeBand.errors} failed</span>}
            </span>
          ) : active ? (
            <span className="text-gray-700 dark:text-gray-200">
              {active.iteration !== undefined && (
                <span className="text-indigo-600 dark:text-indigo-400 font-bold">{bandName(active.iteration)} · </span>
              )}
              {stepLabel(active)}
              <span className="text-gray-400">
                {' · '}{((endOf(active) - startOf(active)) / 1000).toFixed(2)}s
                {' · +'}{((startOf(active) - minStart) / 1000).toFixed(1)}s
              </span>
              {active.status !== 'completed' && (
                <span className={active.status === 'error' ? ' text-red-500' : ' text-indigo-500'}>
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
                      ? 'bg-indigo-500 border-indigo-600 text-white z-20'
                      : band.errors > 0
                        ? 'bg-red-100 border-red-300 text-red-700 hover:bg-red-200 dark:bg-red-500/20 dark:border-red-500/40 dark:text-red-300'
                        : isPhase(band.n)
                          ? 'bg-gray-50 border-dashed border-gray-300 text-gray-500 hover:bg-gray-100 dark:bg-white/[0.03] dark:border-white/20 dark:text-gray-400 dark:hover:bg-white/[0.06]'
                          : 'bg-indigo-50 border-indigo-200 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-500/15 dark:border-indigo-500/30 dark:text-indigo-300 dark:hover:bg-indigo-500/25'
                    } ${hoveredIteration === band.n && !selected ? 'ring-1 ring-inset ring-indigo-400' : ''}`}
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
                className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
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
                className={`absolute top-0 h-full pointer-events-none ${STATUS_BAR_COLOR[step.status || ''] || 'bg-gray-400'} transition-opacity border-r border-white/60 dark:border-black/40 ${hovered === idx ? 'opacity-100 ring-2 ring-inset ring-black/50 dark:ring-white/70 z-20' : 'opacity-90'
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

export default function DataPage() {
  const [history, setHistory] = useState<any[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [edgeStatus, setEdgeStatus] = useState<any>(null);
  const [selectedRun, setSelectedRun] = useState<any>(null);
  const [plots, setPlots] = useState<Record<string, string> | null>(null);
  const [plotsError, setPlotsError] = useState<string | null>(null);
  const [plotsLoading, setPlotsLoading] = useState(false);
  const [pendingDeleteRun, setPendingDeleteRun] = useState<any>(null);
  const [isDeletingRun, setIsDeletingRun] = useState(false);

  // One reading of a run record, shared with Cloud's view of synced results.
  const formatRuns = (runs: any[]) => runs.map(formatRun);

  useEffect(() => {
    // Theme init
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');

    const fetchRuns = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/queue/runs`);
        const data = await res.json();
        const formatted = formatRuns(data.runs);
        setHistory(formatted);
        setSelectedRun((prev: any) => prev ? formatted.find((f: any) => f.id === prev.id) || prev : formatted[0]);
      } catch (e) { }
    };

    fetchRuns();

    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(data => setEdgeStatus(data))
      .catch(err => console.error(err));

    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.status) setEdgeStatus(data.status);
        if (data.runs) {
          const formatted = formatRuns(data.runs);
          setHistory(formatted);
          setSelectedRun((prev: any) => prev ? formatted.find((f: any) => f.id === prev.id) || prev : formatted[0]);
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

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const deleteRun = async (run: any) => {
    setIsDeletingRun(true);
    try {
      const res = await fetch(`${API_BASE}/api/queue/runs/${run.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete run');
      setHistory(prev => prev.filter(r => r.id !== run.id));
      setSelectedRun((prev: any) => (prev?.id === run.id ? null : prev));
      setPendingDeleteRun(null);
    } catch (e: any) {
      alert("Failed to delete run: " + e.message);
    } finally {
      setIsDeletingRun(false);
    }
  };

  const clearHistory = async () => {
    if (confirm("Are you sure you want to clear all history? (Not implemented in DB yet)")) {
      // Future: call DELETE /api/queue/runs
      alert("Clearing history directly from the Edge database will be added soon.");
    }
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
      {pendingDeleteRun && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#1a1a1a] border border-red-200 dark:border-red-500/30 rounded-2xl shadow-2xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg bg-red-50 dark:bg-red-500/10 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-red-600 dark:text-red-400" />
              </div>
              <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">Delete this run?</h2>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              <span className="font-semibold text-gray-800 dark:text-gray-200">{pendingDeleteRun.name?.split(' - ')[0]}</span> and its recorded data will be permanently removed. This can&rsquo;t be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingDeleteRun(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteRun(pendingDeleteRun)}
                disabled={isDeletingRun}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white transition-colors"
              >
                {isDeletingRun ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Sidebar */}
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden min-w-0">
        <div className="w-80 min-w-[20rem] max-w-[20rem] flex-none border-r border-gray-200 dark:border-white/10 bg-white/50 dark:bg-black/20 flex flex-col">
          <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
            <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300">Run History</h2>
            <button onClick={clearHistory} className="text-red-500 hover:text-red-600 p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20" title="Clear All History">
              <Trash2 className="w-4 h-4" />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {history.length === 0 ? (
              <div className="text-gray-500 dark:text-gray-600 italic text-sm text-center mt-10">No history found.</div>
            ) : (
              history.map(run => (
                <div
                  key={run.id}
                  onClick={() => setSelectedRun(run)}
                  className={`group p-3 rounded-lg border cursor-pointer transition-all ${selectedRun?.id === run.id ? 'bg-indigo-50 border-indigo-200 dark:bg-indigo-900/20 dark:border-indigo-500/30' : 'bg-white dark:bg-white/5 border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/10'}`}
                >
                  <div className="flex justify-between items-center mb-1 gap-2">
                    <span className="text-xs font-bold text-gray-800 dark:text-gray-200 truncate min-w-0">{run.name.split(' - ')[0]}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[10px] text-gray-500">{serverDate(run.timestamp).toLocaleString()}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); setPendingDeleteRun(run); }}
                        title="Delete run"
                        className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-opacity"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                    {run.variables.length} variables • {run.rows.length} rows
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col relative z-0 min-w-0 overflow-hidden">
          {selectedRun ? (
            <>
              <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
                <div className="flex items-center space-x-3">
                  <Database className="w-5 h-5 text-indigo-500" />
                  <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300">{selectedRun.name.split(' - ')[0]}</h2>
                  {selectedRun.deckVersion != null && (
                    <span
                      title="The version of the instruments' schema this run executed against (Instruments → deck history)"
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400"
                    >
                      deck v{selectedRun.deckVersion}
                    </span>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  {selectedRun.variables?.length > 0 && (
                    <button
                      onClick={() => downloadRunDataCSV(selectedRun)}
                      className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-green-50 border border-green-200 text-green-700 hover:bg-green-100 dark:bg-green-900/30 dark:border-green-500/30 dark:text-green-300 dark:hover:bg-green-900/50"
                    >
                      <Download className="w-4 h-4" />
                      <span>Export Data</span>
                    </button>
                  )}
                  <button
                    onClick={() => downloadRunLogCSV(selectedRun)}
                    className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:border-indigo-500/30 dark:text-indigo-300 dark:hover:bg-indigo-900/50"
                  >
                    <Download className="w-4 h-4" />
                    <span>Export Log</span>
                  </button>
                </div>
              </header>
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
                        <div>
                          <div className="text-[10px] uppercase font-bold text-gray-400">Error Recovery</div>
                          <div className="text-sm font-mono text-gray-800 dark:text-gray-200">{selectedRun.config.error_recovery || '—'}</div>
                        </div>
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
                            <span className="text-[11px] font-bold text-indigo-500 font-mono truncate">#{p.name}</span>
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
                  <ExecutionTimeline
                    iterationLabel={batches ? 'Batch' : iterationLabelOf(selectedRun)}
                    steps={[
                        ...(selectedRun.prep || []).map((d: any) => ({ ...d, iteration: 'prep' as const })),
                        ...selectedRun.rows.flatMap((r: any) =>
                          (r.details || []).map((d: any) => ({ ...d, iteration: batches ? (batches.get(r.row) ?? r.row) : r.row }))),
                        ...(selectedRun.cleanup || []).map((d: any) => ({ ...d, iteration: 'cleanup' as const })),
                      ]}
                  />
                    );
                  })()}
                  <RunDataTable run={selectedRun} />
                    <LogCard title="steps">
                      <LogGroup label="Prep" summary="ran once" steps={selectedRun.prep || []} muted />
                      {selectedRun.rows.map((row: any) => (
                        <LogGroup
                          key={`${selectedRun.id}-${row.row}`}
                          defaultOpen={selectedRun.rows.length === 1}
                          label={selectedRun.rows.length === 1 && selectedRun.type === 'Sequence'
                            ? 'Run'
                            : `${iterationLabelOf(selectedRun)} ${row.row}`}
                          summary={selectedRun.variables
                            .map((v: string, i: number) => `${v}=${cellText(row.values?.[i])}`)
                            .join('  ')}
                          steps={row.details || []}
                        />
                      ))}
                      <LogGroup label="Cleanup" summary="ran once" steps={selectedRun.cleanup || []} muted />
                    </LogCard>
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
