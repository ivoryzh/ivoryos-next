"use client";

import React, { useState, useEffect } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { GripVertical, Trash2, Settings2, ChevronDown, ChevronUp, AlertTriangle, Eye, EyeOff, Info, PanelRightClose, PanelRightOpen, ChevronsDownUp, ChevronsUpDown, ChevronRight, Search, Hash, Layers } from 'lucide-react';

export type SequenceBlock = {
  id: string;
  instrument: string;
  method: string;
  schema: any;
  params: Record<string, any>;
  isExpanded?: boolean;
  returnVar?: string;
  isHidden?: boolean;
  // Only meaningful in the Main Workflow. Default (false/undefined) = "per-sample": when run
  // against a spreadsheet, this step repeats once per row. true = "batch": the step runs once
  // per batch group (a configurable number of consecutive rows, e.g. 4 samples heated together),
  // not once per row — its #vars are read from whichever one row in the group has them filled in.
  isBatchAction?: boolean;
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
  const [searchQuery, setSearchQuery] = useState("");
  const [emptyHashFields, setEmptyHashFields] = useState<Set<string>>(new Set());
  const [autoFillVariables, setAutoFillVariables] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('ivoryos_autofill_variables');
    if (saved !== null) setAutoFillVariables(saved === 'true');
  }, []);

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

      if (instrument === "Flow Control" && method === "If_Else_Block") {
          destList.splice(destination.index, 0, 
              createBlock("Flow_Control", "If", { condition: "True" }),
              createBlock("Flow_Control", "Else", {}),
              createBlock("Flow_Control", "End_If", {})
          );
      } else if (instrument === "Flow Control" && method === "While_Loop") {
          destList.splice(destination.index, 0, 
              createBlock("Flow_Control", "While", { condition: "False" }),
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

  const toggleBatchAction = (blockId: string, listId: string) => {
    updateBlock(listId, blockId, block => ({ ...block, isBatchAction: !block.isBatchAction }));
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
                  
                  let effectiveSchema = block.schema?.parameters || (statusData.instruments[block.instrument] && statusData.instruments[block.instrument][block.method]?.parameters);
                  
                  const blockWarnings: string[] = [];
                  if (isMissing) {
                      blockWarnings.push(`Method '${block.instrument}.${block.method}' no longer exists.`);
                  }

                  // Check for deprecated parameters if schema is known
                  if (effectiveSchema && block.params && !isMissing) {
                      for (const p of Object.keys(block.params)) {
                          if (effectiveSchema[p] === undefined && typeof block.params[p] !== 'undefined') {
                              blockWarnings.push(`Parameter '${p}' is no longer supported.`);
                          }
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
                    <Draggable key={block.id} draggableId={block.id} index={index}>
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                style={{ ...provided.draggableProps.style, ...indent }}
                                className={`
                                  relative ${bgClass} rounded-lg shadow-sm border
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
                                    onClick={() => !isFlowBlock && hasParams && toggleExpand(block.id, listId)}
                                    className={`px-3 py-1.5 flex items-center justify-between cursor-grab active:cursor-grabbing ${!isFlowBlock && hasParams ? 'hover:bg-gray-50/50 dark:hover:bg-white/5 transition-colors' : ''}`}
                                  >
                                    <div className="flex items-center min-w-0 flex-1">
                                      <div className={`flex items-center space-x-2 ${!isFlowBlock && !hasParams ? 'ml-1' : ''}`}>
                                        {!isFlowBlock && (
                                          <span title={block.instrument.replace(/_/g, ' ')} className="w-28 shrink-0 truncate text-center text-[10px] font-semibold px-2 py-0.5 bg-gray-100 text-gray-600 border border-gray-200 dark:bg-white/10 dark:text-gray-300 dark:border-white/5 rounded-md capitalize">
                                            {block.instrument.replace(/_/g, ' ')}
                                          </span>
                                        )}
                                        <span className={`text-[13px] tracking-tight capitalize ${isFlowBlock ? flowTextClass : 'text-gray-800 dark:text-gray-100 font-medium'}`}>
                                          {block.method.replace(/_/g, ' ')}
                                          {blockWarnings.length > 0 && (
                                            <span title={blockWarnings.join('\n')} className="inline-flex items-center ml-1.5 cursor-help">
                                              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                                            </span>
                                          )}
                                        </span>
                                        {isFlowBlock && block.schema?.parameters && (
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
                                        const hasLegacyReturn = Boolean(block.returnVar);

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
                                        } else if (hasLegacyReturn && isNone) {
                                          numReturns = Math.max(1, (block.returnVar || '').split(',').length);
                                        }

                                        if (isFlowBlock || listId === 'prep' || listId === 'cleanup') return null;
                                        if (isNone && !hasLegacyReturn) return null;
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
                                                      onClick={(e) => e.stopPropagation()}
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
                                        {!isFlowBlock && listId === 'canvas' && (
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
                                    <div className="px-3 pb-2 pt-0 flex flex-col space-y-2">
                                      {blockWarnings.length > 0 && (
                                        <div className="bg-amber-50/50 dark:bg-amber-900/10 border border-amber-200/50 dark:border-amber-500/20 rounded text-amber-700 dark:text-amber-400 text-[10px] px-2 py-1.5 font-medium">
                                            <ul className="list-disc pl-4 space-y-0.5">
                                                {blockWarnings.map((w, idx) => <li key={idx}>{w}</li>)}
                                            </ul>
                                        </div>
                                      )}
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
                                                        list={pData.options ? `datalist-${bId}-${paramKey}` : undefined}
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

                                            const pData = (effectiveSchema as any)?.[param] || {};
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
        
        {/* Left Sidebar (Toolbox) */}
        <div className="w-72 bg-white dark:bg-[#1a1a1a] flex flex-col border-r border-gray-200 dark:border-white/10 shrink-0 z-10">
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
                    const matchingMethods = Object.keys(instruments[instrument]).filter(method => 
                        matchesInst || method.toLowerCase().includes(searchQuery.toLowerCase())
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
                                      <span title={method.replace(/_/g, ' ')} className="font-medium text-gray-700 dark:text-gray-300 text-[13px] truncate capitalize">{method.replace(/_/g, ' ')}</span>
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
                                        <span title={method.replace(/_/g, ' ')} className="font-medium text-gray-700 dark:text-gray-300 text-[13px] truncate">{method.replace(/_/g, ' ')}</span>
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
                  <div className="absolute -top-4 right-0 flex items-center space-x-3 z-10">
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
    </DragDropContext>
  );
}
