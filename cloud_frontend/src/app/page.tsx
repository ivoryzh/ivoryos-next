"use client";

import { useState, useEffect, useCallback } from 'react';
import { Play, AlertTriangle, RefreshCw, Download, Save, FilePlus2 } from 'lucide-react';
import { useNodesState, useEdgesState, addEdge, Connection, Edge, Node } from '@xyflow/react';
import CloudWorkflowEditor from '@/components/CloudWorkflowEditor';
import { LIBRARY_INSTRUMENT, scanDynamicParams } from '@ivoryos/shared-ui';
import { validateGraph } from '@/lib/dag';

// A param written "#name" is a placeholder filled in at run time — the same convention the edge
// Designer uses (scanDynamicParams). Parallel branches on this canvas are usually one protocol
// repeated over different inputs, so those values belong to the run rather than baked into the
// graph, and the same graph can be re-run with different ones.
const DYNAMIC_PREFIX = '#';
const isDynamic = (v: unknown) => typeof v === 'string' && v.trim().startsWith(DYNAMIC_PREFIX);

/** Every distinct #name on the canvas, with the nodes referencing it. */
function collectDynamicParams(nodes: any[]): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const n of nodes) {
    const params = n?.data?.block?.params || {};
    for (const v of Object.values(params)) {
      if (!isDynamic(v)) continue;
      const name = String(v).trim().slice(1);
      if (!name) continue; // a bare '#' is reported separately
      if (!found[name]) found[name] = [];
      if (!found[name].includes(n.id)) found[name].push(n.id);
    }
  }
  return found;
}

const hasBareHash = (nodes: any[]) => nodes.some(n =>
  Object.values(n?.data?.block?.params || {})
    .some(v => typeof v === 'string' && v.trim() === DYNAMIC_PREFIX));

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
  
  const [isExecuting, setIsExecuting] = useState(false);
  const [health, setHealth] = useState<any>(null);
  // Values typed for each #name before a run. Kept out of the graph so the canvas stays reusable.
  const [dynamicValues, setDynamicValues] = useState<Record<string, string>>({});

  // Polled alongside the device list. "0 Edges Online" used to be the only signal, and it looked
  // identical whether the backend was down or the lab was simply idle — this is what separates
  // those. Deliberately tolerant of its own failure: if /api/health itself can't be reached, the
  // badge says so rather than silently keeping a stale green state.
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/health');
        setHealth(await res.json());
      } catch {
        setHealth({ ok: false, problems: ['Cannot reach the Cloud app itself.'], devices: { total: 0, online: 0 } });
      }
    };
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, []);

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
      // uses. Surfacing these as the synthetic instrument's `parameters` is what makes
      // CustomCloudNode render them as editable fields — it already does that generically for any
      // block.schema.parameters, sequences included. `scanDynamicParams` is the shared
      // implementation, so this and the Designer can't drift apart about what counts as a
      // placeholder (AGENTS.md section 3).
      const sequencesByDevice: Record<string, any> = {};
      for (const s of (Array.isArray(sequences) ? sequences : [])) {
        if (!sequencesByDevice[s.device_id]) sequencesByDevice[s.device_id] = {};
        sequencesByDevice[s.device_id][s.name] = {
          description: s.description || '',
          parameters: scanDynamicParams(s.body),
          return_type: 'None',
          // Carried onto the node's `ref` when one is dragged out, so a distributed run pins the
          // body it was built against instead of resolving the bare name against whatever the
          // target device's library happens to hold when the task finally lands there.
          version: s.body?.version,
          body_hash: s.body?.body_hash,
        };
      }
      for (const device of devices) {
        if (sequencesByDevice[device.id]) {
          if (!device.schema) device.schema = { instruments: {} };
          if (!device.schema.instruments) device.schema.instruments = {};
          device.schema.instruments[LIBRARY_INSTRUMENT] = sequencesByDevice[device.id];
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
    } catch (e) {
      console.error("Cloud orchestrator offline or unavailable", e);
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

  // Mirrors the Designer's startNewWorkflow: "Clear" with a trash icon read as destroying
  // something, when the behaviour is really "empty canvas, start the next one". Only asks when
  // there is something to lose — a canvas holding just the seeded Start node is already empty.
  const startNewWorkflow = () => {
    const hasContent = nodes.some(n => n.id !== 'start_node') || edges.length > 0;
    if (hasContent && !confirm("This clears the canvas and starts an untitled workflow.")) return;
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

    // Same check the run route applies, run here only so the answer is immediate and names every
    // problem at once. The server repeats it and is the real gate — this canvas is not the only
    // way a graph reaches that route (Library, localStorage, a direct POST), so a client-side
    // check alone would enforce nothing.
    const problems = validateGraph(nodes, edges);
    if (problems.length > 0) {
      alert(problems.map(p => p.message).join('\n\n'));
      return;
    }

    if (hasBareHash(nodes)) {
      alert("'#' needs a variable name after it (e.g. '#temperature').");
      return;
    }

    // Running with placeholders unfilled would dispatch the literal string "#temperature" to an
    // instrument, which is not a value. Blocked rather than attempted — the same gate the
    // Designer applies before its Configure step.
    const missing = Object.keys(collectDynamicParams(nodes))
      .filter(k => !String(dynamicValues[k] ?? '').trim());
    if (missing.length > 0) {
      // The per-node Configure panel that supplies these (a spreadsheet of rows, or a Bayesian
      // parameter space handed to the edge's own optimizer) is not built yet, so say that rather
      // than asking for input with nowhere to type it.
      alert(
        `This workflow has unfilled placeholders: ${missing.map(m => '#' + m).join(', ')}.\n\n`
        + 'Per-node configuration is not built yet. Replace them with literal values to run it for now.',
      );
      return;
    }

    setIsExecuting(true);
    try {
      // Substituted into the dispatched copy only — the canvas keeps its #placeholders, which is
      // what makes the same graph re-runnable over a different set of inputs.
      const resolvedNodes = nodes.map(n => {
        const block = (n.data as any)?.block;
        const params = block?.params || {};
        const next: Record<string, any> = {};
        let changed = false;
        for (const [k, v] of Object.entries(params)) {
          if (isDynamic(v)) {
            const key = String(v).trim().slice(1);
            if (dynamicValues[key] !== undefined) { next[k] = dynamicValues[key]; changed = true; continue; }
          }
          next[k] = v;
        }
        return changed ? { ...n, data: { ...n.data, block: { ...block, params: next } } } : n;
      });

      const payload = {
        name: currentWorkflowName || 'Distributed Run',
        nodes: resolvedNodes,
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
          health={health}
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
                  onClick={startNewWorkflow}
                  title="Start a new, empty workflow"
                  className="btn-primary flex items-center space-x-2 px-4 py-2 rounded font-medium"
                >
                  <FilePlus2 className="w-4 h-4" />
                  <span>New</span>
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
