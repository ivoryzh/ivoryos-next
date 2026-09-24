"use client";

import React, { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { ReactFlow, MiniMap, Controls, Background, Connection, Edge, NodeTypes, Node, BackgroundVariant, Handle, Position, getOutgoers } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Settings2, ChevronDown, ChevronUp, Cloud, Table2 } from 'lucide-react';
import { LIBRARY_INSTRUMENT } from '@ivoryos/shared-ui';

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
  /** A click on a node's card (not on a field or button inside it). */
  onNodeClick?: (node: Node) => void;
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

const CustomCloudNode = ({ data, id }: any) => {
  const { block, updateNodeData, cloudDevices, targetDeviceId, taskStatus, isInvalid } = data;
  const live = useContext(LiveSchema);
  const statusData = live?.instruments && Object.keys(live.instruments).length ? live : data.statusData;
  const isMissing = !statusData?.instruments?.[block.instrument] || !statusData?.instruments?.[block.instrument]?.[block.method];

  const handleParamChange = (paramKey: string, val: any) => {
    updateNodeData(id, {
      block: {
        ...block,
        params: { ...block.params, [paramKey]: val }
      }
    });
  };

  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    updateNodeData(id, {
      targetDeviceId: e.target.value
    });
  };

  const allParams = Object.keys(block.schema?.parameters || {});

  let borderClass = 'border-blue-500';
  if (taskStatus) {
      if (taskStatus.status === 'running') borderClass = 'border-yellow-400 shadow-[0_0_15px_rgba(250,204,21,0.6)]';
      else if (taskStatus.status === 'completed') borderClass = 'border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.6)]';
      else if (taskStatus.status === 'error') borderClass = 'border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.6)]';
  } else {
      if (!targetDeviceId) borderClass = 'border-orange-500';
      else if (isMissing) borderClass = 'border-red-500';
  }
  // Outranks the resting states above, but never a live task status: while a run is in flight the
  // border is reporting what the hardware is doing, which matters more than a stale authoring
  // complaint. Only reachable when a run was refused, so nothing is in flight anyway.
  if (isInvalid && !taskStatus) borderClass = 'border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.6)]';

  const isStartNode = block.instrument === 'Flow Control' && block.method === 'Start';
  const hasBottomSection = !isStartNode && (allParams.length > 0 || (block.schema?.return_type && block.schema.return_type !== 'None' && block.schema.return_type !== 'NoneType'));
  // Collapsed, a node is its title, device, a one-line summary of its inputs, and what it saves:
  // enough to read the graph, without a column of text boxes per step.
  const collapsed = !!data.collapsed;
  // What running this node saves. A linked workflow's come from its body (read live, so a node
  // dragged out before this existed still shows them); a plain step's are its "Save Output" names.
  const outputs: string[] = block.instrument === 'Library Workflows'
    ? (statusData?.instruments?.[block.instrument]?.[block.method]?.outputs || block.schema?.outputs || [])
    : String(block.returnVar || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  const inputSummary = allParams
    .map((k) => `${k}=${block.params?.[k] ?? block.schema.parameters[k]?.default ?? ''}`)
    .join(' · ');

  return (
    <div className={`bg-white dark:bg-[#1a1a1a] rounded-xl p-0 shadow-md ${borderClass} ${isStartNode ? 'min-w-[150px]' : 'min-w-[250px]'}`} style={{ borderStyle: 'solid', borderWidth: '2px' }}>
      <Handle type="target" position={Position.Top} className="bg-blue-500" />
      <div className={`glass-header px-3 py-2 flex flex-col justify-between ${hasBottomSection ? 'rounded-t-xl' : 'rounded-xl'}`} style={{ height: 'auto' }}>
        {isStartNode ? (
          <div className="w-full flex items-center justify-center py-1">
            <span className="text-xl font-bold tracking-[0.2em] text-gray-500 dark:text-gray-300">START</span>
          </div>
        ) : (
          <>
            <div className="w-full mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-bold text-blue-400 uppercase tracking-wider">{block.instrument === 'Library Workflows' ? 'Sequence' : block.instrument}</div>
                <div className="text-sm font-semibold">{block.method.replace(/_/g, ' ')}</div>
              </div>
              {hasBottomSection && (
                <button
                  onClick={() => updateNodeData(id, { collapsed: !collapsed })}
                  title={collapsed ? 'Show inputs' : 'Collapse'}
                  className="nodrag shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10"
                >
                  {collapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                </button>
              )}
            </div>
            <div className="w-full mt-1">
              {block.instrument === 'Flow Control' ? null : (
                <div className="flex items-center space-x-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full ${(!targetDeviceId || !cloudDevices?.find((d: any) => d.id === targetDeviceId)?.status.includes('online')) ? 'bg-red-500 shadow-[0_0_5px_rgba(239,68,68,0.8)]' : 'bg-green-500 shadow-[0_0_5px_rgba(34,197,94,0.8)]'}`}></div>
                  <span className={`text-[10px] font-bold ${(!targetDeviceId || !cloudDevices?.find((d: any) => d.id === targetDeviceId)?.status.includes('online')) ? 'text-red-400' : 'text-gray-300'}`}>
                    {targetDeviceId ? targetDeviceId : 'Unassigned'}
                    {targetDeviceId && !cloudDevices?.find((d: any) => d.id === targetDeviceId)?.status.includes('online') && ' (Offline)'}
                  </span>
                </div>
              )}
            </div>
            {/* Live progress from the device while this node's task runs (edge queue.py's
                run_progress_summary, at most every 2 s). One line and a bar; the device's own
                Queue page has the full picture. */}
            {taskStatus?.status === 'running' && taskStatus.progress && (() => {
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
            {taskStatus?.hasResult && ['completed', 'error'].includes(taskStatus.status) && (
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
              <div className="mt-2 w-[226px] text-[11px] font-mono text-gray-400 truncate" title={inputSummary}>{inputSummary}</div>
            )}
            {outputs.length > 0 && (collapsed || block.instrument === 'Library Workflows') && (
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
      {hasBottomSection && !collapsed && (
        <div className="p-3 flex flex-col gap-2" style={{ background: 'var(--input-bg)', borderBottomLeftRadius: '0.75rem', borderBottomRightRadius: '0.75rem' }}>
          {allParams.map((paramKey) => {
            const pData = block.schema.parameters[paramKey];
            const val = block.params[paramKey] !== undefined ? block.params[paramKey] : (pData.default || '');
            // An empty box is the thing that blocks a run, so it is marked on the box itself
            // rather than only in the message that named this node.
            const isEmpty = !String(val ?? '').trim();
            return (
              <div key={paramKey} className="flex flex-col gap-2">
                <label className={`text-xs font-bold uppercase ${isInvalid && isEmpty ? 'text-red-400' : 'text-gray-400'}`}>
                  {paramKey}{isInvalid && isEmpty ? ' — required' : ''}
                </label>
                {/* `nodrag` is what lets you actually click into this field. Without it React
                    Flow treats a mousedown anywhere on the node as the start of a node drag, so
                    clicking the input pans the canvas instead of placing a caret — you could
                    sometimes type, but never click or select. `nowheel` stops a scroll over the
                    field from zooming the canvas. */}
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
          {(() => {
            const returnType = block.schema?.return_type || 'None';
            const returnInfo = block.schema?.return_info;
            const isNone = returnType === 'None' || returnType === 'NoneType';
            const isTuple = returnType.toLowerCase().startsWith('tuple[');
            const isObject = returnInfo?.is_object;

            let numReturns = 1;
            let returnLabels: string[] = [];

            if (isTuple) {
              const inner = returnType.match(/tuple\[(.*)\]/i);
              if (inner && inner[1]) {
                numReturns = inner[1].split(',').length;
              }
            } else if (isObject && returnInfo.fields) {
              returnLabels = Object.keys(returnInfo.fields);
              numReturns = returnLabels.length;
            }

            if (isNone) return null;
            return (
              <div className={`flex flex-col gap-2 ${allParams.length > 0 ? 'mt-2 pt-2 border-t border-gray-200 dark:border-white/10' : ''}`}>
                <span className="text-xs text-gray-400 font-bold uppercase">Save Output</span>
                <div className="flex space-x-1 items-center flex-wrap gap-y-2">
                  {Array.from({ length: numReturns }).map((_, i) => {
                    const parts = (block.returnVar || '').split(',').map((s: string) => s.trim());
                    return (
                      <div key={i} className="flex items-center space-x-1">
                        {returnLabels[i] && (
                            <span className="text-[10px] text-gray-400 font-mono">{returnLabels[i]}:</span>
                        )}
                        <input
                          type="text"
                          value={parts[i] || ''}
                          placeholder={`var_${i+1}`}
                          onChange={(e) => {
                            const newParts = [...parts];
                            while(newParts.length < numReturns) newParts.push('');
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
      <Handle type="source" position={Position.Bottom} className="bg-blue-500" />
    </div>
  );
};

const nodeTypes: NodeTypes = {
  customCloudNode: CustomCloudNode,
};

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
  onNodeClick,
}: CloudWorkflowEditorProps) {
  const [expandedToolbox, setExpandedToolbox] = useState<Record<string, boolean>>({});
  const [rfInstance, setRfInstance] = useState<any>(null);
  // #auto: while on, a card dropped on the canvas arrives with every field set to `#<field name>`,
  // so a step meant to be iterated or optimized needs no typing before it shows up in the run
  // panel. Read after hydration, never in the initializer (AGENTS.md section 11).
  const [autoFill, setAutoFill] = useState(false);
  useEffect(() => {
    try { setAutoFill(localStorage.getItem('cloud_auto_fill') === '1'); } catch { }
  }, []);
  const toggleAutoFill = () => setAutoFill(on => {
    try { localStorage.setItem('cloud_auto_fill', on ? '0' : '1'); } catch { }
    return !on;
  });

  useEffect(() => {
    if (statusData && statusData.instruments) {
      const insts: Record<string, boolean> = {};
      Object.keys(statusData.instruments).forEach(k => insts[k] = false);
      setExpandedToolbox(prev => ({ ...insts, ...prev }));
    }
  }, [statusData]);

  const instruments = statusData?.instruments || {};

  const toggleToolbox = (instName: string) => {
    setExpandedToolbox(prev => ({ ...prev, [instName]: !prev[instName] }));
  };

  const updateNodeData = useCallback((id: string, newData: any) => {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === id) {
          return { ...node, data: { ...node.data, ...newData } };
        }
        return node;
      })
    );
  }, [setNodes]);

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const targetNode = nodes.find((node) => node.id === connection.target);
      if (!targetNode) return true;

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

      let position = {
        x: event.clientX - 350,
        y: event.clientY - 100,
      };

      if (rfInstance) {
        position = rfInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });
        // Optional adjustment so the mouse isn't exactly at the top left corner of the block
        position.x -= 100;
        position.y -= 20;
      }

      let m_schema = { parameters: {} };
      let specificDevice = cloudDevices.find(d => d.id === dragDeviceId);
      if (specificDevice && specificDevice.schema && specificDevice.schema.instruments[instrument] && specificDevice.schema.instruments[instrument][method]) {
        m_schema = specificDevice.schema.instruments[instrument][method];
      } else if (statusData.instruments[instrument] && statusData.instruments[instrument][method]) {
        m_schema = statusData.instruments[instrument][method];
      }

      // Cloud Logic steps (Sleep, ...) run here rather than on a device, and nothing substitutes
      // a `#name` into them, so #auto leaves them alone.
      const prefill = autoFill && instrument !== 'Flow Control';
      const defaultParams: Record<string, any> = {};
      if (m_schema.parameters) {
        Object.entries(m_schema.parameters).forEach(([key, param]: [string, any]) => {
          if (prefill) {
            defaultParams[key] = `#${key}`;
          } else if (param.default !== undefined) {
            defaultParams[key] = param.default;
          }
        });
      }

      const newNode: Node = {
        id: `node_${Date.now()}`,
        type: 'customCloudNode',
        position,
        data: {
          targetDeviceId: dragDeviceId,
          block: {
            id: `block-${Date.now()}`,
            instrument,
            method,
            schema: m_schema,
            params: defaultParams,
            returnVar: "",
            // A node on this canvas is dispatched to a device as a single unit, so reuse here is
            // always a link. It follows the workflow's latest version: an edit saved on the edge
            // is what the next run does, and clicking the node shows exactly those steps. (It used
            // to pin the version it was dropped at, so edge edits never reached an existing node
            // while the Library already showed the new version -- and Cloud only has the latest
            // body, so it could not even show what a pinned node would run.)
            ...(instrument === LIBRARY_INSTRUMENT ? {
              ref: {
                name: method,
                version: (m_schema as any)?.version,
                body_hash: (m_schema as any)?.body_hash,
                mode: 'latest' as const,
              }
            } : {})
          },
          updateNodeData,
          statusData,
          cloudDevices
        },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [setNodes, statusData, updateNodeData, cloudDevices, autoFill]
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
              const problems: string[] = health?.problems || [];

              let dot = 'bg-green-500';
              let label = '';
              if (checking) { dot = 'bg-gray-400'; label = 'Checking backend…'; }
              else if (!ok) { dot = 'bg-orange-500'; label = problems[0] || 'Backend unavailable'; }
              else if (total === 0) { dot = 'bg-gray-400'; label = 'No devices connected'; }
              else { label = `${online}/${total} device${total !== 1 ? 's' : ''} online`; }

              const detail = [
                health?.mode && `mode: ${health.mode}`,
                health?.store?.backend && `store: ${health.store.backend}${health.store.ok ? '' : ' (unreachable)'}`,
                (health?.daemon?.brokerUrl || health?.brokerUrl) && `broker: ${health.daemon?.brokerUrl || health.brokerUrl}`,
                health?.daemon && `daemon: ${health.daemon.running ? 'running' : 'not running'}`,
                ...problems,
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
          </div>
          <div className="flex-1 overflow-y-auto p-4 pt-2 space-y-3">
            {cloudDevices.map(device => {
              const deviceId = device.id;
              const dInstruments = device.schema?.instruments || {};

              // Separate Library Workflows
              const libraryWorkflows = dInstruments["Library Workflows"] || {};

              // Other advanced instruments (excluding Flow Control)
              const advancedInstruments = Object.fromEntries(
                Object.entries(dInstruments).filter(([k]) => k !== "Library Workflows" && k !== "Flow Control")
              );

              // An offline device keeps its toolbox entry on purpose — the schema and sequence
              // library are a retained snapshot, and browsing or drafting against a lab that is
              // powered down is legitimate. What is not legitimate is showing it as green: this
              // dot was hardcoded, so a device that had gone away still read as connected while
              // the header two lines above it said "0/1 device online". Same vocabulary as the
              // canvas node's dot, so one status has one appearance everywhere.
              const isOnline = String(device.status || '').includes('online');

              return (
                <div key={deviceId} className="device-group mb-6">
                  <div
                    className="flex items-center space-x-2 px-2 py-1 mb-2"
                    title={isOnline
                      ? `${deviceId} is online`
                      : `${deviceId} is offline — showing its last known instruments and workflows`}
                  >
                    <div className={`w-2 h-2 rounded-full ${isOnline
                      ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]'
                      : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'}`}></div>
                    <h3 className="text-sm font-bold text-gray-800 dark:text-gray-200">{deviceId}</h3>
                    {device.schema?.deck_version != null && (
                      <span
                        className="text-[10px] font-medium text-gray-400"
                        title="Version of this device's instrument schema; it changes when its drivers change"
                      >
                        deck v{device.schema.deck_version}
                      </span>
                    )}
                    {!isOnline && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-red-400">offline</span>
                    )}
                  </div>

                  <div className="space-y-2 mt-2">
                    {/* Library Workflows */}
                    {Object.entries(libraryWorkflows).map(([wfName, wfSchema]: [string, any]) => (
                      <div
                        key={`wf-${deviceId}-${wfName}`}
                        onDragStart={(e) => onDragStart(e, "Library Workflows", wfName, deviceId)}
                        draggable
                        className="p-2 rounded-md flex items-center space-x-3 text-sm cursor-grab shadow-sm transition-colors bg-blue-100 hover:bg-blue-200 border border-blue-200 dark:bg-blue-900/20 dark:border-blue-500/30 dark:hover:bg-blue-900/40"
                      >
                        <div className="flex flex-col min-w-0">
                          <span className="font-bold truncate text-blue-700 dark:text-blue-300">{wfName.replace(/_/g, ' ')}</span>
                        </div>
                      </div>
                    ))}

                    {/* Advanced Folder */}
                    {Object.keys(advancedInstruments).length > 0 && (
                      <div className="toolbox-item rounded-lg overflow-hidden mt-3">
                        <button
                          onClick={() => toggleToolbox(`${deviceId}-advanced`)}
                          className="w-full px-4 py-2 flex items-center justify-between bg-black/10 dark:bg-white/5"
                        >
                          <span className="text-xs font-bold tracking-wider capitalize text-gray-600 dark:text-gray-400">Advanced (Instruments)</span>
                          {expandedToolbox[`${deviceId}-advanced`] ? <ChevronUp className="w-3 h-3 text-gray-500 dark:text-gray-400" /> : <ChevronDown className="w-3 h-3 text-gray-500 dark:text-gray-400" />}
                        </button>
                        {expandedToolbox[`${deviceId}-advanced`] && (
                          <div className="p-2 space-y-2" style={{ background: 'var(--sidebar-hover-bg)' }}>
                            {Object.entries(advancedInstruments).map(([instName, schema]: [string, any]) => (
                              <div key={`${deviceId}-${instName}`}>
                                <div className="text-xs font-bold text-gray-500 mb-1 px-1 mt-2 capitalize">{instName.replace(/_/g, ' ')}</div>
                                <div className="space-y-1">
                                  {Object.keys(schema).map((methodName) => (
                                    <div
                                      key={`${deviceId}-${instName}-${methodName}`}
                                      onDragStart={(e) => onDragStart(e, instName, methodName, deviceId)}
                                      draggable
                                      className="p-2 rounded-md flex items-center text-sm cursor-grab"
                                      style={{ background: 'var(--panel-bg)', border: '1px solid var(--panel-border)' }}
                                    >
                                      <span className="font-medium text-gray-700 dark:text-gray-300 text-xs truncate">{methodName.replace(/_/g, ' ')}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {cloudDevices.length === 0 && (
              <div className="p-4 text-center text-sm text-gray-400">
                No Edge Devices connected.
              </div>
            )}

            {/* Cloud Logic (Flow Control) */}
            {statusData?.instruments?.['Flow Control'] && (
              <div className="device-group mt-6 border-t border-white/10 pt-4">
                <div className="flex items-center space-x-2 px-2 py-1 mb-2">
                  <Cloud className="w-4 h-4 text-blue-400" />
                  <h3 className="text-sm font-bold text-gray-200 uppercase tracking-wider">Cloud Logic</h3>
                </div>

                <div className="space-y-2 mt-2">
                  {Object.entries(statusData.instruments['Flow Control']).map(([methodName, schema]: [string, any]) => {
                    if (methodName === 'Start') return null; // Hide Start from toolbox
                    return (
                      <div
                        key={`cloud-logic-${methodName}`}
                        onDragStart={(e) => onDragStart(e, "Flow Control", methodName, "")}
                        draggable
                        className="p-2 rounded-md flex items-center text-sm cursor-grab"
                        style={{ background: 'var(--panel-bg)', border: '1px solid var(--panel-border)' }}
                      >
                        <span className="font-medium text-gray-300 text-xs truncate">{methodName.replace(/_/g, ' ')}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col relative bg-transparent border-t" style={{ borderColor: 'var(--panel-border)' }}>
          <div className="flex-1 w-full h-full" onDrop={onDrop} onDragOver={onDragOver}>
            <LiveSchema.Provider value={statusData}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onInit={setRfInstance}
              onNodeClick={(e, node) => {
                // Typing into a field or pressing a button inside the card is not "open it".
                if ((e.target as HTMLElement).closest('input, select, textarea, button, a')) return;
                onNodeClick?.(node);
              }}
              nodeTypes={nodeTypes}
              fitView
            >
              <Background color="#aaa" gap={16} variant={BackgroundVariant.Dots} />
              <Controls />
              <MiniMap />
            </ReactFlow>
            </LiveSchema.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}
