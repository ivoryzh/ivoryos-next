'use strict';

/**
 * Remove a device from Cloud: the Devices page's Remove, and a device leaving on its own (the
 * edge's "Remove from Cloud", arriving at daemon.js as a `leave` message). One implementation so
 * both mean the same thing.
 *
 *   1. remembered as removed first, so its next heartbeat (or a retained message the broker
 *      replays) cannot register it again; the daemon ignores it until it is paired again, and
 *      tells it, if it is still running, to forget its pairing
 *   2. its device record, workflows mirror and pushes deleted, and its workspace let go
 *   3. on AWS, its certificates revoked (it can no longer connect) and its Thing deleted
 *
 * Its runs and results stay: they are the lab's record, not the device's.
 */
async function removeDevice(store, deviceId, { awsOps } = {}) {
  await store.markDeviceRemoved(deviceId);
  const removed = await store.deleteDevice(deviceId);
  await store.deleteOwner('device', deviceId);
  let aws = null;
  if (process.env.AWS_IOT_ENDPOINT) {
    const things = require('./awsThings');
    aws = await things.removeThing(awsOps || things.aws(), deviceId);
  }
  return { removed, aws };
}

module.exports = { removeDevice };
