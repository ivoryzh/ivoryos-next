/**
 * Conversion between the editor's `SequenceBlock[]` and the saved "legacy IvoryOS" workflow JSON,
 * plus the copy/link reuse helpers built on top of it.
 *
 * This lives in shared-ui because the same conversion was previously written out three times —
 * `formatBlocks`/`migrateBlocks` in the Edge Designer, again in the Cloud sequence editor, and a
 * third partial copy in the Library page's `mapScriptToBlocks`. AGENTS.md section 3 records that
 * this family of duplicated Designer logic has already drifted out of sync twice. Reuse makes the
 * cost of drift much higher than it used to be: if the two apps disagree about what a saved block
 * means, they disagree about what a shared protocol does.
 */

import type { SequenceBlock } from './WorkflowEditor';

export const LIBRARY_INSTRUMENT = 'Library Workflows';

/** A block in the saved JSON (`{instrument, action, args, ...}`), as written by `toSavedBlocks`. */
export type SavedBlock = Record<string, any>;

export type SavedWorkflowBody = {
  name?: string;
  description?: string;
  prep?: SavedBlock[];
  script?: SavedBlock[];
  sequence?: SavedBlock[];
  cleanup?: SavedBlock[];
  version?: number;
  body_hash?: string;
  updated_at?: number;
  [key: string]: any;
};

/** How a saved workflow was brought into another workflow. See `reuseWorkflow`. */
export type ReuseMode = 'copy' | 'link';

let blockCounter = 0;

export function newBlockId(): string {
  // Date.now() alone collides when a copy inlines a dozen blocks inside the same millisecond, and
  // duplicate ids make react-beautiful-dnd silently drop rows. The counter makes it total.
  blockCounter += 1;
  return `block-${Date.now()}-${blockCounter}-${Math.random().toString(36).slice(2, 9)}`;
}

function lookupSchema(instruments: any, instrument: string, method: string): any {
  const found = instruments?.[instrument]?.[method];
  return found || { parameters: {} };
}

/** Saved JSON block -> editor block. Tolerates both the `action`/`args` and `method`/`params` shapes. */
export function toSequenceBlock(saved: SavedBlock, instruments: any = {}): SequenceBlock {
  const instrument = (saved.instrument || saved.module || 'unknown').replace('deck.', '');
  const method = saved.action || saved.method || 'unknown';
  return {
    id: newBlockId(),
    instrument,
    method,
    schema: lookupSchema(instruments, instrument, method),
    params: saved.args || saved.params || {},
    returnVar: saved.return || saved.returnVar || '',
    isExpanded: false,
    isBatchAction: !!(saved.batch_action ?? saved.isBatchAction),
    ...(saved.ref ? { ref: saved.ref } : {}),
    ...(saved.group ? { group: saved.group } : {}),
  };
}

export function newGroupId(): string {
  return `grp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Consecutive blocks sharing a `group.id` are one group.
 *
 * Groups are **organisation, not linkage**: they exist so a batch of steps reads as one thing on
 * the canvas and can be collapsed, moved and deleted together. A group created by copying a saved
 * workflow remembers where it came from (`group.from`) as a label, but it tracks nothing — version
 * updates are a *link* concept, and conflating the two is what made copy and link look alike.
 */
export function groupBounds(blocks: SequenceBlock[]): Map<number, { id: string; name: string; from?: { name: string; version?: number }; size: number }> {
  const bounds = new Map<number, { id: string; name: string; from?: { name: string; version?: number }; size: number }>();
  let index = 0;
  while (index < blocks.length) {
    const group = blocks[index]?.group;
    if (!group?.id) { index += 1; continue; }
    let end = index;
    while (end + 1 < blocks.length && blocks[end + 1]?.group?.id === group.id) end += 1;
    bounds.set(index, { id: group.id, name: group.name, from: group.from, size: end - index + 1 });
    index = end + 1;
  }
  return bounds;
}

export function toSequenceBlocks(saved: SavedBlock[] | undefined, instruments: any = {}): SequenceBlock[] {
  const blocks = (saved || []).map(b => toSequenceBlock(b, instruments));

  // Adopt the older `copied_from` shape: a run of consecutive blocks naming the same source was a
  // group before groups had their own identity, so give each such run one.
  let index = 0;
  while (index < blocks.length) {
    const legacy = (saved || [])[index]?.copied_from || (saved || [])[index]?.copiedFrom;
    if (!legacy || blocks[index].group) { index += 1; continue; }
    let end = index;
    const same = (other: any) => other
      && other.name === legacy.name && other.version === legacy.version;
    while (end + 1 < blocks.length
           && !blocks[end + 1].group
           && same((saved || [])[end + 1]?.copied_from || (saved || [])[end + 1]?.copiedFrom)) {
      end += 1;
    }
    const id = newGroupId();
    for (let i = index; i <= end; i++) {
      blocks[i] = { ...blocks[i], group: { id, name: legacy.name, from: legacy } };
    }
    index = end + 1;
  }

  return blocks;
}

/** Editor block -> saved JSON block. */
export function toSavedBlock(block: SequenceBlock, index: number): SavedBlock {
  const argTypes: Record<string, string> = {};
  if (block.schema && block.schema.parameters) {
    for (const [key, paramObj] of Object.entries(block.schema.parameters)) {
      argTypes[key] = (paramObj as any).type || 'str';
    }
  }

  return {
    id: index + 1,
    uuid: Math.floor(Math.random() * 1000000000),
    instrument: block.instrument,
    action: block.method,
    args: block.params,
    arg_types: argTypes,
    return: block.returnVar || '',
    batch_action: !!block.isBatchAction,
    consolidate_batch_args: false,
    // Reuse provenance has to survive the round trip: `ref` is what makes a link resolve to a
    // specific saved version at run time, and `copied_from` is what lets the Designer tell the user
    // their copy has fallen behind its source.
    ...(block.ref ? { ref: block.ref } : {}),
    ...(block.group ? { group: block.group } : {}),
  };
}

export function toSavedBlocks(blocks: SequenceBlock[]): SavedBlock[] {
  return (blocks || []).map(toSavedBlock);
}

export function buildSavedBody(
  name: string,
  description: string,
  prep: SequenceBlock[],
  sequence: SequenceBlock[],
  cleanup: SequenceBlock[],
): SavedWorkflowBody {
  return {
    name,
    description,
    prep: toSavedBlocks(prep),
    script: toSavedBlocks(sequence),
    cleanup: toSavedBlocks(cleanup),
  };
}

/** Every block of a saved body in execution order, phases flattened. */
export function flattenSavedBody(body: SavedWorkflowBody | undefined): SavedBlock[] {
  if (!body) return [];
  return [
    ...(body.prep || []),
    ...(body.script || body.sequence || []),
    ...(body.cleanup || []),
  ];
}

/** `#var` placeholders a saved body exposes for its caller to fill in. */
export function scanDynamicParams(body: SavedWorkflowBody | undefined): Record<string, any> {
  const params: Record<string, any> = {};
  flattenSavedBody(body).forEach((b: any) => {
    Object.entries(b.args || b.params || {}).forEach(([key, value]) => {
      if (typeof value === 'string' && value.startsWith('#')) {
        const paramName = value.substring(1);
        const paramType = (b.arg_types && b.arg_types[key]) || 'str';
        params[paramName] = { type: paramType, required: true };
      }
    });
  });
  return params;
}

/**
 * Bring a saved workflow into the sequence being edited.
 *
 * `link` is the default: it keeps a single reference block that resolves at run time, so the saved
 * workflow stays one thing and an edit to it reaches everywhere it is used. It pins the version it
 * was created against, so the step keeps running the body it was built with until someone
 * explicitly updates it.
 *
 * `copy` inlines the blocks instead — immediately editable, with no dependency on the source. That
 * is the right choice when you want to take a protocol and diverge from it, but as a default it
 * forks the protocol every time someone reuses it, which is how a library stops being one.
 */
export function reuseWorkflow(
  name: string,
  body: SavedWorkflowBody | undefined,
  instruments: any,
  mode: ReuseMode,
): SequenceBlock[] {
  if (mode === 'copy' && body) {
    // One group, so the steps arrive as a single collapsible unit rather than loose on the canvas.
    // `from` is a label recording where they came from — it creates no ongoing relationship.
    const group = { id: newGroupId(), name, from: { name, version: body.version } };
    return flattenSavedBody(body).map(saved => ({
      ...toSequenceBlock(saved, instruments),
      // A copied block must not keep the source's own link metadata as if it were its own.
      ref: undefined,
      group,
    }));
  }

  return [{
    id: newBlockId(),
    instrument: LIBRARY_INSTRUMENT,
    method: name,
    schema: { parameters: scanDynamicParams(body), description: body?.description || '', return_type: 'None' },
    params: {},
    returnVar: '',
    isExpanded: true,
    ref: {
      name,
      version: body?.version,
      body_hash: body?.body_hash,
      mode: 'pinned',
    },
  }];
}

/** Turn a link block back into an owned, editable copy of the workflow it points at. */
export function detachLink(
  block: SequenceBlock,
  body: SavedWorkflowBody | undefined,
  instruments: any,
): SequenceBlock[] {
  const name = block.ref?.name || block.method;
  const copied = reuseWorkflow(name, body, instruments, 'copy');
  if (!copied.length) return [block];

  // Carry the caller's filled-in #var values into the now-inlined blocks, so detaching a
  // configured step doesn't quietly discard its configuration.
  const callerParams = block.params || {};
  return copied.map(b => ({
    ...b,
    params: Object.fromEntries(
      Object.entries(b.params || {}).map(([key, value]) => {
        if (typeof value === 'string' && value.startsWith('#')) {
          const varName = value.substring(1);
          if (callerParams[varName] !== undefined && callerParams[varName] !== '') {
            return [key, callerParams[varName]];
          }
        }
        return [key, value];
      })
    ),
  }));
}

// --- diffing ------------------------------------------------------------------------------------

/** A step reduced to just what a comparison cares about, from either block shape. */
export type DiffStep = {
  instrument: string;
  method: string;
  params: Record<string, any>;
  returnVar: string;
  batch: boolean;
};

export type StepChange = { key: string; from: any; to: any };

export type DiffRow =
  | { kind: 'same' | 'changed'; before: DiffStep; after: DiffStep; changes: StepChange[] }
  | { kind: 'added'; after: DiffStep }
  | { kind: 'removed'; before: DiffStep };

export function toDiffStep(block: any): DiffStep {
  return {
    instrument: String(block.instrument || block.module || '').replace('deck.', ''),
    method: String(block.action || block.method || ''),
    params: block.args || block.params || {},
    returnVar: String(block.return ?? block.returnVar ?? ''),
    batch: !!(block.batch_action ?? block.isBatchAction),
  };
}

const stepSignature = (step: DiffStep) => `${step.instrument}.${step.method}`;

function changesBetween(before: DiffStep, after: DiffStep): StepChange[] {
  const changes: StepChange[] = [];
  const keys = new Set([...Object.keys(before.params || {}), ...Object.keys(after.params || {})]);
  keys.forEach(key => {
    const from = (before.params || {})[key];
    const to = (after.params || {})[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ key, from, to });
  });
  if (before.returnVar !== after.returnVar) {
    changes.push({ key: 'saves as', from: before.returnVar || '—', to: after.returnVar || '—' });
  }
  if (before.batch !== after.batch) {
    changes.push({
      key: 'runs',
      from: before.batch ? 'once per batch' : 'once per row',
      to: after.batch ? 'once per batch' : 'once per row',
    });
  }
  return changes;
}

/**
 * Step-by-step comparison of two versions of a workflow.
 *
 * Aligned by a longest-common-subsequence over `instrument.method`, so inserting one step in the
 * middle reads as a single addition rather than shifting everything after it into "changed" — the
 * difference between a diff someone can act on and a wall of noise. Aligned pairs are then compared
 * on parameters, output variable and per-sample/batch mode.
 */
export function diffSteps(beforeBlocks: any[], afterBlocks: any[]): DiffRow[] {
  const before = (beforeBlocks || []).map(toDiffStep);
  const after = (afterBlocks || []).map(toDiffStep);
  const n = before.length;
  const m = after.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = stepSignature(before[i]) === stepSignature(after[j])
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (stepSignature(before[i]) === stepSignature(after[j])) {
      const changes = changesBetween(before[i], after[j]);
      rows.push({ kind: changes.length ? 'changed' : 'same', before: before[i], after: after[j], changes });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: 'removed', before: before[i++] });
    } else {
      rows.push({ kind: 'added', after: after[j++] });
    }
  }
  while (i < n) rows.push({ kind: 'removed', before: before[i++] });
  while (j < m) rows.push({ kind: 'added', after: after[j++] });
  return rows;
}

export function summariseDiff(rows: DiffRow[]) {
  return {
    added: rows.filter(r => r.kind === 'added').length,
    removed: rows.filter(r => r.kind === 'removed').length,
    changed: rows.filter(r => r.kind === 'changed').length,
    same: rows.filter(r => r.kind === 'same').length,
  };
}

/** The output variable names a block writes. `returnVar` holds a comma-separated list for tuples. */
export function returnVarNames(block: SequenceBlock): string[] {
  return String(block.returnVar || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** Every output variable name already in use across the given blocks. */
export function collectReturnVars(blocks: SequenceBlock[]): Set<string> {
  const names = new Set<string>();
  (blocks || []).forEach(block => returnVarNames(block).forEach(name => names.add(name)));
  return names;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `#name` not followed by another name character, so renaming `rate` never mangles `#rate_limit`.
const referenceTo = (name: string) => new RegExp(`#${escapeRegExp(name)}(?![A-Za-z0-9_])`, 'g');

/**
 * Rename any output variable in `blocks` that is already taken in the destination workflow, and
 * rewrite the copy's own `#references` to match.
 *
 * Copying a protocol brings its outputs along, which is right — its later steps may read them, and
 * Data History names result columns after them. But two steps writing the same name silently
 * overwrite each other in `workflow_context`, so a copied `objective` would clobber the one already
 * in the workflow and any `#objective` would resolve to whichever ran last. Renaming keeps the
 * copy's internal wiring intact while making that collision impossible.
 */
export function uniquifyReturnVars(
  blocks: SequenceBlock[],
  taken: Set<string>,
): { blocks: SequenceBlock[]; renamed: { from: string; to: string }[] } {
  const rename = new Map<string, string>();
  const used = new Set(taken);

  (blocks || []).forEach(block => returnVarNames(block).forEach(name => {
    if (rename.has(name)) return;
    if (!used.has(name)) { used.add(name); return; }
    let suffix = 2;
    let candidate = `${name}_${suffix}`;
    while (used.has(candidate)) candidate = `${name}_${++suffix}`;
    used.add(candidate);
    rename.set(name, candidate);
  }));

  if (rename.size === 0) return { blocks, renamed: [] };

  const rewrite = (value: any): any => {
    if (typeof value === 'string') {
      let out = value;
      rename.forEach((to, from) => { out = out.replace(referenceTo(from), `#${to}`); });
      return out;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, rewrite(val)]));
    }
    return value;
  };

  return {
    blocks: blocks.map(block => ({
      ...block,
      returnVar: returnVarNames(block).map(name => rename.get(name) || name).join(', '),
      params: rewrite(block.params || {}),
    })),
    renamed: [...rename.entries()].map(([from, to]) => ({ from, to })),
  };
}

/**
 * Which group a block dropped at `index` should belong to.
 *
 * It joins a group only when it lands *inside* one — both neighbours in the same group — so
 * dragging a step out of a group by definition leaves it, and dropping one between two members
 * takes it in. Landing on a group's edge counts as outside, which is what makes "drag it out"
 * reachable without having to drop it far away.
 */
export function groupAt(blocks: SequenceBlock[], index: number): SequenceBlock['group'] | undefined {
  const before = blocks[index - 1]?.group;
  const after = blocks[index + 1]?.group;
  if (before?.id && before.id === after?.id) return before;
  return undefined;
}
