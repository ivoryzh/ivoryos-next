"use client";
import { API_BASE } from '@/config';
import { LIBRARY_INSTRUMENT, isFlowControlInstrument, sequenceSegments, toWireBlock } from '@ivoryos/shared-ui';
import { sourceBlock } from '@/queuedEdit';

/**
 * A design run in stages.
 *
 * A design whose steps are saved workflows is already an orchestration; what it lacked was a way
 * to give each workflow its own settings. Run as one, everything shares one table: the solids a
 * sample gets and the solvents it gets have to be columns of the same rows. In stages, each linked
 * workflow is configured on its own (Once, its own Iterate table of whatever length, or its own
 * optimization) with the same three configurators the Run tabs use, and the steps between them (a
 * tare, a "swap the plate" prompt) run once in between.
 *
 * Each stage is queued as its own run, in order, tagged as one set (`parameters.group`, edge:
 * POST /api/queue/groups). Separate runs are what keep a stage editable until it starts; the set
 * is what makes them one experiment: accepted or refused together, and a stage that fails or is
 * stopped ends the ones after it.
 *
 * Nothing is shared between stages: each one's open values are its own, and each keeps its own
 * record and table in Data History.
 */

export type StageMode = 'once' | 'iterate' | 'optimize';

export type Stage = {
  /** Position and name: what a saved configuration is kept under. */
  key: string;
  name: string;
  kind: 'workflow' | 'steps';
  blocks: { prep: any[]; sequence: any[]; cleanup: any[] };
};

/**
 * What a stage holds for one way of running it: what was typed (`state`, the configurator's own),
 * and the run that makes (`payload`) once nothing is missing; until then `problem` says what is.
 */
export type StageSettings = { state?: any; payload: any | null; problem?: string | null };

/**
 * One stage's settings, kept as they are typed: there is no Save. `mode` is how the stage will
 * run; each mode keeps its own settings, so trying Optimize does not cost the Iterate table.
 */
export type SavedStage = { signature: string; mode: StageMode; modes: Partial<Record<StageMode, StageSettings>> };

const DRAFT_KEY = 'ivoryos_stages';

const isLink = (b: any) => b?.instrument === LIBRARY_INSTRUMENT;

/**
 * A linked workflow as a stage: an input the step gives no value for is open, written the way the
 * pages expect an open value, `#name`. A freshly dropped link carries no arguments at all; left
 * that way the Optimize page found nothing to search over, while Iterate (which opens the link
 * out) found every input.
 */
const withOpenInputs = (b: any) => ({
  ...b,
  params: {
    ...Object.fromEntries(Object.keys(b?.schema?.parameters || {}).map((name) => [name, `#${name}`])),
    ...Object.fromEntries(Object.entries(b?.params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')),
  },
});

const stepsName = (blocks: any[]) => {
  const first = blocks.find((b) => !isFlowControlInstrument(b?.instrument)) || blocks[0];
  const label = isFlowControlInstrument(first?.instrument)
    ? String(first?.method || 'step').replace(/_/g, ' ')
    : `${first?.instrument} ${first?.method}`.replace(/_/g, ' ');
  return blocks.length > 1 ? `${label} + ${blocks.length - 1} more` : label;
};

/**
 * Cut a design into stages: each linked workflow in Main is one, and each run of other steps
 * between them is one. The design's Prep goes with the first stage and its Cleanup with the last,
 * so they still run once, at the two ends.
 *
 * An If or While that wraps a workflow cannot be cut: its two ends would land in different runs.
 * That is reported as `problem`, and the design can still be run as one.
 */
export function deriveStages(prep: any[], sequence: any[], cleanup: any[]): { stages: Stage[]; problem: string | null } {
  const out: Omit<Stage, 'key'>[] = [];
  let loose: any[] = [];
  let problem: string | null = null;
  const flush = () => {
    if (!loose.length) return;
    out.push({ name: stepsName(loose), kind: 'steps', blocks: { prep: [], sequence: loose, cleanup: [] } });
    loose = [];
  };
  for (const segment of sequenceSegments(sequence || [])) {
    const blocks = sequence.slice(segment.start, segment.end + 1);
    if (blocks.length === 1 && isLink(blocks[0])) {
      flush();
      out.push({ name: String(blocks[0].method), kind: 'workflow', blocks: { prep: [], sequence: [withOpenInputs(blocks[0])], cleanup: [] } });
    } else {
      const wrapped = blocks.find(isLink);
      if (wrapped) problem = `"${wrapped.method}" is inside an If or While, so this design cannot be split into stages there. Move it out of the ${blocks[0].method}, or run the design as one.`;
      loose.push(...blocks);
    }
  }
  flush();
  if (!out.length && ((prep || []).length || (cleanup || []).length)) {
    out.push({ name: 'Steps', kind: 'steps', blocks: { prep: [], sequence: [], cleanup: [] } });
  }
  if (out.length) {
    out[0].blocks.prep = prep || [];
    out[out.length - 1].blocks.cleanup = cleanup || [];
  }
  return { stages: out.map((p, i) => ({ ...p, key: `${i}:${p.name}` })), problem };
}

const read = (key: string) => {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
};

/** The stages of the design the Designer currently holds. */
export function currentStages() {
  return deriveStages(read('ivoryos_prep_sequence'), read('ivoryos_sequence'), read('ivoryos_cleanup_sequence'));
}

/** What a stage does, without what only describes it: settings saved for different steps are stale. */
export const stageSignature = (stage: Stage) =>
  JSON.stringify([stage.blocks.prep, stage.blocks.sequence, stage.blocks.cleanup].map((list) => list.map(sourceBlock)));

export function readDraft(): Record<string, SavedStage> {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') || {}; } catch { return {}; }
}

/** A stage's saved settings, unless the design has changed under them. */
export function savedStage(stage: Stage, draft = readDraft()): SavedStage | null {
  const saved = draft[stage.key];
  return saved && saved.signature === stageSignature(stage) ? saved : null;
}

/** The settings a stage will run with: those of the mode it is set to. */
export const activeSettings = (saved: SavedStage | null | undefined): StageSettings | undefined =>
  saved ? saved.modes?.[saved.mode] : undefined;

const write = (stage: Stage, change: (entry: SavedStage) => void) => {
  const draft = readDraft();
  const kept = savedStage(stage, draft);
  const entry: SavedStage = kept ? { ...kept, modes: { ...kept.modes } } : { signature: stageSignature(stage), mode: 'once', modes: {} };
  change(entry);
  draft[stage.key] = entry;
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
};

/** Choose how a stage runs. Its settings for the other modes are kept. */
export function chooseStageMode(stage: Stage, mode: StageMode) {
  write(stage, (entry) => { entry.mode = mode; });
}

/** Keep what a configurator holds for one mode of a stage. Called as it changes. */
export function saveStageSettings(stage: Stage, mode: StageMode, settings: StageSettings) {
  write(stage, (entry) => {
    // The first settings a stage ever gets decide how it runs, until a mode is chosen.
    if (!Object.keys(entry.modes).length) entry.mode = mode;
    entry.modes[mode] = settings;
  });
}

export function clearStage(stage: Stage) {
  const draft = readDraft();
  delete draft[stage.key];
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

/** How a configurator is told it is setting up one stage, inline on the Stages page. */
export type EmbeddedStage = { index: number; onChange: () => void };

export type LoadedStage = { stage: Stage; index: number; total: number; settings: StageSettings | null; instruments: Record<string, any> };

/** What a configurator needs for one stage: its blocks, and what was last typed for this mode. */
export async function loadStage(index: number, mode: StageMode): Promise<LoadedStage> {
  const { stages } = currentStages();
  const stage = stages[index];
  if (!stage) throw new Error('That stage is no longer in the design.');
  const status = await fetch(`${API_BASE}/api/status`).then((r) => r.json()).catch(() => ({}));
  return { stage, index, total: stages.length, settings: savedStage(stage)?.modes?.[mode] || null, instruments: status?.instruments || {} };
}

const hasHash = (value: unknown): boolean =>
  typeof value === 'string' ? value.trim().startsWith('#')
    : !!value && typeof value === 'object' && Object.values(value as object).some(hasHash);

/**
 * Whether anything in the stage is still open. One with nothing to fill in needs no visit to a page.
 *
 * A linked workflow's inputs are its schema's parameters, and one the step gives no value for is
 * open too: a freshly dropped link carries no arguments at all, which is every input left open,
 * not none.
 */
export const hasOpenValues = (stage: Stage) =>
  [...stage.blocks.prep, ...stage.blocks.sequence, ...stage.blocks.cleanup].some((b) => {
    if (hasHash(b?.params)) return true;
    if (!isLink(b)) return false;
    return Object.keys(b?.schema?.parameters || {}).some((name) => {
      const given = b?.params?.[name];
      return given === undefined || given === null || given === '';
    });
  });

/** A stage with nothing to fill in, as the run it is: its steps once, exactly as designed. */
export function plainPayload(stage: Stage) {
  const { prep, sequence, cleanup } = stage.blocks;
  return {
    parameters: {
      type: 'Simple',
      sequence_template: sequence.map((b) => ({
        instrument: b.instrument, method: b.method, returnVar: b.returnVar || null, returnBindings: b.returnBindings || null,
      })),
      // So the queue can open it on the Once page like any other queued run (queuedEdit.ts).
      _source: { page: 'once', prep: prep.map(sourceBlock), sequence: sequence.map(sourceBlock), cleanup: cleanup.map(sourceBlock), globalValues: {} },
    },
    prep: prep.map(toWireBlock),
    sequence: sequence.map(toWireBlock),
    cleanup: cleanup.map(toWireBlock),
  };
}

/** How a stage that is ready reads in the list: "Iterate · 12 rows". */
export function stageSummary(mode: StageMode, payload: any): string {
  const p = payload?.parameters || {};
  if (p.type === 'Optimization') return `Optimize · ${p.budget ?? '?'} trials${p.optimizer ? ` · ${p.optimizer}` : ''}`;
  if (mode === 'iterate' && p.type === 'Spreadsheet') {
    const rows = (p.rows || []).length;
    return `Iterate · ${rows} ${rows === 1 ? 'row' : 'rows'}${Number(p.batch_size) > 1 ? ` · batches of ${p.batch_size}` : ''}`;
  }
  return 'Once';
}

/**
 * For a configurator drawn inside the Stages page: keep its settings as they change.
 *
 * Returns a function to call with the current state and a builder for the run it makes; it
 * skips a state identical to the last one it kept, so opening a stage to look at it writes
 * nothing. A state that cannot make a run yet is kept all the same, with why.
 */
export function stageKeeper(stage: Stage, mode: StageMode, loadedState: unknown, onChange: () => void) {
  let last = JSON.stringify(loadedState ?? null);
  return (state: unknown, build: () => any) => {
    const now = JSON.stringify(state);
    if (now === last) return;
    last = now;
    let payload: any = null;
    let problem: string | null = null;
    try { payload = build(); } catch (e: any) { problem = e?.message || 'Not complete yet.'; }
    saveStageSettings(stage, mode, { state, payload, problem });
    onChange();
  };
}
