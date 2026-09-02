"use client";

import React, { useState, useEffect } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { GripVertical, Trash2, Settings2, ChevronDown, ChevronUp, AlertTriangle, Eye, EyeOff, Info, PanelRightClose, PanelRightOpen, ChevronsDownUp, ChevronsUpDown, ChevronRight, Layers, BookOpen, Box } from 'lucide-react';

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
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(false);

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
    <div className={listId === 'canvas' ? '' : 'mb-6'}>
      {listId !== 'canvas' && (
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 px-2 uppercase tracking-wide flex items-center justify-between">
            <span>{title}</span>
            <span className="bg-gray-200 dark:bg-white/10 text-gray-500 dark:text-gray-400 text-xs px-2 py-0.5 rounded-full">{sequenceList.length}</span>
          </h3>
      )}
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
                  
                  const hasMissingRequiredArg = (() => {
                      let missing = false;
                      const paramsSchema = block.schema?.parameters || {};
                      for (const p of Object.keys(paramsSchema)) {
                          const pData = paramsSchema[p];
                          if (pData?.required) {
                              const val = block.params[p];
                              if ((val === undefined || val === '') && (pData.default === undefined || pData.default === '')) {
                                  missing = true;
                                  break;
                              }
                          }
                      }
                      return missing;
                  })();

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
                                className={`
                                  relative bg-white dark:bg-[#1a1a1a] rounded-xl shadow-sm border
                                  transition-all duration-200 group
                                  ${block.isHidden ? 'opacity-50 border-gray-200 dark:border-gray-800' : 
                                    snapshot.isDragging ? 'border-blue-500 shadow-xl scale-[1.02] z-50' : 
                                    'border-gray-200 dark:border-white/10 hover:border-gray-300 dark:hover:border-white/20'
                                  }
                                `}
                              >
                                  {/* Top Row: Info & Controls */}
                                  <div 
                                    {...provided.dragHandleProps}
                                    onClick={() => !isFlowBlock && toggleExpand(block.id, listId)}
                                    className={`p-3 flex items-center justify-between cursor-grab active:cursor-grabbing ${!isFlowBlock ? 'hover:bg-gray-50/50 dark:hover:bg-white/5 transition-colors' : ''} ${isExpanded && !isFlowBlock ? 'border-b border-gray-100 dark:border-white/5' : ''}`}
                                  >
                                    <div className="flex items-center min-w-0 flex-1">
                                      {!isFlowBlock && (
                                        <button className="mr-3 p-1 rounded-md text-gray-400 hover:text-gray-800 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-white/10 transition-colors pointer-events-none">
                                          {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                                        </button>
                                      )}
                                      <div className="flex items-center space-x-2">
                                        {!isFlowBlock && (
                                          <span className="text-[10px] font-bold px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 rounded capitalize">
                                            {block.instrument.replace(/_/g, ' ')}
                                          </span>
                                        )}
                                        <span className={`text-sm font-medium flex items-center ${isFlowBlock ? 'text-indigo-700 dark:text-indigo-300 font-bold' : isMissing ? 'text-red-600 dark:text-red-400 font-bold' : 'text-gray-800 dark:text-gray-100'}`}>
                                          {block.method.replace(/_/g, ' ')}
                                          {hasMissingRequiredArg && (
                                            <span title="Missing required parameter">
                                              <AlertTriangle className="w-4 h-4 text-orange-500 ml-2" />
                                            </span>
                                          )}
                                        </span>
                                        {isFlowBlock && block.schema?.parameters && (
                                          <div className="flex items-center space-x-2 ml-2">
                                            {Object.keys(block.schema.parameters).map(paramKey => {
                                              const pData = block.schema!.parameters[paramKey];
                                              const val = block.params[paramKey];
                                              const actualVal = val !== undefined ? val : (pData.default !== undefined ? String(pData.default) : '');
                                              const isDynamic = typeof actualVal === 'string' && actualVal.startsWith('#');
                                              const isInvalidDynamic = isDynamic && (listId === 'prep' || listId === 'cleanup');
                                              return (
                                                <div key={paramKey} className="relative flex items-center">
                                                  <input
                                                    type="text"
                                                    value={actualVal}
                                                    placeholder={paramKey.replace(/_/g, ' ')}
                                                    onChange={(e) => handleParamChange(block.id, paramKey, e.target.value, pData.type || '', listId)}
                                                    onClick={(e) => e.stopPropagation()}
                                                    className={`w-32 bg-indigo-500/10 dark:bg-indigo-900/40 border ${isInvalidDynamic ? 'border-red-500 focus:border-red-500 text-red-600 dark:text-red-400' : 'border-indigo-200 dark:border-indigo-800/50 focus:border-indigo-400 dark:focus:border-indigo-500 text-indigo-900 dark:text-indigo-100'} rounded px-2 py-1 text-xs focus:outline-none placeholder-indigo-300 dark:placeholder-indigo-600/50 pr-6`}
                                                  />
                                                  {isInvalidDynamic && (
                                                    <div className="absolute right-2" title="Dynamic variables (#) are not allowed in Prep/Cleanup phases.">
                                                      <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                                                    </div>
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

                                        if (isFlowBlock || isNone || listId === 'prep' || listId === 'cleanup') return null;
                                        return (
                                          <div className="flex items-center space-x-2 mr-2">
                                            <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">Save</span>
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

                                      {/* Action Buttons */}
                                      <div className="flex items-center space-x-1 border-l border-gray-200 dark:border-white/10 pl-3">
                                        <button onClick={(e) => { e.stopPropagation(); toggleHideBlock(block.id, listId); }} className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors">
                                          {block.isHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); removeBlock(index, listId); }} className="p-1.5 rounded-md text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:text-red-300 dark:hover:bg-red-900/30 transition-colors">
                                          <Trash2 className="w-4 h-4" />
                                        </button>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Bottom Row: Params */}
                                  {isExpanded && !isFlowBlock && (
                                    <div className="p-3 bg-gray-50/50 dark:bg-black/20 rounded-b-xl border-t border-gray-100 dark:border-white/5">
                                      {(() => {
                                        const allParams = Object.keys(block.schema?.parameters || {});
                                        const visibleParams = isFlowBlock 
                                          ? allParams.filter(p => p !== 'condition' && p !== 'duration_seconds')
                                          : allParams;
                                        if (visibleParams.length === 0) return null;
                                        return (
                                        <div className="flex flex-wrap gap-x-4 gap-y-2 items-center">
                                          {visibleParams.map((param) => {
                                            const renderParam = (pData: any, paramKey: string, paramName: string, bId: string, lId: string, paramsObj: any): React.ReactNode => {
                                                if (pData.is_object && pData.fields) {
                                                    return (
                                                        <div key={paramKey} className="flex flex-col space-y-1 shrink-0 p-2 border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] shadow-sm">
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
                                                const actualVal = val !== undefined ? val : (pData.default !== undefined ? String(pData.default) : '');
                                                const isDynamic = typeof actualVal === 'string' && actualVal.startsWith('#');
                                                const isInvalidDynamic = isDynamic && (lId === 'prep' || lId === 'cleanup');
                                                
                                                return (
                                                    <div key={paramKey} className="flex flex-col space-y-0.5 shrink-0 relative">
                                                      <label className="h-4 text-[10px] text-gray-500 dark:text-gray-400 capitalize font-medium flex items-end justify-between space-x-1 whitespace-nowrap w-full">
                                                        <div className="flex items-center space-x-1">
                                                          <span>{paramName.replace(/_/g, ' ')}</span>
                                                          {pData.required && <span className="text-red-500/80 leading-none">*</span>}
                                                        </div>
                                                        {isInvalidDynamic && (
                                                          <span title="Dynamic variables (#) are not allowed in Prep/Cleanup phases.">
                                                            <AlertTriangle className="w-3 h-3 text-red-500 ml-1" />
                                                          </span>
                                                        )}
                                                      </label>
                                                      <input
                                                        type="text"
                                                        list={pData.options ? `datalist-${bId}-${paramKey}` : undefined}
                                                        value={actualVal}
                                                        placeholder={pData.default !== undefined ? `Default: ${pData.default}` : displayType}
                                                        onChange={(e) => handleParamChange(bId, paramKey, e.target.value, pData.type || '', lId)}
                                                        className={`w-32 bg-white dark:bg-[#1a1a1a] border ${isInvalidDynamic ? 'border-red-500 focus:border-red-600 text-red-600 dark:text-red-400' : 'border-gray-300 dark:border-white/10 focus:border-blue-500 dark:focus:border-blue-500 text-gray-800 dark:text-white'} rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-1 ${isInvalidDynamic ? 'focus:ring-red-500/20' : 'focus:ring-blue-500/20'} transition-all`}
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
                              </div>
                            )}
                          </Draggable>
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
        
        {/* Toolbox (Left) */}
        <div className="w-72 border-r border-gray-200 dark:border-white/10 bg-white dark:bg-[#0f0f0f] flex flex-col z-10">
          <div className="h-16 flex items-center px-6 border-b border-gray-200 dark:border-white/10 shrink-0 bg-white/50 dark:bg-black/10">
            <h2 className="text-sm font-bold tracking-wider text-gray-800 dark:text-gray-200 uppercase">Toolbox</h2>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-1">
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
                    .map(instrument => {
                    const isExpanded = expandedToolbox[instrument];
                    const isFlowControl = instrument === 'Flow Control' || instrument === 'Flow_Control';
                    const isLibrary = instrument === 'Library Workflows';
                    
                    let headerClass = "w-full flex items-center justify-between p-3 rounded-xl transition-all duration-200 ";
                    let titleClass = "font-bold text-[15px] ";
                    
                    if (isFlowControl) {
                       headerClass += "bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/20 dark:hover:bg-indigo-900/40";
                       titleClass += "text-indigo-800 dark:text-indigo-300";
                    } else if (isLibrary) {
                       headerClass += "bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:hover:bg-emerald-900/40";
                       titleClass += "text-emerald-800 dark:text-emerald-300";
                    } else {
                       headerClass += "bg-transparent hover:bg-gray-100 dark:hover:bg-white/5";
                       titleClass += "text-gray-900 dark:text-gray-100";
                    }

                    return (
                      <div key={instrument} className="flex flex-col">
                        <button onClick={() => toggleToolbox(instrument)} className={headerClass}>
                          <div className="flex items-center space-x-3">
                             <span className={titleClass}>{instrument.replace(/_/g, ' ')}</span>
                          </div>
                          {isExpanded ? <ChevronUp className="w-4 h-4 opacity-50" /> : <ChevronDown className="w-4 h-4 opacity-50" />}
                        </button>
                        
                        {isExpanded && (
                          <div className="p-2 space-y-2 mb-2">
                            {Object.keys(instruments[instrument]).map((method, idx) => (
                              <Draggable key={`${instrument}::${method}`} draggableId={`${instrument}::${method}`} index={idx}>
                              {(provided, snapshot) => (
                                <React.Fragment>
                                  <div 
                                    ref={provided.innerRef}
                                    {...provided.draggableProps}
                                    {...provided.dragHandleProps}
                                    className={`p-2.5 bg-white dark:bg-[#1a1a1a] border rounded-lg transition-all flex items-center justify-between shadow-sm border-gray-200 dark:border-white/10 hover:border-gray-300 dark:hover:border-white/20 hover:shadow-md ${snapshot.isDragging ? 'border-blue-500 shadow-xl ring-2 ring-blue-500/20' : ''}`}
                                    style={provided.draggableProps.style}
                                  >
                                    <div className="flex flex-col w-full min-w-0">
                                      <div className="flex items-center justify-between w-full relative">
                                        <span className="font-medium text-gray-800 dark:text-gray-200 text-sm truncate">{method.replace(/_/g, ' ')}</span>
                                        {instruments[instrument][method]?.description && (
                                          <div className="relative group/tooltip flex items-center shrink-0 ml-2">
                                            <Info className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors cursor-help" />
                                            <div className="absolute right-0 top-full mt-2 w-[260px] p-2.5 bg-gray-900 dark:bg-gray-800 text-gray-100 text-xs rounded-lg shadow-xl opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all z-50 pointer-events-none whitespace-normal border border-gray-700">
                                              {instruments[instrument][method].description}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                  {snapshot.isDragging && (
                                    <div className="p-2.5 bg-white dark:bg-[#1a1a1a] border rounded-lg flex items-center justify-between shadow-sm border-gray-200 dark:border-white/10 opacity-50 grayscale pointer-events-none select-none">
                                      <div className="flex flex-col w-full min-w-0">
                                        <div className="flex items-center justify-between w-full">
                                          <span className="font-medium text-gray-800 dark:text-gray-200 text-sm truncate">{method.replace(/_/g, ' ')}</span>
                                          {instruments[instrument][method]?.description && (
                                            <div className="shrink-0 ml-2">
                                              <Info className="w-3.5 h-3.5 text-gray-400" />
                                            </div>
                                          )}
                                        </div>
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
        </div>

        {/* Sequence Canvas (Center) and Right Sidebar */}
        <div className="flex-1 flex flex-col bg-gray-100 dark:bg-[#0f0f0f] relative min-w-0">
          {header}
          
          <div className="flex-1 flex overflow-hidden relative min-w-0">
            {customView ? (
              customView
            ) : (
              <div className="flex-1 overflow-y-auto p-6 pb-48 relative">
                <div className="max-w-4xl mx-auto w-full relative">
                  <div className="absolute -top-4 right-0 flex items-center space-x-2 z-10">
                     <button onClick={expandAll} className="flex items-center space-x-1 text-xs text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 transition-colors" title="Expand All Cards">
                         <ChevronsUpDown className="w-3.5 h-3.5" />
                         <span>Expand All</span>
                     </button>
                     <button onClick={collapseAll} className="flex items-center space-x-1 text-xs text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 transition-colors" title="Collapse All Cards">
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
    </DragDropContext>
  );
}
