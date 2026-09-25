/**
 * Which saved Orchestrator graphs no longer run against the devices Cloud knows about.
 *
 * The Cloud counterpart of the edge Library's compatibility badge (edge_server/ivoryos_edge/
 * compatibility.py). A saved graph names a device, an instrument, a method and arguments, and none
 * of it is checked again until someone presses Run -- so a driver renamed on the bench leaves the
 * graph looking fine in the Library right up to the moment it is refused.
 *
 * Only the parts Cloud can actually see are checked here: each step against the schema its device
 * last published. A linked edge workflow is *not* re-validated in Cloud -- that would be a second
 * copy of `validate_body` -- the device's own verdict, which it publishes alongside the body, is
 * reported instead. Plain CommonJS for the same reason as dag.js: `node --test` runs it directly.
 */

const { isFlowControlNode, blockOf, deviceIdOf } = require('./dag');

const LIBRARY_INSTRUMENT = 'Library Workflows';

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * @param {any[]} nodes      a saved graph's nodes
 * @param {any[]} devices    rows from /api/devices ({id, schema})
 * @param {any[]} sequences  rows from /api/edge-sequences ({device_id, name, body})
 * @returns {{where: string, message: string}[]}
 */
function graphProblems(nodes, devices, sequences) {
  const deviceById = new Map((devices || []).map((d) => [String(d.id), d]));
  const sequenceKey = (deviceId, name) => `${deviceId}\u0000${name}`;
  const sequenceByKey = new Map(
    (sequences || []).map((s) => [sequenceKey(String(s.device_id), String(s.name)), s]),
  );

  const problems = [];
  for (const node of nodes || []) {
    if (isFlowControlNode(node)) continue;
    const block = blockOf(node) || {};
    const deviceId = String(deviceIdOf(node) || '');
    const isLink = block.instrument === LIBRARY_INSTRUMENT;
    const where = isLink ? String(block.method) : `${block.instrument}.${block.method}`;

    if (!deviceId) {
      problems.push({ where, message: 'has no target device' });
      continue;
    }
    const device = deviceById.get(deviceId);
    if (!device) {
      problems.push({ where, message: `targets ${deviceId}, which is not a registered device` });
      continue;
    }

    if (isLink) {
      const sequence = sequenceByKey.get(sequenceKey(deviceId, String(block.method)));
      if (!sequence) {
        problems.push({ where, message: `${deviceId} has no saved workflow by this name` });
        continue;
      }
      const verdict = sequence.body && sequence.body.compatibility;
      if (verdict && verdict.status === 'broken') {
        problems.push({
          where,
          message: `won't run on ${deviceId} (${plural(verdict.error_count || 0, 'problem')} in that workflow)`,
        });
      }
      continue;
    }

    // A device that has not published a schema yet tells us nothing either way.
    const instruments = device.schema && device.schema.instruments;
    if (!instruments) continue;

    const methods = instruments[block.instrument];
    if (!methods) {
      problems.push({ where, message: `${deviceId} has no instrument '${block.instrument}'` });
      continue;
    }
    const method = methods[block.method];
    if (!method) {
      problems.push({ where, message: `'${block.instrument}' on ${deviceId} has no method '${block.method}'` });
      continue;
    }

    const declared = method.parameters || {};
    const params = block.params || {};
    if (!method.accepts_kwargs) {
      for (const key of Object.keys(params)) {
        // `_`-prefixed keys are bookkeeping (`_row`, `_phase`, ...), never forwarded to a driver.
        if (!key.startsWith('_') && !(key in declared)) {
          problems.push({ where, message: `argument '${key}' no longer exists` });
        }
      }
    }
    for (const [key, spec] of Object.entries(declared)) {
      if (spec && spec.required && isBlank(params[key])) {
        problems.push({ where, message: `required argument '${key}' is empty` });
      }
    }
  }
  return problems;
}

module.exports = { graphProblems };
