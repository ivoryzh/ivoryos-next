'use strict';

/**
 * AWS IoT Things and certificates for devices: issue credentials for a device's lasting id, and
 * remove a device. Plain CommonJS so both the Next app (pairing, the Devices page) and daemon.js
 * (a device leaving) use the one implementation.
 *
 * A device's Thing is named by its lasting id (the edge's CLOUD_DEVICE_ID), so pairing the same
 * device again finds its Thing: it gets a new certificate and the old ones are revoked, rather
 * than a second Thing being made. Revoking means INACTIVE first, which is what stops a connection;
 * detaching and deleting follow, best effort, as AWS applies detachment eventually.
 *
 * The IAM user needs: iot:CreateThing, iot:DeleteThing, iot:ListThingPrincipals,
 * iot:AttachThingPrincipal, iot:DetachThingPrincipal, iot:CreateKeysAndCertificate,
 * iot:AttachPolicy, iot:UpdateCertificate, iot:DeleteCertificate.
 *
 * Every function takes `{send, cmds}` (an IoTClient's send and the SDK's command classes) so tests
 * can pass fakes; `aws()` gives the real ones.
 */

let client = null;

function aws() {
  const cmds = require('@aws-sdk/client-iot');
  if (!client) client = new cmds.IoTClient({ region: process.env.AWS_REGION || 'us-east-1' });
  return { send: (command) => client.send(command), cmds };
}

const notFound = (e) => e && (e.name === 'ResourceNotFoundException' || e.__type === 'ResourceNotFoundException');

/** The certificates attached to a Thing, or null if there is no such Thing. */
async function certificatesOf({ send, cmds }, thingName) {
  const found = [];
  let nextToken;
  try {
    do {
      const page = await send(new cmds.ListThingPrincipalsCommand({ thingName, nextToken }));
      found.push(...(page.principals || []));
      nextToken = page.nextToken;
    } while (nextToken);
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
  return found.filter((arn) => arn.includes(':cert/'));
}

/** Stop a certificate working, then clean it up. Throws only if it could not be made INACTIVE. */
async function revokeCertificate({ send, cmds }, thingName, certificateArn) {
  const certificateId = certificateArn.split('/').pop();
  await send(new cmds.UpdateCertificateCommand({ certificateId, newStatus: 'INACTIVE' }));
  try { await send(new cmds.DetachThingPrincipalCommand({ thingName, principal: certificateArn })); } catch { /* best effort */ }
  try { await send(new cmds.DeleteCertificateCommand({ certificateId, forceDelete: true })); } catch { /* detach not applied yet: stays INACTIVE */ }
}

/**
 * Credentials for `thingName`: its Thing (made if new), a new active certificate with the device
 * policy, and every earlier certificate revoked. On failure, the new certificate is revoked and a
 * Thing made by this call is deleted, so a retry starts clean; an existing device is left as it was.
 * Returns {certificateArn, certificatePem, privateKey, reattached}.
 */
async function issueCertificate({ send, cmds }, thingName, policyName) {
  const previous = await certificatesOf({ send, cmds }, thingName);
  const reattached = previous !== null;
  let certificateArn;
  try {
    if (!reattached) await send(new cmds.CreateThingCommand({ thingName }));
    const cert = await send(new cmds.CreateKeysAndCertificateCommand({ setAsActive: true }));
    certificateArn = cert.certificateArn;
    const certificatePem = cert.certificatePem;
    const privateKey = cert.keyPair && cert.keyPair.PrivateKey;
    if (!certificateArn || !certificatePem || !privateKey) {
      throw new Error('AWS IoT did not return a complete certificate/key pair.');
    }
    await send(new cmds.AttachPolicyCommand({ policyName, target: certificateArn }));
    await send(new cmds.AttachThingPrincipalCommand({ thingName, principal: certificateArn }));
    // Only now, with the new one attached: the device's old credentials stop working.
    for (const old of previous || []) {
      try { await revokeCertificate({ send, cmds }, thingName, old); }
      catch (e) { console.error(`Could not revoke an old certificate of ${thingName}:`, e.message); }
    }
    return { certificateArn, certificatePem, privateKey, reattached };
  } catch (err) {
    if (certificateArn) {
      try { await revokeCertificate({ send, cmds }, thingName, certificateArn); } catch { /* best effort */ }
    }
    if (!reattached) {
      try { await send(new cmds.DeleteThingCommand({ thingName })); } catch { /* best effort */ }
    }
    throw err;
  }
}

/**
 * Remove a device from AWS: revoke every certificate (the device can no longer connect), then
 * delete the Thing. A Thing that does not exist is already removed. Resolves {revoked, thingDeleted}.
 */
async function removeThing({ send, cmds }, thingName, { retries = 3, delayMs = 1000 } = {}) {
  const certs = await certificatesOf({ send, cmds }, thingName);
  if (certs === null) return { revoked: 0, thingDeleted: false };
  for (const arn of certs) await revokeCertificate({ send, cmds }, thingName, arn);
  // DeleteThing refuses while a principal is still attached, and detaching applies eventually.
  for (let attempt = 0; ; attempt++) {
    try {
      await send(new cmds.DeleteThingCommand({ thingName }));
      return { revoked: certs.length, thingDeleted: true };
    } catch (e) {
      if (notFound(e)) return { revoked: certs.length, thingDeleted: true };
      if (attempt >= retries) {
        // Revoked is what matters; a Thing left behind is only an empty record.
        console.error(`Revoked ${thingName}'s certificates but could not delete the Thing:`, e.message);
        return { revoked: certs.length, thingDeleted: false };
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { aws, certificatesOf, revokeCertificate, issueCertificate, removeThing };
