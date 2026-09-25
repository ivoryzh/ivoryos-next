/**
 * Server-side lookups the run and schedule routes share when planning a run.
 */

import { LIBRARY_INSTRUMENT } from '@ivoryos/shared-ui';
import { getStore } from './store';
import { blockOf } from './dag';
import { batchSizeOf, type WorkflowSource } from './runPayload';

/**
 * A lookup from a workflow node to the body its device published, for the nodes that need one
 * (a spreadsheet with a batch size). Fetched once per plan, only when such a node exists.
 */
export async function workflowSourcesFor(nodes: any[]): Promise<(node: any) => WorkflowSource | null> {
  const needs = nodes.some((n) => batchSizeOf(n) && String(blockOf(n)?.instrument || '') === LIBRARY_INSTRUMENT);
  if (!needs) return () => null;
  const store = getStore();
  const [sequences, devices] = await Promise.all([store.listSequences(), store.listDevices()]);
  return (node: any) => {
    const deviceId = String(node?.data?.targetDeviceId || '');
    const name = String(blockOf(node)?.method || '');
    const seq = (sequences as any[]).find((s) => s.device_id === deviceId && s.name === name);
    if (!seq?.body) return null;
    const device = (devices as any[]).find((d) => d.id === deviceId);
    return { body: seq.body, instruments: device?.schema?.instruments || {} };
  };
}

/**
 * The experiment's name: what was typed, or the canvas's name numbered like the edge numbers its
 * runs ("Screen #3") -- never a generic "Distributed Run", which says nothing about which one.
 */
export async function experimentName(typed: unknown, base: unknown): Promise<string> {
  const name = String(typed ?? '').trim();
  if (name) return name;
  const root = String(base ?? '').trim() || 'Experiment';
  const count = await getStore().countRunsNamed(root);
  return `${root} #${count + 1}`;
}
