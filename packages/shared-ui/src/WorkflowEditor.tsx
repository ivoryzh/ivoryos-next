"use client";

import React, { useState, useEffect, useRef } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { GripVertical, Trash2, Settings2, ChevronDown, ChevronUp, AlertTriangle, Eye, EyeOff, Info, PanelRightClose, PanelRightOpen, ChevronsDownUp, ChevronsUpDown, ChevronRight, Search, Hash, Layers, Link2, Copy, Scissors, ListChecks } from 'lucide-react';
import {
  LIBRARY_INSTRUMENT,
  collectReturnVars,
  detachLink,
  groupAt,
  groupBounds,
  newGroupId,
  diffSteps,
  flattenSavedBody,
  reuseWorkflow,
  scanDynamicParams,
  uniquifyReturnVars,
  type DiffRow,
  type ReuseMode,
} from './workflowBody';
import { confirmDialog, notify, promptDialog } from './dialogs';
import { ExtraArguments } from './ExtraArguments';
import { WorkflowPeek, type WorkflowPeekTarget } from './WorkflowPeek';
import { WorkflowDiff } from './WorkflowDiff';

// One named variable bound to one addressable leaf of a step's return value. `path` is the
// dotted pointer the backend's introspection published in `schema.return_paths`
// ("metrics.purity", "0" for a tuple element, "" for the whole result).
export type ReturnBinding = { path: string; var: string };

export type SequenceBlock = {
  id: string;
  instrument: string;
  method: string;
  schema: any;
  params: Record<string, any>;
  isExpanded?: boolean;
  // Flat, comma-separated variable names, in leaf order. Still the canonical list every other
  // page reads (Optimize objectives, Data History columns, codegen), and still what the backend
  // falls back to positionally — `returnBindings` is what makes each name point at a *specific*
  // field rather than at whatever came out in that position.
  returnVar?: string;
  returnBindings?: ReturnBinding[];
  isHidden?: boolean;
  // Only meaningful in the Main Workflow. Default (false/undefined) = "per-sample": when run
  // against a spreadsheet, this step repeats once per row. true = "batch": the step runs once
  // per batch group (a configurable number of consecutive rows, e.g. 4 samples heated together),
  // not once per row — its #vars are read from whichever one row in the group has them filled in.
  isBatchAction?: boolean;
  // Set on a *linked* block (instrument === 'Library Workflows'): it stays a single collapsed
  // reference and resolves to the named saved workflow at run time, so editing that workflow
  // changes this one too. Pinned to a version by default.
  ref?: { name: string; version?: number; body_hash?: string; mode?: 'pinned' | 'latest' };
  // Consecutive blocks sharing a `group.id` form one group. A group is **organisation only** —
  // a way to collapse, move and delete a run of steps as one. Copying a saved workflow creates one
  // (with `from` recording where the steps came from), and groups can also be made by hand. It
  // establishes no relationship with the source: version updates belong to `ref` links.
  group?: { id: string; name: string; from?: { name: string; version?: number } };
};

export type ReturnLeaf = { path: string; type: string; numeric: boolean };

const isNumericTypeName = (t: string | undefined): boolean => {
  const bare = String(t || '').replace(/Optional\[|\]/g, '').trim();
  return bare === 'int' || bare === 'float';
};

/** A method's return value flattened into the individual leaves a variable can be bound to.
 *
 * A driver method rarely returns one bare number — it returns a dataclass or Pydantic model
 * holding several numbers plus metadata, and an optimizer can only take numbers. The backend
 * publishes those leaves as `return_paths` (dotted for nesting, index for a fixed-length tuple,
 * empty for a scalar, each flagged `numeric`). The fallbacks below derive the same thing from
 * `return_info`/`return_type` so a sequence saved against an older schema still renders.
 */
export const getReturnLeaves = (schema: any): ReturnLeaf[] => {
  if (!schema) return [];
  if (Array.isArray(schema.return_paths)) return schema.return_paths as ReturnLeaf[];

  const returnType: string = schema.return_type || 'None';
  if (returnType === 'None' || returnType === 'NoneType') return [];

  const info = schema.return_info;
  if (info?.is_object && info.fields) {
    return Object.keys(info.fields).map(k => ({
      path: k,
      type: info.fields[k]?.type || 'Any',
      numeric: isNumericTypeName(info.fields[k]?.type),
    }));
  }
  const tupleMatch = returnType.match(/tuple\[(.*)\]/i);
  if (tupleMatch && tupleMatch[1] && !tupleMatch[1].includes('...')) {
    return tupleMatch[1].split(',').map((t, i) => ({ path: String(i), type: t.trim(), numeric: isNumericTypeName(t) }));
  }
  return [{ path: '', type: returnType, numeric: isNumericTypeName(returnType) }];
};

/** The variable name currently bound to one leaf. Falls back to the flat `returnVar` list by
 *  position, so a sequence saved before pointers existed still shows its names in the right
 *  boxes (and keeps them there until the user edits one). */
export const getBoundVar = (block: { returnVar?: string; returnBindings?: ReturnBinding[] }, leaf: ReturnLeaf, leaves: ReturnLeaf[]): string => {
  const explicit = block.returnBindings?.find(b => b.path === leaf.path);
  if (explicit) return explicit.var || '';
  if (block.returnBindings?.length) return '';
  const parts = String(block.returnVar || '').split(',').map(s => s.trim());
  return parts[leaves.findIndex(l => l.path === leaf.path)] || '';
};

interface WorkflowEditorProps {
  statusData: any;
  prepSequence: SequenceBlock[];
  setPrepSequence: (seq: SequenceBlock[]) => void;
  sequence: SequenceBlock[];
  setSequence: (seq: SequenceBlock[]) => void;
  cleanupSequence: SequenceBlock[];
  setCleanupSequence: (seq: SequenceBlock[]) => void;
  header?: React.ReactNode;
  customView?: React.ReactNode;
  /** Pinned to the bottom of the module toolbox, below the instrument list. The Designer
   *  puts the assistant toggle here so the two ways of building a sequence — drag a module
   *  in, or describe what you want — sit in the same column. */
  toolboxFooter?: React.ReactNode;
  /** Hide the module toolbox entirely. The Designer sets this while the assistant panel is
   *  open: the panel takes the column the toolbox was in, because picking a module out of a
   *  list and describing what you want are alternatives, not things you do side by side.
   *  Reordering and editing blocks on the canvas still work — only the drag *source* goes. */
  hideToolbox?: boolean;
  /**
   * Latest saved version per workflow name, from `GET /api/workflows`. Drives the "source has been
   * updated" badge on copied groups and pinned links — the notification that replaces the old
   * behaviour of silently swapping the steps out from under the user.
   */
  workflowVersions?: Record<string, number>;
  /**
   * Loads one exact saved version. Needed by Detach, which must inline the version a step is
   * pinned to rather than the head the toolbox happens to have cached. Without it, Detach on a
   * pinned step is refused instead of quietly substituting different steps.
   */
  fetchWorkflowVersion?: (name: string, version: number) => Promise<any>;
  /**
   * Opens a saved workflow for editing. Only the host page can do this: it owns whatever is
   * currently unsaved on the canvas and has to decide what happens to it first.
   */
  onEditWorkflow?: (name: string, version?: number) => void;
  /**
   * The workflow currently open. Used to keep it out of its own toolbox — a workflow cannot
   * reuse itself, and the server refuses such a save outright, so offering it is a dead end.
   * Tracked as a prop rather than captured when the toolbox is built, because the Designer can
   * switch which workflow it is editing without remounting.
   */
  currentWorkflowName?: string;
}

export default function WorkflowEditor({
  statusData,
  prepSequence,
  setPrepSequence,
  sequence,
  setSequence,
  cleanupSequence,
  setCleanupSequence,
  header,
  customView,
  toolboxFooter,
  hideToolbox,
  workflowVersions,
  fetchWorkflowVersion,
  onEditWorkflow,
  currentWorkflowName
}: WorkflowEditorProps) {
  const [expandedToolbox, setExpandedToolbox] = useState<Record<string, boolean>>({});
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [emptyHashFields, setEmptyHashFields] = useState<Set<string>>(new Set());
  const [autoFillVariables, setAutoFillVariables] = useState(false);
  // Copy is the default: dragging a saved workflow in inlines its steps so they can be edited on
  // the spot, which is what people overwhelmingly mean by reuse. Link is the deliberate exception
  // for shared boilerplate that should change everywhere at once.
  // Link, not copy. Dropping a saved workflow in should keep it *one* thing: edit the source and
  // every sequence using it follows. Copy inlines the steps and quietly forks the protocol, which
  // is occasionally what you want but a poor thing to get by default.
  const [reuseMode, setReuseMode] = useState<ReuseMode>('link');
  // Copied groups start collapsed — dropping a twelve-step protocol onto the canvas as twelve
  // loose cards buries whatever else is already there. This tracks the ones the user has opened;
  // absent means collapsed.
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  // Step selection, for grouping several at once. Scoped to one phase: a group is a run of
  // consecutive blocks within a single list, so a selection spanning Prep and Main could not
  // become one. Picking a step in another list starts a fresh selection rather than failing later.
  const [selection, setSelection] = useState<{ listId: string; ids: string[] }>({ listId: '', ids: [] });
  // The linked-workflow drawer. A link's steps live in another workflow, so they are shown
  // read-only beside the canvas rather than expanded into it like a copy's.
  const [peek, setPeek] = useState<
    { target: WorkflowPeekTarget; listId: string; blockId: string } | null
  >(null);
  const [peekBody, setPeekBody] = useState<any>(null);
  const [peekError, setPeekError] = useState<string | null>(null);
  const [peekLoading, setPeekLoading] = useState(false);
  /**
   * `#var` list of each pinned version actually referenced on the canvas, keyed `name@version`.
   *
   * A linked block also carries a snapshot of this on `block.schema`, but that snapshot is only
   * written when the block is created or re-pinned, so it drifts out of step with `ref` — a block
   * pinned to v5 could be rendering v1's (or an empty) parameter list. When it renders *nothing*,
   * a value the step is really passing becomes invisible: the run still substitutes it, and the
   * result can look identical to the newer version by coincidence. Resolving the pinned body is
   * what makes the fields on screen match what will actually run.
   */
  const [pinnedParams, setPinnedParams] = useState<Record<string, Record<string, any>>>({});
  // The "what changes if I update?" modal. Updating replaces real hardware instructions — and for
  // a copy it also discards local edits — so it is shown before, not confirmed blind.
  const [diff, setDiff] = useState<{
    title: string; fromLabel: string; toLabel: string; rows: DiffRow[];
    warning?: string; applyLabel: string; apply: () => void;
    paramChanges?: { added: string[]; removed: { key: string; value: any }[] };
  } | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('ivoryos_autofill_variables');
    if (saved !== null) setAutoFillVariables(saved === 'true');
    const savedReuse = localStorage.getItem('ivoryos_reuse_mode');
    if (savedReuse === 'copy' || savedReuse === 'link') setReuseMode(savedReuse);
  }, []);

  const toggleReuseMode = () => {
    setReuseMode(prev => {
      const next = prev === 'copy' ? 'link' : 'copy';
      localStorage.setItem('ivoryos_reuse_mode', next);
      return next;
    });
  };

  const toggleAutoFillVariables = () => {
    setAutoFillVariables(prev => {
      const next = !prev;
      localStorage.setItem('ivoryos_autofill_variables', String(next));
      return next;
    });
  };

  // Builds a new block's initial params. In auto-fill mode, every leaf parameter (recursing into
  // nested object params) defaults to '#paramName' instead of its schema default, so a block dragged
  // in for optimization is immediately wired up as a variable — just delete the '#' on any param
  // that should stay fixed.
  const buildDefaultParams = (schemaParams: any, useVariables: boolean): Record<string, any> => {
    const result: Record<string, any> = {};
    if (!schemaParams) return result;
    Object.entries(schemaParams).forEach(([key, param]: [string, any]) => {
      if (param?.is_object && param?.fields) {
        result[key] = buildDefaultParams(param.fields, useVariables);
      } else if (useVariables) {
        result[key] = `#${key}`;
      } else if (param?.default !== undefined) {
        result[key] = param.default;
      }
    });
    return result;
  };

  const hashFieldKey = (listId: string, blockId: string, paramKey: string) => `${listId}::${blockId}::${paramKey}`;

  // Only flag a bare '#' with no variable name once the user leaves the field —
  // flagging on every keystroke would warn mid-typing, before they've had a chance to name it.
  const handleHashBlur = (listId: string, blockId: string, paramKey: string, value: string) => {
    const key = hashFieldKey(listId, blockId, paramKey);
    setEmptyHashFields(prev => {
      const isEmpty = value.trim() === '#';
      if (isEmpty === prev.has(key)) return prev;
      const next = new Set(prev);
      if (isEmpty) next.add(key); else next.delete(key);
      return next;
    });
  };

  const clearHashWarning = (listId: string, blockId: string, paramKey: string) => {
    const key = hashFieldKey(listId, blockId, paramKey);
    setEmptyHashFields(prev => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const expandAll = () => {
    const expandList = (list: SequenceBlock[]) => list.map(b => ({ ...b, isExpanded: true }));
    setSequence(expandList(sequence));
    setPrepSequence(expandList(prepSequence));
    setCleanupSequence(expandList(cleanupSequence));
  };

  const collapseAll = () => {
    const collapseList = (list: SequenceBlock[]) => list.map(b => ({ ...b, isExpanded: false }));
    setSequence(collapseList(sequence));
    setPrepSequence(collapseList(prepSequence));
    setCleanupSequence(collapseList(cleanupSequence));
  };

  useEffect(() => {
    // Initialize toolbox state (all collapsed) when statusData changes
    if (statusData && statusData.instruments) {
        const insts: Record<string, boolean> = {};
        Object.keys(statusData.instruments).forEach(k => insts[k] = false);
        setExpandedToolbox(prev => ({ ...insts, ...prev })); // preserve existing state
    }
  }, [statusData]);

  const instruments = statusData?.instruments || {};

  const pinnedKey = (name: string, version?: number) => `${name}@${version ?? 'head'}`;

  const linkTargetOf = (block: SequenceBlock) => {
    if (block.instrument !== LIBRARY_INSTRUMENT || !block.ref) return null;
    const name = block.ref.name || block.method;
    const version = block.ref.mode === 'latest' ? undefined : block.ref.version;
    return { name, version, key: pinnedKey(name, version) };
  };

  // Resolves each distinct pinned version referenced on the canvas exactly once. Bounded by the
  // number of links actually present, and the head version needs no fetch at all.
  useEffect(() => {
    const wanted = new Map<string, { name: string; version?: number }>();
    [prepSequence, sequence, cleanupSequence].forEach(list => (list || []).forEach(block => {
      const target = linkTargetOf(block);
      if (target) wanted.set(target.key, { name: target.name, version: target.version });
    }));

    // Deliberately no in-flight ref and no "cancelled" bail. Both were here and between them they
    // dropped the result entirely: React StrictMode runs mount effects twice, the first pass was
    // cancelled by its own cleanup after the fetch resolved, and the second refused to retry
    // because the key was still marked in flight. The functional guard below is enough — a
    // duplicate GET of an immutable version is cheap, and re-running after each resolution
    // terminates because every key is then present.
    (async () => {
      for (const [key, { name, version }] of wanted) {
        if (pinnedParams[key]) continue;
        const entry = instruments[LIBRARY_INSTRUMENT]?.[name];
        let body = entry?.body;
        if (version !== undefined && body && version !== body.version) {
          if (!fetchWorkflowVersion) continue;
          try {
            body = await fetchWorkflowVersion(name, version);
          } catch {
            continue;   // leave the snapshot in place rather than blanking the fields
          }
        }
        if (!body) continue;
        const params = scanDynamicParams(body);
        setPinnedParams(prev => (prev[key] ? prev : { ...prev, [key]: params }));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepSequence, sequence, cleanupSequence, statusData, pinnedParams]);

  const getSequenceList = (id: string) => {
    if (id === 'prep') return prepSequence;
    if (id === 'canvas') return sequence;
    if (id === 'cleanup') return cleanupSequence;
    return [];
  };

  const setSequenceList = (id: string, list: SequenceBlock[]) => {
    if (id === 'prep') setPrepSequence(list);
    if (id === 'canvas') setSequence(list);
    if (id === 'cleanup') setCleanupSequence(list);
  };

  const onDragEnd = (result: DropResult) => {
    const { source, destination } = result;
    if (!destination) return;

    const destId = destination.droppableId;
    const sourceId = source.droppableId;

    if (sourceId === 'toolbox' && ['prep', 'canvas', 'cleanup'].includes(destId)) {
      const [instrument, method] = result.draggableId.split('::');
      const methodSchema = statusData.instruments[instrument][method];
      
      const isFlowControlBlock = instrument === "Flow Control" || instrument === "Flow_Control";
      const defaultParams = buildDefaultParams(methodSchema.parameters, autoFillVariables && !isFlowControlBlock);

      const destList = Array.from(getSequenceList(destId));
      
      const createBlock = (m_inst: string, m_method: string, m_params: any = {}) => {
          const m_schema = statusData.instruments[m_inst] && statusData.instruments[m_inst][m_method] 
                            ? statusData.instruments[m_inst][m_method] 
                            : { parameters: m_params };
          return {
            id: `block-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            instrument: m_inst,
            method: m_method,
            schema: m_schema,
            params: m_params,
            returnVar: ""
          };
      };

      // Reusing a saved workflow. `copy` inlines its steps (default — no live dependency, edit
      // freely); `link` drops a single reference that resolves at run time and therefore *does*
      // change when the source workflow is edited.
      // Drop positions come back as indices over the *rendered* rows, which is not the same as
      // the underlying array once a collapsed group is standing in for several steps.
      const dropAt = realIndexFor(destList, destId, destination.index);

      if (instrument === LIBRARY_INSTRUMENT) {
        const entry = statusData.instruments[instrument]?.[method] || {};
        const blocks = reuseWorkflow(method, entry.body, statusData.instruments, reuseMode);
        if (!blocks.length) return;
        // Auto-fill applies to a *link* the same way it applies to any other block: the link's
        // parameters are the #vars the saved workflow leaves open, and those are exactly what an
        // Optimization run needs bound. It deliberately does not touch a copy — a copy arrives
        // with the protocol's real arguments, and overwriting those with #var would throw the
        // protocol away.
        if (autoFillVariables && blocks.length === 1 && blocks[0].ref) {
          blocks[0].params = buildDefaultParams(blocks[0].schema?.parameters, true);
        }
        // A copied protocol brings its output variables with it; rename any that this workflow is
        // already using, so the two can't silently overwrite each other in the run context.
        void (async () => {
          const adopted = await adoptReturnVars(blocks);
          const list = Array.from(getSequenceList(destId));
          list.splice(Math.min(dropAt, list.length), 0, ...adopted);
          setSequenceList(destId, list);
        })();
        return;
      }

      if (instrument === "Flow Control" && method === "If_Else_Block") {
          destList.splice(dropAt, 0,
              createBlock("Flow_Control", "If", { condition: "True" }),
              createBlock("Flow_Control", "Else", {}),
              createBlock("Flow_Control", "End_If", {})
          );
      } else if (instrument === "Flow Control" && method === "While_Loop") {
          destList.splice(dropAt, 0,
              createBlock("Flow_Control", "While", { condition: "False" }),
              createBlock("Flow_Control", "End_While", {})
          );
      } else {
          // Normal block
          const newBlock = createBlock(instrument, method, defaultParams);
          if (instrument === "Flow Control" && method === "Sleep") {
              newBlock.instrument = "Flow_Control"; // standardise the instrument name for backend
          }
          destList.splice(dropAt, 0, newBlock);
      }

      setSequenceList(destId, destList);
      return;
    }

    if (['prep', 'canvas', 'cleanup'].includes(sourceId) && ['prep', 'canvas', 'cleanup'].includes(destId)) {
      const sourceList = Array.from(getSequenceList(sourceId));
      const destList = sourceId === destId ? sourceList : Array.from(getSequenceList(destId));

      // A collapsed group is one draggable covering several real steps, so a move lifts a *range*,
      // not a single block — this is what makes "drag the whole group" work.
      const { slices } = buildDragRows(getSequenceList(sourceId), sourceId);
      const moved = slices[source.index];
      if (!moved) return;
      const items = sourceList.splice(moved.start, moved.size);

      // Recomputed after the removal for a same-list move, because the rows shifted underneath.
      const insertAt = realIndexFor(destList, destId, destination.index);
      destList.splice(insertAt, 0, ...items);

      // Membership follows position. A single step dropped *inside* a group joins it; dropped
      // anywhere else it leaves whatever group it was in — which is what makes dragging a step out
      // produce a plain step rather than a one-step group of its own. A whole collapsed group
      // moving (size > 1, or a block that is itself a group) keeps its own identity.
      if (moved.size === 1 && items.length === 1) {
        const landedIn = groupAt(destList, insertAt);
        const current = items[0].group;
        if (landedIn?.id !== current?.id) {
          destList[insertAt] = { ...items[0], group: landedIn };
        }
      }

      setSequenceList(sourceId, sourceList);
      if (sourceId !== destId) {
        setSequenceList(destId, destList);
      }
    }
  };

  const updateBlock = (listId: string, blockId: string, updater: (block: SequenceBlock) => SequenceBlock) => {
    const list = getSequenceList(listId);
    setSequenceList(listId, list.map(b => b.id === blockId ? updater(b) : b));
  };

  const handleParamChange = (blockId: string, param: string, value: any, type: string, listId: string) => {
    updateBlock(listId, blockId, block => {
      let parsedValue = value;
      if (typeof value === 'string' && !value.startsWith('#')) {
        if (type.includes('bool')) {
          if (value.toLowerCase() === 'true') parsedValue = true;
          else if (value.toLowerCase() === 'false') parsedValue = false;
        } else if (type.includes('int') || type.includes('float')) {
          if (!isNaN(Number(value)) && value !== '') parsedValue = Number(value);
        }
      }
      if (param.includes('.')) {
          const keys = param.split('.');
          const newParams = JSON.parse(JSON.stringify(block.params || {}));
          let curr = newParams;
          for (let i = 0; i < keys.length - 1; i++) {
              if (!curr[keys[i]]) curr[keys[i]] = {};
              curr = curr[keys[i]];
          }
          curr[keys[keys.length - 1]] = parsedValue;
          return { ...block, params: newParams };
      }
      return { ...block, params: { ...block.params, [param]: parsedValue } };
    });
  };

  /** Argument names already given to this same method elsewhere in the workflow.
   *
   *  The weakness of a free-text row is that the scientist has to know the option's spelling;
   *  a vendor option used once is almost always used again, so the second time it is a pick
   *  from the list rather than something to remember. (A driver that declares its options as a
   *  TypedDict skips all of this and gets real fields.) */
  const kwargNamesUsedFor = (instrument: string, method: string, schemaNames: Set<string>): string[] => {
    const names = new Set<string>();
    [prepSequence, sequence, cleanupSequence].forEach(list => (list || []).forEach(b => {
      if (b.instrument !== instrument || b.method !== method) return;
      Object.keys(b.params || {}).forEach(k => {
        if (!schemaNames.has(k) && !k.startsWith('_')) names.add(k);
      });
    }));
    return Array.from(names).sort();
  };

  const handleReturnVarChange = (blockId: string, value: string, listId: string) => {
    updateBlock(listId, blockId, block => ({ ...block, returnVar: value }));
  };

  // Binds one variable name to one return leaf. Writes both shapes: `returnBindings` (the
  // pointer the backend resolves by path) and the derived flat `returnVar` in leaf order, which
  // everything downstream — Optimize's objective list, Data History's columns, codegen — still
  // reads as the list of names this step produces.
  const handleReturnBindingChange = (blockId: string, leaves: ReturnLeaf[], path: string, value: string, listId: string) => {
    updateBlock(listId, blockId, block => {
      const bindings = leaves
        .map(leaf => ({ path: leaf.path, var: (leaf.path === path ? value : getBoundVar(block, leaf, leaves)).trim() }))
        .filter(b => b.var);
      return {
        ...block,
        returnBindings: bindings,
        returnVar: bindings.map(b => b.var).join(', '),
      };
    });
  };

  const toggleExpand = (blockId: string, listId: string) => {
    updateBlock(listId, blockId, block => ({ ...block, isExpanded: !block.isExpanded }));
  };

  const toggleHideBlock = (blockId: string, listId: string) => {
    updateBlock(listId, blockId, block => ({ ...block, isHidden: !block.isHidden }));
  };

  const toggleBatchAction = (blockId: string, listId: string) => {
    updateBlock(listId, blockId, block => ({ ...block, isBatchAction: !block.isBatchAction }));
  };

  /**
   * Open the drawer for a link block, resolving the exact version it is pinned to. The cached
   * toolbox entry is only ever the head, so a step pinned to v1 next to a v4 head would otherwise
   * be previewed as v4 — showing steps that are not the ones it will run.
   */
  const openPeek = async (block: SequenceBlock, listId: string) => {
    if (!block.ref) return;
    const name = block.ref.name || block.method;
    const entry = instruments[LIBRARY_INSTRUMENT]?.[name];
    const target: WorkflowPeekTarget = {
      name,
      version: block.ref.version,
      mode: block.ref.mode,
      params: block.params || {},
    };

    setPeek({ target, listId, blockId: block.id });
    setPeekError(null);
    setPeekBody(entry?.body ?? null);

    const pinned = block.ref.mode !== 'latest' ? block.ref.version : undefined;
    if (!pinned || pinned === entry?.body?.version) {
      if (!entry?.body) setPeekError(`'${name}' is not available from this server right now.`);
      return;
    }
    if (!fetchWorkflowVersion) {
      setPeekBody(null);
      setPeekError(`This step is pinned to v${pinned}, which can't be loaded here.`);
      return;
    }
    setPeekLoading(true);
    try {
      setPeekBody(await fetchWorkflowVersion(name, pinned));
    } catch (e: any) {
      setPeekBody(null);
      setPeekError(`Could not load '${name}' v${pinned} (${e?.message || e}).`);
    } finally {
      setPeekLoading(false);
    }
  };

  const closePeek = () => { setPeek(null); setPeekBody(null); setPeekError(null); };

  /**
   * Output names already in use across all three phases, so incoming copies can be given
   * collision-free ones. `ignore` skips a range that is about to be replaced (a group being
   * refreshed, or the link block being detached), which would otherwise reserve its own names
   * against itself.
   */
  const takenReturnVars = (ignore?: { listId: string; start: number; size: number }) => {
    const lists: [string, SequenceBlock[]][] = [
      ['prep', prepSequence], ['canvas', sequence], ['cleanup', cleanupSequence],
    ];
    const blocks: SequenceBlock[] = [];
    lists.forEach(([id, list]) => list.forEach((block, index) => {
      if (ignore && ignore.listId === id && index >= ignore.start && index < ignore.start + ignore.size) return;
      blocks.push(block);
    }));
    return collectReturnVars(blocks);
  };

  /** Applies the renames and tells the user, since a silent rename is its own kind of surprise. */
  const adoptReturnVars = async (
    blocks: SequenceBlock[],
    ignore?: { listId: string; start: number; size: number },
  ) => {
    const { blocks: adopted, renamed } = uniquifyReturnVars(blocks, takenReturnVars(ignore));
    if (renamed.length) {
      await notify(
        renamed.map(r => `  ${r.from}  →  ${r.to}`).join('\n'),
        {
          title: renamed.length === 1 ? 'Renamed one output variable' : `Renamed ${renamed.length} output variables`,
        },
      );
    }
    return adopted;
  };

  const groupKey = (listId: string, blockId: string) => `${listId}::${blockId}`;

  type GroupInfo = {
    startIndex: number; size: number; key: string; firstId: string;
    id: string; name: string; from?: { name: string; version?: number };
  };
  type DragRow =
    | { kind: 'collapsed'; group: GroupInfo; dndIndex: number }
    | { kind: 'header'; group: GroupInfo }
    | { kind: 'block'; index: number; dndIndex: number; group?: GroupInfo }
    | { kind: 'cap'; group: GroupInfo };

  /**
   * What the list actually renders, and how those rows map back onto the underlying flat array.
   *
   * Drag-and-drop indices must be contiguous over the *rendered* draggables, so a collapsed group
   * contributes exactly one draggable standing for all of its steps. `slices` translates a drag
   * index back to the real range it covers, which is what lets a collapsed group move as a unit.
   *
   * An earlier version kept collapsed members mounted and hid them with `display:none`. That left
   * zero-sized draggables in the index space, so a collapsed group could not be grabbed at all and
   * drop positions were wrong for every other block in the list.
   */
  const buildDragRows = (list: SequenceBlock[], listId: string) => {
    const bounds = groupBounds(list);
    const rows: DragRow[] = [];
    const slices: { start: number; size: number }[] = [];

    let i = 0;
    while (i < list.length) {
      const info = bounds.get(i);
      if (info) {
        const group: GroupInfo = { ...info, startIndex: i, key: groupKey(listId, list[i].id), firstId: list[i].id };
        if (expandedGroups[group.key]) {
          rows.push({ kind: 'header', group });
          for (let j = i; j < i + info.size; j++) {
            rows.push({ kind: 'block', index: j, dndIndex: slices.length, group });
            slices.push({ start: j, size: 1 });
          }
          rows.push({ kind: 'cap', group });
        } else {
          rows.push({ kind: 'collapsed', group, dndIndex: slices.length });
          slices.push({ start: i, size: info.size });
        }
        i += info.size;
      } else {
        rows.push({ kind: 'block', index: i, dndIndex: slices.length });
        slices.push({ start: i, size: 1 });
        i += 1;
      }
    }
    return { rows, slices };
  };

  /**
   * The group's header row. Rendered plain when the group is open (its steps follow below), and
   * inside a Draggable when collapsed, so the whole group can be picked up and moved as one.
   */
  const renderGroupHeader = (listId: string, group: GroupInfo, open: boolean) => {
    // Deliberately no version badge and no "update" action. A group is organisation, not a link:
    // it has no ongoing relationship with whatever the steps were copied from, so advertising
    // staleness here would promise a relationship that does not exist. `from` is a label only.
    return (
      <div className={`flex items-center gap-2 flex-wrap px-2.5 py-1.5 rounded-lg border border-gray-300 dark:border-white/15 bg-gray-100/80 dark:bg-white/[0.06] text-[11px] text-gray-600 dark:text-gray-300 ${
        open ? '' : 'cursor-grab active:cursor-grabbing'
      }`}>
        <button
          type="button"
          onClick={() => toggleGroup(listId, group.firstId)}
          title={open
            ? 'Collapse these steps — collapsed, the whole group can be dragged as one'
            : 'Show the steps in this group. Drag this bar to move the whole group.'}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
        >
          {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-gray-400" />
                : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-gray-400" />}
          <Copy className="w-3 h-3 shrink-0 text-gray-400" />
          {/* Verbatim: a workflow name is typed by a person, unlike an instrument or method
              name introspected from Python where underscores and lower case are an artefact of
              the identifier rather than a choice. */}
          <span className="font-bold truncate">{group.name}</span>
          <span className="text-gray-400 dark:text-gray-500 shrink-0">
            {group.size} step{group.size === 1 ? '' : 's'}
          </span>
          {group.from && (
            <span className="text-gray-400 dark:text-gray-500 shrink-0 truncate">
              · copied from {group.from.name}{group.from.version ? ` v${group.from.version}` : ''}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => renameGroup(listId, group.startIndex, group.size)}
          title="Rename this group"
          className="px-1.5 py-0.5 rounded border text-[10px] font-bold shrink-0 bg-white border-gray-200 text-gray-600 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300"
        >
          Rename
        </button>
        <button
          type="button"
          onClick={() => ungroup(listId, group.startIndex, group.size)}
          title="Dissolve the group. The steps stay exactly as they are, just no longer drawn as a unit."
          className="px-1.5 py-0.5 rounded border text-[10px] font-bold shrink-0 bg-white border-gray-200 text-gray-600 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300"
        >
          Ungroup
        </button>
        <button
          type="button"
          onClick={() => removeGroup(listId, group.startIndex, group.size)}
          title="Remove every step in this group"
          className="p-1 rounded text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:text-red-300 dark:hover:bg-red-900/30 shrink-0"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  };

  /** Drag index -> where that row starts in the real array (end of list when past the last row). */
  const realIndexFor = (list: SequenceBlock[], listId: string, dndIndex: number) => {
    const { slices } = buildDragRows(list, listId);
    return dndIndex < slices.length ? slices[dndIndex].start : list.length;
  };

  const toggleGroup = (listId: string, blockId: string) =>
    setExpandedGroups(prev => ({ ...prev, [groupKey(listId, blockId)]: !prev[groupKey(listId, blockId)] }));

  /** Drop a whole group at once, rather than making the user delete N cards one by one. */
  const removeGroup = async (listId: string, startIndex: number, size: number) => {
    const list = Array.from(getSequenceList(listId));
    const name = list[startIndex]?.group?.name;
    const ok = await confirmDialog(
      `Remove all ${size} step(s) in '${name}'?`,
      { title: 'Remove group', confirmLabel: 'Remove', tone: 'danger' },
    );
    if (!ok) return;
    list.splice(startIndex, size);
    setSequenceList(listId, list);
  };

  /** Dissolve the grouping. The steps are untouched — they just stop being drawn as a unit. */
  const ungroup = (listId: string, startIndex: number, size: number) => {
    const list = Array.from(getSequenceList(listId));
    for (let i = startIndex; i < startIndex + size && i < list.length; i++) {
      list[i] = { ...list[i], group: undefined };
    }
    setSequenceList(listId, list);
  };

  const isSelected = (listId: string, blockId: string) =>
    selection.listId === listId && selection.ids.includes(blockId);

  const toggleSelect = (listId: string, blockId: string) => setSelection(prev => {
    if (prev.listId !== listId) return { listId, ids: [blockId] };
    const ids = prev.ids.includes(blockId)
      ? prev.ids.filter(id => id !== blockId)
      : [...prev.ids, blockId];
    return { listId, ids };
  });

  const clearSelection = () => setSelection({ listId: '', ids: [] });

  /**
   * Selecting is a mode, not a permanent affordance. Checkboxes on every card all the time is a
   * lot of chrome for something used occasionally, so they only appear once this is switched on.
   * Being in the mode *is* `selection.listId` — there is no second flag to keep in step.
   */
  const toggleSelectMode = (listId: string) => setSelection(prev => (
    prev.listId === listId ? { listId: '', ids: [] } : { listId, ids: [] }
  ));

  const renderSelectToggle = (listId: string) => {
    const on = selection.listId === listId;
    return (
      <button
        type="button"
        onClick={() => toggleSelectMode(listId)}
        title={on ? 'Leave select mode' : 'Select several steps to put them in a group'}
        className={`flex items-center space-x-1.5 text-[11px] font-medium uppercase tracking-wide transition-colors ${
          on
            ? 'text-indigo-600 dark:text-indigo-400'
            : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
        }`}
      >
        <ListChecks className="w-3.5 h-3.5" />
        <span>Select</span>
      </button>
    );
  };

  const nextGroupName = (list: SequenceBlock[]) => {
    const taken = new Set(list.map(b => b.group?.name).filter(Boolean) as string[]);
    let n = 1;
    while (taken.has(`Group ${n}`)) n += 1;
    return `Group ${n}`;
  };

  /** Where the current selection sits, and whether it can simply be wrapped where it is. */
  const selectionInfo = (listId: string) => {
    const list = getSequenceList(listId);
    const indices = list
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => selection.ids.includes(block.id))
      .map(({ index }) => index)
      .sort((a, b) => a - b);
    if (!indices.length) return null;

    const first = indices[0];
    const last = indices[indices.length - 1];
    const contiguous = last - first === indices.length - 1;
    const anyGrouped = indices.some(i => list[i].group);
    // Only offer "add to" when the run sits flush against exactly one group, so joining it keeps
    // the group contiguous without moving anything.
    const neighbour = !anyGrouped && contiguous
      ? (list[first - 1]?.group ?? list[last + 1]?.group)
      : undefined;
    return { list, indices, first, last, contiguous, neighbour };
  };

  /**
   * Put the selected steps in a group — a new one, or `adopt` to extend the group they abut.
   *
   * A group is a *consecutive* run, so a scattered selection has to be brought together first.
   * That reorders the workflow, which changes what runs when, so it is never done silently.
   */
  const groupSelection = async (listId: string, adopt?: SequenceBlock['group']) => {
    const info = selectionInfo(listId);
    if (!info) return;
    const { indices, first, contiguous } = info;

    if (!contiguous) {
      const ok = await confirmDialog(
        'The selected steps are not next to each other. Grouping them moves them together, which '
        + 'changes the order they run in.',
        { title: 'Move steps together?', confirmLabel: 'Move and group', tone: 'danger' },
      );
      if (!ok) return;
    }

    const list = Array.from(getSequenceList(listId));
    const picked = indices.map(i => list[i]);
    [...indices].reverse().forEach(i => list.splice(i, 1));

    const group = adopt ?? { id: newGroupId(), name: nextGroupName(list) };
    list.splice(first, 0, ...picked.map(block => ({ ...block, group })));

    setSequenceList(listId, list);
    setExpandedGroups(prev => ({ ...prev, [groupKey(listId, picked[0].id)]: true }));
    clearSelection();
  };

  const renameGroup = async (listId: string, startIndex: number, size: number) => {
    const list = Array.from(getSequenceList(listId));
    const current = list[startIndex]?.group;
    if (!current) return;
    const name = await promptDialog('What should this group be called?', {
      title: 'Rename group', defaultValue: current.name, confirmLabel: 'Rename',
    });
    if (!name) return;
    for (let i = startIndex; i < startIndex + size && i < list.length; i++) {
      list[i] = { ...list[i], group: { ...list[i].group!, name } };
    }
    setSequenceList(listId, list);
  };

  /** Turn a link into an owned copy: the steps are inlined here and stop tracking the source. */
  const detachBlock = async (index: number, listId: string) => {
    const list = Array.from(getSequenceList(listId));
    const block = list[index];
    if (!block?.ref) return;
    const name = block.ref.name || block.method;
    const entry = instruments[LIBRARY_INSTRUMENT]?.[name];
    if (!entry?.body) {
      await notify(`'${name}' is not available from this server right now.`,
                   { title: 'Cannot detach', tone: 'error' });
      return;
    }

    // Detach must inline the version this step was actually pinned to, not whatever the library
    // currently holds. The cached toolbox entry is the head, so a step pinned to v1 sitting next to
    // a v4 head would otherwise be silently swapped to v4 by a button labelled "Detach" — the exact
    // substitution-without-telling-you that pinning exists to prevent.
    let body = entry.body;
    const pinned = block.ref.mode !== 'latest' ? block.ref.version : undefined;
    if (pinned && pinned !== entry.body?.version) {
      if (!fetchWorkflowVersion) {
        await notify(
          `This step is pinned to '${name}' v${pinned}, and that version can't be loaded here. `
          + `Update the step to the latest version first if that's what you want.`,
          { title: 'Cannot detach', tone: 'error' },
        );
        return;
      }
      try {
        body = await fetchWorkflowVersion(name, pinned);
      } catch (e: any) {
        await notify(`Could not load '${name}' v${pinned} (${e?.message || e}).`,
                     { title: 'Cannot detach', tone: 'error' });
        return;
      }
    }

    // Re-read: an await happened, so the list may have moved under us.
    const current = Array.from(getSequenceList(listId));
    const at = current.findIndex(b => b.id === block.id);
    if (at === -1) return;
    const inlined = await adoptReturnVars(
      detachLink(block, body, instruments),
      { listId, start: at, size: 1 },
    );
    current.splice(at, 1, ...inlined);
    setSequenceList(listId, current);
  };

  const applyRelink = (blockId: string, listId: string) => {
    updateBlock(listId, blockId, block => {
      if (!block.ref) return block;
      const name = block.ref.name || block.method;
      const entry = instruments[LIBRARY_INSTRUMENT]?.[name];
      if (!entry?.body) return block;

      // Values for parameters the new version no longer exposes are dropped rather than carried
      // along: keeping them would leave the step holding an argument nothing reads, which is what
      // used to surface later as a "no longer supported" warning with no way to clear it.
      const nextParams = entry.parameters || {};
      const kept = Object.fromEntries(
        Object.entries(block.params || {}).filter(([key]) => key in nextParams)
      );

      return {
        ...block,
        params: kept,
        schema: { ...block.schema, parameters: nextParams },
        ref: { ...block.ref, version: entry.body.version, body_hash: entry.body.body_hash },
      };
    });
  };

  /**
   * Re-pin a link to the newest saved version, after showing what that changes. The steps a link
   * runs are invisible on the canvas, so "v4 available — update" without a diff would be asking
   * someone to re-point hardware instructions at something they have never seen.
   */
  const relinkToLatest = async (blockId: string, listId: string) => {
    const block = getSequenceList(listId).find(b => b.id === blockId);
    if (!block?.ref) return;
    const name = block.ref.name || block.method;
    const entry = instruments[LIBRARY_INSTRUMENT]?.[name];
    if (!entry?.body) {
      await notify(`'${name}' is not available from this server right now.`,
                   { title: 'Cannot update', tone: 'error' });
      return;
    }

    const pinned = block.ref.mode !== 'latest' ? block.ref.version : undefined;
    let currentBody = entry.body;
    if (pinned && pinned !== entry.body.version && fetchWorkflowVersion) {
      try {
        currentBody = await fetchWorkflowVersion(name, pinned);
      } catch {
        // Fall back to comparing head against itself rather than blocking the update outright;
        // the diff then simply shows no differences and the version number still moves.
        currentBody = entry.body;
      }
    }

    // What this step's own inputs become. Separate from the step diff: these are the values the
    // caller supplies, and the update is what adds or drops them.
    const nextParams = entry.parameters || {};
    const supplied = block.params || {};
    const paramChanges = {
      added: Object.keys(nextParams).filter(key => !(key in supplied)),
      removed: Object.keys(supplied).filter(key => !(key in nextParams))
        .map(key => ({ key, value: supplied[key] })),
    };

    setDiff({
      title: name,
      fromLabel: pinned ? `v${pinned}` : 'latest',
      toLabel: `v${entry.body.version}`,
      rows: diffSteps(flattenSavedBody(currentBody), flattenSavedBody(entry.body)),
      paramChanges,
      applyLabel: `Pin to v${entry.body.version}`,
      apply: () => { setDiff(null); applyRelink(blockId, listId); },
    });
  };

  const toggleToolbox = (instName: string) => {
    setExpandedToolbox(prev => ({ ...prev, [instName]: !prev[instName] }));
  };

  const removeBlock = (index: number, listId: string) => {
    const list = Array.from(getSequenceList(listId));
    const block = list[index];
    const toDelete = [index];

    if (block.method === 'If') {
      let depth = 1;
      for (let i = index + 1; i < list.length; i++) {
        const b = list[i];
        if (b.method === 'If') depth++;
        else if (b.method === 'End_If') depth--;
        
        toDelete.push(i);
        if (depth === 0) break;
      }
    } else if (block.method === 'While') {
      let depth = 1;
      for (let i = index + 1; i < list.length; i++) {
        const b = list[i];
        if (b.method === 'While') depth++;
        else if (b.method === 'End_While') depth--;
        
        toDelete.push(i);
        if (depth === 0) break;
      }
    }

    // Remove from highest index to lowest to avoid shifting issues
    toDelete.sort((a, b) => b - a).forEach(i => {
      list.splice(i, 1);
    });

    setSequenceList(listId, list);
  };

  const newBlockId = () => `block-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // How many blocks a flow-control opener owns, including its own matching End_/Else blocks —
  // duplicating or deleting an 'If' has to take the whole construct, or the canvas is left with
  // an unmatched End_If that can never execute.
  const blockGroupLength = (list: SequenceBlock[], index: number): number => {
    const block = list[index];
    const opener = block?.method === 'If' ? 'If' : block?.method === 'While' ? 'While' : null;
    if (!opener) return 1;
    const closer = opener === 'If' ? 'End_If' : 'End_While';
    let depth = 1;
    for (let i = index + 1; i < list.length; i++) {
      if (list[i].method === opener) depth++;
      else if (list[i].method === closer) {
        depth--;
        if (depth === 0) return i - index + 1;
      }
    }
    return list.length - index;
  };

  // Legacy IvoryOS let you copy a configured step instead of dragging a fresh one in and
  // retyping every parameter — by far the fastest way to build a repetitive protocol.
  const duplicateBlock = (index: number, listId: string) => {
    const list = Array.from(getSequenceList(listId));
    const span = blockGroupLength(list, index);
    const copies = list.slice(index, index + span).map(b => ({
      ...b,
      id: newBlockId(),
      params: JSON.parse(JSON.stringify(b.params || {})),
    }));
    list.splice(index + span, 0, ...copies);
    setSequenceList(listId, list);
  };

  // Variables a step can legally reference: only those produced *before* it runs. Legacy scoped
  // its autocomplete the same way (`get_autocomplete_variables(before_id=...)`) so you can't wire
  // a parameter to a value that doesn't exist yet at that point in the run.
  const collectVarsUpTo = (blocks: SequenceBlock[], upTo: number): string[] => {
    const out: string[] = [];
    blocks.slice(0, upTo).forEach(b => {
      const isUserInput = (b.instrument === 'Flow_Control' || b.instrument === 'Flow Control') && b.method === 'User_Input';
      if (isUserInput && b.params?.variable_name) out.push(String(b.params.variable_name).trim());
      if (b.returnVar) {
        String(b.returnVar).split(',').map(v => v.trim()).filter(Boolean).forEach(v => out.push(v));
      }
    });
    return out;
  };

  const getVariablesBefore = (listId: string, index: number): string[] => {
    const vars: string[] = [];
    // Phases always run prep -> main -> cleanup, so earlier phases are fully in scope.
    if (listId === 'prep') {
      vars.push(...collectVarsUpTo(prepSequence, index));
    } else if (listId === 'canvas') {
      vars.push(...collectVarsUpTo(prepSequence, prepSequence.length));
      vars.push(...collectVarsUpTo(sequence, index));
    } else {
      vars.push(...collectVarsUpTo(prepSequence, prepSequence.length));
      vars.push(...collectVarsUpTo(sequence, sequence.length));
      vars.push(...collectVarsUpTo(cleanupSequence, index));
    }
    return Array.from(new Set(vars.filter(Boolean)));
  };

  const renderSequenceList = (listId: string, title: string, sequenceList: SequenceBlock[]) => (
    <div className={listId === 'canvas' ? '' : 'mb-6'}>
      {listId !== 'canvas' && (
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 px-2 uppercase tracking-wide flex items-center justify-between">
            <span className="flex items-center gap-3">
              <span>{title}</span>
              {sequenceList.length > 0 && renderSelectToggle(listId)}
            </span>
            <span className="bg-gray-200 dark:bg-white/10 text-gray-500 dark:text-gray-400 text-xs px-2 py-0.5 rounded-full">{sequenceList.length}</span>
          </h3>
      )}
      {selection.listId === listId && (() => {
        const info = selectionInfo(listId);
        const count = selection.ids.length;
        return (
          <div className="mb-2 flex items-center flex-wrap gap-2 px-2.5 py-1.5 rounded-lg border border-indigo-200 dark:border-indigo-800/50 bg-indigo-50/70 dark:bg-indigo-900/20 text-[11px]">
            <span className="font-semibold text-indigo-800 dark:text-indigo-300">
              {count > 0
                ? `${count} step${count === 1 ? '' : 's'} selected`
                : 'Tick the steps you want to group'}
            </span>
            {info && !info.contiguous && (
              <span className="text-indigo-700/70 dark:text-indigo-400/70">
                not next to each other — grouping will move them together
              </span>
            )}
            <div className="flex-1" />
            {info?.neighbour && (
              <button
                type="button"
                onClick={() => groupSelection(listId, info.neighbour)}
                className="px-2 py-0.5 rounded border text-[10px] font-bold bg-white border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:bg-white/5 dark:border-indigo-700/40 dark:text-indigo-300"
              >
                Add to {info.neighbour.name}
              </button>
            )}
            {count > 0 && (
              <button
                type="button"
                onClick={() => groupSelection(listId)}
                className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-600 text-white hover:bg-indigo-700"
              >
                Group
              </button>
            )}
            <button
              type="button"
              onClick={clearSelection}
              className="px-2 py-0.5 rounded border text-[10px] font-bold bg-white border-gray-200 text-gray-600 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300"
            >
              {count > 0 ? 'Cancel' : 'Done'}
            </button>
          </div>
        );
      })()}

      <Droppable droppableId={listId}>
        {(provided, snapshot) => (
          <div 
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`min-h-[100px] border-2 border-dashed rounded-xl p-2 transition-colors ${snapshot.isDraggingOver ? 'bg-blue-50/50 border-blue-300 dark:bg-white/[0.02] dark:border-blue-500/50' : 'border-gray-200 dark:border-white/10'}`}
          >
            {sequenceList.length === 0 ? (
              <div className="h-24 flex flex-col items-center justify-center text-gray-400 dark:text-gray-500">
                <p className="text-xs font-medium">Drag blocks here</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {(() => {
                  // Pre-compute nesting depth for each block
                  const nestColors = [
                    'border-l-blue-500', 'border-l-purple-500', 'border-l-amber-500',
                    'border-l-emerald-500', 'border-l-rose-500', 'border-l-cyan-500'
                  ];
                  const nestBgs = [
                    'bg-blue-50/30 dark:bg-blue-900/10', 'bg-purple-50/30 dark:bg-purple-900/10',
                    'bg-amber-50/30 dark:bg-amber-900/10', 'bg-emerald-50/30 dark:bg-emerald-900/10',
                    'bg-rose-50/30 dark:bg-rose-900/10', 'bg-cyan-50/30 dark:bg-cyan-900/10'
                  ];
                  let depth = 0;
                  const depths: number[] = [];
                  for (const b of sequenceList) {
                    if (b.instrument === 'Flow_Control') {
                      if (b.method === 'End_If' || b.method === 'End_While' || b.method === 'Else') depth = Math.max(0, depth - 1);
                      depths.push(depth);
                      if (b.method === 'If' || b.method === 'While' || b.method === 'Else') depth++;
                    } else {
                      depths.push(depth);
                    }
                  }

                  // Only rendered rows get a drag index, so a collapsed group is one draggable
                  // standing for all its steps. See buildDragRows.
                  const { rows } = buildDragRows(sequenceList, listId);

                  return (<>{rows.map((row) => {
                  if (row.kind === 'collapsed') {
                    return (
                      // disableInteractiveElementBlocking: the header is mostly <button>s (the
                      // title, Ungroup, delete), and dnd refuses to start a drag on an interactive
                      // element by default — so grabbing the bar anywhere a user actually aims did
                      // nothing. A click still works: dnd only begins a drag past its movement
                      // threshold.
                      <Draggable
                        key={`group-${row.group.firstId}`}
                        draggableId={`group-${row.group.firstId}`}
                        index={row.dndIndex}
                        disableInteractiveElementBlocking
                      >
                        {(provided, snapshot) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            {...provided.dragHandleProps}
                            style={provided.draggableProps.style}
                            className={snapshot.isDragging ? 'opacity-90 shadow-xl rounded-lg' : ''}
                          >
                            {renderGroupHeader(listId, row.group, false)}
                          </div>
                        )}
                      </Draggable>
                    );
                  }
                  if (row.kind === 'header') {
                    return <React.Fragment key={`header-${row.group.firstId}`}>{renderGroupHeader(listId, row.group, true)}</React.Fragment>;
                  }
                  if (row.kind === 'cap') {
                    return (
                      // Closes the group so the eye knows where the copy stops and this workflow's
                      // own steps resume. Carries the same rail and indent as the members above it.
                      <div key={`cap-${row.group.firstId}`} className="ml-2.5 pl-3 border-l-2 border-gray-300 dark:border-white/20 text-[10px] text-gray-400 dark:text-gray-500 flex items-center gap-1.5">
                        <span className="h-px w-3 bg-gray-300 dark:bg-white/20" />
                        end of {row.group.name}
                      </div>
                    );
                  }

                  const index = row.index;
                  const block = sequenceList[index];
                  const isExpanded = block.isExpanded !== false;
                  const inExpandedGroup = !!row.group;
                  const blockDepth = depths[index] || 0;
                  const nestColor = blockDepth > 0 ? nestColors[(blockDepth - 1) % nestColors.length] : '';
                  const nestBg = blockDepth > 0 ? nestBgs[(blockDepth - 1) % nestBgs.length] : '';
                  const isFlowBlock = block.instrument === 'Flow_Control' || block.instrument === 'Flow Control';
                  // Duplicating a closing/branching half on its own would orphan it — only the
                  // opener (If/While) can be copied, and it copies the whole construct.
                  const isClosingFlowBlock = isFlowBlock && ['End_If', 'End_While', 'Else'].includes(block.method);
                  // User Input is laid out like a method card rather than like the other flow
                  // blocks: what it produces (the variable) sits where a step's Save sits, it can be
                  // per-sample or batch like any step, and its prompt and type are the body.
                  const isUserInputBlock = isFlowBlock && block.method === 'User_Input';
                  const availableVars = getVariablesBefore(listId, index);
                  // On a Library Workflows block the "method" is a saved workflow's name, which the
                  // user typed — it must not be prettified the way a Python identifier is.
                  const isLibraryBlock = block.instrument === LIBRARY_INSTRUMENT;
                  const isMissing = !isFlowBlock && (!statusData.instruments[block.instrument] || !statusData.instruments[block.instrument][block.method]);
                  let borderClass = blockDepth > 0 ? `border-gray-200 dark:border-white/10 border-l-4 ${nestColor}` : 'border-gray-200 dark:border-white/10';
                  
                  // A linked block's stored schema is the parameter list of the version it is
                  // **pinned to**, written whenever `ref` is written. That is what it must show:
                  // pulling the live (head) list in would change the step's parameters before the
                  // user has agreed to move to that version, which is the opposite of pinning.
                  // The new version's list arrives only through the update flow, alongside a diff.
                  //
                  // For an ordinary instrument block the stored schema is just a cache, so an empty
                  // one falls through to the live schema (a block imported from legacy JSON has
                  // `schema: {}` and would otherwise render no parameters at all).
                  const liveSchema = statusData.instruments?.[block.instrument]?.[block.method]?.parameters;
                  let effectiveSchema = block.schema?.parameters;
                  const pinnedTarget = linkTargetOf(block);
                  if (pinnedTarget && pinnedParams[pinnedTarget.key]) {
                    // Straight from the pinned body, so the fields shown are the ones this step
                    // will really pass — the stored snapshot is only a fallback until it resolves.
                    effectiveSchema = pinnedParams[pinnedTarget.key];
                  } else if (block.instrument !== LIBRARY_INSTRUMENT
                      && liveSchema
                      && (!effectiveSchema || Object.keys(effectiveSchema).length === 0)) {
                    effectiveSchema = liveSchema;
                  }
                  
                  const blockWarnings: string[] = [];
                  if (isMissing) {
                      blockWarnings.push(`Method '${block.instrument}.${block.method}' no longer exists.`);
                  }

                  // Deliberately no warning for a parameter the schema doesn't list. For a
                  // linked block that only means the *newer* version dropped it — this step is
                  // still pinned to one that wants it, so nothing is wrong yet. It is reported
                  // when the user compares versions to update, and dropped as part of that. The
                  // warning triangle is reserved for something actually broken now: a missing
                  // required parameter, a wrong type, or a method that no longer exists.

                  // A **kwargs method takes arguments this schema cannot list, so the ones this
                  // step carries are not orphans — they are the point. They get their own
                  // name/value editor below (where a name can be changed or a new one added)
                  // instead of a fixed field each, and are kept out of the orphan sweep so they
                  // are not rendered twice.
                  const acceptsKwargs = !isFlowBlock && !!block.schema?.accepts_kwargs;
                  const schemaParamNames = new Set(Object.keys(effectiveSchema || {}));
                  const extraArgs: Record<string, any> = {};
                  if (acceptsKwargs && block.params) {
                    for (const [k, v] of Object.entries(block.params)) {
                      if (!schemaParamNames.has(k) && !k.startsWith('_')) extraArgs[k] = v;
                    }
                  }

                  // Any argument the step carries that the resolved schema doesn't mention gets a
                  // field too. Hiding it is what let `test: 1` sit on a block invisibly, still
                  // being substituted into the run with no way to see or clear it.
                  if (effectiveSchema && block.params) {
                    const orphaned = Object.keys(block.params).filter(
                      k => effectiveSchema[k] === undefined && !(k in extraArgs));
                    if (orphaned.length) {
                      effectiveSchema = { ...effectiveSchema };
                      orphaned.forEach(k => { effectiveSchema[k] = { type: 'unknown', required: false, orphaned: true }; });
                    }
                  }

                  if (!effectiveSchema && block.params && Object.keys(block.params).length > 0) {
                      effectiveSchema = {};
                      for (const key of Object.keys(block.params)) {
                          effectiveSchema[key] = { type: "unknown", required: false };
                      }
                  } else if (!effectiveSchema) {
                      effectiveSchema = {};
                  }

                  const allParams = Object.keys(effectiveSchema);
                  const visibleParams = isFlowBlock
                    ? allParams.filter(p => p !== 'condition' && p !== 'duration_seconds' && p !== 'prompt' && p !== 'variable_name' && p !== 'message')
                    : allParams;
                  const hasParams = visibleParams.length > 0;
                  // `configure(**settings)` lists no parameters and still has something to fill
                  // in, so expandability can't be read off the parameter count alone.
                  const hasBody = hasParams || acceptsKwargs;

                  // Everything this step's return value can be pointed at. A structured result
                  // (dataclass/Pydantic model, or anything nested) gets its own Outputs panel
                  // in the expanded body rather than a row of unlabeled boxes in the header.
                  const returnLeaves = (isFlowBlock || listId === 'prep' || listId === 'cleanup')
                    ? []
                    : getReturnLeaves(block.schema);
                  const usesOutputPanel = returnLeaves.length > 2 || returnLeaves.some(l => l.path.includes('.'));
                  
                  const checkRequiredParams = (schemaObj: any, prefix: string = '') => {
                      for (const p of Object.keys(schemaObj)) {
                          const pData = schemaObj[p];
                          const fullKey = prefix ? `${prefix}.${p}` : p;

                          if (pData?.is_object && pData?.fields) {
                              // If object is not required and no params for it exist at all, we can skip enforcing its inner fields.
                              // But if it is required or partially filled, we enforce.
                              const objVal = fullKey.split('.').reduce((acc: any, part: string) => acc && acc[part] !== undefined ? acc[part] : undefined, block.params);
                              if (pData.required || (objVal !== undefined && Object.keys(objVal).length > 0)) {
                                  checkRequiredParams(pData.fields, fullKey);
                              }
                              continue;
                          }

                          const val = fullKey.split('.').reduce((acc: any, part: string) => acc && acc[part] !== undefined ? acc[part] : undefined, block.params);
                          const isDynamicRef = typeof val === 'string' && val.startsWith('#');

                          if (pData?.required && !isDynamicRef) {
                              if ((val === undefined || val === '') && (pData.default === undefined || pData.default === '')) {
                                  blockWarnings.push(`Missing required parameter: '${fullKey}'`);
                                  continue;
                              }
                          }

                          // A param typed int/float has to be a '#variable' or an actual number —
                          // anything else would only fail once the run tries to cast it, so flag
                          // it here instead of letting that happen mid-run.
                          const typeStr = (pData?.type || '').toLowerCase();
                          const isNumericType = typeStr.includes('int') || typeStr.includes('float');
                          if (isNumericType && !isDynamicRef && val !== undefined && val !== '' && isNaN(Number(val))) {
                              blockWarnings.push(`Parameter '${fullKey}' expects a number (or '#variable'), got '${val}'`);
                          }
                      }
                  };
                  checkRequiredParams(effectiveSchema);

                  if (blockWarnings.length > 0) {
                      borderClass = `border-amber-400 dark:border-amber-500/50 shadow-[0_0_0_1px_rgba(251,191,36,0.5)] ${blockDepth > 0 ? 'border-l-4 ' + nestColor : ''}`;
                  }
                  let flowBgClass = 'bg-stone-50/60 dark:bg-stone-900/20';
                  let flowTextClass = 'text-stone-700 dark:text-stone-300 font-bold';
                  let flowInputClass = 'bg-stone-500/10 dark:bg-stone-900/40 border-stone-200 dark:border-stone-800/50 focus:border-stone-400 dark:focus:border-stone-500 text-stone-900 dark:text-stone-100 placeholder-stone-300 dark:placeholder-stone-600/50';
                  
                  if (isFlowBlock) {
                      if (block.method === 'If' || block.method === 'End_If' || block.method === 'Else') {
                          flowBgClass = 'bg-sky-50/70 dark:bg-sky-900/20';
                          flowTextClass = 'text-sky-700 dark:text-sky-300 font-bold';
                          flowInputClass = 'bg-sky-500/10 dark:bg-sky-900/40 border-sky-200 dark:border-sky-800/50 focus:border-sky-400 dark:focus:border-sky-500 text-sky-900 dark:text-sky-100 placeholder-sky-300 dark:placeholder-sky-600/50';
                      } else if (block.method === 'While' || block.method === 'End_While') {
                          flowBgClass = 'bg-amber-50/70 dark:bg-amber-900/20';
                          flowTextClass = 'text-amber-700 dark:text-amber-300 font-bold';
                          flowInputClass = 'bg-amber-500/10 dark:bg-amber-900/40 border-amber-200 dark:border-amber-800/50 focus:border-amber-400 dark:focus:border-amber-500 text-amber-900 dark:text-amber-100 placeholder-amber-300 dark:placeholder-amber-600/50';
                      } else if (block.method === 'Sleep') {
                          flowBgClass = 'bg-violet-50/70 dark:bg-violet-900/20';
                          flowTextClass = 'text-violet-700 dark:text-violet-300 font-bold';
                          flowInputClass = 'bg-violet-500/10 dark:bg-violet-900/40 border-violet-200 dark:border-violet-800/50 focus:border-violet-400 dark:focus:border-violet-500 text-violet-900 dark:text-violet-100 placeholder-violet-300 dark:placeholder-violet-600/50';
                      } else if (block.method === 'User_Input') {
                          flowBgClass = 'bg-pink-50/70 dark:bg-pink-900/20';
                          flowTextClass = 'text-pink-700 dark:text-pink-300 font-bold';
                          flowInputClass = 'bg-pink-500/10 dark:bg-pink-900/40 border-pink-200 dark:border-pink-800/50 focus:border-pink-400 dark:focus:border-pink-500 text-pink-900 dark:text-pink-100 placeholder-pink-300 dark:placeholder-pink-600/50';
                      } else if (block.method === 'Comment') {
                          flowBgClass = 'bg-slate-50/70 dark:bg-slate-800/20';
                          flowTextClass = 'text-slate-600 dark:text-slate-400 font-bold';
                          flowInputClass = 'bg-slate-500/10 dark:bg-slate-800/40 border-slate-200 dark:border-slate-700/50 focus:border-slate-400 dark:focus:border-slate-500 text-slate-900 dark:text-slate-100 placeholder-slate-300 dark:placeholder-slate-600/50';
                      }
                  }

                  let bgClass = 'bg-white dark:bg-[#1a1a1a]';
                  if (isFlowBlock) bgClass = flowBgClass;
                  else if (blockDepth > 0) bgClass = `bg-white dark:bg-black/40 ${nestBg}`;

                  const indent = blockDepth > 0 ? { marginLeft: `${blockDepth * 20}px` } : {};
                  
                  return (
                    <React.Fragment key={block.id}>
                    <Draggable draggableId={block.id} index={row.dndIndex}>
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                style={{
                                  ...provided.draggableProps.style,
                                  ...indent,
                                  // Indented under the group header. Without this an expanded copy
                                  // is indistinguishable from the workflow's own steps, which is
                                  // the whole thing a group is meant to make obvious. Added to any
                                  // flow-control indent rather than replacing it.
                                  ...(inExpandedGroup
                                    ? { marginLeft: `${(parseInt(String(indent.marginLeft || '0'), 10) || 0) + 10}px` }
                                    : {}),
                                }}
                                className={`
                                  relative ${bgClass} rounded-lg shadow-sm border
                                  transition-all duration-200 group
                                  ${block.isHidden ? 'opacity-50 border-gray-200 dark:border-gray-800' :
                                    snapshot.isDragging ? 'border-blue-500 shadow-xl scale-[1.02] z-50' :
                                    'border-gray-200 dark:border-white/10 hover:border-gray-300 dark:hover:border-white/20'
                                  }
                                  ${inExpandedGroup ? 'border-l-2 border-l-gray-300 dark:border-l-white/20 rounded-l-none' : ''}
                                  ${isSelected(listId, block.id) ? 'ring-2 ring-indigo-400 dark:ring-indigo-500' : ''}
                                `}
                              >
                                  {/* The handle wraps the provenance strip *and* the top row, so
                                      every card is dragged by its top bar regardless of whether it
                                      carries a strip. With the handle on the top row alone, a
                                      linked card could only be grabbed below its banner, which is
                                      not where anyone aims. Interactive children (the strip's
                                      buttons, the return-var inputs) still block a drag from
                                      starting on them, which is what keeps them clickable. */}
                                  <div {...provided.dragHandleProps} className="cursor-grab active:cursor-grabbing">
                                  {/* Reuse provenance. A link says so loudly, because editing the
                                      workflow it points at will change this step too; a copy just
                                      records where its steps came from. Either way the user can see
                                      which of the two they have — that ambiguity was the whole
                                      problem. */}
                                  {(() => {
                                    // Links only. A copied group carries its provenance on the
                                    // group header row instead, so it is stated once for the whole
                                    // group rather than repeated on every step.
                                    const source = block.ref?.name || (block.ref ? block.method : null);
                                    if (!source) return null;

                                    const pinned = block.ref?.version;
                                    const latest = workflowVersions?.[source];
                                    const tracksLatest = block.ref?.mode === 'latest';
                                    const isStale = !!(latest && pinned && latest > pinned);

                                    return (
                                      <div className="flex items-center gap-2 flex-wrap px-3 py-1 text-[10px] border-b bg-emerald-50/70 dark:bg-emerald-900/20 border-emerald-200/70 dark:border-emerald-800/40 text-emerald-700 dark:text-emerald-400">
                                        <Link2 className="w-3 h-3 shrink-0" />
                                        <span className="font-semibold truncate">
                                          Linked to {source}
                                          {tracksLatest ? ' · tracks latest' : pinned ? ` · v${pinned}` : ''}
                                        </span>
                                        <span className="text-emerald-600/70 dark:text-emerald-500/70 shrink-0">
                                          edits to {source} change this step
                                        </span>
                                        {isStale && !tracksLatest && (
                                          <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); relinkToLatest(block.id, listId); }}
                                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-bold shrink-0 bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100 dark:bg-amber-500/20 dark:border-amber-700/40 dark:text-amber-300"
                                          >
                                            <AlertTriangle className="w-2.5 h-2.5" />
                                            v{latest} available — update
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          onClick={(e) => { e.stopPropagation(); openPeek(block, listId); }}
                                          title="Show the steps this link stands for, beside the canvas"
                                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-bold shrink-0 bg-white border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:bg-white/5 dark:border-emerald-700/40 dark:text-emerald-300"
                                        >
                                          <PanelRightOpen className="w-2.5 h-2.5" /> View steps
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(e) => { e.stopPropagation(); detachBlock(index, listId); }}
                                          title="Inline these steps here so they can be edited. The copy stops tracking the saved workflow."
                                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-bold shrink-0 bg-white border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:bg-white/5 dark:border-emerald-700/40 dark:text-emerald-300"
                                        >
                                          <Scissors className="w-2.5 h-2.5" /> Detach
                                        </button>
                                      </div>
                                    );
                                  })()}

                                  {/* Top Row: Info & Controls */}
                                  <div
                                    onClick={() => ((!isFlowBlock && (hasBody || usesOutputPanel)) || isUserInputBlock) && toggleExpand(block.id, listId)}
                                    className={`px-3 py-1.5 flex items-center justify-between ${(!isFlowBlock && (hasBody || usesOutputPanel)) || isUserInputBlock ? 'hover:bg-gray-50/50 dark:hover:bg-white/5 transition-colors' : ''}`}
                                  >
                                    <div className="flex items-center min-w-0 flex-1">
                                      {/* Only in select mode, so the cards stay uncluttered the rest
                                          of the time. A real checkbox, so drag-and-drop refuses to
                                          start on it and ticking one never becomes a drag. */}
                                      {selection.listId === listId && (
                                        <input
                                          type="checkbox"
                                          checked={isSelected(listId, block.id)}
                                          onChange={() => toggleSelect(listId, block.id)}
                                          onClick={(e) => e.stopPropagation()}
                                          title="Select this step"
                                          className="mr-2 shrink-0 accent-indigo-600 cursor-pointer"
                                        />
                                      )}
                                      <div className={`flex items-center space-x-2 ${!isFlowBlock && !hasParams ? 'ml-1' : ''}`}>
                                        {!isFlowBlock && (
                                          <span title={block.instrument.replace(/_/g, ' ')} className="w-28 shrink-0 truncate text-center text-[10px] font-semibold px-2 py-0.5 bg-gray-100 text-gray-600 border border-gray-200 dark:bg-white/10 dark:text-gray-300 dark:border-white/5 rounded-md capitalize">
                                            {block.instrument.replace(/_/g, ' ')}
                                          </span>
                                        )}
                                        <span className={`text-[13px] tracking-tight ${isLibraryBlock ? '' : 'capitalize'} ${isFlowBlock ? flowTextClass : 'text-gray-800 dark:text-gray-100 font-medium'}`}>
                                          {isLibraryBlock ? block.method : block.method.replace(/_/g, ' ')}
                                          {blockWarnings.length > 0 && (
                                            <span title={blockWarnings.join('\n')} className="inline-flex items-center ml-1.5 cursor-help">
                                              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                                            </span>
                                          )}
                                        </span>
                                        {isFlowBlock && !isUserInputBlock && block.schema?.parameters && (
                                          <div className="flex items-center space-x-2 ml-2">
                                            {Object.keys(block.schema.parameters).map(paramKey => {
                                              const pData = block.schema!.parameters[paramKey];
                                              const val = block.params[paramKey];
                                              const actualVal = val !== undefined ? val : (pData.default !== undefined ? String(pData.default) : '');
                                              const hashInvalid = emptyHashFields.has(hashFieldKey(listId, block.id, paramKey));
                                              return (
                                                <div key={paramKey} className="relative flex items-center">
                                                  <input
                                                    type="text"
                                                    list={(pData.options || availableVars.length > 0) ? `flow-vars-${block.id}-${paramKey}` : undefined}
                                                    value={actualVal}
                                                    placeholder={paramKey.replace(/_/g, ' ')}
                                                    title={hashInvalid ? "Add a variable name after '#'" : undefined}
                                                    onChange={(e) => {
                                                      handleParamChange(block.id, paramKey, e.target.value, pData.type || '', listId);
                                                      clearHashWarning(listId, block.id, paramKey);
                                                    }}
                                                    onBlur={(e) => {
                                                      if (e.target.value === '' && pData.default !== undefined) {
                                                        handleParamChange(block.id, paramKey, String(pData.default), pData.type || '', listId);
                                                      }
                                                      handleHashBlur(listId, block.id, paramKey, e.target.value);
                                                    }}
                                                    onClick={(e) => e.stopPropagation()}
                                                    className={`${(paramKey === 'prompt' || paramKey === 'message') ? 'w-56' : 'w-32'} border rounded px-2 py-1 text-xs focus:outline-none ${hashInvalid ? 'border-red-400 dark:border-red-500 focus:border-red-500' : flowInputClass}`}
                                                  />
                                                  {(pData.options || availableVars.length > 0) && (
                                                    <datalist id={`flow-vars-${block.id}-${paramKey}`}>
                                                      {(pData.options || []).map((opt: any) => (
                                                        <option key={`opt-${String(opt)}`} value={String(opt)} />
                                                      ))}
                                                      {/* Conditions are evaluated against the run's variables directly, so they take
                                                          the bare name (e.g. `temperature > 40`), not the '#name' parameter form. */}
                                                      {!pData.options && availableVars.map((v: string) => (
                                                        <option key={`var-${v}`} value={v} />
                                                      ))}
                                                    </datalist>
                                                  )}
                                                </div>
                                              )
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    <div className="flex items-center space-x-2 shrink-0 ml-4">
                                      {/* Return Variable Logic */}
                                      {(() => {
                                        if (isFlowBlock || listId === 'prep' || listId === 'cleanup') return null;
                                        const hasLegacyReturn = Boolean(block.returnVar);
                                        if (returnLeaves.length === 0 && !hasLegacyReturn) return null;

                                        // A structured return has more fields than fit in this
                                        // row — it gets the Outputs panel in the expanded body
                                        // instead, and the header just summarizes what's bound.
                                        if (usesOutputPanel) {
                                          const bound = returnLeaves.map(l => getBoundVar(block, l, returnLeaves)).filter(Boolean);
                                          return (
                                            <button
                                              type="button"
                                              onClick={(e) => { e.stopPropagation(); toggleExpand(block.id, listId); }}
                                              title={`This step returns ${returnLeaves.length} fields. Name the ones you want to keep — only numbers can be used as an optimization objective.`}
                                              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] font-bold transition-colors mr-2 ${
                                                bound.length
                                                  ? 'bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-500/10 dark:border-blue-500/30 dark:text-blue-300'
                                                  : 'bg-white border-gray-200 text-gray-500 hover:text-gray-700 dark:bg-white/5 dark:border-white/10 dark:text-gray-400 dark:hover:text-gray-200'
                                              }`}
                                            >
                                              <span>Save</span>
                                              <span className="font-mono font-normal max-w-[10rem] truncate">
                                                {bound.length ? bound.join(', ') : `${returnLeaves.length} outputs`}
                                              </span>
                                            </button>
                                          );
                                        }

                                        // Scalar / short-tuple return: the names stay inline.
                                        const inlineLeaves: ReturnLeaf[] = returnLeaves.length
                                          ? returnLeaves
                                          : (block.returnVar || '').split(',').map((_, i) => ({ path: String(i), type: 'Any', numeric: false }));
                                        return (
                                          <div className="flex items-center space-x-2 mr-2">
                                            <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">Save</span>
                                            <div className="flex space-x-1 items-center">
                                              {inlineLeaves.map((leaf, i) => (
                                                <div key={leaf.path || i} className="flex items-center space-x-1">
                                                  {inlineLeaves.length > 1 && (
                                                    <span className="text-[10px] text-gray-400 font-mono">{leaf.path}:</span>
                                                  )}
                                                  <input
                                                    type="text"
                                                    value={getBoundVar(block, leaf, inlineLeaves)}
                                                    placeholder={`var_${i + 1}`}
                                                    onClick={(e) => e.stopPropagation()}
                                                    onChange={(e) => handleReturnBindingChange(block.id, inlineLeaves, leaf.path, e.target.value, listId)}
                                                    className="w-20 bg-gray-50 dark:bg-black/60 border border-gray-300 dark:border-white/10 rounded px-2 py-0.5 text-xs focus:outline-none focus:border-blue-500 dark:focus:border-blue-500 text-gray-800 dark:text-white"
                                                  />
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                        );
                                      })()}

                                      {isUserInputBlock && (
                                        <div className="flex items-center space-x-2 mr-2">
                                          <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">Save</span>
                                          <input
                                            type="text"
                                            value={block.params?.variable_name ?? ''}
                                            placeholder="variable"
                                            title="The answer is stored under this name, for later steps to use as #name"
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(e) => handleParamChange(block.id, 'variable_name', e.target.value, 'str', listId)}
                                            className="w-20 bg-gray-50 dark:bg-black/60 border border-gray-300 dark:border-white/10 rounded px-2 py-0.5 text-xs focus:outline-none focus:border-blue-500 dark:focus:border-blue-500 text-gray-800 dark:text-white"
                                          />
                                        </div>
                                      )}

                                      {/* Action Buttons */}
                                      <div className="flex items-center space-x-1 border-l border-gray-200 dark:border-white/10 pl-3">
                                        {(!isFlowBlock || isUserInputBlock) && listId === 'canvas' && (
                                          <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); toggleBatchAction(block.id, listId); }}
                                            title={block.isBatchAction ? "Batch step: runs once per batch group (set the group size on the Configure page), not once per row. Click to make it per-sample again." : "Per-sample step: repeats once per row when run against a spreadsheet. Click to make it a batch step (runs once per batch group instead)."}
                                            className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-bold transition-colors ${
                                              block.isBatchAction
                                                ? 'bg-teal-50 border-teal-300 text-teal-700 dark:bg-teal-500/20 dark:border-teal-700/40 dark:text-teal-300'
                                                : 'bg-white border-gray-200 text-gray-500 hover:text-gray-700 dark:bg-white/5 dark:border-white/10 dark:text-gray-400 dark:hover:text-gray-200'
                                            }`}
                                          >
                                            <Layers className="w-3.5 h-3.5" />
                                            <span>{block.isBatchAction ? 'Batch' : 'Per-Sample'}</span>
                                          </button>
                                        )}
                                        <button onClick={(e) => { e.stopPropagation(); toggleHideBlock(block.id, listId); }} title={block.isHidden ? 'Skip this step on the next run (click to re-enable)' : 'Disable this step without deleting it'} className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors">
                                          {block.isHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                        </button>
                                        {!isClosingFlowBlock && (
                                          <button
                                            onClick={(e) => { e.stopPropagation(); duplicateBlock(index, listId); }}
                                            title={isFlowBlock ? 'Duplicate this block and everything inside it' : 'Duplicate this step with its parameters'}
                                            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
                                          >
                                            <Copy className="w-4 h-4" />
                                          </button>
                                        )}
                                        <button onClick={(e) => { e.stopPropagation(); removeBlock(index, listId); }} className="p-1.5 rounded-md text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:text-red-300 dark:hover:bg-red-900/30 transition-colors">
                                          <Trash2 className="w-4 h-4" />
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                  </div>

                                  {/* What is wrong with this step is not something to click for.
                                      These used to live inside the expandable body, and a block is
                                      only expandable when it has parameters — so on a method that
                                      takes none ("Method 'x.y' no longer exists" being the case
                                      that matters most) the message had nowhere to appear at all,
                                      leaving a warning triangle whose explanation existed only in
                                      a hover tooltip. */}
                                  {!isFlowBlock && blockWarnings.length > 0 && (
                                    <div className="px-3 pb-2 pt-0">
                                      <div className="bg-amber-50/50 dark:bg-amber-900/10 border border-amber-200/50 dark:border-amber-500/20 rounded text-amber-700 dark:text-amber-400 text-[10px] px-2 py-1.5 font-medium">
                                          <ul className="list-disc pl-4 space-y-0.5">
                                              {blockWarnings.map((w, idx) => <li key={idx}>{w}</li>)}
                                          </ul>
                                      </div>
                                    </div>
                                  )}

                                  {isExpanded && isUserInputBlock && (() => {
                                    const typeOptions: string[] = block.schema?.parameters?.input_type?.options?.map(String)
                                      || ['str', 'int', 'float', 'bool'];
                                    const currentType = String(block.params?.input_type || 'str');
                                    return (
                                      // Same field boxes as a method's arguments (see renderParam below).
                                      <div className="px-3 pb-2 pt-0 flex flex-wrap gap-2 items-center">
                                        <div className="flex items-center space-x-2 shrink-0 bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 rounded-md px-2 py-1">
                                          <label className="text-[10px] text-gray-500 dark:text-gray-400 font-medium whitespace-nowrap">prompt</label>
                                          <input
                                            type="text"
                                            value={block.params?.prompt ?? ''}
                                            placeholder="str"
                                            onChange={(e) => handleParamChange(block.id, 'prompt', e.target.value, 'str', listId)}
                                            className="w-44 bg-transparent border-l border-gray-200 dark:border-white/10 pl-2 text-gray-800 dark:text-gray-100 text-[11px] focus:outline-none placeholder:text-gray-300 dark:placeholder:text-gray-700"
                                          />
                                        </div>
                                        <div className="flex items-center space-x-2 shrink-0 bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 rounded-md px-2 py-1">
                                          <label className="text-[10px] text-gray-500 dark:text-gray-400 font-medium whitespace-nowrap">type</label>
                                          {/* A select, not a datalist: the choices are fixed, and a datalist filters them by
                                              whatever is already typed -- with "str" chosen it offered only "str". */}
                                          <select
                                            value={typeOptions.includes(currentType) ? currentType : 'str'}
                                            onChange={(e) => handleParamChange(block.id, 'input_type', e.target.value, 'str', listId)}
                                            className="w-16 bg-transparent border-l border-gray-200 dark:border-white/10 pl-1.5 text-gray-800 dark:text-gray-100 text-[11px] focus:outline-none"
                                          >
                                            {typeOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                                          </select>
                                        </div>
                                      </div>
                                    );
                                  })()}

                                  {/* Bottom Row: Params */}
                                  {isExpanded && !isFlowBlock && (
                                    <div className="px-3 pb-2 pt-0 flex flex-col space-y-2">
                                      {(() => {
                                        if (!hasParams) return null;
                                        return (
                                        <div className="flex flex-wrap gap-2 items-center">
                                          {visibleParams.map((param) => {
                                            const renderParam = (pData: any, paramKey: string, paramName: string, bId: string, lId: string, paramsObj: any): React.ReactNode => {
                                                if (pData.is_object && pData.fields) {
                                                    return (
                                                        <div key={paramKey} className="flex flex-col space-y-1 shrink-0 p-2 border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a]">
                                                            <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider px-1">{paramName}</span>
                                                            <div className="flex flex-wrap gap-x-2 gap-y-1.5">
                                                                {Object.keys(pData.fields).map(subKey => 
                                                                    renderParam(pData.fields[subKey], `${paramKey}.${subKey}`, subKey, bId, lId, paramsObj)
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                }

                                                const displayType = (pData.type || '').replace(/<class '([^']+)'>/, '$1').replace('typing.', '');
                                                const val = paramKey.split('.').reduce((acc: any, part: string) => acc && acc[part] !== undefined ? acc[part] : undefined, paramsObj);
                                                const actualVal = val !== undefined ? val : (pData.default !== undefined ? String(pData.default) : '');
                                                const hashInvalid = emptyHashFields.has(hashFieldKey(lId, bId, paramKey));

                                                return (
                                                    <div key={paramKey} className={`flex items-center space-x-2 shrink-0 bg-white dark:bg-[#1a1a1a] border rounded-md px-2 py-1 ${hashInvalid ? 'border-red-400 dark:border-red-500/70' : 'border-gray-200 dark:border-white/10'}`}>
                                                      <label className="text-[10px] text-gray-500 dark:text-gray-400 capitalize font-medium flex items-center whitespace-nowrap">
                                                        <span>{paramName.replace(/_/g, ' ')}</span>
                                                        {pData.required && <span className="text-red-500/80 leading-none ml-0.5">*</span>}
                                                      </label>
                                                      <input
                                                        type="text"
                                                        list={(pData.options || availableVars.length > 0) ? `datalist-${bId}-${paramKey}` : undefined}
                                                        value={actualVal}
                                                        placeholder={pData.default !== undefined ? `Default: ${pData.default}` : displayType}
                                                        onChange={(e) => {
                                                          handleParamChange(bId, paramKey, e.target.value, pData.type || '', lId);
                                                          clearHashWarning(lId, bId, paramKey);
                                                        }}
                                                        onBlur={(e) => {
                                                          if (e.target.value === '' && pData.default !== undefined) {
                                                            handleParamChange(bId, paramKey, String(pData.default), pData.type || '', lId);
                                                          }
                                                          handleHashBlur(lId, bId, paramKey, e.target.value);
                                                        }}
                                                        className={`w-28 bg-transparent border-l border-gray-200 dark:border-white/10 pl-2 text-gray-800 dark:text-gray-100 text-[11px] focus:outline-none placeholder:text-gray-300 dark:placeholder:text-gray-700`}
                                                      />
                                                      {hashInvalid && (
                                                        <span title="Add a variable name after '#'" className="cursor-help shrink-0">
                                                          <AlertTriangle className="w-3 h-3 text-red-500" />
                                                        </span>
                                                      )}
                                                      {(pData.options || availableVars.length > 0) && (
                                                        <datalist id={`datalist-${bId}-${paramKey}`}>
                                                          {(pData.options || []).map((opt: any) => (
                                                            <option key={`opt-${String(opt)}`} value={String(opt)} />
                                                          ))}
                                                          {availableVars.map((v: string) => (
                                                            <option key={`var-${v}`} value={`#${v}`} label={`variable from an earlier step`} />
                                                          ))}
                                                        </datalist>
                                                      )}
                                                    </div>
                                                );
                                            };

                                            const pData = (effectiveSchema as any)?.[param] || {};
                                            return renderParam(pData, param, param, block.id, listId, block.params);
                                          })}
                                        </div>
                                        );
                                      })()}

                                      {acceptsKwargs && (
                                        <div className="p-2 border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a]">
                                          <ExtraArguments
                                            idPrefix={`extra-${listId}-${block.id}`}
                                            value={extraArgs}
                                            unknownSignature={!!block.schema?.signature_unavailable}
                                            // Names already used for this same method elsewhere in the
                                            // workflow: the second time an option is needed it is a pick
                                            // rather than a spelling the scientist has to remember.
                                            suggestions={kwargNamesUsedFor(block.instrument, block.method, schemaParamNames)}
                                            valueSuggestions={availableVars.map(v => ({ value: `#${v}`, label: 'variable from an earlier step' }))}
                                            onChange={(next) => updateBlock(listId, block.id, b => {
                                              const kept: Record<string, any> = {};
                                              for (const [k, v] of Object.entries(b.params || {})) {
                                                if (schemaParamNames.has(k) || k.startsWith('_')) kept[k] = v;
                                              }
                                              return { ...b, params: { ...kept, ...next } };
                                            })}
                                          />
                                        </div>
                                      )}

                                      {/* Outputs: one variable per field of a structured return.
                                          The whole point of naming fields individually is that a
                                          rich result object can't go into an optimizer as-is —
                                          only its numeric leaves can, and which ones matter is
                                          the user's call, not something we can guess. */}
                                      {usesOutputPanel && (
                                        <div className="p-2 border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a]">
                                          <div className="flex items-baseline gap-2 px-1 pb-1.5">
                                            <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">Outputs</span>
                                            <span className="text-[10px] text-gray-400 dark:text-gray-500">
                                              returns <span className="font-mono">{block.schema?.return_type}</span> — name a field to keep it; leave the rest blank
                                            </span>
                                          </div>
                                          <div className="flex flex-wrap gap-x-2 gap-y-1.5">
                                            {returnLeaves.map(leaf => (
                                              <div
                                                key={leaf.path}
                                                className="flex items-center space-x-2 shrink-0 bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 rounded-md px-2 py-1"
                                              >
                                                <label className="text-[10px] text-gray-500 dark:text-gray-400 font-mono flex items-center whitespace-nowrap">
                                                  <span>{leaf.path}</span>
                                                  {leaf.numeric ? (
                                                    <span
                                                      title="A number — this one can be used as an optimization objective."
                                                      className="ml-1 px-1 rounded bg-purple-50 text-purple-600 dark:bg-purple-500/10 dark:text-purple-400 text-[9px] font-bold uppercase cursor-help"
                                                    >
                                                      {leaf.type}
                                                    </span>
                                                  ) : (
                                                    <span
                                                      title={`${leaf.type} — can be saved as a variable for later steps, but can't be an optimization objective.`}
                                                      className="ml-1 px-1 rounded bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-500 text-[9px] font-bold uppercase cursor-help"
                                                    >
                                                      {leaf.type}
                                                    </span>
                                                  )}
                                                </label>
                                                <input
                                                  type="text"
                                                  value={getBoundVar(block, leaf, returnLeaves)}
                                                  placeholder="variable name"
                                                  onClick={(e) => e.stopPropagation()}
                                                  onChange={(e) => handleReturnBindingChange(block.id, returnLeaves, leaf.path, e.target.value, listId)}
                                                  className="w-28 bg-transparent border-l border-gray-200 dark:border-white/10 pl-2 text-gray-800 dark:text-gray-100 text-[11px] focus:outline-none placeholder:text-gray-300 dark:placeholder:text-gray-700"
                                                />
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  )}
                              </div>
                            )}
                          </Draggable>
                    </React.Fragment>
                  );
                })}</>)})()}
                  <div className="hidden">{provided.placeholder}</div>
                </div>
            )}
          </div>
        )}
      </Droppable>
    </div>
  );

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div className="flex-1 flex overflow-hidden">
        
        {/* Left Sidebar (Toolbox) */}
        <div className={`w-72 bg-white dark:bg-[#1a1a1a] flex-col border-r border-gray-200 dark:border-white/10 shrink-0 z-10 ${hideToolbox ? 'hidden' : 'flex'}`}>
          <div className="h-16 px-4 flex items-center gap-2 border-b border-gray-200 dark:border-white/10 bg-gray-50/60 dark:bg-black/10 shrink-0">
             <div className="relative flex-1">
                <input
                  type="text"
                  placeholder="Search modules..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-blue-500 dark:focus:border-blue-500 transition-colors shadow-sm"
                />
                <Search className="w-4 h-4 absolute left-3 top-2.5 text-gray-400" />
             </div>
             <button
                onClick={toggleAutoFillVariables}
                title={autoFillVariables ? "Auto-fill is ON — new blocks default every param to #paramName, for Optimization. Click to turn off." : "Auto-fill is OFF. Click to make new blocks default every param to #paramName, for Optimization."}
                className={`shrink-0 flex items-center gap-1 pl-1.5 pr-2 py-2 rounded-lg border text-[11px] font-bold transition-colors ${autoFillVariables
                  ? 'bg-purple-50 border-purple-200 text-purple-600 dark:bg-purple-500/10 dark:border-purple-500/30 dark:text-purple-400'
                  : 'bg-white border-gray-200 text-gray-400 hover:text-gray-600 dark:bg-white/5 dark:border-white/10 dark:hover:text-gray-300'}`}
             >
                <Hash className="w-3.5 h-3.5" />
                <span>Auto</span>
             </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-0.5">
            <Droppable 
              droppableId="toolbox" 
              isDropDisabled={true}
            >
              {(provided) => (
                <div ref={provided.innerRef} {...provided.droppableProps} className="space-y-1">
                  {Object.keys(instruments)
                    .sort((a, b) => {
                       const aIsFC = a === 'Flow Control' || a === 'Flow_Control';
                       const bIsFC = b === 'Flow Control' || b === 'Flow_Control';
                       if (aIsFC) return -1;
                       if (bIsFC) return 1;
                       const aIsLib = a === 'Library Workflows';
                       const bIsLib = b === 'Library Workflows';
                       if (aIsLib) return 1;
                       if (bIsLib) return -1;
                       return a.localeCompare(b);
                    })
                    .map((instrument) => {
                    const matchesInst = instrument.toLowerCase().includes(searchQuery.toLowerCase());
                    const isLibraryGroup = instrument === LIBRARY_INSTRUMENT;
                    const matchingMethods = Object.keys(instruments[instrument]).filter(method =>
                        (matchesInst || method.toLowerCase().includes(searchQuery.toLowerCase()))
                        // Never offer the open workflow to itself: `math` inside `math` is a cycle,
                        // which save_workflow rejects, so listing it only leads somewhere invalid.
                        && !(isLibraryGroup && currentWorkflowName && method === currentWorkflowName)
                    );
                    
                    if (searchQuery && matchingMethods.length === 0) return null;

                    const isExpanded = searchQuery ? true : expandedToolbox[instrument];
                    const isFlowControl = instrument === 'Flow Control' || instrument === 'Flow_Control';
                    const isLibrary = instrument === 'Library Workflows';
                    const isBuiltin = isFlowControl || isLibrary;

                    let nameClass = "text-[13px] font-semibold capitalize truncate ";
                    if (isFlowControl) nameClass += "text-sky-700 dark:text-sky-400";
                    else if (isLibrary) nameClass += "text-emerald-700 dark:text-emerald-400";
                    else nameClass += "text-gray-700 dark:text-gray-200";

                    return (
                      <div key={instrument} className="flex flex-col">
                        <button onClick={() => toggleToolbox(instrument)} className="w-full flex items-center justify-between px-2 py-2 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-white/5">
                          <div className="flex items-center space-x-2 min-w-0">
                             <span className={nameClass}>{instrument.replace(/_/g, ' ')}</span>
                             {isBuiltin ? (
                               <span className={`text-[9px] font-bold uppercase tracking-wider shrink-0 ${isFlowControl ? 'text-sky-400 dark:text-sky-500' : 'text-emerald-400 dark:text-emerald-500'}`}>Built-in</span>
                             ) : (
                               <span className="text-[10px] text-gray-400 dark:text-gray-500 font-medium shrink-0">{Object.keys(instruments[instrument]).length}</span>
                             )}
                          </div>
                          {isExpanded ? <ChevronUp className="w-3.5 h-3.5 text-gray-400 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
                        </button>

                        {isExpanded && (
                          <div className="ml-2 pl-2 border-l border-gray-100 dark:border-white/5 mt-0.5 mb-2 space-y-0.5">
                            {/* How a dragged workflow is brought in. Link is the default: reuse
                                should keep the saved workflow as one thing, so an edit to it
                                reaches everywhere. Copy is the deliberate choice to fork, with
                                the consequence spelled out rather than left implicit. */}
                            {isLibrary && (
                              <div className="px-1.5 py-1.5 mb-1">
                                <div className="flex rounded-md border border-gray-200 dark:border-white/10 overflow-hidden">
                                  {(['copy', 'link'] as ReuseMode[]).map(mode => (
                                    <button
                                      key={mode}
                                      type="button"
                                      onClick={() => { if (reuseMode !== mode) toggleReuseMode(); }}
                                      title={mode === 'copy'
                                        ? 'Copy: the workflow\'s steps are inlined here and become yours to edit. Later changes to the saved workflow do not affect this one.'
                                        : 'Link: keeps one reference that resolves when the run starts. Editing the saved workflow WILL change this workflow too.'}
                                      className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                                        reuseMode === mode
                                          ? (mode === 'copy'
                                              ? 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-200'
                                              : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300')
                                          : 'bg-transparent text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
                                      }`}
                                    >
                                      {mode === 'copy' ? <Copy className="w-3 h-3" /> : <Link2 className="w-3 h-3" />}
                                      {mode}
                                    </button>
                                  ))}
                                </div>
                                <p className="text-[9px] leading-tight text-gray-400 dark:text-gray-500 mt-1 px-0.5">
                                  {reuseMode === 'copy'
                                    ? 'Steps are inlined and editable. The original is left alone.'
                                    : 'Stays a reference — editing the original changes this workflow too.'}
                                </p>
                              </div>
                            )}
                            {matchingMethods.length === 0 && (
                              <p className="text-[11px] text-gray-400 dark:text-gray-500 italic px-2 py-1.5">
                                {isLibrary ? 'No saved workflows yet' : 'No modules'}
                              </p>
                            )}
                            {matchingMethods.map((method, idx) => (
                              <Draggable key={`${instrument}::${method}`} draggableId={`${instrument}::${method}`} index={idx}>
                              {(provided, snapshot) => (
                                <React.Fragment>
                                  <div
                                    ref={provided.innerRef}
                                    {...provided.draggableProps}
                                    {...provided.dragHandleProps}
                                    className={`group/item pl-1.5 pr-2 py-1.5 rounded-md transition-all flex items-center gap-1.5 cursor-grab active:cursor-grabbing ${snapshot.isDragging ? 'bg-white dark:bg-[#1a1a1a] shadow-xl ring-2 ring-blue-500/20' : 'bg-transparent hover:bg-gray-50 dark:hover:bg-white/5'}`}
                                    style={provided.draggableProps.style}
                                  >
                                    <GripVertical className="w-3 h-3 text-gray-300 dark:text-gray-600 shrink-0 opacity-0 group-hover/item:opacity-100 transition-opacity" />
                                    <div className="flex items-center justify-between w-full min-w-0 relative">
                                      <span title={isLibrary ? method : method.replace(/_/g, ' ')} className={`font-medium text-gray-700 dark:text-gray-300 text-[13px] truncate ${isLibrary ? '' : 'capitalize'}`}>{isLibrary ? method : method.replace(/_/g, ' ')}</span>
                                      {instruments[instrument][method]?.description && (
                                        <div className="relative group/tooltip flex items-center shrink-0 ml-2">
                                          <Info className="w-3.5 h-3.5 text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 transition-colors cursor-help" />
                                          <div className="absolute right-0 top-full mt-2 w-[260px] p-2.5 bg-gray-900 dark:bg-gray-800 text-gray-100 text-xs rounded-lg shadow-xl opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all z-50 pointer-events-none whitespace-normal border border-gray-700">
                                            {instruments[instrument][method].description}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  {snapshot.isDragging && (
                                    <div className="pl-1.5 pr-2 py-1.5 rounded-md flex items-center gap-1.5 opacity-50 grayscale pointer-events-none select-none">
                                      <GripVertical className="w-3 h-3 text-gray-300 dark:text-gray-600 shrink-0" />
                                      <div className="flex items-center justify-between w-full min-w-0">
                                        <span title={isLibrary ? method : method.replace(/_/g, ' ')} className="font-medium text-gray-700 dark:text-gray-300 text-[13px] truncate">{isLibrary ? method : method.replace(/_/g, ' ')}</span>
                                        {instruments[instrument][method]?.description && (
                                          <div className="shrink-0 ml-2">
                                            <Info className="w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </React.Fragment>
                              )}
                              </Draggable>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="hidden">{provided.placeholder}</div>
                </div>
              )}
            </Droppable>
          </div>
          {toolboxFooter && (
            <div className="shrink-0 border-t border-gray-200 dark:border-white/10 p-3">
              {toolboxFooter}
            </div>
          )}
        </div>

        {/* Sequence Canvas (Center) and Right Sidebar */}
        <div className="flex-1 flex flex-col bg-gray-50 dark:bg-[#0a0a0a] relative min-w-0">
          {header}
          
          <div className="flex-1 flex overflow-hidden relative min-w-0">
            {customView ? (
              customView
            ) : (
              <div className="flex-1 overflow-y-auto p-4 md:p-8 relative">
                <div className="max-w-5xl mx-auto w-full relative min-h-[85vh]">
                  {/* Select sits hard left, lining up with the checkbox column it turns on; the
                      whole-list view toggles stay right. The strip spans the full width only to
                      place them, so it lets clicks through to the list beneath it. */}
                  <div className="absolute -top-4 left-0 right-0 flex items-center space-x-3 z-10 pointer-events-none [&>*]:pointer-events-auto">
                     {renderSelectToggle('canvas')}
                     <div className="flex-1" />
                     <button onClick={expandAll} className="flex items-center space-x-1.5 text-[11px] font-medium text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 transition-colors uppercase tracking-wide" title="Expand All Cards">
                         <ChevronsUpDown className="w-3.5 h-3.5" />
                         <span>Expand All</span>
                     </button>
                     <div className="w-px h-3 bg-gray-200 dark:bg-white/10"></div>
                     <button onClick={collapseAll} className="flex items-center space-x-1.5 text-[11px] font-medium text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 transition-colors uppercase tracking-wide" title="Collapse All Cards">
                         <ChevronsDownUp className="w-3.5 h-3.5" />
                         <span>Collapse All</span>
                     </button>
                  </div>
                  {renderSequenceList('canvas', 'Main Workflow', sequence)}
                </div>
              </div>
            )}

            {/* Spacer to prevent scrollbar overlap when sidebar is collapsed */}
            <div className="w-12 shrink-0 border-l border-transparent"></div>

            {/* Prep/Cleanup Sidebar Overlay */}
            <div className={`absolute top-0 right-0 h-full shrink-0 bg-white dark:bg-[#1a1a1a] border-l border-gray-200 dark:border-white/10 flex flex-col transition-all duration-300 shadow-2xl z-20 ${isRightSidebarOpen ? 'w-[28rem]' : 'w-12'}`}>
               {isRightSidebarOpen ? (
                 <div className="flex-1 flex h-full">
                    <button 
                      onClick={() => setIsRightSidebarOpen(false)}
                      className="w-6 shrink-0 h-full flex flex-col items-center justify-center bg-gray-50 hover:bg-gray-100 dark:bg-white/5 dark:hover:bg-white/10 border-r border-gray-200 dark:border-white/10 transition-colors"
                      title="Collapse Sidebar"
                    >
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                    </button>
                    <div className="flex-1 overflow-y-auto p-4 space-y-6">
                       {renderSequenceList('prep', 'Prep Phase', prepSequence)}
                       {renderSequenceList('cleanup', 'Cleanup Phase', cleanupSequence)}
                    </div>
                 </div>
               ) : (
                 <div className="flex-1 flex flex-col items-center justify-center cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5 transition-colors" onClick={() => setIsRightSidebarOpen(true)}>
                    <div className="text-xs font-bold tracking-[0.2em] text-gray-400 uppercase pointer-events-none" style={{ writingMode: 'vertical-rl' }}>
                        PREP & CLEANUP
                    </div>
                 </div>
               )}
            </div>
          </div>
        </div>
      </div>

      <WorkflowDiff
        isOpen={!!diff}
        title={diff?.title ?? ''}
        fromLabel={diff?.fromLabel ?? ''}
        toLabel={diff?.toLabel ?? ''}
        rows={diff?.rows ?? []}
        warning={diff?.warning}
        paramChanges={diff?.paramChanges}
        applyLabel={diff?.applyLabel ?? 'Update'}
        onApply={() => diff?.apply()}
        onClose={() => setDiff(null)}
      />

      <WorkflowPeek
        target={peek?.target ?? null}
        body={peekBody}
        isLoading={peekLoading}
        error={peekError}
        latestVersion={peek ? workflowVersions?.[peek.target.name] : undefined}
        onClose={closePeek}
        onDetach={peek ? () => {
          const list = getSequenceList(peek.listId);
          const index = list.findIndex(b => b.id === peek.blockId);
          closePeek();
          if (index !== -1) detachBlock(index, peek.listId);
        } : undefined}
        onUpdate={peek ? () => {
          const { blockId, listId } = peek;
          closePeek();
          void relinkToLatest(blockId, listId);
        } : undefined}
        onEdit={peek && onEditWorkflow ? () => {
          const { name, version, mode } = peek.target;
          closePeek();
          // Edit the version this step is pinned to, not head — otherwise "edit what this runs"
          // would quietly open something else.
          onEditWorkflow(name, mode === 'latest' ? undefined : version);
        } : undefined}
      />
    </DragDropContext>
  );
}
