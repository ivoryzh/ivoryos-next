// Create a persistent global store to survive Next.js dev reloads
declare global {
  var _orchestratorStore: any;
}

if (!global._orchestratorStore) {
  global._orchestratorStore = {
    devices: new Map<string, any>(),
    runs: new Map<string, any>(),
    pendingTasks: new Map<string, any[]>(),
  };
}

const store = global._orchestratorStore;

export const registerDevice = (deviceId: string, schema: any) => {
  store.devices.set(deviceId, {
    id: deviceId,
    status: 'online',
    lastSeen: Date.now(),
    schema
  });
  if (!store.pendingTasks.has(deviceId)) {
    store.pendingTasks.set(deviceId, []);
  }
};

export const getDevices = () => {
  const now = Date.now();
  const onlineDevices: any[] = [];
  store.devices.forEach((device: any, id: string) => {
    // Timeout devices that haven't heartbeat in 10 seconds
    if (now - device.lastSeen > 10000) {
      device.status = 'offline';
    } else {
      device.status = 'online';
      onlineDevices.push(device);
    }
  });
  return onlineDevices;
};

export const getAggregatedSchema = () => {
  const aggregated: any = { instruments: {} };
  const online = getDevices();
  for (const device of online) {
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
  return aggregated;
};

export const startRun = (runId: string, name: string, nodes: any[], edges: any[]) => {
  const nodesMap = new Map();
  nodes.forEach(n => nodesMap.set(n.id, { ...n, status: 'pending' }));
  
  const incomingEdges = new Map();
  const outgoingEdges = new Map();
  
  edges.forEach(e => {
    if (!incomingEdges.has(e.target)) incomingEdges.set(e.target, []);
    incomingEdges.get(e.target).push(e.source);
    
    if (!outgoingEdges.has(e.source)) outgoingEdges.set(e.source, []);
    outgoingEdges.get(e.source).push(e.target);
  });
  
  store.runs.set(runId, {
    id: runId,
    name,
    nodes: nodesMap,
    incomingEdges,
    outgoingEdges,
    status: 'running',
    startTime: Date.now()
  });
  
  checkReadyNodes(runId);
  return runId;
};

export const checkReadyNodes = (runId: string) => {
  const run = store.runs.get(runId);
  if (!run || run.status !== 'running') return;
  
  let allDone = true;
  let dispatchedAny = false;
  
  console.log(`[Orchestrator] checkReadyNodes for run ${runId}, total nodes: ${run.nodes.size}`);
  run.nodes.forEach((node: any, nodeId: string) => {
    if (node.status === 'pending') {
      allDone = false;
      const deps = run.incomingEdges.get(nodeId) || [];
      const allDepsCompleted = deps.every((depId: string) => {
        const depNode = run.nodes.get(depId);
        return depNode && depNode.status === 'completed';
      });
      
      console.log(`[Orchestrator] Node ${nodeId} deps: ${deps.length}, allCompleted: ${allDepsCompleted}`);
      
      if (allDepsCompleted) {
        if (node.data?.block?.instrument === 'Flow Control') {
          console.log(`[Orchestrator] Node ${nodeId} is Flow Control. Marking completed.`);
          node.status = 'completed';
          dispatchedAny = true;
          // Recurse to immediately evaluate its children
          setTimeout(() => checkReadyNodes(runId), 0);
        } else {
          // Dispatch node to the target device's queue
          node.status = 'queued';
          const targetDeviceId = node.data?.targetDeviceId;
          if (targetDeviceId) {
            if (!store.pendingTasks.has(targetDeviceId)) {
              store.pendingTasks.set(targetDeviceId, []);
            }
            console.log(`[Orchestrator] Dispatching node ${nodeId} to device ${targetDeviceId}`);
            store.pendingTasks.get(targetDeviceId).push({
              runId,
              nodeId,
              block: node.data.block
            });
            dispatchedAny = true;
          } else {
            console.error(`[Orchestrator] ERROR: Node ${nodeId} has no targetDeviceId! node.data: ${JSON.stringify(node.data)}`);
            node.status = 'error';
          }
        }
      }
    } else if (node.status === 'queued' || node.status === 'running') {
      allDone = false;
    }
  });
  
  if (allDone && !dispatchedAny) {
    run.status = 'completed';
    console.log(`[Orchestrator] Run ${runId} completed.`);
  }
};

export const getPendingTasks = (deviceId: string) => {
  const tasks = store.pendingTasks.get(deviceId) || [];
  if (tasks.length > 0) {
      console.log(`[Orchestrator] getPendingTasks for ${deviceId} returning ${tasks.length} tasks`);
  }
  store.pendingTasks.set(deviceId, []); // clear after fetching
  
  // Mark them as running
  tasks.forEach((t: any) => {
    const run = store.runs.get(t.runId);
    if (run && run.nodes.has(t.nodeId)) {
      run.nodes.get(t.nodeId).status = 'running';
    }
  });
  return tasks;
};

export const completeNode = (runId: string, nodeId: string, status: string) => {
  const run = store.runs.get(runId);
  if (!run) return;
  
  const node = run.nodes.get(nodeId);
  if (node) {
    node.status = status;
    console.log(`Node ${nodeId} marked as ${status}`);
    if (status === 'completed') {
      checkReadyNodes(runId);
    } else {
      run.status = 'error';
      console.log(`Run ${runId} errored due to node ${nodeId}`);
    }
  }
};
