"use client";
import { withBase } from '@/config';
import type { SequenceBlock } from '@ivoryos/shared-ui';

/**
 * Putting a workflow on the Designer's canvas from another page: the Library's "Load to Designer"
 * and the assistant's "Open in Designer". The Designer reads its canvas from these keys when it
 * mounts, so this writes them and navigates there with a full load.
 */

const CANVAS_KEYS = ['ivoryos_sequence', 'ivoryos_prep_sequence', 'ivoryos_cleanup_sequence'];

/** Whether the canvas holds work that was never saved, which a handoff would replace. */
export function canvasHasUnsavedWork(): boolean {
  if (localStorage.getItem('ivoryos_is_unsaved') !== 'true') return false;
  return CANVAS_KEYS.some((key) => {
    try {
      const raw = localStorage.getItem(key);
      return !!raw && JSON.parse(raw).length > 0;
    } catch {
      return false;
    }
  });
}

/** The name of the workflow on the canvas, '' when it was never named. */
export const canvasWorkflowName = () => localStorage.getItem('ivoryos_editing_workflow') || '';

export function handOffToDesigner({ prep, script, cleanup, name, description, savedSignature, unsaved }: {
  prep: SequenceBlock[]; script: SequenceBlock[]; cleanup: SequenceBlock[];
  name: string; description: string;
  /** The signature of what is saved under `name` ('' when nothing is): what "Unsaved" compares to. */
  savedSignature: string;
  unsaved: boolean;
}) {
  localStorage.setItem('ivoryos_sequence', JSON.stringify(script));
  localStorage.setItem('ivoryos_prep_sequence', JSON.stringify(prep));
  localStorage.setItem('ivoryos_cleanup_sequence', JSON.stringify(cleanup));
  localStorage.setItem('ivoryos_editing_workflow', name);
  localStorage.setItem('ivoryos_editing_workflow_desc', description);
  localStorage.setItem('ivoryos_saved_signature', savedSignature);
  localStorage.setItem('ivoryos_is_unsaved', unsaved ? 'true' : 'false');
  window.location.href = withBase('/designer');
}
