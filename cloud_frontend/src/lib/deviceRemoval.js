'use strict';

/**
 * Remove a device from Cloud: the Devices page's Remove, and a device leaving on its own (the
 * edge's "Remove from Cloud", arriving at daemon.js as a `leave` message). One implementation so
 * both mean the same thing.
 *
 *   1. remembered as removed first, so its next status (or a retained message the broker
 *      replays) cannot register it again; the daemon ignores it until it is paired again, and
 *      tells it, if it is still running, to forget its pairing
 *   2. the live device goes: its record and pending pushes deleted, its workspace let go, so the
 *      same id can be paired again anywhere as a new device
 *   3. on AWS, its certificates revoked (it can no longer connect) and its Thing deleted
 *
 * What stays is the lab's record, not the device's: its runs and results, and the workflows
 * mirrored from it. Those move to a kept record (`<id>~removed-<time>`, status 'removed') in the
 * same workspace, with the instrument schema they were written against, and stay readable in the
 * Library. Nothing can run on a kept record, and nothing a device publishes can change it.
 */
function archiveIdFor(deviceId, now = new Date()) {
  return `${deviceId}~removed-${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
}

async function removeDevice(store, deviceId, { awsOps } = {}) {
  await store.markDeviceRemoved(deviceId);
  const workspace = await store.getOwner('device', deviceId);
  const { removed, archived, workflows } = await store.archiveDevice(deviceId, archiveIdFor(deviceId));
  // The kept workflows stay with the workspace that had the device.
  if (archived && workspace) await store.setOwner('device', archived, workspace);
  await store.deleteOwner('device', deviceId);
  // Its broker secret goes too, so the LAN broker refuses it from its next connect (brokerAuth.js).
  await store.deleteBrokerCredential(deviceId);
  let aws = null;
  // Only a Cloud that is on AWS IoT minted a Thing for this device (store/index.js usesAwsIot).
  if (require('./store').usesAwsIot()) {
    const things = require('./awsThings');
    aws = await things.removeThing(awsOps || things.aws(), deviceId);
  }
  return { removed, aws, archived, workflows };
}

/** Whether a device id is a removed device's kept record rather than a device. */
const isArchivedId = (deviceId) => /~removed-\d{14}$/.test(String(deviceId || ''));

module.exports = { removeDevice, archiveIdFor, isArchivedId };
