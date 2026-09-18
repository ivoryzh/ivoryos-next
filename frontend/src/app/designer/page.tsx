"use client";
import { API_BASE, WS_BASE } from '@/config';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Trash2, Settings2, Sun, Moon, Save, Code, Download, Upload, LayoutTemplate, X, Zap, AlertTriangle, Menu, ListTree, Sparkles } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import AgentPanel from '@/components/AgentPanel';
import AgentTab from '@/components/AgentTab';
import {
  WorkflowEditor,
  SequenceBlock,
  PythonCodeView,
  generatePythonCode,
  buildRunName,
  workflowSignature,
  WorkflowMap,
  buildSavedBody,
  scanDynamicParams,
  toSequenceBlocks,
  chooseDialog,
  confirmDialog,
  notify,
  promptDialog,
} from '@ivoryos/shared-ui';

export default function DesignerPage() {
  const [statusData, setStatusData] = useState<any>(null);
  const [prepSequence, setPrepSequence] = useState<SequenceBlock[]>([]);
  const [sequence, setSequence] = useState<SequenceBlock[]>([]);
  const [cleanupSequence, setCleanupSequence] = useState<SequenceBlock[]>([]);
  const [currentWorkflowName, setCurrentWorkflowName] = useState<string>('');
  const [isUnsaved, setIsUnsaved] = useState(false);
  // Fingerprint of the workflow as it was last saved (or last loaded from the Library). "Unsaved"
  // means the canvas no longer matches it — not merely "an effect has run", which was true on
  // every page load and made the badge (and anything relying on it) meaningless.
  const savedSignature = useRef<string | null>(null);
  // True once the mount effect has read localStorage into state. The persistence effect below
  // must not run before this, or it writes the empty initial state over a workflow that was just
  // loaded. It is state rather than a ref so that it becomes true in the same render as the
  // sequences it guards.
  const [hasLoaded, setHasLoaded] = useState(false);
  const [currentWorkflowDescription, setCurrentWorkflowDescription] = useState<string>('');
  const [executionState, setExecutionState] = useState<{
    isRunning: boolean;
    currentIndex: number;
    results: Record<string, any>;
  }>({
    isRunning: false,
    currentIndex: -1,
    results: {}
  });

  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  // The assistant panel is opt-in and remembered: a lab with no model configured should
  // never see it, and one that uses it every day should not reopen it every visit.
  const [agentOpen, setAgentOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'canvas' | 'code'>('canvas');
  const [hasPendingRuns, setHasPendingRuns] = useState(false);
  const [instrumentMeta, setInstrumentMeta] = useState<Record<string, any>>({});
  const [isOffline, setIsOffline] = useState(false);
  // Latest saved version per workflow name — drives the "vN available" badge on copies and links.
  const [workflowVersions, setWorkflowVersions] = useState<Record<string, number>>({});
  const [isMapOpen, setIsMapOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);

        // Auto-migrate legacy sequence format. Shared with the Cloud sequence editor and the
        // Library page so an imported workflow means the same thing in all three (AGENTS.md #3).
        const migrateBlocks = (blocks: any[]): SequenceBlock[] =>
          toSequenceBlocks(blocks, statusData?.instruments || {});

        let newPrep, newSeq, newClean, name = '';

        if (json.script_dict) {
          // Legacy format detected
          newPrep = migrateBlocks(json.script_dict.prep || []);
          newSeq = migrateBlocks(json.script_dict.script || []);
          newClean = migrateBlocks(json.script_dict.cleanup || []);
          name = json.name || '';
        } else {
          // New format
          newPrep = json.prep || [];
          newSeq = json.sequence || json.script || [];
          newClean = json.cleanup || [];
          name = json.name || '';
        }

        setPrepSequence(newPrep);
        setSequence(newSeq);
        setCleanupSequence(newClean);
        if (name) setCurrentWorkflowName(name);
        if (json.description) setCurrentWorkflowDescription(json.description);

      } catch (error) {
        console.error("Failed to parse JSON file", error);
        notify("That file isn't a workflow this app can read.", { title: 'Import failed', tone: 'error' });
      }

      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    };
    reader.readAsText(file);
  };

  const exportJSON = () => {
    const payload = {
      name: currentWorkflowName,
      description: currentWorkflowDescription,
      prep: prepSequence,
      script: sequence,
      cleanup: cleanupSequence
    };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(payload, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    dlAnchorElem.setAttribute("download", "ivoryos_sequence.json");
    dlAnchorElem.click();
  };

  // Fetch status on mount
  useEffect(() => {
    // Theme init
    const ws = new WebSocket(`${WS_BASE}/api/ws/queue`);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.runs) {
          const hasPending = data.runs.some((r: any) => r.status === 'pending');
          const hasActive = data.runs.some((r: any) => ['running', 'paused', 'cancelling'].includes(r.status));
          setHasPendingRuns(hasPending || hasActive);
        }
      } catch (e) { }
    };

    fetch(`${API_BASE}/api/queue/runs`)
      .then(res => res.json())
      .then(data => {
        if (data.runs) {
          const hasPending = data.runs.some((r: any) => r.status === 'pending');
          const hasActive = data.runs.some((r: any) => ['running', 'paused', 'cancelling'].includes(r.status));
          setHasPendingRuns(hasPending || hasActive);
        }
      });

    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');

    // Load saved sequence if exists
    setAgentOpen(localStorage.getItem('ivoryos_agent_panel') === 'true');
    const savedSeq = localStorage.getItem('ivoryos_sequence');
    if (savedSeq) {
      try {
        setSequence(JSON.parse(savedSeq));
      } catch (e) {
        console.error(e);
      }
    }
    const savedPrepSeq = localStorage.getItem('ivoryos_prep_sequence');
    if (savedPrepSeq) {
      try { setPrepSequence(JSON.parse(savedPrepSeq)); } catch (e) { console.error(e); }
    }
    const savedCleanupSeq = localStorage.getItem('ivoryos_cleanup_sequence');
    if (savedCleanupSeq) {
      try { setCleanupSequence(JSON.parse(savedCleanupSeq)); } catch (e) { console.error(e); }
    }
    const editingWf = localStorage.getItem('ivoryos_editing_workflow');
    if (editingWf) {
      setCurrentWorkflowName(editingWf);
    }
    const editingWfDesc = localStorage.getItem('ivoryos_editing_workflow_desc');
    if (editingWfDesc) {
      setCurrentWorkflowDescription(editingWfDesc);
    }
    // With no stored baseline (a fresh canvas, or one built by importing JSON), the baseline is
    // "empty" — so anything on the canvas correctly counts as not yet saved anywhere.
    savedSignature.current = localStorage.getItem('ivoryos_saved_signature') ?? workflowSignature([], [], [], '', '');
    const unsaved = localStorage.getItem('ivoryos_is_unsaved');
    if (unsaved === 'true') {
      setIsUnsaved(true);
    }
    // Batched with the setSequence calls above, so the persistence effect first sees hasLoaded
    // true in a render where the sequences are already populated.
    setHasLoaded(true);

    const processStatusData = async (data: any) => {
      // Fetch workflows
      try {
        const wfRes = await fetch(`${API_BASE}/api/workflows`);
        const wfData = await wfRes.json();
        if (wfData.workflows && wfData.workflows.length > 0) {

          if (!data.instruments) data.instruments = {};

          // Inject Flow Control
          data.instruments["Flow Control"] = {
            If_Else_Block: { description: "If / Else conditional block", parameters: { condition: { type: "str", required: true } }, return_type: "None" },
            While_Loop: { description: "While loop block", parameters: { condition: { type: "str", required: true } }, return_type: "None" },
            Sleep: { description: "Pause execution for duration (s)", parameters: { duration_seconds: { type: "float", required: true } }, return_type: "None" },
            User_Input: { description: "Pause and ask a person to type in a value (human-in-the-loop)", parameters: { prompt: { type: "str", required: true }, variable_name: { type: "str", required: true }, input_type: { type: "str", required: false, default: "str", options: ["str", "int", "float", "bool"] } }, return_type: "None" },
            Comment: { description: "Add a note to the run log — like Python's print()", parameters: { message: { type: "str", required: true } }, return_type: "None" }
          };

          data.instruments["Library Workflows"] = {};
          const versions: Record<string, number> = {};

          for (const wfObj of wfData.workflows) {
            const wfName = wfObj.name;
            const wfJsonRes = await fetch(`${API_BASE}/api/workflows/${wfName}`);
            const wfJson = await wfJsonRes.json();

            // Tracked for every workflow, including the one being edited — the "vN available"
            // badge on an already-placed copy or link has to work regardless of what the toolbox
            // is currently offering.
            if (wfJson.version) versions[wfName] = wfJson.version;

                // Self-reference is filtered reactively by WorkflowEditor
                // (currentWorkflowName), because this page can switch which workflow
                // it is editing without rebuilding the toolbox.

            data.instruments["Library Workflows"][wfName] = {
              description: wfJson.description || "Saved Workflow from Library",
              parameters: scanDynamicParams(wfJson),
              return_type: "None",
              // The full saved body, so a Copy-mode drag can inline the real steps without a
              // second round trip — and so Detach can turn a link back into an editable copy.
              body: wfJson,
            };
          }
          setWorkflowVersions(versions);
        }
      } catch (e) {
        console.error("Failed to load workflows for toolbox (might be offline)", e);
      }

      setStatusData(data);
      if (data.instrument_meta) setInstrumentMeta(data.instrument_meta);

    };

    fetch(`${API_BASE}/api/status`)
      .then(res => res.json())
      .then(async data => {
        localStorage.setItem('ivoryos_cached_schema', JSON.stringify(data));
        await processStatusData(data);
      })
      .catch(err => {
        console.error("Backend offline, loading cached schema...", err);
        setIsOffline(true);
        const cached = localStorage.getItem('ivoryos_cached_schema');
        if (cached) {
          try {
            const data = JSON.parse(cached);
            processStatusData(data);
          } catch (e) {
            console.error("Failed to parse cached schema", e);
            setStatusData({ instruments: {} });
          }
        } else {
          // No cached schema available
          setStatusData({ instruments: {} });
        }
      });
  }, []);

  // Save sequences on change.
  //
  // Gated on `hasLoaded` — a piece of *state*, not a ref — and on a content comparison. Both are
  // load-bearing, and a mount-counter ref was not enough:
  //
  //  - `hasLoaded` is set by the load effect below in the same batch as its setSequence calls, so
  //    this effect can never observe the empty initial state while localStorage already holds a
  //    workflow. A ref flipped on the first pass still let the second pass (React StrictMode
  //    re-runs mount effects in dev) write the stale empty arrays over what had just been loaded,
  //    which is how "Load to Designer" ended up on an empty canvas.
  //  - The content check keeps a re-run that produces fresh arrays with identical contents from
  //    counting as an edit, which was marking a freshly-opened workflow "Unsaved" untouched.
  useEffect(() => {
    if (!hasLoaded) return;

    const next = {
      ivoryos_sequence: JSON.stringify(sequence),
      ivoryos_prep_sequence: JSON.stringify(prepSequence),
      ivoryos_cleanup_sequence: JSON.stringify(cleanupSequence),
    };
    if (!Object.entries(next).every(([key, value]) => localStorage.getItem(key) === value)) {
      Object.entries(next).forEach(([key, value]) => localStorage.setItem(key, value));
    }

    const signature = workflowSignature(prepSequence, sequence, cleanupSequence, currentWorkflowName, currentWorkflowDescription);
    const dirty = savedSignature.current !== null && signature !== savedSignature.current;
    setIsUnsaved(dirty);
    // The Library reads this before replacing the canvas, so it has to stay in sync here.
    localStorage.setItem('ivoryos_is_unsaved', String(dirty));
  }, [hasLoaded, sequence, prepSequence, cleanupSequence, currentWorkflowName, currentWorkflowDescription]);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const clearCanvas = async () => {
    if (await confirmDialog("Every block on the canvas will be removed. This cannot be undone.", {
      title: 'Clear the canvas?',
      confirmLabel: 'Clear',
      tone: 'danger',
    })) {
      setSequence([]);
      setPrepSequence([]);
      setCleanupSequence([]);
      setCurrentWorkflowName("");
      setCurrentWorkflowDescription("");
      // Written as empty arrays rather than removed, so the persistence effect's content check
      // sees the cleared canvas as already-persisted and doesn't immediately flag it "Unsaved".
      localStorage.setItem('ivoryos_sequence', '[]');
      localStorage.setItem('ivoryos_prep_sequence', '[]');
      localStorage.setItem('ivoryos_cleanup_sequence', '[]');
      localStorage.removeItem('ivoryos_editing_workflow');
      localStorage.removeItem('ivoryos_editing_workflow_desc');
      localStorage.removeItem('ivoryos_is_unsaved');
      localStorage.removeItem('ivoryos_saved_signature');
      savedSignature.current = null;
      setIsUnsaved(false);
    }
  };

  /** Returns true only when the workflow is actually on disk afterwards. */
  const saveWorkflow = async (): Promise<boolean> => {
    let name = currentWorkflowName;
    if (!name) {
      const inputName = await promptDialog("Give this workflow a name so it can be saved to the library.", {
        title: 'Name this workflow',
        placeholder: 'e.g. wash_protocol',
        confirmLabel: 'Save',
      });
      if (!inputName) return false;
      name = inputName;
    }

    // Impact check *before* writing, not after. This is the moment the person still has the
    // context to decide: they came here to edit this protocol and may not know — or may have
    // forgotten — that other workflows link to it and will change with it. Warning them at run
    // time instead would be too late; by then they are committed and will click through.
    // Copies are deliberately absent from this list: an inlined copy holds no reference, so it
    // cannot be affected.
    try {
      const depRes = await fetch(`${API_BASE}/api/workflows/${name}/dependents`);
      if (depRes.ok) {
        const dependents: string[] = (await depRes.json()).dependents || [];
        if (dependents.length > 0) {
          // Three real options rather than a yes/no, because "save it somewhere else instead" is
          // the one most people actually want once they learn what else this would change.
          const choice = await chooseDialog({
            title: `${dependents.length} other workflow${dependents.length === 1 ? '' : 's'} use${dependents.length === 1 ? 's' : ''} "${name}"`,
            message:
              `Saving will change ${dependents.length === 1 ? 'it' : 'them'} too:\n\n`
              + dependents.map(d => `  • ${d}`).join('\n'),
            tone: 'danger',
            actions: [
              { id: 'cancel', label: 'Cancel', kind: 'cancel' },
              { id: 'fork', label: 'Save as new workflow' },
              { id: 'overwrite', label: 'Save anyway', kind: 'danger' },
            ],
          });
          if (choice === null || choice === 'cancel') return false;
          if (choice === 'fork') {
            const forkName = await promptDialog("Save as a new workflow named:", {
              title: 'Save a copy',
              defaultValue: `${name} copy`,
              confirmLabel: 'Save copy',
            });
            if (!forkName) return false;
            name = forkName;
          }
        }
      }
    } catch {
      // A dependents check that can't reach the server must not block saving — the server
      // validates the link graph itself on write regardless.
    }

    const legacyFormat = buildSavedBody(name, currentWorkflowDescription, prepSequence, sequence, cleanupSequence);

    try {
      const post = (force: boolean) => fetch(`${API_BASE}/api/workflows/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(force ? { ...legacyFormat, force: true } : legacyFormat)
      });

      let res = await post(false);
      let data = await res.json();

      // A link-graph rejection is worth stopping for, but not worth throwing the edit away over:
      // writing A before the B it calls exists is a normal order to work in. Say exactly what is
      // wrong, then let the author decide. The run path validates independently, so a workflow
      // saved this way still cannot dispatch anything broken — it just refuses later, by which
      // point the missing piece usually exists.
      if (data.forceable) {
        const isCycle = data.forceable === 'cycle';
        const choice = await chooseDialog({
          title: isCycle ? 'These links form a loop' : 'This links to something missing',
          message: data.error + (isCycle
            ? '\n\nSaving anyway keeps your edit, but this workflow will not be runnable until the loop is broken.'
            : '\n\nSaving anyway keeps your edit. It will not run until that workflow exists.'),
          tone: 'danger',
          actions: [
            { id: 'cancel', label: 'Keep editing', kind: 'cancel' },
            { id: 'force', label: 'Save anyway', kind: 'danger' },
          ],
        });
        if (choice !== 'force') return false;
        res = await post(true);
        data = await res.json();
      }

      if (data.status === 'success') {
        setCurrentWorkflowName(name);
        localStorage.setItem('ivoryos_editing_workflow', name);
        localStorage.setItem('ivoryos_editing_workflow_desc', currentWorkflowDescription);
        const signature = workflowSignature(prepSequence, sequence, cleanupSequence, name, currentWorkflowDescription);
        savedSignature.current = signature;
        localStorage.setItem('ivoryos_saved_signature', signature);
        localStorage.setItem('ivoryos_is_unsaved', 'false');
        setIsUnsaved(false);
        setWorkflowVersions(prev => ({ ...prev, [name]: data.version }));
        await notify(
          data.created_version
            ? `Saved as v${data.version}.`
            : `No changes to save — still v${data.version}.`,
          { title: name },
        );
        return true;
      } else {
        // Anything not offered as forceable: a bad name, or the write itself failing.
        await notify(data.error, { title: 'Could not save', tone: 'error' });
      }
    } catch (e: any) {
      await notify(e.message, { title: 'Could not reach the edge server', tone: 'error' });
    }
    return false;
  };

  /**
   * Open a saved workflow on this canvas — used by the linked-workflow drawer's "Edit in the
   * Designer". Whatever is currently here would be replaced, so unsaved work is dealt with first
   * rather than silently dropped.
   */
  const openWorkflowInDesigner = async (name: string, version?: number) => {
    if (isUnsaved) {
      const choice = await chooseDialog({
        title: 'You have unsaved changes',
        message: `Opening "${name}" replaces what is on this canvas.`,
        tone: 'danger',
        actions: [
          { id: 'cancel', label: 'Cancel', kind: 'cancel' },
          { id: 'discard', label: 'Discard and open', kind: 'danger' },
          { id: 'save', label: 'Save first', kind: 'primary' },
        ],
      });
      if (choice === null || choice === 'cancel') return;
      if (choice === 'save' && !(await saveWorkflow())) return;
    }

    try {
      const url = version
        ? `${API_BASE}/api/workflows/${encodeURIComponent(name)}?version=${version}`
        : `${API_BASE}/api/workflows/${encodeURIComponent(name)}`;
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Workflow could not be read');

      const instruments = statusData?.instruments || {};
      const loaded = {
        prep: toSequenceBlocks(body.prep, instruments),
        script: toSequenceBlocks(body.script, instruments),
        cleanup: toSequenceBlocks(body.cleanup, instruments),
      };

      // Written to localStorage *before* the state updates, so the persistence effect's content
      // check sees the canvas as already-persisted and does not flag a freshly-opened workflow as
      // unsaved the moment it lands.
      localStorage.setItem('ivoryos_sequence', JSON.stringify(loaded.script));
      localStorage.setItem('ivoryos_prep_sequence', JSON.stringify(loaded.prep));
      localStorage.setItem('ivoryos_cleanup_sequence', JSON.stringify(loaded.cleanup));
      localStorage.setItem('ivoryos_editing_workflow', name);
      localStorage.setItem('ivoryos_editing_workflow_desc', body.description || '');

      // Opening an *older* version leaves the canvas deliberately dirty: it does not match what is
      // saved under this name, and saving from here is what would create the next version. Opening
      // the current one is clean.
      const isOlderVersion = !!version && version !== workflowVersions[name];
      localStorage.setItem('ivoryos_is_unsaved', isOlderVersion ? 'true' : 'false');

      setPrepSequence(loaded.prep);
      setSequence(loaded.script);
      setCleanupSequence(loaded.cleanup);
      setCurrentWorkflowName(name);
      setCurrentWorkflowDescription(body.description || '');
      setIsUnsaved(isOlderVersion);
    } catch (e: any) {
      await notify(e.message, { title: `Could not open ${name}`, tone: 'error' });
    }
  };

  // Flattens the current sequence through the *same* server-side expander that dispatch uses, so
  // the preview can never disagree with what actually gets queued.
  const fetchExpansion = useCallback(async () => {
    const body = buildSavedBody(currentWorkflowName, currentWorkflowDescription, prepSequence, sequence, cleanupSequence);
    const res = await fetch(`${API_BASE}/api/workflows/expand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prep: body.prep, sequence: body.script, cleanup: body.cleanup })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not expand this sequence.');
    return data;
  }, [currentWorkflowName, currentWorkflowDescription, prepSequence, sequence, cleanupSequence]);


  // Variable names produced by a 'User_Input' step — these are resolved live on the edge server
  // while the workflow runs, so they shouldn't be treated as parameters the user must pre-fill.
  const getLiveInputVars = (blocks: SequenceBlock[]): Set<string> => {
    const vars = new Set<string>();
    blocks.forEach(b => {
      const isUserInput = (b.instrument === 'Flow_Control' || b.instrument === 'Flow Control') && b.method === 'User_Input';
      if (isUserInput && b.params?.variable_name) {
        vars.add(String(b.params.variable_name).trim());
      }
    });
    return vars;
  };

  // Finds a '#' used as a dynamic parameter with no variable name after it (e.g. '#' instead of '#temperature'),
  // searching nested object parameters too.
  const findEmptyHashName = (blocks: SequenceBlock[]): string | null => {
    const scan = (obj: any): string | null => {
      if (!obj) return null;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.trim() === '#') return k;
        if (typeof v === 'object' && v !== null) {
          const nested = scan(v);
          if (nested) return nested;
        }
      }
      return null;
    };
    for (const block of blocks) {
      const badKey = scan(block.params);
      if (badKey) return `${block.instrument}.${block.method} → ${badKey}`;
    }
    return null;
  };

  // Async because every rejection now surfaces as a modal the user has to acknowledge —
  // previously these were alert() calls, which this webview silently swallows.
  const validateSequence = async () => {
    const allBlocks = [...prepSequence, ...sequence, ...cleanupSequence];

    const emptyHashLocation = findEmptyHashName(allBlocks);
    if (emptyHashLocation) {
      await notify(`'#' needs a variable name after it (e.g. '#temperature'). Found an empty one in ${emptyHashLocation}.`,
                   { title: 'Unnamed variable', tone: 'error' });
      return false;
    }

    for (const block of allBlocks) {
      if (block.schema?.parameters) {
        for (const [key, param] of Object.entries(block.schema.parameters)) {
          const val = block.params[key];
          // Allow dynamic variables (strings starting with #) to pass through here, they are checked in execution/optimizer
          if (typeof val === 'string' && val.startsWith('#')) continue;

          if (val === undefined || val === '') {
            await notify(`Missing parameter '${key}' in ${block.instrument}.${block.method}`,
                         { title: 'Incomplete step', tone: 'error' });
            return false;
          }

          // A param typed int/float has to resolve to an actual number — anything else would
          // only fail once the run tries to cast it, so catch it here instead.
          const typeStr = ((param as any)?.type || '').toLowerCase();
          if ((typeStr.includes('int') || typeStr.includes('float')) && isNaN(Number(val))) {
            await notify(`Parameter '${key}' in ${block.instrument}.${block.method} expects a number (or '#variable'), got '${val}'`,
                         { title: 'Wrong parameter type', tone: 'error' });
            return false;
          }
        }
      }
    }
    return true;
  };

  const runSequence = async () => {
    if (!await validateSequence()) return;
    if (prepSequence.length === 0 && sequence.length === 0 && cleanupSequence.length === 0) return;



    setExecutionState({ isRunning: false, currentIndex: -1, results: {} });

    try {
      const blockToPayload = (s: SequenceBlock) => ({
        instrument: s.instrument,
        method: s.method,
        params: s.params,
        // A linked step's pinned version has to reach the server, or the run would silently
        // resolve against the newest saved body instead of the one this step was built with.
        ...(s.ref ? { ref: s.ref } : {})
      });

      // 1. Submit Sequence to Edge Queue
      const payload = {
        name: await buildRunName(`${currentWorkflowName || 'Designer'} Run`, '', API_BASE),
        parameters: { type: 'Sequence' },
        prep: prepSequence.filter(b => !b.isHidden).map(blockToPayload),
        sequence: sequence.filter(b => !b.isHidden).map(blockToPayload),
        cleanup: cleanupSequence.filter(b => !b.isHidden).map(blockToPayload)
      };

      const res = await fetch(`${API_BASE}/api/queue/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (res.ok) {
        setExecutionState({ isRunning: false, currentIndex: -1, results: {} });
      } else {
        throw new Error(data.error || 'Failed to add to queue');
      }
    } catch (e: any) {
      setExecutionState({
        isRunning: false,
        currentIndex: -1,
        results: {}
      });
      await notify(e.message, { title: 'Could not start the run', tone: 'error' });
    }
  };

  if (!statusData) return <div className="p-8 text-gray-900 dark:text-white bg-gray-50 dark:bg-[#0a0a0a] min-h-screen">Loading designer...</div>;

  const instruments = statusData.instruments || {};


  return (
    <div className={`h-screen w-screen overflow-x-auto overflow-y-hidden bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white font-sans ${theme}`}>
    {/* This designer is a dense, desktop-oriented workspace — rather than reflow/squish its
        panes at narrow widths (which just produces overlapping, clipped controls), it holds its
        natural minimum width and the page scrolls horizontally to reach whatever's off-screen. */}
    {/* The assistant panel is a fixed 26rem column, so the designer's own minimum has to grow
        by that much when it is open — otherwise the editor is squeezed below its usable width
        and the block rows overlap, instead of the page scrolling as it is designed to. */}
    <div className={`flex h-full ${agentOpen ? 'min-w-[1496px]' : 'min-w-[1080px]'}`}>
      {/* Sidebar */}
      <Sidebar theme={theme} toggleTheme={toggleTheme} />

      <AgentTab
        open={agentOpen}
        onToggle={() => {
          const next = !agentOpen;
          setAgentOpen(next);
          localStorage.setItem('ivoryos_agent_panel', String(next));
        }}
      />

      {agentOpen && (
        <AgentPanel
          prepSequence={prepSequence}
          sequence={sequence}
          cleanupSequence={cleanupSequence}
          workflowName={currentWorkflowName}
          instruments={instruments}
          onApply={(body) => {
            // Replaces the canvas wholesale, which is why it is only reachable from an explicit
            // accept and why the diff is offered first: the proposal is always a complete body.
            setPrepSequence(body.prep);
            setSequence(body.script);
            setCleanupSequence(body.cleanup);
            // The steps persist themselves on change, but the name and description do not —
            // they are only written when a workflow is saved or loaded from the Library. Doing
            // the same here keeps them through a reload, rather than leaving the canvas full
            // and the header blank.
            if (body.name && !currentWorkflowName) {
              setCurrentWorkflowName(body.name);
              localStorage.setItem('ivoryos_editing_workflow', body.name);
            }
            if (body.description && !currentWorkflowDescription) {
              setCurrentWorkflowDescription(body.description);
              localStorage.setItem('ivoryos_editing_workflow_desc', body.description);
            }
          }}
          onClose={() => { setAgentOpen(false); localStorage.setItem('ivoryos_agent_panel', 'false'); }}
        />
      )}

      {/* Main Designer Area */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <WorkflowEditor
          statusData={statusData}
          prepSequence={prepSequence}
          setPrepSequence={setPrepSequence}
          sequence={sequence}
          setSequence={setSequence}
          cleanupSequence={cleanupSequence}
          setCleanupSequence={setCleanupSequence}
          header={
            <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-6 bg-white/80 dark:bg-black/20 backdrop-blur-md shadow-sm dark:shadow-none z-50 relative">
              <div className="flex flex-col justify-center flex-1 mr-4 space-y-1">
                <div className="flex items-center space-x-3">
                  <input
                    type="text"
                    value={currentWorkflowName}
                    onChange={(e) => setCurrentWorkflowName(e.target.value)}
                    placeholder="Sequence Name"
                    className="text-sm font-bold tracking-wider text-gray-600 dark:text-gray-300 bg-transparent border-none focus:outline-none focus:ring-0 p-0"
                  />
                  {isUnsaved && <span className="px-1.5 py-0.5 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 text-[10px] font-bold uppercase tracking-wider">Unsaved</span>}
                  {isOffline && (
                    <span className="flex items-center space-x-1 px-1.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 text-[10px] font-bold uppercase tracking-wider border border-purple-200 dark:border-purple-500/30">
                      <AlertTriangle className="w-3 h-3" />
                      <span>Offline Mode</span>
                    </span>
                  )}
                  <div className="flex items-center space-x-1.5 pl-2 border-l border-gray-200 dark:border-white/10">
                    <button
                      onClick={saveWorkflow}
                      disabled={sequence.length === 0}
                      title="Save"
                      className="flex items-center justify-center p-1.5 rounded transition-all bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Save className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={clearCanvas}
                      title="Clear"
                      className="flex items-center justify-center p-1.5 rounded transition-all bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-500/30"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <input
                  type="text"
                  value={currentWorkflowDescription}
                  onChange={(e) => setCurrentWorkflowDescription(e.target.value)}
                  placeholder="Add a short description..."
                  className="text-xs text-gray-400 dark:text-gray-500 bg-transparent border-none focus:outline-none focus:ring-0 p-0 w-full"
                />
              </div>
              <div className="flex items-center space-x-2">

                <div className="relative group">
                  <button className="flex items-center space-x-1 px-3 py-1.5 rounded text-sm font-medium transition-all bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10">
                    <Settings2 className="w-4 h-4" />
                    <span className="hidden sm:inline">Manage</span>
                  </button>
                  <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 rounded-xl shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 overflow-hidden">
                    <button
                      onClick={exportJSON}
                      disabled={sequence.length === 0}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
                    >
                      <Download className="w-4 h-4" />
                      <span>Export JSON</span>
                    </button>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5 flex items-center space-x-2 border-t border-gray-100 dark:border-white/5"
                    >
                      <Upload className="w-4 h-4" />
                      <span>Import JSON</span>
                    </button>
                  </div>
                </div>

                <input
                  type="file"
                  accept=".json"
                  className="hidden"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                />

                {/* The steps a linked workflow stands in for are otherwise invisible until the run
                    is already underway. This shows them before anything is committed to hardware. */}
                <button
                  onClick={() => setIsMapOpen(true)}
                  disabled={prepSequence.length === 0 && sequence.length === 0 && cleanupSequence.length === 0}
                  title="Preview every step this sequence will run, with linked workflows expanded"
                  className="flex items-center space-x-1 px-3 py-1.5 rounded text-sm font-medium transition-all bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ListTree className="w-4 h-4 text-emerald-500" />
                  <span className="hidden sm:inline">Preview</span>
                </button>

                <button
                  onClick={() => {
                    const next = !agentOpen;
                    setAgentOpen(next);
                    localStorage.setItem('ivoryos_agent_panel', String(next));
                  }}
                  title="Describe a protocol in words and have it drafted against this deck"
                  className={`flex items-center space-x-1 px-3 py-1.5 rounded text-sm font-medium transition-all border ${agentOpen
                    ? 'bg-purple-50 border-purple-200 text-purple-700 dark:bg-purple-900/30 dark:border-purple-500/30 dark:text-purple-300'
                    : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10'}`}
                >
                  <Sparkles className="w-4 h-4 text-purple-500" />
                  <span className="hidden sm:inline">Assistant</span>
                </button>

                <button
                  onClick={() => setViewMode(viewMode === 'canvas' ? 'code' : 'canvas')}
                  className="flex items-center space-x-1 px-3 py-1.5 rounded text-sm font-medium transition-all bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-white/5 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10"
                >
                  {viewMode === 'canvas' ? <Code className="w-4 h-4 text-indigo-500" /> : <LayoutTemplate className="w-4 h-4 text-indigo-500" />}
                  <span className="hidden sm:inline">{viewMode === 'canvas' ? 'Python' : 'Back'}</span>
                </button>
                {(() => {
                  const allBlocks = [...prepSequence, ...sequence, ...cleanupSequence];
                  const liveInputVars = getLiveInputVars(allBlocks);
                  const hasDynamicParams = allBlocks.some(block =>
                    Object.values(block.params).some(val =>
                      typeof val === 'string' && val.startsWith('#') && !liveInputVars.has(val.substring(1).trim())
                    )
                  );
                  const hasNoSteps = prepSequence.length === 0 && sequence.length === 0 && cleanupSequence.length === 0;
                  return (
                    <>
                      <button
                        onClick={async () => {
                          if (!await validateSequence()) return;
                          if (sequence.length === 0 && (prepSequence.length > 0 || cleanupSequence.length > 0)) {
                            if (!await confirmDialog("There are no steps in the Main Workflow — only Prep and Cleanup will run.", {
                              title: 'Run anyway?',
                              confirmLabel: 'Run',
                            })) {
                              return;
                            }
                          }
                          if (hasPendingRuns) {
                            if (!await confirmDialog("A task is already running. Add this sequence to the execution queue?", {
                              title: 'Queue this run?',
                              confirmLabel: 'Add to queue',
                            })) {
                              return;
                            }
                          }
                          if (hasDynamicParams) window.location.href = '/execution';
                          else runSequence();
                        }}
                        disabled={hasNoSteps}
                        className={`flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all ${hasNoSteps
                            ? 'bg-gray-50 text-gray-400 border border-gray-200 dark:bg-gray-900/30 dark:border-gray-800 dark:text-gray-600 cursor-not-allowed'
                            : hasDynamicParams
                              ? 'bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:border-indigo-500/30 dark:text-indigo-300 dark:hover:bg-indigo-900/50 shadow-sm'
                              : 'bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 dark:bg-green-900/30 dark:border-green-500/30 dark:text-green-300 dark:hover:bg-green-900/50 shadow-sm'
                          }`}
                      >
                        {hasDynamicParams ? <Settings2 className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                        <span>{hasDynamicParams ? 'Configure' : (hasPendingRuns ? 'Add to Queue' : 'Run')}</span>
                      </button>
                      {hasDynamicParams && sequence.some(s => s.returnVar) && (
                        <a
                          href="/optimize"
                          className="flex items-center space-x-2 px-4 py-1.5 rounded text-sm font-medium transition-all bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100 dark:bg-purple-900/30 dark:border-purple-500/30 dark:text-purple-300 dark:hover:bg-purple-900/50"
                        >
                          <Zap className="w-4 h-4" />
                          <span>Optimize</span>
                        </a>
                      )}
                    </>
                  );
                })()}
              </div>
            </header>
          }
          customView={
            viewMode === 'code' ? (
              <PythonCodeView
                code={generatePythonCode(prepSequence, sequence, cleanupSequence, instrumentMeta)}
                theme={theme}
                fileName={currentWorkflowName || 'sequence'}
              />
            ) : null
          }
          workflowVersions={workflowVersions}
          onEditWorkflow={openWorkflowInDesigner}
          currentWorkflowName={currentWorkflowName}
          fetchWorkflowVersion={async (name, version) => {
            const res = await fetch(`${API_BASE}/api/workflows/${name}?version=${version}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `v${version} not found`);
            return data;
          }}
        />
        <WorkflowMap
          isOpen={isMapOpen}
          onClose={() => setIsMapOpen(false)}
          fetchExpansion={fetchExpansion}
        />
      </div>

    </div>
    </div>
  );
}
