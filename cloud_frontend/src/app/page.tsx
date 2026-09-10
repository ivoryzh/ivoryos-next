"use client";

import { useState, useEffect, useCallback } from 'react';
import { Play, Trash2, Cloud, AlertTriangle, RefreshCw, Download, Save } from 'lucide-react';
import { useNodesState, useEdgesState, addEdge, Connection, Edge, Node } from '@xyflow/react';
import CloudWorkflowEditor from '@/components/CloudWorkflowEditor';

export default function CloudDesignerPage() {
  const [statusData, setStatusData] = useState<any>({ instruments: {} });
  const [cloudDevices, setCloudDevices] = useState<any[]>([]);
  
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [currentWorkflowName, setCurrentWorkflowName] = useState<string>('');
  const [currentWorkflowDescription, setCurrentWorkflowDescription] = useState<string>('');

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [taskStatuses, setTaskStatuses] = useState<any[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem('cloud_workflow');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setNodes(parsed.nodes || []);
        setEdges(parsed.edges || []);
        setCurrentWorkflowName(parsed.name || '');
        setCurrentWorkflowDescription(parsed.description || '');
      } catch (e) {}
    } else {
      setNodes([{
          id: 'start_node',
          type: 'customCloudNode',
          position: { x: 250, y: 100 },
          data: { 
              targetDeviceId: "",
              block: {
                  id: 'start_block',
                  instrument: 'Flow Control',
                  method: 'Start',
                  schema: { parameters: {} },
                  params: {}
              }
          }
      }]);
    }
  }, [setNodes, setEdges]);

  useEffect(() => {
    if (nodes.length > 0) {
      localStorage.setItem('cloud_workflow', JSON.stringify({
        nodes, edges, name: currentWorkflowName, description: currentWorkflowDescription
      }));
    }
  }, [nodes, edges, currentWorkflowName, currentWorkflowDescription]);
  
  const [isOffline, setIsOffline] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);

  const onConnect = useCallback(
    (params: Connection | Edge) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  // Devices AND their schemas both live on the same /api/devices response (daemon.js writes the
  // schema column as each device's retained MQTT schema topic arrives) — one poll drives both the
  // device list and the aggregated instrument palette, so a device that connects to the cloud
  // after this page has already mounted still shows up without a manual refresh.
  const fetchCloudDevices = async () => {
    try {
      const [devicesRes, sequencesRes] = await Promise.all([
        fetch(`/api/devices`),
        fetch(`/api/edge-sequences`),
      ]);
      const data = await devicesRes.json();
      const sequences = await sequencesRes.json().catch(() => []);
      const devices = Array.isArray(data) ? data : [];

      // Graft each device's saved sequences into its schema as a synthetic "Library Workflows"
      // instrument — the toolbox/drag-drop/node-creation code below already understands this
      // category (it's how the single-device edge-sequence editor's local composition works
      // too), and the edge server already knows how to expand a {instrument: "Library Workflows",
      // method: <sequenceName>} block back into the full saved sequence at dispatch time
      // (expand_workflow_blocks in server.py) — so this is the only piece that was missing to
      // make "drag a saved sequence onto the distributed canvas" actually work end-to-end.
      // A sequence can expose its own params for the caller to fill in — any block arg written
      // as "#varName" in the saved body is a placeholder, same convention the local edge Designer
      // uses (see edge-sequence/page.tsx's identical scan). Surfacing these as the synthetic
      // instrument's `parameters` is what makes CustomCloudNode render them as editable fields —
      // it already does that generically for any block.schema.parameters, sequences included.
      const scanDynamicParams = (body: any): Record<string, any> => {
        const params: Record<string, any> = {};
        const scanBlocks = (blocks: any[]) => {
          (blocks || []).forEach((b: any) => {
            Object.entries(b.args || b.params || {}).forEach(([k, val]) => {
              if (typeof val === 'string' && val.startsWith('#')) {
                const paramName = val.substring(1);
                const paramType = (b.arg_types && b.arg_types[k]) || 'str';
                params[paramName] = { type: paramType, required: true };
              }
            });
          });
        };
        scanBlocks(body?.prep);
        scanBlocks(body?.script || body?.sequence);
        scanBlocks(body?.cleanup);
        return params;
      };

      const sequencesByDevice: Record<string, any> = {};
      for (const s of (Array.isArray(sequences) ? sequences : [])) {
        if (!sequencesByDevice[s.device_id]) sequencesByDevice[s.device_id] = {};
        sequencesByDevice[s.device_id][s.name] = { description: s.description || '', parameters: scanDynamicParams(s.body), return_type: 'None' };
      }
      for (const device of devices) {
        if (sequencesByDevice[device.id]) {
          if (!device.schema) device.schema = { instruments: {} };
          if (!device.schema.instruments) device.schema.instruments = {};
          device.schema.instruments['Library Workflows'] = sequencesByDevice[device.id];
        }
      }
      setCloudDevices(devices);

      const aggregated: any = { instruments: {} };
      for (const device of devices) {
        if (device.schema && device.schema.instruments) {
          for (const [inst, methods] of Object.entries(device.schema.instruments)) {
            if (!aggregated.instruments[inst]) {
              aggregated.instruments[inst] = methods;
            } else {
              Object.assign(aggregated.instruments[inst], methods);
            }
          }
        }
      }
      setStatusData({ instruments: aggregated.instruments });
      setIsOffline(false);
    } catch (e) {
      console.error("Cloud orchestrator offline or unavailable", e);
      setIsOffline(true);
    }
  };

  useEffect(() => {
    fetchCloudDevices();
    const interval = setInterval(fetchCloudDevices, 3000);
    return () => clearInterval(interval);
  }, []);

  // One-shot refresh on load — a node's taskStatus is saved into localStorage as part of its
  // data blob, so reopening this page (or reloading mid-run) shows whatever status was last
  // polled before the tab closed, even if the run actually finished in the meantime. activeRunId
  // itself isn't persisted, so the interval-based polling below never resumes for it either. This
  // fetches the real current status once, for every node on the canvas, regardless of activeRunId.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/cloud-workflows/status');
        const tasks = await res.json();
        setNodes(nds => nds.map(n => {
          const fresh = tasks.find((t: any) => t.nodeId === n.id);
          if (fresh && JSON.stringify(fresh) !== JSON.stringify((n.data as any).taskStatus)) {
            return { ...n, data: { ...n.data, taskStatus: fresh } };
          }
          return n;
        }));
      } catch (e) {}
    })();
  }, []);

  useEffect(() => {
    if (!activeRunId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/cloud-workflows/status');
        const tasks = await res.json();
        const currentRunTasks = tasks.filter((t: any) => t.runId === activeRunId);
        setTaskStatuses(currentRunTasks);
        
        // Stop executing/polling if all tasks in the UI are completed or error
        if (currentRunTasks.length > 0 && currentRunTasks.every((t: any) => t.status === 'completed' || t.status === 'error' || t.status === 'cancelled')) {
           setActiveRunId(null);
        }
      } catch (e) {}
    }, 1000);
    return () => clearInterval(interval);
  }, [activeRunId]);

  useEffect(() => {
    setNodes(nds => nds.map(n => {
      if (n.type === 'customCloudNode') {
        const taskStatus = taskStatuses.find(t => t.nodeId === n.id);
        if (taskStatus) {
            return { ...n, data: { ...n.data, taskStatus } };
        }
      }
      return n;
    }));
  }, [taskStatuses, setNodes]);

  const clearCanvas = () => {
    if (confirm("Are you sure you want to clear the cloud canvas?")) {
        setNodes([{
            id: 'start_node',
            type: 'customCloudNode',
            position: { x: 250, y: 100 },
            data: { 
                targetDeviceId: "",
                block: {
                    id: 'start_block',
                    instrument: 'Flow Control',
                    method: 'Start',
                    schema: { parameters: {} },
                    params: {}
                }
            }
        }]);
        setEdges([]);
        setCurrentWorkflowName("");
        setCurrentWorkflowDescription("");
    }
  };

  const exportJSON = () => {
    const payload = {
      name: currentWorkflowName || 'Distributed Run',
      description: currentWorkflowDescription,
      nodes,
      edges
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${payload.name.replace(/ /g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveToLibrary = () => {
    if (!currentWorkflowName) {
      alert("Please enter a workflow name before saving.");
      return;
    }
    const saved = localStorage.getItem('cloud_saved_workflows');
    const library = saved ? JSON.parse(saved) : [];
    
    const existingIndex = library.findIndex((w: any) => w.name === currentWorkflowName);
    const newWf = {
      name: currentWorkflowName,
      description: currentWorkflowDescription,
      nodes,
      edges,
      updated_at: Date.now(),
      created_at: existingIndex >= 0 ? library[existingIndex].created_at : Date.now()
    };
    
    if (existingIndex >= 0) {
      library[existingIndex] = newWf;
    } else {
      library.push(newWf);
    }
    
    localStorage.setItem('cloud_saved_workflows', JSON.stringify(library));
    alert(`Workflow '${currentWorkflowName}' saved to Cloud Library!`);
  };

  const runDistributedWorkflow = async () => {
    if (nodes.length === 0) return;

    const unassignedNodes = nodes.filter(n => !n.data.targetDeviceId && (n.data as any).block?.instrument !== 'Flow Control');
    if (unassignedNodes.length > 0) {
      alert("Please assign a target device for all instrument nodes.");
      return;
    }

    setIsExecuting(true);
    try {
      const payload = {
        name: currentWorkflowName || 'Distributed Run',
        nodes,
        edges
      };

      const res = await fetch(`/api/cloud-workflows/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      
      if (res.ok) {
         setActiveRunId(data.runId);
         alert(`Distributed workflow started with ID: ${data.runId}`);
      } else {
         throw new Error(data.error || 'Failed to dispatch workflow');
      }
    } catch (e: any) {
      alert(`Error starting execution: ${e.message}`);
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="flex h-full w-full">
      <div className="flex-1 flex flex-col h-full w-full overflow-hidden relative">
        <CloudWorkflowEditor
          cloudDevices={cloudDevices}
          statusData={statusData}
          nodes={nodes}
          setNodes={setNodes}
          edges={edges}
          setEdges={setEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          header={
            <header className="glass-header flex items-center justify-between px-6 z-10 shrink-0">
              <div className="flex items-center space-x-4">
                <div className="flex items-center justify-center p-2 rounded-lg" style={{ background: 'rgba(59, 130, 246, 0.2)' }}>
                  <Cloud className="w-6 h-6 text-blue-400" />
                </div>
                
                <div className="flex flex-col justify-center">
                  <input
                    type="text"
                    value={currentWorkflowName}
                    onChange={(e) => setCurrentWorkflowName(e.target.value)}
                    placeholder="Workflow Name"
                    className="input-ghost"
                    style={{ minWidth: '300px' }}
                  />
                  <input
                    type="text"
                    value={currentWorkflowDescription}
                    onChange={(e) => setCurrentWorkflowDescription(e.target.value)}
                    placeholder="Add a short description..."
                    className="input-ghost"
                    style={{ minWidth: '300px', fontSize: '0.75rem', opacity: 0.7 }}
                  />
                </div>
                <span className="badge badge-online space-x-1">
                  <span>{cloudDevices.length} Edge{cloudDevices.length !== 1 ? 's' : ''} Online</span>
                </span>
                {isOffline && (
                  <span className="badge badge-warning space-x-1">
                    <AlertTriangle className="w-3 h-3" />
                    <span>Schema Engine Offline</span>
                  </span>
                )}
              </div>
              <div className="flex items-center space-x-3">
                <button 
                  onClick={saveToLibrary}
                  className="btn-primary flex items-center space-x-2 px-4 py-2 rounded font-medium"
                >
                  <Save className="w-4 h-4" />
                  <span>Save</span>
                </button>

                <button 
                  onClick={exportJSON}
                  className="btn-primary flex items-center space-x-2 px-4 py-2 rounded font-medium"
                >
                  <Download className="w-4 h-4" />
                  <span>Export</span>
                </button>

                <button 
                  onClick={clearCanvas}
                  className="btn-danger flex items-center space-x-2 px-4 py-2 rounded font-medium"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Clear</span>
                </button>
                
                <button 
                  onClick={runDistributedWorkflow}
                  disabled={nodes.length === 0}
                  className="btn-primary flex items-center space-x-2 px-6 py-2 rounded font-bold"
                >
                  {activeRunId ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  <span>{activeRunId ? 'Running...' : 'Run Distributed'}</span>
                </button>
              </div>
            </header>
          }
        />
      </div>
    </div>
  );
}
