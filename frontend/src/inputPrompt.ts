/**
 * Whether the operator has put the "Input needed" prompt aside for now.
 *
 * The prompt lives in the Sidebar, which every page renders afresh, so remembering "minimized" in
 * component state would pop it back up on the next navigation -- exactly when someone put it down
 * to go and look at the workflow. It is remembered per prompt (run + step) in sessionStorage
 * instead: a *new* prompt opens by itself, and the status bar (GlobalQueueBar) can bring this one
 * back. Both listen for the same window event.
 */

const KEY = 'ivoryos_input_minimized';
export const INPUT_PROMPT_EVENT = 'ivoryos:input-prompt';

export const promptKey = (runId: number, stepId: number | string | undefined) => `${runId}:${stepId ?? ''}`;

export function isPromptMinimized(key: string): boolean {
  try {
    return sessionStorage.getItem(KEY) === key;
  } catch {
    return false;
  }
}

/** Minimize the given prompt, or pass null to bring it back. */
export function setPromptMinimized(key: string | null) {
  try {
    if (key) sessionStorage.setItem(KEY, key);
    else sessionStorage.removeItem(KEY);
  } catch { /* storage blocked: the prompt simply stays open */ }
  window.dispatchEvent(new CustomEvent(INPUT_PROMPT_EVENT));
}
