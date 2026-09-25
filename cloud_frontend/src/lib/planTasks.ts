/**
 * The bridge between the graph plan (`dag.js`) and the rows that actually get dispatched.
 *
 * `planRun` answers "what waits for what" and nothing else — it is plain CommonJS so `daemon.js`
 * can require it, which rules out everything in `@ivoryos/shared-ui`. This module is where each
 * planned task acquires the payload its device will execute: a bare block for a step that is one
 * call, or a whole run for a spreadsheet or an optimization campaign.
 *
 * Used by both the run route and the schedules route, so a scheduled run and a run started by
 * hand are planned identically — a schedule stores the rows this produces and replays them, which
 * is the only reason the daemon never needs to build a payload of its own.
 */

import { RunConfigError, resolveBlockParams } from '@ivoryos/shared-ui';
import { blockOf, isCloudLogicNode } from './dag';
import {
  buildNodeRun,
  repeatIntervalMs,
  repeatTotal,
  runModeOf,
  singleValuesOf,
  validateNodeRunConfig,
  type EdgeRunPayload,
  type WorkflowSource,
} from './runPayload';

export interface TaskRow {
  run_id: string;
  node_id: string;
  device_id: string;
  block: any;
  run: EdgeRunPayload | null;
  members: string[];
  status: string;
  repeat_every_ms: number;
  repeat_total: number;
}

/** A readable name for one node, used in problem messages and in the run's name on the device. */
export function labelForNode(node: any): string {
  const block = blockOf(node);
  // A linked workflow's "method" is its name, which the person typed; it is the whole label.
  if (block?.instrument === 'Library Workflows') return String(block.method || 'workflow');
  const method = String(block?.method || node?.id || '').replace(/_/g, ' ');
  return block?.instrument ? `${block.instrument} · ${method}` : String(node?.id || 'step');
}

/**
 * Substitute a single-mode node's configured values into its params.
 *
 * Applied to the dispatched copy only — the canvas keeps its `#placeholders`, which is what makes
 * the same graph re-runnable over a different set of inputs. Seeded from the node's own params so
 * a value that only ever existed as a schema default is written out explicitly once it resolves:
 * the dispatched copy has to be complete on its own, since the edge never sees this node's schema.
 */
function resolveSingleBlock(node: any): any {
  const block = blockOf(node);
  const values = singleValuesOf(node);
  // The same walker the spreadsheet expansion and the edge's Configure page use, so a value typed
  // once here and a value typed in a row are treated identically — including the cast to a number
  // for an int/float param. Doing this by hand was already producing the string "1.5" where the
  // spreadsheet path produced 1.5, for the same field on the same instrument.
  //
  // `leave` rather than `throw`: a #name with nothing supplied stays as it is and `planRun` refuses
  // the graph by name, which is a far better message than one thrown from the middle of a walk.
  // `lenient` because the edge's own `cast_arguments` has the last word on a value it cannot
  // convert, and failing here would reject a run the device would have accepted.
  const params = resolveBlockParams(block, {
    lookup: (v) => values[v],
    describe: (v) => `'${v}'`,
    onMissing: 'leave',
    numeric: 'lenient',
  });
  return { ...block, params };
}

/**
 * The graph as it will actually be dispatched: every single-mode node's `#names` replaced by the
 * values configured for it, every iterating node left exactly as authored.
 *
 * This has to happen **before** `planRun`, not after. `planRun` refuses a graph still carrying an
 * unresolved placeholder on a step that dispatches once — correctly, since such a value would
 * never arrive — so planning the authored graph rejects every configured run before its values
 * are applied. The canvas used to substitute client-side and post the resolved copy, which hid
 * the ordering; moving substitution to the server (a spreadsheet node has no single resolved copy
 * to build, so the page could not keep doing it) made the order matter.
 *
 * The resolved graph is also what gets stored on the run, so the record says what ran rather than
 * what was drawn.
 */
export function resolveGraphForDispatch(nodes: any[]): any[] {
  return nodes.map((node) => {
    if (runModeOf(node) !== 'single') return node;
    if (!Object.keys(singleValuesOf(node)).length) return node;
    return { ...node, data: { ...node.data, block: resolveSingleBlock(node) } };
  });
}

/** Attach a payload to every planned task. One task is one node, dispatched on its own. */
export function buildRunTasks(
  tasks: any[],
  nodes: any[],
  runName: string,
  /** A workflow node's body as its device published it -- only a batched spreadsheet needs it. */
  sourceOf: (node: any) => WorkflowSource | null = () => null,
): { rows: TaskRow[]; problems: string[] } {
  const nodeById = new Map(nodes.map((n: any) => [String(n.id), n]));
  const problems: string[] = [];
  const rows: TaskRow[] = [];

  for (const task of tasks) {
    const head = nodeById.get(String(task.node_id));
    if (!head) {
      problems.push(`Step ${task.node_id} is no longer on the canvas.`);
      continue;
    }

    // Cloud's own steps (Wait, User_Input, If) go to no device and carry no run payload. An If's
    // variable may be written `#yield`, which names a value to *read*, not a placeholder to fill,
    // so the placeholder checks below must not see it.
    if (isCloudLogicNode(head)) {
      rows.push({
        run_id: task.run_id,
        node_id: task.node_id,
        device_id: task.device_id,
        block: blockOf(head),
        run: null,
        members: [String(task.node_id)],
        status: task.status,
        repeat_every_ms: 0,
        repeat_total: 0,
      });
      continue;
    }

    problems.push(...validateNodeRunConfig(head, labelForNode(head)));

    let run: EdgeRunPayload | null = null;
    try {
      run = buildNodeRun(head, `${runName} · ${labelForNode(head)}`, sourceOf(head));
    } catch (e: any) {
      if (e instanceof RunConfigError) {
        problems.push(`${labelForNode(head)}: ${e.message}`);
        continue;
      }
      throw e;
    }

    rows.push({
      run_id: task.run_id,
      node_id: task.node_id,
      device_id: task.device_id,
      // Kept for the single-step wire shape, which is what goes out when `run` is null.
      block: runModeOf(head) === 'single' ? resolveSingleBlock(head) : task.block,
      run,
      members: [String(task.node_id)],
      status: task.status,
      repeat_every_ms: repeatIntervalMs(head),
      repeat_total: repeatTotal(head),
    });
  }

  return { rows, problems };
}
