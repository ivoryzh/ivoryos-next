'use strict';

/**
 * Deciding, from Cloud, about a task a device has stopped on.
 *
 * A device-run task can stop for a person in two ways, the same two the bench has: a User_Input
 * step asking a question, or a failed step waiting for retry / skip / stop. The device says so in
 * its progress summary (`progress.pause`, plus `prompt`/`input_type` or `error`; see pause_summary
 * in the edge's queue.py). A decision is stored on the task as `command` by the control route and
 * published by the daemon; the device applies it only while the same pause is current.
 *
 * Plain CommonJS so daemon.js (no build step) and the Next routes share it, like dag.js.
 */

const ACTIONS = {
  input: ['input', 'stop'],
  error: ['retry', 'skip', 'stop'],
};

// Re-send a decision the device has not visibly acted on after this long. Safe because the device
// ignores one whose pause has gone, so a duplicate can never apply twice or to a later stop.
const RESEND_AFTER_MS = 10000;

/** 'input' | 'error' | null: what, if anything, this task is stopped on. */
function pauseKind(task) {
  const pause = task && task.progress && task.progress.pause;
  if (!task || task.status !== 'running' || typeof pause !== 'string') return null;
  if (pause.startsWith('input:')) return 'input';
  if (pause.startsWith('error:')) return 'error';
  return null;
}

/** Why this decision cannot be taken, or null when it can. */
function commandProblem(task, { action, pause }) {
  if (!task) return 'No such task.';
  const kind = pauseKind(task);
  if (!kind || task.progress.pause !== pause) return 'That step is no longer waiting for a decision.';
  if (!ACTIONS[kind].includes(action)) return `'${action}' does not apply here.`;
  if (task.command && task.command.pause === pause) return 'A decision has already been sent.';
  return null;
}

/**
 * What the daemon should do with a stored decision now:
 *   'clear' -- it took effect (or can never): the task moved on from the pause it was about.
 *   'send'  -- not sent yet, or sent and not acted on for a while, and the device is reachable.
 *   'wait'  -- sent recently, or the device is not reachable.
 */
function commandStep(task, deviceUp, now = Date.now()) {
  const cmd = task && task.command;
  if (!cmd) return 'wait';
  if (pauseKind(task) === null || task.progress.pause !== cmd.pause) return 'clear';
  if (!deviceUp) return 'wait';
  if (cmd.state !== 'sent') return 'send';
  const sentAt = Date.parse(cmd.sent_at || '');
  return Number.isNaN(sentAt) || now - sentAt >= RESEND_AFTER_MS ? 'send' : 'wait';
}

module.exports = { ACTIONS, RESEND_AFTER_MS, pauseKind, commandProblem, commandStep };
