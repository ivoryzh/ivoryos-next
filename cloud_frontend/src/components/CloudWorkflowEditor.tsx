"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { ReactFlow, MiniMap, Controls, Background, Connection, Edge, NodeTypes, Node, BackgroundVariant, Handle, Position, getOutgoers } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Settings2, ChevronDown, ChevronUp, Cloud } from 'lucide-react';

interface CloudWorkflowEditorProps {
  cloudDevices: any[];
  statusData: any;
  nodes: Node[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  edges: Edge[];
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  onNodesChange: any;
  onEdgesChange: any;
  onConnect: (params: Connection | Edge) => void;
  header?: React.ReactNode;
}

const CustomCloudNode = ({ data, id }: any) => {
  const { block, updateNodeData, statusData, cloudDevices, targetDeviceId, taskStatus } = data;
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

  const isStartNode = block.instrument === 'Flow Control' && block.method === 'Start';
  const hasBottomSection = !isStartNode && (allParams.length > 0 || (block.schema?.return_type && block.schema.return_type !== 'None' && block.schema.return_type !== 'NoneType'));

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
            <div className="w-full mb-2">
              <div className="text-xs font-bold text-blue-400 uppercase tracking-wider">{block.instrument === 'Library Workflows' ? 'Sequence' : block.instrument}</div>
              <div className="text-sm font-semibold">{block.method.replace(/_/g, ' ')}</div>
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
          </>
        )}
      </div>
      {hasBottomSection && (
        <div className="p-3 flex flex-col gap-2" style={{ background: 'var(--input-bg)', borderBottomLeftRadius: '0.75rem', borderBottomRightRadius: '0.75rem' }}>
          {allParams.map((paramKey) => {
            const pData = block.schema.parameters[paramKey];
            const val = block.params[paramKey] !== undefined ? block.params[paramKey] : (pData.default || '');
            return (
              <div key={paramKey} className="flex flex-col gap-2">
                <label className="text-xs text-gray-400 font-bold uppercase">{paramKey}</label>
                <input
                  type="text"
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
                          className="w-20 bg-gray-50 dark:bg-black/60 border border-gray-300 dark:border-white/10 rounded px-2 py-0.5 text-xs focus:outline-none focus:border-blue-500 dark:focus:border-blue-500 text-gray-800 dark:text-white"
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
  nodes,
  setNodes,
  edges,
  setEdges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  header
}: CloudWorkflowEditorProps) {
  const [expandedToolbox, setExpandedToolbox] = useState<Record<string, boolean>>({});
  const [rfInstance, setRfInstance] = useState<any>(null);

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

      const defaultParams: Record<string, any> = {};
      if (m_schema.parameters) {
        Object.entries(m_schema.parameters).forEach(([key, param]: [string, any]) => {
          if (param.default !== undefined) {
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
            returnVar: ""
          },
          updateNodeData,
          statusData,
          cloudDevices
        },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [setNodes, statusData, updateNodeData, cloudDevices]
  );

  useEffect(() => {
    setNodes(nds => nds.map(n => {
      if (n.type === 'customCloudNode') {
        return { ...n, data: { ...n.data, cloudDevices, updateNodeData } };
      }
      return n;
    }));
  }, [cloudDevices, updateNodeData, setNodes]);

  return (
    <div className="flex-1 flex flex-col h-full w-full bg-transparent overflow-hidden">
      {header}
      <div className="flex-1 flex h-full w-full overflow-hidden">
        <div className="glass-sidebar flex flex-col z-10 shrink-0 border-t" style={{ borderColor: 'var(--panel-border)' }}>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {cloudDevices.map(device => {
              const deviceId = device.id;
              const dInstruments = device.schema?.instruments || {};

              // Separate Library Workflows
              const libraryWorkflows = dInstruments["Library Workflows"] || {};

              // Other advanced instruments (excluding Flow Control)
              const advancedInstruments = Object.fromEntries(
                Object.entries(dInstruments).filter(([k]) => k !== "Library Workflows" && k !== "Flow Control")
              );

              return (
                <div key={deviceId} className="device-group mb-6">
                  <div className="flex items-center space-x-2 px-2 py-1 mb-2">
                    <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></div>
                    <h3 className="text-sm font-bold text-gray-800 dark:text-gray-200">{deviceId}</h3>
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
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onInit={setRfInstance}
              nodeTypes={nodeTypes}
              fitView
            >
              <Background color="#aaa" gap={16} variant={BackgroundVariant.Dots} />
              <Controls />
              <MiniMap />
            </ReactFlow>
          </div>
        </div>
      </div>
    </div>
  );
}
