'use strict';

// AWS IoT credentials for a device's lasting id (awsThings.js), against a fake IoT API: the real
// one mints billable resources. What is pinned: a device paired again keeps its Thing and loses
// its old certificates only once the new one is attached; a failed attempt cleans up after itself
// without touching an existing device; removal makes every certificate INACTIVE, then deletes.

const test = require('node:test');
const assert = require('node:assert');
const things = require('./awsThings.js');

/** Command classes that just record their name and input, like the SDK's shape. */
const cmds = new Proxy({}, {
  get: (_t, name) => class { constructor(input) { this.name = name; this.input = input; } },
});

/** An in-memory AWS IoT: Things with attached certificates, certificates with a status. */
function fakeIot({ things: initial = {}, failOn = null } = {}) {
  const state = { things: structuredClone(initial), certs: {}, calls: [] };
  let n = 0;
  for (const principals of Object.values(state.things)) for (const arn of principals) state.certs[arn] = 'ACTIVE';
  const notFound = () => Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
  const send = async (command) => {
    const { name, input } = command;
    state.calls.push(name.replace('Command', ''));
    if (failOn === name) throw new Error(`${name} failed`);
    switch (name) {
      case 'ListThingPrincipalsCommand':
        if (!state.things[input.thingName]) throw notFound();
        return { principals: [...state.things[input.thingName]] };
      case 'CreateThingCommand':
        state.things[input.thingName] = state.things[input.thingName] || [];
        return {};
      case 'CreateKeysAndCertificateCommand': {
        const arn = `arn:aws:iot:us-east-1:1:cert/new${++n}`;
        state.certs[arn] = 'ACTIVE';
        return { certificateArn: arn, certificatePem: '-----BEGIN CERTIFICATE-----', keyPair: { PrivateKey: '-----BEGIN RSA PRIVATE KEY-----' } };
      }
      case 'AttachPolicyCommand': return {};
      case 'AttachThingPrincipalCommand': state.things[input.thingName].push(input.principal); return {};
      case 'UpdateCertificateCommand': state.certs[`arn:aws:iot:us-east-1:1:cert/${input.certificateId}`] = input.newStatus; return {};
      case 'DetachThingPrincipalCommand':
        state.things[input.thingName] = (state.things[input.thingName] || []).filter((p) => p !== input.principal);
        return {};
      case 'DeleteCertificateCommand': delete state.certs[`arn:aws:iot:us-east-1:1:cert/${input.certificateId}`]; return {};
      case 'DeleteThingCommand':
        if (!state.things[input.thingName]) throw notFound();
        if (state.things[input.thingName].length) throw new Error('principals still attached');
        delete state.things[input.thingName];
        return {};
      default: throw new Error(`unexpected ${name}`);
    }
  };
  return { send, cmds, state };
}

test('a new device gets a Thing named by its id and one active certificate', async () => {
  const iot = fakeIot();
  const out = await things.issueCertificate(iot, 'my-deck-7k4m2q', 'edge-policy');
  assert.strictEqual(out.reattached, false);
  assert.deepStrictEqual(iot.state.things['my-deck-7k4m2q'], [out.certificateArn]);
  assert.strictEqual(iot.state.certs[out.certificateArn], 'ACTIVE');
  assert.ok(out.privateKey.includes('PRIVATE KEY'));
});

test('the same device paired again keeps its Thing; its old certificates stop working', async () => {
  const old = 'arn:aws:iot:us-east-1:1:cert/old1';
  const iot = fakeIot({ things: { 'my-deck-7k4m2q': [old] } });
  const out = await things.issueCertificate(iot, 'my-deck-7k4m2q', 'edge-policy');
  assert.strictEqual(out.reattached, true);
  assert.ok(!iot.state.calls.includes('CreateThing'), 'the existing Thing is kept');
  assert.deepStrictEqual(iot.state.things['my-deck-7k4m2q'], [out.certificateArn]);
  assert.ok(!(old in iot.state.certs), 'the old certificate is revoked and deleted');
  // revoked only after the new one is attached, so a failure in between never strands the device
  assert.ok(iot.state.calls.indexOf('AttachThingPrincipal') < iot.state.calls.indexOf('UpdateCertificate'));
});

test('a failed attempt cleans up; an existing device is left as it was', async () => {
  const fresh = fakeIot({ failOn: 'AttachThingPrincipalCommand' });
  await assert.rejects(things.issueCertificate(fresh, 'new-dev-aaaaaa', 'p'));
  assert.deepStrictEqual(fresh.state.things, {}, 'the Thing this attempt made is deleted');
  assert.ok(Object.values(fresh.state.certs).every((s) => s !== 'ACTIVE'), 'no active certificate is left behind');

  const old = 'arn:aws:iot:us-east-1:1:cert/old1';
  const existing = fakeIot({ things: { 'my-deck-7k4m2q': [old] }, failOn: 'AttachThingPrincipalCommand' });
  await assert.rejects(things.issueCertificate(existing, 'my-deck-7k4m2q', 'p'));
  assert.deepStrictEqual(existing.state.things['my-deck-7k4m2q'], [old], 'still connects with what it had');
  assert.strictEqual(existing.state.certs[old], 'ACTIVE');
});

test('removing a device revokes every certificate and deletes its Thing', async () => {
  const certs = ['arn:aws:iot:us-east-1:1:cert/a', 'arn:aws:iot:us-east-1:1:cert/b'];
  const iot = fakeIot({ things: { 'rig-abc123': [...certs] } });
  const out = await things.removeThing(iot, 'rig-abc123', { delayMs: 1 });
  assert.deepStrictEqual(out, { revoked: 2, thingDeleted: true });
  assert.ok(!('rig-abc123' in iot.state.things));
  assert.deepStrictEqual(await things.removeThing(iot, 'rig-abc123', { delayMs: 1 }), { revoked: 0, thingDeleted: false },
    'removing twice is harmless');
});
