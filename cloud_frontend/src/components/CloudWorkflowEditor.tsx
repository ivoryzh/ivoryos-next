"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react';
import {
  ReactFlow, MiniMap, Controls, Background, Connection, Edge, NodeTypes, Node, BackgroundVariant,
  Handle, Position, Panel, getOutgoers, addEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ChevronDown, ChevronUp, ChevronRight, Table2, PanelRightOpen, Hourglass, MessageSquareText,
  GitBranch, AlertTriangle, AlertCircle, CheckCircle2, LayoutGrid, X, EyeOff, GripVertical, Workflow, Wrench,
} from 'lucide-react';
import { LIBRARY_INSTRUMENT } from '@ivoryos/shared-ui';
import {
  CLOUD_LOGIC as CLOUD_LOGIC_SCHEMAS, IF_OPERATORS, isCloudLogicNode, isDeviceNode, isStartNode, blankParamsOf,
  logicProblemsOf, buildGraph,
} from '@/lib/dag';
import { parallelOnSameDevice } from '@/lib/canvasChecks';
import { useDocumentTheme } from '@/lib/useDocumentTheme';
import { GRID, freeHandleOf, isIfNode, pickAutoSource, slotBelow, tidyLayout } from '@/lib/canvasLayout';

interface CloudWorkflowEditorProps {
  cloudDevices: any[];
  statusData: any;
  health?: any;
  /** Nodes the last run attempt rejected — outlined on the canvas so the problem is findable. */
  invalidNodeIds?: string[];
  nodes: Node[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  edges: Edge[];
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  onNodesChange: any;
  onEdgesChange: any;
  onConnect: (params: Connection | Edge) => void;
  header?: React.ReactNode;
  /** The node's "open" button: shows a linked workflow's steps beside the canvas. */
  onOpenNode?: (node: Node) => void;
}

const FLOW_CONTROL = 'Flow Control';
// Indexed by a method name read off a node, so typed loosely.
const CLOUD_LOGIC: Record<string, any> = CLOUD_LOGIC_SCHEMAS;
const LOGIC_META: Record<string, { label: string; icon: React.ComponentType<any>; accent: string }> = {
  Wait: { label: 'Wait', icon: Hourglass, accent: 'text-sky-500' },
  User_Input: { label: 'User input', icon: MessageSquareText, accent: 'text-amber-500' },
  If: { label: 'If / else', icon: GitBranch, accent: 'text-violet-500' },
};

/** What a person calls a step, for warnings and toasts (never its generated id). */
function labelOf(node: Node | undefined): string {
  const block = (node?.data as any)?.block || {};
  if (block.instrument === LIBRARY_INSTRUMENT) return String(block.method || 'workflow');
  if (block.instrument === FLOW_CONTROL || block.instrument === 'Flow_Control') {
    return LOGIC_META[block.method]?.label || String(block.method || 'step');
  }
  return `${block.instrument} · ${String(block.method || '').replace(/_/g, ' ')}`;
}

/**
 * A rough picture of where a running node's loop is -- samples or optimizer iterations -- from the
 * device's progress summary. One cell per iteration up to 30, a plain bar beyond that.
 */
const IterationStrip = ({ progress }: { progress: any }) => {
  const total = progress.budget || progress.rows_total || 0;
  if (total < 2) return null;
  const done = progress.budget ? Math.max(0, (progress.iteration || 1) - 1) : (progress.rows_done || 0);
  const label = progress.budget ? 'iterations' : 'samples';
  if (total > 30) {
    return (
      <div className="mb-1.5" title={`${done} of ${total} ${label} done`}>
        <div className="h-1 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
          <div className="h-full bg-green-500" style={{ width: `${(done / total) * 100}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className="mb-1.5 flex gap-0.5" title={`${done} of ${total} ${label} done`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-1.5 flex-1 rounded-sm ${i < done ? 'bg-green-500' : i === done ? 'bg-yellow-400 animate-pulse' : 'bg-gray-200 dark:bg-white/10'}`}
        />
      ))}
    </div>
  );
};

/**
 * The live, aggregated schema. A node's `data.statusData` is a snapshot taken when it was dropped
 * and saved with the canvas, so anything learned since -- a workflow's outputs, a method added to
 * a driver -- never reached it. Nodes read this first and fall back to their snapshot.
 */
const LiveSchema = createContext<any>(null);

/** What the canvas knows that a single node cannot work out from its own data. */
const CanvasContext = createContext<{
  /** Every value a step on this canvas saves, for an If's variable picker. */
  variables: string[];
  /** Per node: why it cannot run as drawn. */
  problems: Map<string, string[]>;
  openNode: (id: string) => void;
  canOpen: boolean;
  answerInput: (runId: string, nodeId: string, value: string) => Promise<boolean>;
}>({ variables: [], problems: new Map(), openNode: () => {}, canOpen: false, answerInput: async () => false });

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * One draggable entry in the toolbox. Logic steps, a device's workflows and its instrument methods
 * all use it, so the palette reads as one list of things you can drop, told apart by icon colour
 * rather than by three unrelated box styles. What an entry does is in its tooltip, not on the card.
 */
const ToolItem = ({ icon: Icon, accent, label, title, onDragStart, trailing }: {
  icon: React.ComponentType<any>;
  accent: string;
  label: string;
  title?: string;
  onDragStart: (e: React.DragEvent) => void;
  trailing?: React.ReactNode;
}) => (
  <div
    draggable
    onDragStart={onDragStart}
    title={title}
    className="group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 cursor-grab active:cursor-grabbing transition-colors border-gray-300 bg-white shadow-sm hover:border-gray-400 hover:bg-gray-50 dark:shadow-none dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/20 dark:hover:bg-white/[0.07]"
  >
    <Icon className={`w-3.5 h-3.5 shrink-0 ${accent}`} />
    <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-700 dark:text-gray-200">{label}</span>
    {trailing}
    <GripVertical className="w-3.5 h-3.5 shrink-0 text-gray-300 opacity-0 group-hover:opacity-100 dark:text-gray-600" />
  </div>
);

const fieldLabel = 'text-[11px] font-mono text-gray-500 dark:text-gray-400';
const smallInput = 'nodrag nowheel w-full bg-gray-50 dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500 text-gray-800 dark:text-white';

/** A Cloud Logic node's settings. */
const LogicFields = ({ block, onParam, variables }: { block: any; onParam: (k: string, v: any) => void; variables: string[] }) => {
  const p = (k: string) => block.params?.[k] ?? CLOUD_LOGIC[block.method]?.parameters?.[k]?.default ?? '';
  if (block.method === 'Wait') {
    return (
      <label className="flex items-center gap-2">
        <span className={fieldLabel}>seconds</span>
        <input type="number" min={0} step="any" value={p('seconds')} onChange={e => onParam('seconds', e.target.value)} className={smallInput} />
      </label>
    );
  }
  if (block.method === 'User_Input') {
    return (
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className={fieldLabel}>prompt</span>
          <input type="text" value={p('prompt')} onChange={e => onParam('prompt', e.target.value)} className={smallInput} />
        </label>
        <label className="flex flex-col gap-1" title="Optional. Saves the answer under this name, so an If further down can test it.">
          <span className={fieldLabel}>save answer as (optional)</span>
          <input type="text" value={p('save_as')} placeholder="e.g. approved" onChange={e => onParam('save_as', e.target.value)} className={smallInput} />
        </label>
      </div>
    );
  }
  if (block.method === 'If') {
    const listId = `vars-${block.id}`;
    return (
      <div className="flex flex-col gap-1.5">
        <span className={fieldLabel}>continue down <span className="text-emerald-600 dark:text-emerald-400">true</span> when</span>
        <input
          type="text" list={listId} value={p('variable')} placeholder="variable, e.g. yield_percent"
          onChange={e => onParam('variable', e.target.value)} className={smallInput}
        />
        <datalist id={listId}>{variables.map(v => <option key={v} value={v} />)}</datalist>
        <div className="flex gap-1.5">
          <select value={p('operator')} onChange={e => onParam('operator', e.target.value)} className="nodrag nowheel w-24 text-xs">
            {IF_OPERATORS.map((op: string) => <option key={op} value={op}>{op}</option>)}
          </select>
          <input type="text" value={p('value')} placeholder="value" onChange={e => onParam('value', e.target.value)} className={smallInput} />
        </div>
      </div>
    );
  }
  return null;
};

function logicSummary(block: any): string {
  const p = (k: string) => block.params?.[k] ?? CLOUD_LOGIC[block.method]?.parameters?.[k]?.default ?? '';
  if (block.method === 'Wait') return `wait ${p('seconds')} s`;
  if (block.method === 'User_Input') return `ask: ${p('prompt')}`;
  if (block.method === 'If') return `if ${p('variable') || '?'} ${p('operator')} ${p('value')}`;
  return '';
}

/** A User_Input step that is waiting: the question, and where to answer it. */
const AnswerBox = ({ taskStatus }: { taskStatus: any }) => {
  const { answerInput } = useContext(CanvasContext);
  const [value, setValue] = useState('');
  const [sent, setSent] = useState(false);
  const submit = async () => {
    if (sent) return;
    setSent(true);
    const ok = await answerInput(taskStatus.runId, taskStatus.nodeId, value);
    if (!ok) setSent(false);
  };
  return (
    <div className="nodrag mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 dark:border-amber-500/40 dark:bg-amber-500/10">
      <div className="text-xs font-medium text-amber-900 dark:text-amber-200">{taskStatus.progress?.prompt || 'Continue?'}</div>
      <div className="mt-1.5 flex gap-1.5">
        <input
          type="text" value={value} disabled={sent} placeholder="answer (optional)"
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          className={smallInput}
        />
        <button
          onClick={submit} disabled={sent}
          className="shrink-0 rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
        >
          {sent ? 'Sent' : 'Continue'}
        </button>
      </div>
    </div>
  );
};

/** What a running or finished Cloud Logic step is doing, in one line. */
const LogicStatus = ({ block, taskStatus }: { block: any; taskStatus: any }) => {
  const pr = taskStatus?.progress || {};
  const waiting = taskStatus?.status === 'running' && block.method === 'Wait' && pr.until;
  const now = useNow(!!waiting);
  if (!taskStatus) return null;
  if (taskStatus.status === 'running' && block.method === 'User_Input' && pr.state === 'waiting_input') {
    return <AnswerBox taskStatus={taskStatus} />;
  }
  let text = '';
  if (waiting) {
    const left = Math.max(0, Math.round((Date.parse(pr.until) - now) / 1000));
    text = `waiting · ${left >= 60 ? `${Math.floor(left / 60)} min ${left % 60} s` : `${left} s`} left`;
  } else if (taskStatus.status === 'running' && pr.state === 'answered') {
    text = 'answered · continuing…';
  } else if (taskStatus.status === 'completed' && block.method === 'If' && pr.branch) {
    text = `${pr.variable} = ${pr.actual} → ${pr.branch}`;
  } else if (taskStatus.status === 'completed' && block.method === 'User_Input') {
    text = pr.answer ? `answered: ${pr.answer}` : 'continued';
  } else if (taskStatus.status === 'error' && pr.message) {
    text = pr.message;
  } else if (taskStatus.status === 'skipped') {
    text = 'skipped · branch not taken';
  }
  if (!text) return null;
  return (
    <div className={`mt-2 text-[11px] ${taskStatus.status === 'error' ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`} title={text}>
      {text}
    </div>
  );
};

const CustomCloudNode = ({ data, id }: any) => {
  const { block, updateNodeData, cloudDevices, targetDeviceId, taskStatus, isInvalid } = data;
  const live = useContext(LiveSchema);
  const canvas = useContext(CanvasContext);
  const statusData = live?.instruments && Object.keys(live.instruments).length ? live : data.statusData;
  const isLogic = (block.instrument === FLOW_CONTROL || block.instrument === 'Flow_Control') && !!CLOUD_LOGIC[block.method];
  const isStart = (block.instrument === FLOW_CONTROL || block.instrument === 'Flow_Control') && block.method === 'Start';
  const isLink = block.instrument === LIBRARY_INSTRUMENT;
  const isMissing = !isLogic && !isStart
    && (!statusData?.instruments?.[block.instrument] || !statusData?.instruments?.[block.instrument]?.[block.method]);
  const problems = canvas.problems.get(String(id)) || [];

  const handleParamChange = (paramKey: string, val: any) => {
    updateNodeData(id, { block: { ...block, params: { ...block.params, [paramKey]: val } } });
  };

  const allParams = isLogic ? [] : Object.keys(block.schema?.parameters || {});

  const status = taskStatus?.status;
  const waitingOnPerson = status === 'running' && taskStatus?.progress?.state === 'waiting_input';
  let borderClass = 'border-blue-500';
  if (isLogic) borderClass = 'border-slate-400 dark:border-slate-500';
  // A steady ring, not a pulse: the card holds a text box someone is about to type into.
  if (status === 'running') borderClass = waitingOnPerson
    ? 'border-amber-500 ring-4 ring-amber-400/30 shadow-[0_0_18px_rgba(245,158,11,0.7)]'
    : 'border-yellow-400 shadow-[0_0_15px_rgba(250,204,21,0.6)]';
  else if (status === 'completed') borderClass = 'border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.6)]';
  else if (status === 'error') borderClass = 'border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.6)]';
  else if (status === 'skipped' || status === 'cancelled') borderClass = 'border-gray-300 dark:border-white/20 opacity-60';
  else if (!status && !isLogic) {
    if (!targetDeviceId) borderClass = 'border-orange-500';
    else if (isMissing) borderClass = 'border-red-500';
  }
  // Outranks the resting states above, but never a live task status: while a run is in flight the
  // border is reporting what the hardware is doing, which matters more than a stale authoring
  // complaint. Only reachable when a run was refused, so nothing is in flight anyway.
  if (isInvalid && !taskStatus) borderClass = 'border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.6)]';

  const returnType = block.schema?.return_type || 'None';
  const hasReturn = !['None', 'NoneType'].includes(returnType);
  const hasBottomSection = !isStart && (isLogic || allParams.length > 0 || hasReturn);
  // Collapsed, a node is its title, device, a one-line summary of its inputs, and what it saves:
  // enough to read the graph, without a column of text boxes per step.
  const collapsed = !!data.collapsed;
  // While a Cloud Logic step is running its settings are moot (they were sent with the run), and
  // hiding them keeps the card no taller than when it was laid out even with the answer box shown
  // -- otherwise the question grows the card over the step below it.
  const showBottom = hasBottomSection && !collapsed && !(isLogic && status === 'running');
  // What running this node saves. A linked workflow's come from its body (read live, so a node
  // dragged out before this existed still shows them); a plain step's are its "save output" names.
  const outputs: string[] = isLink
    ? (statusData?.instruments?.[block.instrument]?.[block.method]?.outputs || block.schema?.outputs || [])
    : String(block.returnVar || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  const inputSummary = isLogic
    ? logicSummary(block)
    : allParams.map((k) => `${k}=${block.params?.[k] ?? block.schema.parameters[k]?.default ?? ''}`).join(' · ');

  // The card has a 2px border and a 12px radius, so everything inside it is rounded to 10px --
  // an inner 12px corner leaves a sliver of background showing at each corner. The header takes
  // all four corners whenever nothing is drawn below it (collapsed, or nothing to show).
  const inner = 'calc(0.75rem - 2px)';
  const Meta = isLogic ? LOGIC_META[block.method] : null;
  const isDevice = !isLogic && !isStart;
  const deviceOnline = !!targetDeviceId && !!cloudDevices?.find((d: any) => d.id === targetDeviceId)?.status?.includes('online');

  return (
    <div
      className={`relative bg-white dark:bg-[#1a1a1a] rounded-xl p-0 shadow-md ${borderClass} ${isStart ? 'min-w-[150px]' : isLogic ? 'w-[230px]' : 'min-w-[250px]'}`}
      style={{ borderStyle: status === 'skipped' ? 'dashed' : 'solid', borderWidth: '2px' }}
    >
      {!isStart && <Handle type="target" position={Position.Top} className="bg-blue-500" />}
      <div
        className="glass-header px-3 py-2 flex flex-col justify-between"
        style={{
          height: 'auto',
          borderTopLeftRadius: inner, borderTopRightRadius: inner,
          borderBottomLeftRadius: showBottom ? 0 : inner, borderBottomRightRadius: showBottom ? 0 : inner,
        }}
      >
        {isStart ? (
          <div className="w-full flex items-center justify-center py-1">
            <span className="text-xl font-bold tracking-[0.2em] text-gray-500 dark:text-gray-300">START</span>
          </div>
        ) : (
          <>
            <div className="w-full flex items-start justify-between gap-2">
              <div className="min-w-0 flex items-start gap-2">
                {Meta && <Meta.icon className={`w-4 h-4 mt-0.5 shrink-0 ${Meta.accent}`} />}
                <div className="min-w-0">
                  {!isLogic && (
                    <div className="text-xs font-bold text-blue-400 uppercase tracking-wider truncate">{isLink ? 'Sequence' : block.instrument}</div>
                  )}
                  <div className="text-sm font-semibold">{isLogic ? Meta!.label : block.method.replace(/_/g, ' ')}</div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {problems.length > 0 && !taskStatus && (
                  <span title={problems.join('\n')} className="p-0.5 text-red-500"><AlertCircle className="w-4 h-4" /></span>
                )}
                {isLink && canvas.canOpen && (
                  <button
                    onClick={() => canvas.openNode(String(id))}
                    title="Show this workflow's steps"
                    className="nodrag p-0.5 rounded-md text-gray-400 hover:text-blue-600 dark:hover:text-blue-300 hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    <PanelRightOpen className="w-4 h-4" />
                  </button>
                )}
                {hasBottomSection && (
                  <button
                    onClick={() => updateNodeData(id, { collapsed: !collapsed })}
                    title={collapsed ? 'Show settings' : 'Collapse'}
                    className="nodrag p-0.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    {collapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                  </button>
                )}
              </div>
            </div>
            {isDevice && (
              <div className="w-full mt-2 flex items-center space-x-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${deviceOnline ? 'bg-green-500 shadow-[0_0_5px_rgba(34,197,94,0.8)]' : 'bg-red-500 shadow-[0_0_5px_rgba(239,68,68,0.8)]'}`}></div>
                <span className={`text-[10px] font-bold ${deviceOnline ? 'text-gray-400' : 'text-red-400'}`}>
                  {targetDeviceId ? targetDeviceId : 'Unassigned'}
                  {targetDeviceId && !deviceOnline && ' (Offline)'}
                </span>
              </div>
            )}
            {/* Live progress from the device while this node's task runs (edge queue.py's
                run_progress_summary, at most every 2 s). One line and a bar; the device's own
                Queue page has the full picture. */}
            {isDevice && status === 'running' && taskStatus.progress && (() => {
              const pr = taskStatus.progress;
              const pct = pr.total ? Math.min(100, Math.round((pr.done / pr.total) * 100)) : 0;
              const where = pr.state === 'waiting_input' ? 'waiting for input'
                : pr.state === 'paused' ? 'paused'
                : pr.state === 'error' ? 'stopped on an error'
                : pr.step ? String(pr.step).replace(/_/g, ' ') : '';
              const loop = pr.budget ? `iteration ${pr.iteration}/${pr.budget}`
                : pr.rows_total ? `sample ${Math.min(pr.rows_done + 1, pr.rows_total)}/${pr.rows_total}` : '';
              return (
                <div className="w-full mt-2" title={`${pr.done} of ${pr.total} steps done${pr.phase ? ` · ${pr.phase}` : ''}${pr.row ? ` · row ${pr.row}` : ''}`}>
                  <IterationStrip progress={pr} />
                  <div className="h-1.5 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${['waiting_input', 'paused'].includes(pr.state) ? 'bg-amber-400' : pr.state === 'error' ? 'bg-red-500' : 'bg-yellow-400'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-gray-400">
                    <span className="truncate">{[loop, where].filter(Boolean).join(' · ')}</span>
                    <span className="shrink-0 font-bold tabular-nums">{pr.done}/{pr.total}</span>
                  </div>
                </div>
              );
            })()}
            {isLogic && <LogicStatus block={block} taskStatus={taskStatus} />}
            {taskStatus?.hasResult && ['completed', 'error'].includes(status) && (
              <a
                href={`/results?runId=${encodeURIComponent(taskStatus.runId)}&nodeId=${encodeURIComponent(taskStatus.nodeId)}`}
                className="nodrag mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 hover:underline"
              >
                <Table2 className="w-3 h-3" /> view data
              </a>
            )}
            {collapsed && inputSummary && (
              // Fixed width: the node sizes to its content, so an unconstrained one-liner would
              // stretch it sideways instead of truncating.
              <div className={`mt-2 ${isLogic ? 'w-[200px]' : 'w-[226px]'} text-[11px] font-mono text-gray-400 truncate`} title={inputSummary}>{inputSummary}</div>
            )}
            {outputs.length > 0 && (collapsed || isLink) && (
              <div className="mt-2 max-w-[226px] flex flex-wrap items-center gap-1" title="Saved by this step when it runs">
                <span className="text-[10px] text-gray-400">saves</span>
                {outputs.map((o) => (
                  <span key={o} className="px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30">{o}</span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {showBottom && (
        <div className="p-3 flex flex-col gap-2" style={{ background: 'var(--input-bg)', borderBottomLeftRadius: inner, borderBottomRightRadius: inner }}>
          {isLogic && <LogicFields block={block} onParam={handleParamChange} variables={canvas.variables} />}
          {allParams.map((paramKey) => {
            const pData = block.schema.parameters[paramKey];
            const val = block.params[paramKey] !== undefined ? block.params[paramKey] : (pData.default || '');
            // An empty box is the thing that blocks a run, so it is marked on the box itself
            // rather than only in the message that named this node.
            const isEmpty = !String(val ?? '').trim();
            return (
              <div key={paramKey} className="flex flex-col gap-1">
                {/* Shown exactly as the driver spells it: this is the argument name the call uses. */}
                <label className={`${fieldLabel} ${isInvalid && isEmpty ? '!text-red-400' : ''}`}>
                  {paramKey}{isInvalid && isEmpty ? ' — required' : ''}
                </label>
                {/* `nodrag` is what lets you actually click into this field. Without it React
                    Flow treats a mousedown anywhere on the node as the start of a node drag, so
                    clicking the input pans the canvas instead of placing a caret. `nowheel` stops
                    a scroll over the field from zooming the canvas. */}
                <input
                  type="text"
                  className={`nodrag nowheel ${isInvalid && isEmpty ? 'ring-1 ring-red-500' : ''}`}
                  value={val}
                  onChange={e => handleParamChange(paramKey, e.target.value)}
                />
              </div>
            );
          })}

          {/* Return Variable Logic */}
          {!isLogic && hasReturn && (() => {
            const returnInfo = block.schema?.return_info;
            const isTuple = returnType.toLowerCase().startsWith('tuple[');
            const isObject = returnInfo?.is_object;

            let numReturns = 1;
            let returnLabels: string[] = [];
            if (isTuple) {
              const innerTypes = returnType.match(/tuple\[(.*)\]/i);
              if (innerTypes && innerTypes[1]) numReturns = innerTypes[1].split(',').length;
            } else if (isObject && returnInfo.fields) {
              returnLabels = Object.keys(returnInfo.fields);
              numReturns = returnLabels.length;
            }

            return (
              <div className={`flex flex-col gap-2 ${allParams.length > 0 ? 'mt-2 pt-2 border-t border-gray-200 dark:border-white/10' : ''}`}>
                <span className={fieldLabel}>save output as</span>
                <div className="flex space-x-1 items-center flex-wrap gap-y-2">
                  {Array.from({ length: numReturns }).map((_, i) => {
                    const parts = (block.returnVar || '').split(',').map((s: string) => s.trim());
                    return (
                      <div key={i} className="flex items-center space-x-1">
                        {returnLabels[i] && <span className="text-[10px] text-gray-400 font-mono">{returnLabels[i]}:</span>}
                        <input
                          type="text"
                          value={parts[i] || ''}
                          placeholder={`var_${i + 1}`}
                          onChange={(e) => {
                            const newParts = [...parts];
                            while (newParts.length < numReturns) newParts.push('');
                            newParts[i] = e.target.value;
                            updateNodeData(id, { block: { ...block, returnVar: newParts.join(', ') } });
                          }}
                          className="nodrag nowheel w-20 bg-gray-50 dark:bg-black/60 border border-gray-300 dark:border-white/10 rounded px-2 py-0.5 text-xs focus:outline-none focus:border-blue-500 dark:focus:border-blue-500 text-gray-800 dark:text-white"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      )}
      {block.method === 'If' && isLogic ? (
        <>
          {/* Two exits: the edge drawn from each one carries its branch as `sourceHandle`. */}
          <Handle id="true" type="source" position={Position.Bottom} style={{ left: '30%', background: '#10b981' }} />
          <Handle id="false" type="source" position={Position.Bottom} style={{ left: '70%', background: '#ef4444' }} />
          <span className="pointer-events-none absolute -bottom-5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400" style={{ left: 'calc(30% + 8px)' }}>true</span>
          <span className="pointer-events-none absolute -bottom-5 text-[10px] font-semibold text-red-500" style={{ left: 'calc(70% + 8px)' }}>false</span>
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} className="bg-blue-500" />
      )}
    </div>
  );
};

const nodeTypes: NodeTypes = {
  customCloudNode: CustomCloudNode,
};

// Collapse state of each toolbox group, per browser. Read after hydration (AGENTS.md section 11).
const COLLAPSE_KEY = 'cloud_toolbox_collapsed';

export default function CloudWorkflowEditor({
  cloudDevices,
  statusData,
  health,
  invalidNodeIds,
  nodes,
  setNodes,
  edges,
  setEdges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  header,
  onOpenNode,
}: CloudWorkflowEditorProps) {
  const [expandedToolbox, setExpandedToolbox] = useState<Record<string, boolean>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [rfInstance, setRfInstance] = useState<any>(null);
  const [showIssues, setShowIssues] = useState(false);
  const theme = useDocumentTheme();
  const [toast, setToast] = useState<string | null>(null);
  // #auto: while on, a card dropped on the canvas arrives with every field set to `#<field name>`,
  // so a step meant to be iterated or optimized needs no typing before it shows up in the run
  // panel. Read after hydration, never in the initializer (AGENTS.md section 11).
  const [autoFill, setAutoFill] = useState(false);
  useEffect(() => {
    try { setAutoFill(localStorage.getItem('cloud_auto_fill') === '1'); } catch { }
    try { setCollapsedGroups(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {}); } catch { }
  }, []);
  const toggleAutoFill = () => setAutoFill(on => {
    try { localStorage.setItem('cloud_auto_fill', on ? '0' : '1'); } catch { }
    return !on;
  });
  const toggleGroup = (key: string) => setCollapsedGroups(prev => {
    const next = { ...prev, [key]: !prev[key] };
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch { }
    return next;
  });

  const toggleToolbox = (key: string) => {
    setExpandedToolbox(prev => ({ ...prev, [key]: !prev[key] }));
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  const updateNodeData = useCallback((id: string, newData: any) => {
    setNodes((nds) =>
      nds.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...newData } } : node))
    );
  }, [setNodes]);

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const targetNode = nodes.find((node) => node.id === connection.target);
      if (!targetNode) return true;
      if (isStartNode(targetNode)) return false;

      const hasCycle = (node: Node, visited = new Set()) => {
        if (visited.has(node.id)) return false;
        visited.add(node.id);
        for (const outgoer of getOutgoers(node, nodes, edges)) {
          if (outgoer.id === connection.source) return true;
          if (hasCycle(outgoer, visited)) return true;
        }
        return false;
      };

      if (targetNode.id === connection.source) return false;
      return !hasCycle(targetNode);
    },
    [nodes, edges]
  );

  const onDragStart = (event: React.DragEvent, instrument: string, method: string, deviceId: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ instrument, method, deviceId }));
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const typeStr = event.dataTransfer.getData('application/reactflow');
      if (!typeStr) return;

      let instrument, method, dragDeviceId = "";
      try {
        const parsed = JSON.parse(typeStr);
        instrument = parsed.instrument;
        method = parsed.method;
        dragDeviceId = parsed.deviceId;
      } catch (e) {
        const split = typeStr.split('::');
        instrument = split[0];
        method = split[1];
      }

      let drop = { x: event.clientX - 350, y: event.clientY - 100 };
      if (rfInstance) drop = rfInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });

      let m_schema: any = { parameters: {} };
      const specificDevice = cloudDevices.find(d => d.id === dragDeviceId);
      if (instrument === FLOW_CONTROL && CLOUD_LOGIC[method]) {
        m_schema = CLOUD_LOGIC[method];
      } else if (specificDevice?.schema?.instruments?.[instrument]?.[method]) {
        m_schema = specificDevice.schema.instruments[instrument][method];
      } else if (statusData.instruments[instrument]?.[method]) {
        m_schema = statusData.instruments[instrument][method];
      }

      // Cloud Logic steps run in Cloud rather than on a device, and nothing substitutes a `#name`
      // into them, so #auto leaves them alone.
      const prefill = autoFill && instrument !== FLOW_CONTROL;
      const defaultParams: Record<string, any> = {};
      Object.entries(m_schema.parameters || {}).forEach(([key, param]: [string, any]) => {
        if (prefill) defaultParams[key] = `#${key}`;
        else if (param.default !== undefined) defaultParams[key] = param.default;
      });

      const stamp = Date.now();
      const newId = `node_${stamp}`;
      const isLogic = instrument === FLOW_CONTROL;

      // n8n-style: the new step connects to the selected step, or the nearest open end of the
      // graph above where it was dropped (Start, on an empty canvas), and takes a grid slot under
      // it. Holding Alt drops it exactly where it was let go, unconnected.
      const source = event.altKey ? null : pickAutoSource(nodes, edges, drop);
      const position = source
        ? slotBelow(source, nodes, edges, isLogic ? 234 : 254)
        : { x: Math.round((drop.x - 120) / GRID) * GRID, y: Math.round((drop.y - 20) / GRID) * GRID };

      const newNode: Node = {
        id: newId,
        type: 'customCloudNode',
        position,
        selected: true,
        data: {
          targetDeviceId: isLogic ? '' : dragDeviceId,
          block: {
            id: `block-${stamp}`,
            instrument,
            method,
            schema: m_schema,
            params: defaultParams,
            returnVar: "",
            // A node on this canvas is dispatched to a device as a single unit, so reuse here is
            // always a link. It follows the workflow's latest version: an edit saved on the edge
            // is what the next run does, and opening the node shows exactly those steps.
            ...(instrument === LIBRARY_INSTRUMENT ? {
              ref: {
                name: method,
                version: m_schema?.version,
                body_hash: m_schema?.body_hash,
                mode: 'latest' as const,
              }
            } : {})
          },
          updateNodeData,
          statusData,
          cloudDevices
        },
      };

      // Selecting the new step means the next drop chains from it: dropping steps one after
      // another builds a line without drawing a single edge.
      setNodes((nds) => nds.map(n => (n.selected ? { ...n, selected: false } : n)).concat(newNode));
      if (source) {
        const sourceHandle = freeHandleOf(source, edges);
        setEdges((eds) => addEdge({ source: source.id, target: newId, sourceHandle, targetHandle: null }, eds));
      }
    },
    [setNodes, setEdges, statusData, updateNodeData, cloudDevices, autoFill, rfInstance, nodes, edges]
  );

  useEffect(() => {
    setNodes(nds => nds.map(n => {
      if (n.type === 'customCloudNode') {
        return { ...n, data: { ...n.data, cloudDevices, updateNodeData } };
      }
      return n;
    }));
  }, [cloudDevices, updateNodeData, setNodes]);

  // Kept separate from the effect above: that one re-runs whenever the device list is polled,
  // and folding this into it would clear the invalid outline every few seconds.
  useEffect(() => {
    const invalid = new Set(invalidNodeIds || []);
    setNodes(nds => nds.map(n => {
      if (n.type !== 'customCloudNode') return n;
      const isInvalid = invalid.has(String(n.id));
      if (Boolean((n.data as any)?.isInvalid) === isInvalid) return n;
      return { ...n, data: { ...n.data, isInvalid } };
    }));
  }, [invalidNodeIds, setNodes]);

  // --- What is wrong with the graph as drawn, recomputed as it is drawn -------------------------
  // The same rules the run route enforces (dag.js), phrased per step so each can be pointed at,
  // plus warnings that never block a run. Before this, a graph's problems surfaced only as an
  // alert of generated node ids after pressing Run.
  const variables = useMemo(() => {
    const names = new Set<string>();
    for (const n of nodes) {
      const block = (n.data as any)?.block || {};
      if (block.instrument === LIBRARY_INSTRUMENT) {
        const outs = statusData?.instruments?.[LIBRARY_INSTRUMENT]?.[block.method]?.outputs || block.schema?.outputs || [];
        outs.forEach((o: string) => names.add(o));
      }
      String(block.returnVar || '').split(',').map((s: string) => s.trim()).filter(Boolean).forEach((v: string) => names.add(v));
      if (block.method === 'User_Input' && block.params?.save_as) names.add(String(block.params.save_as).replace(/^#/, ''));
    }
    return Array.from(names).sort();
  }, [nodes, statusData]);

  const { problems, issueList, parallel } = useMemo(() => {
    const perNode = new Map<string, string[]>();
    const add = (id: string, msg: string) => perNode.set(id, [...(perNode.get(id) || []), msg]);
    const { outgoing } = buildGraph(nodes, edges);
    const reachable = new Set<string>(nodes.filter(isStartNode).map(n => String(n.id)));
    const stack = [...reachable];
    while (stack.length) {
      for (const next of outgoing.get(stack.pop()!) || []) {
        if (!reachable.has(next)) { reachable.add(next); stack.push(next); }
      }
    }

    for (const n of nodes) {
      if (isStartNode(n)) continue;
      const id = String(n.id);
      const block = (n.data as any)?.block || {};
      if (!reachable.has(id)) add(id, 'not connected to Start, so it would never run');
      if (isCloudLogicNode(n)) {
        logicProblemsOf(n).forEach((p: string) => add(id, p));
        continue;
      }
      if (!isDeviceNode(n)) continue;
      const deviceId = String((n.data as any)?.targetDeviceId || '');
      if (!deviceId) { add(id, 'no device assigned'); continue; }
      const device = cloudDevices.find(d => String(d.id) === deviceId);
      // Blocks the run (the page and the run route both refuse it), so it is a problem, not a
      // warning: nothing on this graph can start until the device is back.
      if (!String(device?.status || '').includes('online')) add(id, `${deviceId} is offline`);
      const methods = device?.schema?.instruments?.[block.instrument];
      if (device?.schema?.instruments && !methods?.[block.method]) {
        add(id, block.instrument === LIBRARY_INSTRUMENT
          ? `${deviceId} no longer has a workflow called ${block.method}`
          : `${deviceId} no longer has ${block.instrument}.${block.method}`);
        continue;
      }
      const verdict = block.instrument === LIBRARY_INSTRUMENT ? methods?.[block.method]?.compatibility : null;
      if (verdict?.status === 'broken') {
        const first = verdict.errors?.[0]?.message;
        add(id, `this workflow won't run on ${deviceId} as saved${first ? `: ${first}` : ''}`);
      }
      const blank = blankParamsOf(n);
      if (blank.length) add(id, `empty ${blank.length === 1 ? 'field' : 'fields'}: ${blank.join(', ')}`);
    }

    const par = parallelOnSameDevice(nodes, edges) as { deviceId: string; nodeIds: string[] }[];
    const list: { id: string; level: 'error' | 'warning'; text: string }[] = [];
    for (const [id, msgs] of perNode) {
      const label = labelOf(nodes.find(n => String(n.id) === id));
      msgs.forEach(m => list.push({ id, level: 'error', text: `${label}: ${m}` }));
    }
    for (const p of par) {
      const names = p.nodeIds.map(id => labelOf(nodes.find(n => String(n.id) === id)));
      list.push({
        id: p.nodeIds[0],
        level: 'warning',
        text: `${p.deviceId} runs one task at a time. ${names.join(', ')} are on parallel branches, so they will run one after another, in whichever order each becomes ready. Connect them in the order you need.`,
      });
    }
    return { problems: perNode, issueList: list, parallel: par };
  }, [nodes, edges, cloudDevices]);

  // Prompt the moment a connection or drop puts two steps for one device side by side, not only in
  // the issues list: that is when the drawing and what the device will do stop matching.
  const parallelKey = parallel.map(p => `${p.deviceId}:${p.nodeIds.join(',')}`).join('|');
  const lastParallel = useRef<string | null>(null);
  // Read inside the effect for labels only; keying the effect on `nodes` would re-fire it on
  // every keystroke in a field.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useEffect(() => {
    const prev = lastParallel.current;
    lastParallel.current = parallelKey;
    if (prev === null || !parallelKey || parallelKey === prev) return;
    const grew = parallel.find(p => !prev.includes(`${p.deviceId}:${p.nodeIds.join(',')}`));
    if (grew) {
      const names = grew.nodeIds.map(id => labelOf(nodesRef.current.find(n => String(n.id) === id)));
      setToast(`${grew.deviceId} runs one task at a time, so ${names.join(' and ')} will run one after another, not in parallel.`);
    }
  }, [parallelKey, parallel]);

  const focusNode = (id: string) => {
    setNodes(nds => nds.map(n => ({ ...n, selected: n.id === id })));
    rfInstance?.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.1, padding: 0.6 });
  };

  const answerInput = useCallback(async (runId: string, nodeId: string, value: string) => {
    try {
      const res = await fetch('/api/cloud-workflows/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, nodeId, value }),
      });
      if (res.ok) return true;
      const data = await res.json().catch(() => ({}));
      setToast(data.error || 'Could not send the answer.');
    } catch {
      setToast('Could not reach Cloud to send the answer.');
    }
    return false;
  }, []);

  const canvasContext = useMemo(() => ({
    variables,
    problems,
    canOpen: !!onOpenNode,
    openNode: (id: string) => {
      const node = nodes.find(n => String(n.id) === id);
      if (node) onOpenNode?.(node);
    },
    answerInput,
  }), [variables, problems, onOpenNode, nodes, answerInput]);

  // An If's two exits are told apart by colour, matching the labelled handles they leave from (a
  // text label on the edge as well only repeated those, right beside them). Everything is drawn as
  // right-angled steps, which reads as a grid rather than a tangle once the graph is tidied.
  const displayEdges = useMemo(() => {
    const ifIds = new Set(nodes.filter(n => isIfNode(n)).map(n => n.id));
    return edges.map((e) => {
      const base = { type: 'smoothstep', ...e } as Edge;
      if (!ifIds.has(e.source) || !e.sourceHandle) return base;
      const colour = e.sourceHandle === 'true' ? '#10b981' : '#ef4444';
      return { ...base, style: { ...(e.style || {}), stroke: colour } };
    });
  }, [edges, nodes]);

  const tidy = () => {
    setNodes(nds => tidyLayout(nds, edges));
    setTimeout(() => rfInstance?.fitView({ duration: 300, padding: 0.2 }), 50);
  };

  const errorCount = issueList.filter(i => i.level === 'error').length;
  const warnCount = issueList.length - errorCount;
  const hasSteps = nodes.some(n => !isStartNode(n));

  const groupHeader = (key: string, children: React.ReactNode, title?: string) => (
    <button
      type="button"
      onClick={() => toggleGroup(key)}
      title={title}
      className="w-full flex items-center gap-2 px-2 py-1 mb-1 rounded-md text-left hover:bg-black/5 dark:hover:bg-white/5"
    >
      {collapsedGroups[key]
        ? <ChevronRight className="w-3.5 h-3.5 shrink-0 text-gray-400" />
        : <ChevronDown className="w-3.5 h-3.5 shrink-0 text-gray-400" />}
      {children}
    </button>
  );

  return (
    <div className="flex-1 flex flex-col h-full w-full bg-transparent overflow-hidden">
      {header}
      <div className="flex-1 flex h-full w-full overflow-hidden">
        <div className="glass-sidebar flex flex-col z-10 shrink-0 border-t" style={{ borderColor: 'var(--panel-border)' }}>
          {/* Backend + device status sits at the head of the toolbox, beside the devices it
              describes, rather than in the title bar next to the workflow name — which is about
              the document, not the lab. One line, full detail on hover. */}
          <div className="px-4 pt-4 pb-2 shrink-0">
            {(() => {
              const checking = !health;
              const ok = health?.ok;
              const total = health?.devices?.total ?? cloudDevices.length;
              const online = health?.devices?.online ?? 0;
              const healthProblems: string[] = health?.problems || [];

              let dot = 'bg-green-500';
              let label = '';
              if (checking) { dot = 'bg-gray-400'; label = 'Checking backend…'; }
              else if (!ok) { dot = 'bg-orange-500'; label = healthProblems[0] || 'Backend unavailable'; }
              else if (total === 0) { dot = 'bg-gray-400'; label = 'No devices connected'; }
              else { label = `${online}/${total} device${total !== 1 ? 's' : ''} online`; }

              const detail = [
                health?.mode && `mode: ${health.mode}`,
                health?.store?.backend && `store: ${health.store.backend}${health.store.ok ? '' : ' (unreachable)'}`,
                (health?.daemon?.brokerUrl || health?.brokerUrl) && `broker: ${health.daemon?.brokerUrl || health.brokerUrl}`,
                health?.daemon && `daemon: ${health.daemon.running ? 'running' : 'not running'}`,
                ...healthProblems,
              ].filter(Boolean).join('\n');

              return (
                <div className="flex items-center gap-2 min-w-0">
                  <div className="flex items-center gap-2 min-w-0 flex-1" title={detail || undefined}>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                    <span className="text-xs font-medium truncate text-gray-600 dark:text-gray-300">{label}</span>
                  </div>
                  <button
                    type="button"
                    onClick={toggleAutoFill}
                    aria-pressed={autoFill}
                    title={autoFill
                      ? '#auto is on: dropped cards fill every field with #<field name>. Click to turn off.'
                      : 'Turn on #auto: dropped cards fill every field with #<field name>, ready to configure in the run panel.'}
                    className={`shrink-0 px-2 py-0.5 rounded-md border font-mono text-[11px] font-semibold transition-colors ${autoFill
                      ? 'bg-indigo-600 border-indigo-600 text-white'
                      : 'bg-white border-gray-200 text-gray-500 hover:text-gray-800 dark:bg-white/5 dark:border-white/10 dark:text-gray-400 dark:hover:text-gray-200'}`}
                  >
                    #auto
                  </button>
                </div>
              );
            })()}
            <p className="mt-2 text-[11px] leading-snug text-gray-400">
              Dropped steps connect to the selected step, or the nearest open end. Hold Alt to drop one unconnected.
            </p>
          </div>
          <div className="flex-1 overflow-y-auto p-4 pt-2 space-y-4">
            {/* Logic: steps Cloud runs itself (see dag.js rule 3). First, because every graph
                can use them whichever devices happen to be connected. */}
            <div>
              {groupHeader('cloud-logic', (
                <h3 className="text-sm font-bold text-gray-800 dark:text-gray-200">Logic</h3>
              ), 'Steps Cloud runs itself, between device steps')}
              {!collapsedGroups['cloud-logic'] && (
                <div className="space-y-1 mt-1">
                  {Object.entries(CLOUD_LOGIC).map(([methodName, schema]: [string, any]) => {
                    const meta = LOGIC_META[methodName];
                    return (
                      <ToolItem
                        key={`cloud-logic-${methodName}`}
                        icon={meta.icon}
                        accent={meta.accent}
                        label={meta.label}
                        title={schema.description}
                        onDragStart={(e) => onDragStart(e, FLOW_CONTROL, methodName, "")}
                      />
                    );
                  })}
                </div>
              )}
            </div>

            {cloudDevices.map(device => {
              const deviceId = device.id;
              const dInstruments = device.schema?.instruments || {};
              const libraryWorkflows: Record<string, any> = dInstruments[LIBRARY_INSTRUMENT] || {};
              // A saved workflow the device itself says no longer runs against its deck is kept
              // out of the palette: dragging one out only builds a step that will be refused.
              // Still listed, folded away, so a missing workflow is explainable rather than gone.
              const workflowEntries = Object.entries(libraryWorkflows);
              const runnable = workflowEntries.filter(([, s]) => s?.compatibility?.status !== 'broken');
              const broken = workflowEntries.filter(([, s]) => s?.compatibility?.status === 'broken');
              const advancedInstruments = Object.fromEntries(
                Object.entries(dInstruments).filter(([k]) => k !== LIBRARY_INSTRUMENT && k !== FLOW_CONTROL && k !== 'Flow_Control')
              );
              const methodCount = Object.values(advancedInstruments)
                .reduce((n: number, m: any) => n + Object.keys(m || {}).length, 0);

              // An offline device keeps its toolbox entry on purpose — the schema and sequence
              // library are a retained snapshot, and browsing or drafting against a lab that is
              // powered down is legitimate. It is just never shown as green, and a run using it
              // cannot start.
              const isOnline = String(device.status || '').includes('online');
              const collapsed = !!collapsedGroups[`device:${deviceId}`];
              const subLabel = 'px-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500';

              return (
                <div key={deviceId}>
                  {groupHeader(`device:${deviceId}`, (
                    <>
                      <div className={`w-2 h-2 shrink-0 rounded-full ${isOnline
                        ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]'
                        : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'}`}></div>
                      <h3 className="text-sm font-bold text-gray-800 dark:text-gray-200 truncate">{deviceId}</h3>
                      {device.schema?.deck_version != null && (
                        <span className="text-[10px] font-medium text-gray-400 shrink-0" title="Version of this device's instrument schema; it changes when its drivers change">
                          deck v{device.schema.deck_version}
                        </span>
                      )}
                      {!isOnline && <span className="text-[10px] font-semibold uppercase tracking-wide text-red-400 shrink-0">offline</span>}
                      {collapsed && <span className="ml-auto text-[10px] text-gray-400 shrink-0">{runnable.length}</span>}
                    </>
                  ), isOnline
                    ? `${deviceId} is online. Click to ${collapsed ? 'expand' : 'collapse'}.`
                    : `${deviceId} is offline. Showing its last known instruments and workflows; a run using it cannot start.`)}

                  {!collapsed && (
                    <div className="mt-1 space-y-1">
                      {runnable.length > 0 && <div className={subLabel}>Workflows</div>}
                      {runnable.map(([wfName, wfSchema]) => (
                        <ToolItem
                          key={`wf-${deviceId}-${wfName}`}
                          icon={Workflow}
                          accent="text-blue-500"
                          label={wfName.replace(/_/g, ' ')}
                          title={wfSchema?.description || wfName}
                          onDragStart={(e) => onDragStart(e, LIBRARY_INSTRUMENT, wfName, deviceId)}
                        />
                      ))}

                      {broken.length > 0 && (
                        <div>
                          <button
                            type="button"
                            onClick={() => toggleToolbox(`${deviceId}-broken`)}
                            className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                            title="Saved workflows this device reports will not run against its current instruments"
                          >
                            <EyeOff className="w-3 h-3" />
                            {broken.length} hidden · won&apos;t run on this deck
                          </button>
                          {expandedToolbox[`${deviceId}-broken`] && (
                            <div className="mt-1 space-y-1">
                              {broken.map(([wfName, s]) => (
                                <div
                                  key={`broken-${deviceId}-${wfName}`}
                                  title={(s?.compatibility?.errors || []).map((er: any) => `${er.where ? `${er.where}: ` : ''}${er.message}`).join('\n') || 'Does not run on this deck'}
                                  className="flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-xs cursor-not-allowed border-red-300 text-red-500 dark:border-red-500/40 dark:text-red-400"
                                >
                                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                  <span className="min-w-0 flex-1 truncate">{wfName.replace(/_/g, ' ')}</span>
                                  <span className="shrink-0 text-[10px]">{s?.compatibility?.error_count || ''} {s?.compatibility?.error_count === 1 ? 'problem' : 'problems'}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {methodCount > 0 && (
                        <div>
                          <button
                            type="button"
                            onClick={() => toggleToolbox(`${deviceId}-advanced`)}
                            className={`w-full flex items-center gap-1 ${subLabel} hover:text-gray-600 dark:hover:text-gray-300`}
                            title="Single instrument calls, for steps no saved workflow covers"
                          >
                            {expandedToolbox[`${deviceId}-advanced`] ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                            Instruments
                            <span className="ml-auto font-medium normal-case tracking-normal">{methodCount}</span>
                          </button>
                          {expandedToolbox[`${deviceId}-advanced`] && (
                            <div className="mt-1 space-y-2">
                              {Object.entries(advancedInstruments).map(([instName, schema]: [string, any]) => (
                                <div key={`${deviceId}-${instName}`} className="space-y-1">
                                  <div className="px-1 text-[11px] font-mono text-gray-500 dark:text-gray-400">{instName}</div>
                                  {Object.keys(schema).map((methodName) => (
                                    <ToolItem
                                      key={`${deviceId}-${instName}-${methodName}`}
                                      icon={Wrench}
                                      accent="text-gray-400"
                                      label={methodName.replace(/_/g, ' ')}
                                      title={schema[methodName]?.description || `${instName}.${methodName}`}
                                      onDragStart={(e) => onDragStart(e, instName, methodName, deviceId)}
                                    />
                                  ))}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {cloudDevices.length === 0 && (
              <div className="p-4 text-center text-sm text-gray-400">
                No Edge Devices connected.
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col relative bg-transparent border-t" style={{ borderColor: 'var(--panel-border)' }}>
          <div className="flex-1 w-full h-full" onDrop={onDrop} onDragOver={onDragOver}>
            <LiveSchema.Provider value={statusData}>
            <CanvasContext.Provider value={canvasContext}>
            <ReactFlow
              nodes={nodes}
              edges={displayEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onInit={setRfInstance}
              nodeTypes={nodeTypes}
              // React Flow draws its own controls, minimap and handles; without this they stay
              // light-themed on a dark canvas.
              colorMode={theme}
              snapToGrid
              snapGrid={[GRID, GRID]}
              fitView
            >
              <Background color="#aaa" gap={GRID} variant={BackgroundVariant.Dots} />
              <Controls />
              <MiniMap />

              <Panel position="top-left">
                <button
                  type="button"
                  onClick={tidy}
                  title="Arrange the steps in rows, each one under the step it waits for"
                  className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white/90 px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-white dark:border-white/10 dark:bg-black/60 dark:text-gray-200"
                >
                  <LayoutGrid className="w-3.5 h-3.5" /> Tidy up
                </button>
              </Panel>

              {hasSteps && (
                <Panel position="top-right">
                  <div className="w-[340px] max-w-[calc(100vw-2rem)] flex flex-col items-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowIssues(s => !s)}
                      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium shadow-sm ${errorCount
                        ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-950/60 dark:text-red-300'
                        : warnCount
                          ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/60 dark:text-amber-300'
                          : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-950/60 dark:text-emerald-300'}`}
                    >
                      {errorCount ? <AlertCircle className="w-3.5 h-3.5" /> : warnCount ? <AlertTriangle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                      {errorCount
                        ? `${errorCount} problem${errorCount === 1 ? '' : 's'}${warnCount ? ` · ${warnCount} warning${warnCount === 1 ? '' : 's'}` : ''}`
                        : warnCount ? `${warnCount} warning${warnCount === 1 ? '' : 's'}` : 'Ready to run'}
                      {issueList.length > 0 && (showIssues ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />)}
                    </button>
                    {showIssues && issueList.length > 0 && (
                      <div className="w-full max-h-[50vh] overflow-y-auto rounded-lg border border-gray-200 bg-white/95 p-1.5 shadow-lg dark:border-white/10 dark:bg-[#141414]/95">
                        {issueList.map((issue, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => focusNode(issue.id)}
                            className="w-full flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
                          >
                            {issue.level === 'error'
                              ? <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0 text-red-500" />
                              : <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0 text-amber-500" />}
                            <span>{issue.text}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </Panel>
              )}

              {toast && (
                <Panel position="bottom-center">
                  <div className="flex max-w-md items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow-lg dark:border-amber-500/40 dark:bg-amber-950/90 dark:text-amber-200">
                    <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500" />
                    <span className="flex-1">{toast}</span>
                    <button onClick={() => setToast(null)} className="shrink-0 text-amber-700 hover:text-amber-900 dark:text-amber-300" title="Dismiss">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </Panel>
              )}
            </ReactFlow>
            </CanvasContext.Provider>
            </LiveSchema.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}
