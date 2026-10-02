'use strict';
/**
 * Who may use a LAN Cloud's own MQTT broker (embedded-broker.js), and for what.
 *
 * On AWS IoT a device proves itself with its certificate, and a policy keeps it to its own topics.
 * The broker built into the daemon had neither: any client on the network could connect under any
 * id, read every device's data, and publish an `execute` that moves another device's hardware.
 * This gives it the same two rules.
 *
 *  - Identity. Pairing mints a random secret for the device (provision.ts) and Cloud keeps only
 *    its hash. The secret travels inside the token the edge collects once, so no person ever sees
 *    or types it: it is a credential between two programs. The device connects with username =
 *    its id (also its client id) and that secret. Pairing again replaces the secret; removing the
 *    device deletes it.
 *  - Topics. A device may publish only what an edge publishes and subscribe only to what Cloud
 *    sends it, both under its own id. In particular it cannot publish an `execute`, so even a
 *    device's own stolen secret cannot be used to drive its instruments; only Cloud can.
 *
 * The daemon is the one privileged client. It connects with a secret made fresh each time it
 * starts, which exists only in its memory.
 *
 * Plain CommonJS so daemon.js (no build step) and the Next app share it, and `npm test` covers it.
 */
const crypto = require('crypto');

const DAEMON_USER = '@ivoryos-cloud-daemon';

/** What an edge publishes, under `<prefix>/<its id>/` (edge server.py / broker.py). */
const DEVICE_PUBLISHES = ['status', 'schema', 'sequences/+', 'task-status', 'task-result', 'presence', 'leave'];
/** What Cloud sends an edge, and its own presence, under the same root. */
const DEVICE_SUBSCRIBES = ['execute', 'sequences-push', 'cloud-queue', 'task-control', 'removed', 'ping', 'presence'];

const newSecret = () => crypto.randomBytes(32).toString('base64url');
// A 256-bit random secret needs no slow hash: there is nothing to guess.
const hashSecret = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');

function secretMatches(secret, hash) {
  if (!secret || !hash) return false;
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(String(hash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The rest of `topic` after `<prefix>/<deviceId>/`, or null when it is not under that device. */
function ownPart(topic, prefix, deviceId) {
  const root = `${prefix}/${deviceId}/`;
  return typeof topic === 'string' && topic.startsWith(root) ? topic.slice(root.length) : null;
}

/** `sequences/+` matches exactly one level after `sequences/`; anything else matches exactly. */
function inList(part, list) {
  if (part === null) return false;
  return list.some((p) => (p.endsWith('/+')
    ? part.startsWith(p.slice(0, -1)) && part.length > p.length - 1 && !part.slice(p.length - 1).includes('/')
    : part === p));
}

const devicePublishAllowed = (topic, prefix, deviceId) => inList(ownPart(topic, prefix, deviceId), DEVICE_PUBLISHES);

/** Exact topics only: a device has no reason to subscribe with a wildcard. */
const deviceSubscribeAllowed = (filter, prefix, deviceId) =>
  !/[#+]/.test(String(filter)) && inList(ownPart(filter, prefix, deviceId), DEVICE_SUBSCRIBES);

/** Whether the broker checks credentials at all (`IVORYOS_BROKER_AUTH=off` turns it off). */
const brokerAuthEnabled = () => String(process.env.IVORYOS_BROKER_AUTH || 'on').trim().toLowerCase() !== 'off';

module.exports = {
  DAEMON_USER, DEVICE_PUBLISHES, DEVICE_SUBSCRIBES,
  newSecret, hashSecret, secretMatches, devicePublishAllowed, deviceSubscribeAllowed, brokerAuthEnabled,
};
