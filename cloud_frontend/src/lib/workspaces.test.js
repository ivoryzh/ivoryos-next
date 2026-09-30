'use strict';

// Sessions, ownership and platforms in the LAN store (the Supabase store implements the same
// operations; see migrations/0011). Ownership is what keeps one workspace's devices, runs and
// schedules out of another's lists, so its edge cases are pinned here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSqliteStore } = require('./store/sqlite.js');

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-ws-'));
  const store = createSqliteStore(path.join(dir, 'test.db'));
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return store;
}

test('a session keeps its workspaces and moves between them', async (t) => {
  const store = freshStore(t);
  const workspaces = [{ id: 'user:u1', kind: 'personal', name: 'Personal' }, { id: 'org:o1', kind: 'org', name: 'Hein Lab' }];
  await store.createSession({ id: 's1', user_id: 'u1', email: 'a@b.c', workspace_id: 'user:u1', workspaces, expires_at: '2099-01-01T00:00:00Z' });
  let s = await store.getSession('s1');
  assert.deepStrictEqual(s.workspaces.map((w) => w.id), ['user:u1', 'org:o1']);
  await store.updateSession('s1', { workspace_id: 'org:o1', not_a_column: 'ignored' });
  s = await store.getSession('s1');
  assert.strictEqual(s.workspace_id, 'org:o1');
  await store.purgeExpiredSessions('2100-01-01T00:00:00Z');
  assert.strictEqual(await store.getSession('s1'), null);
});

test('ownership: each thing has one workspace, and lists never cross', async (t) => {
  const store = freshStore(t);
  await store.setOwner('device', 'pump', 'user:u1');
  await store.setOwner('device', 'collector', 'org:o1');
  await store.setOwner('run', 'run_1', 'org:o1');
  assert.deepStrictEqual(await store.listOwned('device', 'user:u1'), ['pump']);
  assert.deepStrictEqual(await store.listOwned('device', 'org:o1'), ['collector']);
  assert.strictEqual(await store.getOwner('run', 'run_1'), 'org:o1');
  assert.strictEqual(await store.getOwner('run', 'pump'), null, 'kinds are separate');
  await store.setOwner('device', 'pump', 'org:o1'); // re-pairing into another workspace moves it
  assert.deepStrictEqual((await store.listOwned('device', 'org:o1')).sort(), ['collector', 'pump']);
  await store.deleteOwner('device', 'pump');
  assert.deepStrictEqual(await store.listOwnedKeys('device'), ['collector']);
});

test('platforms belong to a workspace', async (t) => {
  const store = freshStore(t);
  await store.upsertPlatform({ id: 'p1', workspace_id: 'org:o1', name: 'Flow rig', device_ids: ['pump', 'collector'] });
  await store.upsertPlatform({ id: 'p2', workspace_id: 'user:u1', name: 'Mine', device_ids: [] });
  assert.deepStrictEqual((await store.listPlatforms('org:o1')).map((p) => [p.name, p.device_ids]), [['Flow rig', ['pump', 'collector']]]);
  await store.deletePlatform('p1', 'user:u1'); // another workspace cannot delete it
  assert.strictEqual((await store.listPlatforms('org:o1')).length, 1);
  await store.deletePlatform('p1', 'org:o1');
  assert.strictEqual((await store.listPlatforms('org:o1')).length, 0);
});
