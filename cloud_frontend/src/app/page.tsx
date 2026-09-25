"use client";

import { useState, useEffect, useCallback } from 'react';
import { Play, RefreshCw, Download, Save, FilePlus2 } from 'lucide-react';
import { useNodesState, useEdgesState, addEdge, Connection, Edge, Node } from '@xyflow/react';
import CloudWorkflowEditor from '@/components/CloudWorkflowEditor';
import {
  LIBRARY_INSTRUMENT,
  scanDynamicParams,
  scanReturnVars,
  emptyOptimizeConfig,
  type OptimizeConfig,
  type SpreadsheetRow,
  WorkflowPeek,
} from '@ivoryos/shared-ui';
import { validateGraph, isDynamicValue, effectiveParamValue, blankParamsOf } from '@/lib/dag';
import { runConfigOf, runModeOf, type NodeCadence, type RunMode } from '@/lib/runPayload';
import RunConfigPanel, { ConfigurableNode } from '@/components/RunConfigPanel';
import ScheduleDialog from '@/components/ScheduleDialog';

// A param written "#name" is a placeholder filled in at run time — the same convention the edge
// Designer uses (scanDynamicParams). Parallel branches on this canvas are usually one protocol
// repeated over different inputs, so those values belong to the run rather than baked into the
// graph, and the same graph can be re-run with different ones.
const DYNAMIC_PREFIX = '#';

/**
 * The distinct #names ONE node references, in the order its params declare them.
 *
 * Deliberately per node rather than per canvas. Two steps both written `#temperature` are two
 * screens of the same protocol, and running the same sequence twice at two temperatures is the
 * reason to put it on the canvas twice. Collecting these globally by name — which is what the
 * first pass did — quietly forces the two to be equal, with nothing on the graph to show for it.
 */
function dynamicVarsOf(node: any): string[] {
  const block = node?.data?.block || {};
  const found: string[] = [];
  for (const key of Object.keys(block.schema?.parameters || {})) {
    const value = effectiveParamValue(block, key);
    if (!isDynamicValue(value)) continue;
    const name = String(value).trim().slice(1);
    if (!name) continue; // a bare '#' names nothing and is reported separately
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** Values supplied for this node's #names. Lives on the node, so Save/Export/Load carry it. */
const configOf = (node: any): Record<string, string> => (node?.data?.config || {});

const hasBareHash = (nodes: any[]) => nodes.some((n) => {
  const block = n?.data?.block || {};
  return Object.keys(block.schema?.parameters || {})
    .some(k => String(effectiveParamValue(block, k) ?? '').trim() === DYNAMIC_PREFIX);
});

export default function CloudDesignerPage() {
  const [statusData, setStatusData] = useState<any>({ instruments: {} });
  const [cloudDevices, setCloudDevices] = useState<any[]>([]);
  
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [currentWorkflowName, setCurrentWorkflowName] = useState<string>('');
  const [currentWorkflowDescription, setCurrentWorkflowDescription] = useState<string>('');

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [taskStatuses, setTaskStatuses] = useState<any[]>([]);
  // Blank means "number it after the canvas's name" (the run route does that).
  const [experimentName, setExperimentName] = useState('');

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
  // Open when a run needs #placeholder values supplied. Per-node values themselves live on the
  // nodes (`data.config`), so they are saved, exported and reloaded with the workflow rather than
  // retyped every session.
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  // Return variables each saved sequence produces, per device — the candidate objectives for a
  // node configured to optimize. Read from the body Cloud already mirrors, so no extra round trip.
  const [sequenceReturns, setSequenceReturns] = useState<Record<string, Record<string, string[]>>>({});
  // Each device's published workflow bodies (their latest version), for the step preview.
  const [sequenceBodies, setSequenceBodies] = useState<Record<string, any>>({});
  const [peekNodeId, setPeekNodeId] = useState<string | null>(null);
  // Nodes the last run attempt rejected, so the canvas can point at them instead of leaving a
  // list of ids in an alert for someone to match up by eye.
  const [invalidNodeIds, setInvalidNodeIds] = useState<string[]>([]);

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
      // A saved sequence's outputs are the objectives a node running it can optimise against.
      // Collected here because this is the one place the bodies are already in hand.
      const returnsByDevice: Record<string, Record<string, string[]>> = {};
      for (const s of (Array.isArray(sequences) ? sequences : [])) {
        if (!sequencesByDevice[s.device_id]) sequencesByDevice[s.device_id] = {};
        if (!returnsByDevice[s.device_id]) returnsByDevice[s.device_id] = {};
        returnsByDevice[s.device_id][s.name] = scanReturnVars(s.body);
        sequencesByDevice[s.device_id][s.name] = {
          description: s.description || '',
          parameters: scanDynamicParams(s.body),
          return_type: 'None',
          // What running it saves, shown on the node so a graph reads as data flowing through it.
          outputs: returnsByDevice[s.device_id][s.name],
          // Carried onto the node's `ref` when one is dragged out, so a distributed run pins the
          // body it was built against instead of resolving the bare name against whatever the
          // target device's library happens to hold when the task finally lands there.
          version: s.body?.version,
          body_hash: s.body?.body_hash,
          // Typical duration from the device's own completed runs of it (edge runtime.py).
          runtime: s.body?.runtime || null,
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
      setSequenceReturns(returnsByDevice);
      setSequenceBodies(Object.fromEntries(
        (Array.isArray(sequences) ? sequences : []).map((s: any) => [`${s.device_id}/${s.name}`, s.body]),
      ));

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
      name: currentWorkflowName || 'Experiment',
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

  /** Optimizer backends the node's target device reported in its published schema. */
  const optimizerCatalogFor = (deviceId: string): Record<string, any> =>
    cloudDevices.find(d => String(d.id) === String(deviceId))?.schema?.optimizers || {};

  /**
   * Output variables this node can be optimized against: the saved sequence's own return
   * variables for a Library Workflows node, or the step's own for a plain instrument call.
   */
  const objectiveOptionsFor = (node: any): string[] => {
    const block = (node.data as any)?.block || {};
    const deviceId = String((node.data as any)?.targetDeviceId || '');
    if (block.instrument === LIBRARY_INSTRUMENT) {
      return sequenceReturns[deviceId]?.[String(block.method)] || [];
    }
    return String(block.returnVar || '').split(',').map((n: string) => n.trim()).filter(Boolean);
  };

  /** Declared type per #name, so the panel can warn about a non-numeric value before dispatch. */
  const varTypesFor = (node: any): Record<string, string> => {
    const block = (node.data as any)?.block || {};
    const types: Record<string, string> = {};
    for (const [key, declared] of Object.entries<any>(block.schema?.parameters || {})) {
      const value = effectiveParamValue(block, key);
      if (!isDynamicValue(value)) continue;
      const name = String(value).trim().slice(1);
      if (name && declared?.type) types[name] = String(declared.type);
    }
    return types;
  };

  /** Panel rows: every node with #names, filled or not, so a configured one can be reviewed. */
  // Every step, not only those with #values: a step with none can still be repeated, and the
  // panel is also where the experiment is named.
  const configurableNodes = (): ConfigurableNode[] => nodes
    .filter(n => !['Flow Control', 'Flow_Control'].includes(String((n.data as any)?.block?.instrument || '')))
    .map((n) => {
      const block = (n.data as any)?.block || {};
      const runConfig = runConfigOf(n);
      const deviceId = String((n.data as any)?.targetDeviceId || '');
      return {
        id: String(n.id),
        label: block.instrument === LIBRARY_INSTRUMENT
          ? String(block.method || n.id)
          : `${block.instrument} · ${String(block.method || '').replace(/_/g, ' ')}`,
        deviceId,
        vars: dynamicVarsOf(n),
        varTypes: varTypesFor(n),
        mode: runModeOf(n),
        values: configOf(n),
        // At least one row always exists so the table has somewhere to type.
        rows: runConfig.spreadsheet?.rows?.length ? runConfig.spreadsheet.rows : [{}],
        batchSize: runConfig.spreadsheet?.batchSize ?? '',
        isWorkflow: block.instrument === LIBRARY_INSTRUMENT,
        optimization: runConfig.optimization || { ...emptyOptimizeConfig(), objectives_order: [] },
        optimizerCatalog: optimizerCatalogFor(deviceId),
        objectiveOptions: objectiveOptionsFor(n),
        runtime: block.instrument === LIBRARY_INSTRUMENT
          ? cloudDevices.find(d => String(d.id) === deviceId)?.schema?.instruments?.[LIBRARY_INSTRUMENT]?.[String(block.method)]?.runtime || null
          : null,
        schedule: runConfig.schedule || {},
      };
    });

  /** Patch one node's `data.runConfig`. Lives on the node, so Save/Export/Load carry it. */
  const patchRunConfig = (nodeId: string, patch: Record<string, any>) => {
    setNodes(nds => nds.map(n => (String(n.id) !== nodeId ? n : {
      ...n,
      data: { ...n.data, runConfig: { ...runConfigOf(n), ...patch } },
    })));
  };

  const setNodeMode = (nodeId: string, mode: RunMode) => patchRunConfig(nodeId, { mode });

  // Merged, not replaced: rows and batch size both live under `spreadsheet`.
  const spreadsheetOf = (nodeId: string) =>
    runConfigOf(nodes.find(n => String(n.id) === nodeId)).spreadsheet || {};
  const setNodeRows = (nodeId: string, rows: SpreadsheetRow[]) =>
    patchRunConfig(nodeId, { spreadsheet: { ...spreadsheetOf(nodeId), rows } });
  const setNodeBatchSize = (nodeId: string, batchSize: string) =>
    patchRunConfig(nodeId, { spreadsheet: { ...spreadsheetOf(nodeId), batchSize } });

  const setNodeOptimization = (nodeId: string, optimization: OptimizeConfig & { objectives_order?: string[] }) =>
    patchRunConfig(nodeId, { optimization });

  const setNodeSchedule = (nodeId: string, schedule: NodeCadence) =>
    patchRunConfig(nodeId, { schedule });

  const setNodeConfigValue = (nodeId: string, varName: string, value: string) => {
    setNodes(nds => nds.map(n => (String(n.id) !== nodeId ? n : {
      ...n,
      data: { ...n.data, config: { ...configOf(n), [varName]: value } },
    })));
  };

  const copyNodeConfig = (fromNodeId: string, toNodeId: string) => {
    const source = nodes.find(n => String(n.id) === fromNodeId);
    if (!source) return;
    // Copied by value, not linked. Two steps that happen to start identical are still two steps,
    // and editing one afterwards must not silently move the other.
    const copied = { ...configOf(source) };
    setNodes(nds => nds.map(n => (String(n.id) !== toNodeId ? n : {
      ...n,
      data: { ...n.data, config: { ...configOf(n), ...copied } },
    })));
  };

  /**
   * Gate a run. Structure first, then the two parameter problems, which are deliberately handled
   * differently: an empty box is an incomplete *step* and is fixed on the node, while a #name is a
   * complete step whose value belongs to the *run* and is collected in the panel.
   */
  const runDistributedWorkflow = async () => {
    if (nodes.length === 0) return;

    // Same check the run route applies, run here only so the answer is immediate and names every
    // problem at once. The server repeats it and is the real gate — this canvas is not the only
    // way a graph reaches that route (Library, localStorage, a direct POST), so a client-side
    // check alone would enforce nothing.
    const problems = validateGraph(nodes, edges);
    if (problems.length > 0) {
      // Point at the offending nodes on the canvas as well as naming them, so a large graph does
      // not turn a list of ids into a search.
      setInvalidNodeIds(nodes.filter(n => blankParamsOf(n).length > 0).map(n => String(n.id)));
      alert(problems.map(p => p.message).join('\n\n'));
      return;
    }
    setInvalidNodeIds([]);

    if (hasBareHash(nodes)) {
      alert("'#' needs a variable name after it (e.g. '#temperature').");
      return;
    }

    // Any node with #names opens the panel, filled in or not. The panel is where a step is set
    // to run once, per spreadsheet row, or as an optimization, and where a run is scheduled, so
    // it is the last stop before dispatch rather than something only a missing value reaches.
    // (There used to be a separate Configure button for the filled-in case; two buttons that
    // both opened this panel read as two ways of doing the same thing.) The panel's own Run
    // button refuses while a node is still incomplete.
    if (configurableNodes().length > 0) {
      setShowConfigPanel(true);
      return;
    }

    await dispatchRun();
  };

  const dispatchRun = async () => {
    setShowConfigPanel(false);
    setIsExecuting(true);
    try {
      // The canvas keeps its `#placeholders` and sends them as authored — substituting them into
      // the dispatched copy is the run route's job now (see src/lib/planTasks.ts). It has to be:
      // a spreadsheet node resolves one value per row and an optimization node one per trial, so
      // "the resolved copy" is no longer a single thing this page could build. Keeping the graph
      // unsubstituted is also what makes it re-runnable over a different set of inputs.
      const res = await fetch(`/api/cloud-workflows/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Typed, or numbered after the canvas's name by the route ("Screen #3").
          name: experimentName.trim() || undefined,
          base: currentWorkflowName || 'Experiment',
          nodes,
          edges,
        }),
      });
      const data = await res.json();

      if (res.ok) {
         setActiveRunId(data.runId);
      } else {
         throw new Error(data.error || 'Failed to dispatch workflow');
      }
    } catch (e: any) {
      alert(`Error starting execution: ${e.message}`);
    } finally {
      setIsExecuting(false);
    }
  };

  /** Turn the configured graph into a recurring trigger instead of running it now. */
  const createSchedule = async (spec: { name: string; everyMinutes: number; maxRuns: number; startAt?: string }) => {
    const res = await fetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...spec, nodes, edges }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create the schedule.');
    setShowScheduleDialog(false);
    setShowConfigPanel(false);
    return data;
  };

  return (
    <div className="flex h-full w-full">
      <div className="flex-1 flex flex-col h-full w-full overflow-hidden relative">
        <CloudWorkflowEditor
          cloudDevices={cloudDevices}
          statusData={statusData}
          health={health}
          invalidNodeIds={invalidNodeIds}
          nodes={nodes}
          setNodes={setNodes}
          edges={edges}
          setEdges={setEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(node) => {
            if ((node.data as any)?.block?.instrument === LIBRARY_INSTRUMENT) setPeekNodeId(String(node.id));
          }}
          header={
            <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-10 relative">
              {/* Same layout and button vocabulary as the edge Designer's header, so moving
                  between the two does not mean relearning which button is which. */}
              <div className="flex flex-col justify-center flex-1 mr-4 space-y-1 min-w-0">
                <input
                  type="text"
                  value={currentWorkflowName}
                  onChange={(e) => setCurrentWorkflowName(e.target.value)}
                  placeholder="Workflow Name"
                  className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300 bg-transparent border-none focus:outline-none focus:ring-0 p-0"
                />
                <input
                  type="text"
                  value={currentWorkflowDescription}
                  onChange={(e) => setCurrentWorkflowDescription(e.target.value)}
                  placeholder="Add a short description..."
                  className="text-xs text-gray-400 dark:text-gray-500 bg-transparent border-none focus:outline-none focus:ring-0 p-0 w-full"
                />
              </div>
              <div className="flex items-center space-x-2 shrink-0">
                <button
                  onClick={startNewWorkflow}
                  title="Start a new, empty workflow"
                  className="flex items-center space-x-1 px-3 py-1.5 rounded text-sm font-medium transition-all bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10"
                >
                  <FilePlus2 className="w-4 h-4 text-gray-400" />
                  <span className="hidden sm:inline">New</span>
                </button>

                <button
                  onClick={saveToLibrary}
                  disabled={nodes.length === 0}
                  title="Save this workflow to the Cloud library"
                  className="flex items-center space-x-1 px-3 py-1.5 rounded text-sm font-medium transition-all bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Save className="w-4 h-4" />
                  <span className="hidden sm:inline">Save</span>
                </button>

                <button
                  onClick={exportJSON}
                  title="Download this workflow as JSON"
                  className="flex items-center space-x-1 px-3 py-1.5 rounded text-sm font-medium transition-all bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10"
                >
                  <Download className="w-4 h-4 text-gray-400" />
                  <span className="hidden sm:inline">Export</span>
                </button>

                <button
                  onClick={runDistributedWorkflow}
                  disabled={nodes.length === 0}
                  title="Dispatch each step to its device"
                  className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 dark:bg-green-900/30 dark:border-green-500/30 dark:text-green-300 dark:hover:bg-green-900/50 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {activeRunId ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  <span>{activeRunId ? 'Running…' : 'Run'}</span>
                </button>
              </div>
            </header>
          }
        />
      </div>
      {showConfigPanel && (
        <RunConfigPanel
          nodes={configurableNodes()}
          onChange={setNodeConfigValue}
          onCopy={copyNodeConfig}
          onModeChange={setNodeMode}
          onRowsChange={setNodeRows}
          onOptimizationChange={setNodeOptimization}
          onScheduleChange={setNodeSchedule}
          onBatchSizeChange={setNodeBatchSize}
          experimentName={experimentName}
          experimentNamePlaceholder={`${currentWorkflowName || 'Experiment'} #…`}
          onExperimentNameChange={setExperimentName}
          onCancel={() => setShowConfigPanel(false)}
          onRun={dispatchRun}
          onSchedule={() => setShowScheduleDialog(true)}
        />
      )}
      {(() => {
        // The steps a workflow node will run, from the body its device published. Cloud has only
        // the latest version's body, so a node still pinned to an older one says so and offers the
        // update rather than showing steps it will not run.
        const node = nodes.find(n => String(n.id) === peekNodeId);
        if (!node) return null;
        const block = (node.data as any).block || {};
        const deviceId = String((node.data as any).targetDeviceId || '');
        const body = sequenceBodies[`${deviceId}/${block.method}`] || null;
        const head = body?.version;
        const ref = block.ref || {};
        const tracksLatest = ref.mode === 'latest' || !ref.version || ref.version === head;
        const values = configOf(node);
        const params = Object.fromEntries(Object.entries(block.params || {}).map(([k, v]: [string, any]) => {
          const name = typeof v === 'string' && v.trim().startsWith('#') ? v.trim().slice(1) : null;
          return [k, name && values[name] ? values[name] : v];
        }));
        return (
          <WorkflowPeek
            target={{ name: String(block.method), version: ref.version, mode: ref.mode === 'latest' ? 'latest' : 'pinned', params }}
            body={tracksLatest ? body : null}
            error={!body
              ? `${deviceId || 'Its device'} has not published this workflow's steps.`
              : !tracksLatest
                ? `This step is pinned to v${ref.version}. Cloud only has the latest version (v${head}), so it cannot show v${ref.version}'s steps. Update to run and see v${head}.`
                : null}
            latestVersion={head}
            note={<>These are the steps of <strong className="font-semibold">{String(block.method)}</strong> as {deviceId || 'its device'} last published it. Edit it on the device; {ref.mode === 'latest' ? 'this step runs the latest saved version.' : `this step runs v${ref.version} until you update it.`}</>}
            onClose={() => setPeekNodeId(null)}
            onUpdate={() => {
              setNodes(nds => nds.map(n => (String(n.id) !== peekNodeId ? n : {
                ...n,
                data: {
                  ...n.data,
                  block: {
                    ...(n.data as any).block,
                    ref: { ...ref, name: block.method, version: head, body_hash: body?.body_hash, mode: 'latest' },
                  },
                },
              })));
            }}
          />
        );
      })()}
      {showScheduleDialog && (
        <ScheduleDialog
          defaultName={experimentName.trim() || currentWorkflowName || 'Experiment'}
          onCancel={() => setShowScheduleDialog(false)}
          onCreate={createSchedule}
        />
      )}
    </div>
  );
}
