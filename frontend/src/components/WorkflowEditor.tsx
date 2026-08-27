"use client";

import React, { useState, useEffect } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { GripVertical, Trash2, Settings2, ChevronDown, ChevronUp, AlertTriangle, Eye, EyeOff, Info } from 'lucide-react';

export type SequenceBlock = {
  id: string;
  instrument: string;
  method: string;
  schema: any;
  params: Record<string, any>;
  isExpanded?: boolean;
  returnVar?: string;
  isHidden?: boolean;
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
  customView
}: WorkflowEditorProps) {
  const [expandedToolbox, setExpandedToolbox] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // Initialize toolbox state (all collapsed) when statusData changes
    if (statusData && statusData.instruments) {
        const insts: Record<string, boolean> = {};
        Object.keys(statusData.instruments).forEach(k => insts[k] = false);
        setExpandedToolbox(prev => ({ ...insts, ...prev })); // preserve existing state
    }
  }, [statusData]);

  const instruments = statusData?.instruments || {};

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
      
      const defaultParams: Record<string, any> = {};
      if (methodSchema.parameters) {
        Object.entries(methodSchema.parameters).forEach(([key, param]: [string, any]) => {
            if (param.default !== undefined) {
                defaultParams[key] = param.default;
            }
        });
      }

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

      if (instrument === "Flow Control" && method === "If_Else_Block") {
          destList.splice(destination.index, 0, 
              createBlock("Flow_Control", "If", { condition: "True" }),
              createBlock("Flow_Control", "Else", {}),
              createBlock("Flow_Control", "End_If", {})
          );
      } else if (instrument === "Flow Control" && method === "While_Loop") {
          destList.splice(destination.index, 0, 
              createBlock("Flow_Control", "While", { condition: "True" }),
              createBlock("Flow_Control", "End_While", {})
          );
      } else {
          // Normal block
          const newBlock = createBlock(instrument, method, defaultParams);
          if (instrument === "Flow Control" && method === "Sleep") {
              newBlock.instrument = "Flow_Control"; // standardise the instrument name for backend
          }
          destList.splice(destination.index, 0, newBlock);
      }

      setSequenceList(destId, destList);
      return;
    }

    if (['prep', 'canvas', 'cleanup'].includes(sourceId) && ['prep', 'canvas', 'cleanup'].includes(destId)) {
      const sourceList = Array.from(getSequenceList(sourceId));
      const destList = sourceId === destId ? sourceList : Array.from(getSequenceList(destId));
      
      const [removed] = sourceList.splice(source.index, 1);
      destList.splice(destination.index, 0, removed);
      
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

  const handleReturnVarChange = (blockId: string, value: string, listId: string) => {
    updateBlock(listId, blockId, block => ({ ...block, returnVar: value }));
  };

  const toggleExpand = (blockId: string, listId: string) => {
    updateBlock(listId, blockId, block => ({ ...block, isExpanded: !block.isExpanded }));
  };

  const toggleHideBlock = (blockId: string, listId: string) => {
    updateBlock(listId, blockId, block => ({ ...block, isHidden: !block.isHidden }));
  };

  const toggleToolbox = (instName: string) => {
    setExpandedToolbox(prev => ({ ...prev, [instName]: !prev[instName] }));
  };

  const removeBlock = (index: number, listId: string) => {
    const list = Array.from(getSequenceList(listId));
    list.splice(index, 1);
    setSequenceList(listId, list);
  };

  const renderSequenceList = (listId: string, title: string, sequenceList: SequenceBlock[]) => (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 px-2 uppercase tracking-wide flex items-center justify-between">
        <span>{title}</span>
        <span className="bg-gray-200 dark:bg-white/10 text-gray-500 dark:text-gray-400 text-xs px-2 py-0.5 rounded-full">{sequenceList.length}</span>
      </h3>
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

                  return (<>{sequenceList.map((block, index) => {
                  const isExpanded = block.isExpanded !== false;
                  const blockDepth = depths[index] || 0;
                  const nestColor = blockDepth > 0 ? nestColors[(blockDepth - 1) % nestColors.length] : '';
                  const nestBg = blockDepth > 0 ? nestBgs[(blockDepth - 1) % nestBgs.length] : '';
                  const isFlowBlock = block.instrument === 'Flow_Control' || block.instrument === 'Flow Control';
                  const isMissing = !isFlowBlock && (!statusData.instruments[block.instrument] || !statusData.instruments[block.instrument][block.method]);
                  let borderClass = blockDepth > 0 ? `border-gray-200 dark:border-white/10 border-l-4 ${nestColor}` : 'border-gray-200 dark:border-white/10';
                  if (isMissing) borderClass = `border-red-400 dark:border-red-500/50 shadow-[0_0_0_1px_rgba(248,113,113,0.5)] ${blockDepth > 0 ? 'border-l-4' : ''}`;
                  let bgClass = isFlowBlock ? 'bg-indigo-50/60 dark:bg-indigo-900/20' : (blockDepth > 0 ? `bg-white dark:bg-black/40 ${nestBg}` : 'bg-white dark:bg-black/40');
                  const indent = blockDepth > 0 ? { marginLeft: `${blockDepth * 20}px` } : {};
                  
                  return (
                    <Draggable key={block.id} draggableId={block.id} index={index}>
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                style={{ ...provided.draggableProps.style, ...indent }}
                                className={`rounded-xl border ${borderClass} ${bgClass} shadow-sm transition-all ${
                                  snapshot.isDragging ? 'shadow-xl ring-2 ring-blue-500 scale-[1.02]' : ''
                                }`}
                              >
                                  {/* Top Row: Info & Controls */}
                                  <div className="flex items-center justify-between bg-gray-50/50 dark:bg-white/[0.02] border-b border-gray-100 dark:border-white/5 h-[34px] rounded-t-xl">
                                    <div className="flex items-center h-full">
                                      <div {...provided.dragHandleProps} className="px-3 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-white cursor-grab h-full flex items-center border-r border-gray-100 dark:border-white/5">
                                        <GripVertical className="w-4 h-4" />
                                      </div>
                                      <div className="flex items-center space-x-2 px-3">
                                        {!isFlowBlock && (
                                          <span className="text-[10px] font-bold px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 rounded capitalize whitespace-nowrap">
                                            {block.instrument.replace(/_/g, ' ')}
                                          </span>
                                        )}
                                        <span className={`text-sm font-medium whitespace-nowrap ${isFlowBlock ? 'text-indigo-700 dark:text-indigo-300 font-bold' : isMissing ? 'text-red-600 dark:text-red-400 font-bold' : 'text-gray-800 dark:text-gray-100'}`}>
                                          {block.method.replace(/_/g, ' ')}
                                        </span>
                                        {block.schema?.description && (
                                          <div className="group relative flex items-center ml-2">
                                            <Info className="w-3.5 h-3.5 text-gray-400 hover:text-blue-500 transition-colors cursor-help" />
                                            <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-64 p-2 bg-gray-800 dark:bg-gray-700 text-white text-xs rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 whitespace-pre-wrap pointer-events-none">
                                              {block.schema.description}
                                              <div className="absolute left-1/2 -bottom-1 -translate-x-1/2 w-2 h-2 bg-gray-800 dark:bg-gray-700 transform rotate-45"></div>
                                            </div>
                                          </div>
                                        )}
                                        {isMissing && (
                                          <span className="flex items-center text-red-500 bg-red-50 dark:bg-red-900/30 px-2 py-0.5 rounded text-xs ml-2" title={`Instrument or method not found in current setup.`}>
                                            <AlertTriangle className="w-3 h-3 mr-1" />
                                            Missing from Setup
                                          </span>
                                        )}
                                        {isFlowBlock && (block.method === 'If' || block.method === 'While') && (
                                          <input
                                            type="text"
                                            value={block.params.condition !== undefined ? block.params.condition : ''}
                                            placeholder="condition"
                                            onChange={(e) => handleParamChange(block.id, 'condition', e.target.value, 'str', listId)}
                                            className="w-40 bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-500/30 rounded px-2 py-0.5 text-xs font-mono focus:outline-none focus:border-indigo-500 text-indigo-900 dark:text-indigo-100"
                                          />
                                        )}
                                        {isFlowBlock && block.method === 'Sleep' && (
                                          <input
                                            type="number"
                                            value={block.params.duration_seconds !== undefined ? block.params.duration_seconds : ''}
                                            placeholder="seconds"
                                            onChange={(e) => handleParamChange(block.id, 'duration_seconds', parseFloat(e.target.value) || 0, 'float', listId)}
                                            className="w-24 bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-500/30 rounded px-2 py-0.5 text-xs font-mono focus:outline-none focus:border-indigo-500 text-indigo-900 dark:text-indigo-100"
                                          />
                                        )}
                                      </div>
                                    </div>
                                    <div className="px-3 flex items-center space-x-2 border-l border-gray-100 dark:border-white/5 h-full">
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

                                        if (isFlowBlock || isNone) return null;
                                        return (
                                          <div className="flex items-center space-x-2 mr-2">
                                            <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">
                                              Return
                                            </span>
                                            <div className="flex space-x-1 items-center">
                                              {Array.from({ length: numReturns }).map((_, i) => {
                                                const parts = (block.returnVar || '').split(',').map(s => s.trim());
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
                                                        handleReturnVarChange(block.id, newParts.join(', '), listId);
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
                                      <button onClick={() => toggleHideBlock(block.id, listId)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" title={block.isHidden ? "Unhide Block" : "Hide Block"}>
                                        {block.isHidden ? <EyeOff className="w-4 h-4 text-gray-400" /> : <Eye className="w-4 h-4" />}
                                      </button>
                                      <button onClick={() => removeBlock(index, listId)} className="text-gray-400 hover:text-red-500 dark:hover:text-red-400 p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/10 transition-colors">
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    </div>
                                  </div>

                                  {/* Bottom Row: Params (hidden when no params or flow control with inline condition) */}
                                  {(() => {
                                    const allParams = Object.keys(block.schema?.parameters || {});
                                    const visibleParams = isFlowBlock 
                                      ? allParams.filter(p => p !== 'condition' && p !== 'duration_seconds')
                                      : allParams;
                                    if (visibleParams.length === 0) return null;
                                    return (
                                    <div className="p-1.5 px-2.5 flex flex-wrap gap-x-4 gap-y-1.5 items-center bg-white dark:bg-transparent min-h-[2.5rem]">
                                      {visibleParams.map((param) => {
                                        const renderParam = (pData: any, paramKey: string, paramName: string, bId: string, lId: string, paramsObj: any): React.ReactNode => {
                                            if (pData.is_object && pData.fields) {
                                                return (
                                                    <div key={paramKey} className="flex flex-col space-y-1 shrink-0 p-1.5 border border-gray-200 dark:border-white/10 rounded bg-gray-50 dark:bg-white/5">
                                                        <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider px-1">{paramName}</span>
                                                        <div className="flex flex-wrap gap-x-2 gap-y-1.5 pl-1 border-l-2 border-gray-300 dark:border-white/20">
                                                            {Object.keys(pData.fields).map(subKey => 
                                                                renderParam(pData.fields[subKey], `${paramKey}.${subKey}`, subKey, bId, lId, paramsObj)
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            }

                                            const displayType = (pData.type || '').replace(/<class '([^']+)'>/, '$1').replace('typing.', '');
                                            const val = paramKey.split('.').reduce((acc: any, part: string) => acc && acc[part] !== undefined ? acc[part] : undefined, paramsObj);
                                            
                                            return (
                                                <div key={paramKey} className="flex flex-col space-y-0.5 shrink-0">
                                                  <label className="h-4 text-[10px] text-gray-500 dark:text-gray-400 capitalize font-medium flex items-end space-x-1 whitespace-nowrap">
                                                    <span>{paramName.replace(/_/g, ' ')}</span>
                                                    {pData.required && <span className="text-red-500/80 leading-none">*</span>}
                                                  </label>
                                                  <input
                                                    type="text"
                                                    list={pData.options ? `datalist-${bId}-${paramKey}` : undefined}
                                                    value={val !== undefined ? val : (pData.default !== undefined ? String(pData.default) : '')}
                                                    placeholder={pData.default !== undefined ? `Default: ${pData.default}` : displayType}
                                                    onChange={(e) => handleParamChange(bId, paramKey, e.target.value, pData.type || '', lId)}
                                                    className="w-28 bg-gray-50 dark:bg-black/60 border border-gray-300 dark:border-white/10 rounded px-2 py-0.5 text-xs focus:outline-none focus:border-blue-500 dark:focus:border-blue-500 text-gray-800 dark:text-white"
                                                  />
                                                  {pData.options && (
                                                    <datalist id={`datalist-${bId}-${paramKey}`}>
                                                      {pData.options.map((opt: any) => (
                                                        <option key={String(opt)} value={String(opt)} />
                                                      ))}
                                                    </datalist>
                                                  )}
                                                </div>
                                            );
                                        };

                                        const pData = (block.schema?.parameters as any)?.[param] || {};
                                        return renderParam(pData, param, param, block.id, listId, block.params);
                                      })}
                                    </div>
                                    );
                                  })()}
                              </div>
                            )}
                          </Draggable>
                  );
                })}</>)})()}
                {provided.placeholder}
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
        
        {/* Toolbox (Left) */}
        <div className="w-72 border-r border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 flex flex-col z-10">
          <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10">
            <h2 className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300">Toolbox</h2>
          </header>
          
          <Droppable droppableId="toolbox" isDropDisabled={true}>
            {(provided) => {
              const allEntries = Object.entries(instruments);
              const flowControl = allEntries.filter(([k]) => k === 'Flow Control');
              const drivers = allEntries.filter(([k]) => k !== 'Flow Control' && k !== 'Library Workflows');
              const workflows = allEntries.filter(([k]) => k === 'Library Workflows');
              
              const renderSection = (entries: [string, any][], accentClass: string, iconClass: string) => entries.map(([instName, schema]: [string, any]) => (
                  <div key={instName} className={`border rounded-lg overflow-hidden ${accentClass}`}>
                    <button 
                      onClick={() => toggleToolbox(instName)}
                      className="w-full px-4 py-2 flex items-center justify-between bg-white dark:bg-white/5 hover:bg-gray-50 dark:hover:bg-white/10 transition-colors border-b border-gray-200 dark:border-white/5"
                    >
                      <span className="text-xs font-bold text-gray-700 dark:text-gray-300 tracking-wider capitalize">{instName.replace(/_/g, ' ')}</span>
                      {expandedToolbox[instName] ? <ChevronUp className="w-3 h-3 text-gray-500" /> : <ChevronDown className="w-3 h-3 text-gray-500" />}
                    </button>
                    {expandedToolbox[instName] && (
                      <div className="p-2 space-y-2">
                        {Object.keys(schema).map((methodName, idx) => (
                          <Draggable key={`${instName}::${methodName}`} draggableId={`${instName}::${methodName}`} index={idx}>
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                {...provided.dragHandleProps}
                                className={`p-2.5 rounded-md border flex items-center space-x-3 text-sm
                                  ${snapshot.isDragging 
                                    ? 'bg-blue-100 dark:bg-blue-600 border-blue-300 dark:border-blue-500 shadow-xl' 
                                    : 'bg-white dark:bg-white/5 border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10'}`}
                              >
                                <Settings2 className={`w-3.5 h-3.5 shrink-0 ${iconClass}`} />
                                <span className="font-medium text-gray-700 dark:text-gray-200 truncate">{methodName.replace(/_/g, ' ')}</span>
                              </div>
                            )}
                          </Draggable>
                        ))}
                      </div>
                    )}
                  </div>
              ));
              
              return (
              <div ref={provided.innerRef} {...provided.droppableProps} className="flex-1 overflow-y-auto p-4 space-y-3">
                {flowControl.length > 0 && (
                  <>
                    {renderSection(flowControl, 'border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/30 dark:bg-indigo-900/10', 'text-indigo-500 dark:text-indigo-400')}
                  </>
                )}
                {drivers.length > 0 && (
                  <>
                    <div className="border-t border-gray-200 dark:border-white/10 my-2"></div>
                    {renderSection(drivers, 'border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02]', 'text-blue-500 dark:text-blue-400')}
                  </>
                )}
                {workflows.length > 0 && (
                  <>
                    <div className="border-t border-gray-200 dark:border-white/10 my-2"></div>
                    {renderSection(workflows, 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/30 dark:bg-emerald-900/10', 'text-emerald-500 dark:text-emerald-400')}
                  </>
                )}
                {provided.placeholder}
              </div>
            );}}
          </Droppable>
        </div>

        {/* Sequence Canvas (Right) */}
        <div className="flex-1 flex flex-col bg-gray-100 dark:bg-[#0f0f0f] relative">
          {header}
          
          {customView ? (
              customView
          ) : (
          <div className="flex-1 overflow-y-auto p-6 max-w-5xl mx-auto w-full pb-48">
            {renderSequenceList('prep', 'Prep Phase', prepSequence)}
            {renderSequenceList('canvas', 'Main Workflow', sequence)}
            {renderSequenceList('cleanup', 'Cleanup Phase', cleanupSequence)}
          </div>
          )}
        </div>
      </div>
    </DragDropContext>
  );
}
