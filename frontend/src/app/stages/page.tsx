"use client";
import { API_BASE } from '@/config';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Check, ChevronDown, ChevronRight, ListOrdered, Play, Rows3, Workflow, Wrench, X, Zap } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import RunTabs from '@/components/RunTabs';
import LiveRun from '@/components/LiveRun';
import RunWorkflowPage from '@/components/RunWorkflowPage';
import OptimizeRunPage from '@/components/OptimizeRunPage';
import { confirmDialog, notify, useDocumentTheme } from '@ivoryos/shared-ui';
import { useQueueBusy } from '@/queueBusy';
import {
  activeSettings, chooseStageMode, clearStage, currentStages, hasOpenValues, plainPayload, readDraft, savedStage, stageSummary,
  type SavedStage, type Stage, type StageMode,
} from '@/stages';

const MODES: { mode: StageMode; label: string; icon: typeof Play; title: string }[] = [
  { mode: 'once', label: 'Once', icon: Play, title: 'Run this stage a single time, with its values filled in' },
  { mode: 'iterate', label: 'Iterate', icon: Rows3, title: 'Give this stage its own table: one pass per row' },
  { mode: 'optimize', label: 'Optimize', icon: Zap, title: 'Let an optimizer choose this stage’s values, trial by trial' },
];

/**
 * The Run page's Stages tab: a design made of saved workflows, each given its own settings.
 *
 * The Designer already stacks workflows as steps; run from Once, Iterate or Optimize they share
 * one configuration. Here each linked workflow is a stage with its own Once, Iterate table or
 * optimization, and the steps between them run once in between. Every stage is set up on this one
 * page: it opens in place, with the same configurator its Run tab uses (RunWorkflowPage,
 * OptimizeRunPage, drawn without their page around them), so nobody goes back and forth. What is
 * typed is kept as it is typed: there is no Save, and each stage says here whether it is ready or
 * what it still needs.
 *
 * Starting queues every stage as its own run, in order, as one set (src/stages.ts): a stage that
 * has not started can still be changed from the queue, and a stage that fails or is stopped ends
 * the ones after it.
 */
export default function StagesPage() {
  const theme = useDocumentTheme();
  const queueBusy = useQueueBusy();
  // Read after mount (AGENTS.md section 11): the design and its settings live in localStorage.
  const [design, setDesign] = useState<{ stages: Stage[]; problem: string | null } | null>(null);
  const [draft, setDraft] = useState<Record<string, SavedStage>>({});
  const [workflowName, setWorkflowName] = useState('');
  const [experimentName, setExperimentName] = useState('');
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState<string | null>(null);
  // Which stages have been opened, how, and whether they are showing. A panel stays mounted once
  // opened and is only hidden when folded, so folding one does not throw away what was typed in it.
  const [panels, setPanels] = useState<Record<string, { mode: StageMode; open: boolean }>>({});

  useEffect(() => {
    setDesign(currentStages());
    setDraft(readDraft());
    setWorkflowName(localStorage.getItem('ivoryos_editing_workflow') || '');
  }, []);

  const stages = design?.stages || [];
  const hasWorkflow = stages.some((s) => s.kind === 'workflow');
  // A stage is ready when the mode it is set to has everything it needs (or it needs nothing).
  const stateOf = (stage: Stage) => {
    const saved = savedStage(stage, draft);
    const settings = activeSettings(saved);
    const needsSetup = hasOpenValues(stage);
    return { saved, settings, needsSetup, ready: !!settings?.payload || !needsSetup };
  };
  const waiting = stages.filter((s) => !stateOf(s).ready);
  const defaultMode = (stage: Stage): StageMode => savedStage(stage, draft)?.mode || (stage.kind === 'workflow' ? 'iterate' : 'once');
  // A configurator kept something: read it back, so the stage's line says where it stands.
  const refresh = () => setDraft(readDraft());

  // Picking a mode is choosing how the stage runs; its settings for the other modes are kept.
  const show = (stage: Stage, mode: StageMode) => {
    chooseStageMode(stage, mode);
    refresh();
    setPanels((p) => ({ ...p, [stage.key]: { mode, open: !(p[stage.key]?.open && p[stage.key].mode === mode) } }));
  };
  const toggle = (stage: Stage) =>
    setPanels((p) => ({ ...p, [stage.key]: { mode: p[stage.key]?.mode || defaultMode(stage), open: !p[stage.key]?.open } }));

  const forget = (stage: Stage) => {
    clearStage(stage);
    setDraft(readDraft());
    setPanels((p) => { const rest = { ...p }; delete rest[stage.key]; return rest; });
  };

  const start = async () => {
    if (!design || waiting.length || starting) return;
    if (queueBusy && !await confirmDialog('A task is already running. Add these stages to the queue behind it?', {
      title: 'Queue these stages?', confirmLabel: 'Add to queue',
    })) return;
    setStarting(true);
    try {
      const res = await fetch(`${API_BASE}/api/queue/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prefix: `${workflowName || 'Staged'} Run`,
          name: experimentName.trim(),
          // A stage nobody had to set up runs as designed; the others as their configurator built them.
          stages: stages.map((stage) => ({ ...(activeSettings(savedStage(stage, draft))?.payload || plainPayload(stage)), name: stage.name })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        await notify(data.error || 'The edge refused these stages.', { title: 'Nothing was queued', tone: 'error' });
        return;
      }
      setStarted(data.group?.name || 'The stages');
    } catch (e: any) {
      await notify(e.message, { title: 'Could not start', tone: 'error' });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className={`flex h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans overflow-hidden ${theme}`}>
      <Sidebar />
      <div className="flex-1 flex flex-col relative z-0 min-w-0">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-3 px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
          <RunTabs active="stages" />
          {hasWorkflow && (
            <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-white/5 px-2 py-0.5 rounded-full">
              {stages.length} {stages.length === 1 ? 'stage' : 'stages'}
            </span>
          )}
        </header>

        <div className="p-8 flex-1 overflow-y-auto pb-12">
          <div className="max-w-5xl space-y-4">
            {design && !hasWorkflow && (
              <div className="max-w-3xl rounded-xl border-2 border-dashed border-gray-300 dark:border-white/10 px-6 py-8 text-sm text-gray-500 dark:text-gray-400">
                <p className="font-medium text-gray-700 dark:text-gray-200">This design has no saved workflow in it, so there is nothing to split into stages.</p>
                <p className="mt-2">
                  Stages are for a design that stacks saved workflows: each one then gets its own table or its own
                  optimization, instead of sharing one. In the <Link href="/designer" className="underline underline-offset-2">Designer</Link>,
                  drag saved workflows in from the toolbox (as links) with any steps you want between them, then come back.
                </p>
              </div>
            )}

            {design?.problem && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{design.problem}</span>
              </div>
            )}

            {hasWorkflow && !design?.problem && (
              <>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  <b className="font-semibold">{workflowName || 'This design'}</b> runs in {stages.length} stages, one after another.
                  Give each its own settings; nothing is shared between them.
                </p>

                <ol className="space-y-2">
                  {stages.map((stage, index) => {
                    const { saved: kept, settings, needsSetup, ready } = stateOf(stage);
                    const panel = panels[stage.key];
                    const steps = stage.blocks.prep.length + stage.blocks.sequence.length + stage.blocks.cleanup.length;
                    return (
                      <li key={stage.key} className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-white/5">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                          <button
                            type="button"
                            onClick={() => needsSetup && toggle(stage)}
                            disabled={!needsSetup}
                            aria-expanded={!!panel?.open}
                            title={needsSetup ? (panel?.open ? 'Fold' : 'Set up this stage here') : undefined}
                            className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
                          >
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-bold text-gray-600 dark:bg-white/10 dark:text-gray-300">{index + 1}</span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2">
                                {stage.kind === 'workflow'
                                  ? <Workflow className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                                  : <Wrench className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
                                <span className="truncate text-sm font-semibold" title={stage.name}>{stage.name}</span>
                                <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-gray-400">{stage.kind === 'workflow' ? 'workflow' : `${steps} ${steps === 1 ? 'step' : 'steps'}`}</span>
                              </span>
                              <span className="mt-0.5 flex items-center gap-1.5 text-xs">
                                {kept && settings?.payload ? (
                                  <>
                                    <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                                    <span className="text-gray-700 dark:text-gray-200">{stageSummary(kept.mode, settings.payload)}</span>
                                  </>
                                ) : ready ? (
                                  <>
                                    <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                                    <span className="text-gray-500 dark:text-gray-400">Nothing to fill in: runs once, as designed</span>
                                  </>
                                ) : settings?.problem ? (
                                  // Typed, kept, and not yet a run: what is still missing.
                                  <span className="truncate font-medium text-amber-700 dark:text-amber-300" title={settings.problem}>Not ready: {settings.problem}</span>
                                ) : (
                                  <span className="font-medium text-amber-700 dark:text-amber-300">Not set up yet: choose how it runs</span>
                                )}
                              </span>
                            </span>
                          </button>
                          {kept && (
                            <button type="button" onClick={() => forget(stage)} title="Forget these settings" aria-label="Forget these settings" className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-white/10">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {needsSetup && (
                            <>
                              <div className="flex shrink-0 items-center gap-1 rounded-lg bg-gray-100 p-0.5 dark:bg-white/5">
                                {MODES.map(({ mode, label, icon: Icon, title }) => {
                                  // Lit: how the stage is set to run.
                                  const chosen = kept?.mode === mode;
                                  return (
                                    <button key={mode} type="button" onClick={() => show(stage, mode)} title={title} aria-pressed={chosen}
                                      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                                        chosen ? 'bg-white text-accent-fg shadow-sm ring-1 ring-accent-tint/60 dark:bg-accent-soft dark:ring-0'
                                          : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
                                      }`}>
                                      <Icon className="h-3.5 w-3.5" />
                                      {label}
                                    </button>
                                  );
                                })}
                              </div>
                              <button type="button" onClick={() => toggle(stage)} aria-label={panel?.open ? 'Fold' : 'Unfold'} className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10">
                                {panel?.open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              </button>
                            </>
                          )}
                        </div>

                        {panel && (
                          <div className={`border-t border-gray-200 bg-gray-50/70 px-4 py-4 dark:border-white/10 dark:bg-black/20 ${panel.open ? '' : 'hidden'}`}>
                            {/* Keyed by mode: switching mode is a different configurator, started afresh. */}
                            {panel.mode === 'optimize'
                              ? <OptimizeRunPage key={`${stage.key}:optimize`} stage={{ index, onChange: refresh }} />
                              : <RunWorkflowPage key={`${stage.key}:${panel.mode}`} mode={panel.mode} stage={{ index, onChange: refresh }} />}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>

                <p className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <ListOrdered className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Each stage is queued as its own run, so one that has not started can still be changed from the queue.
                    If a stage fails or is stopped, the stages after it are not run.
                  </span>
                </p>

                {started && (
                  <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-500/30 dark:bg-green-900/20 dark:text-green-200">
                    Queued as <b className="font-semibold">{started}</b>: {stages.length} runs, in this order.
                  </div>
                )}

                <div className="flex flex-col items-end gap-2 pt-2">
                  <input
                    type="text"
                    value={experimentName}
                    onChange={(e) => setExperimentName(e.target.value)}
                    placeholder="Experiment name (optional)"
                    title="Names the whole set; each stage's run adds its own name"
                    className="w-56 px-3 py-2 rounded-lg text-sm bg-white border border-gray-200 text-gray-700 placeholder:text-gray-400 focus:outline-none focus:border-green-400 dark:bg-black/50 dark:border-white/10 dark:text-gray-200 dark:placeholder:text-gray-500"
                  />
                  <button
                    type="button"
                    onClick={start}
                    disabled={waiting.length > 0 || starting}
                    title={waiting.length ? `Set up first: ${waiting.map((s) => s.name).join(', ')}` : undefined}
                    className="flex items-center space-x-2 px-6 py-3 bg-green-600 hover:bg-green-700 dark:hover:bg-green-500 text-white rounded-xl transition-colors font-bold shadow-lg shadow-green-500/20 disabled:opacity-40 disabled:shadow-none"
                  >
                    <Play className="w-5 h-5" />
                    <span>{starting ? 'Queueing…' : queueBusy ? `Add ${stages.length} stages to queue` : `Run ${stages.length} stages`}</span>
                  </button>
                  {waiting.length > 0 && (
                    <span className="text-xs text-amber-700 dark:text-amber-300">{waiting.length === 1 ? `"${waiting[0].name}" is` : `${waiting.length} stages are`} not set up yet.</span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        {/* Below the scrolling page, as on the other run tabs: the run is watched where it started. */}
        <LiveRun />
      </div>
    </div>
  );
}
