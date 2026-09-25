import { workflowSignature } from '@ivoryos/shared-ui';

/**
 * The saved workflow's name when the canvas in localStorage *is* that workflow, unedited -- else
 * null. Run pages stamp it on a run as `parameters.workflow_name`, which is how the edge times a
 * workflow run from the bench (see `edge_server/ivoryos_edge/runtime.py`).
 *
 * The same signature check the Designer uses for its "Unsaved" badge: a canvas edited after
 * loading is a different protocol, and counting its runs toward the saved one would skew the
 * typical duration Cloud uses to explain a repeat cadence.
 */
export function unmodifiedSavedWorkflowName(): string | null {
  try {
    const name = localStorage.getItem('ivoryos_editing_workflow');
    const saved = localStorage.getItem('ivoryos_saved_signature');
    if (!name || !saved) return null;
    const read = (key: string) => JSON.parse(localStorage.getItem(key) || '[]');
    const current = workflowSignature(
      read('ivoryos_prep_sequence'),
      read('ivoryos_sequence'),
      read('ivoryos_cleanup_sequence'),
      name,
      localStorage.getItem('ivoryos_editing_workflow_desc') || '',
    );
    return current === saved ? name : null;
  } catch {
    return null;
  }
}
