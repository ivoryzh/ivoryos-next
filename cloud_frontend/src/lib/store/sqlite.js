'use strict';

/**
 * LAN-mode storage: a single SQLite file shared by the Next app and `daemon.js`.
 *
 * Why a file rather than the daemon holding state in memory: these are two separate processes
 * (a Next route is request-scoped and must not own the broker connection — see AGENTS.md), so
 * they need somewhere to meet. A file also survives a daemon restart mid-run, which an in-memory
 * map does not; that was one of the original sins of the deleted orchestrator.ts.
 *
 * Two processes on one SQLite file is fine specifically because of WAL + busy_timeout below:
 * WAL lets a reader and a writer work concurrently instead of blocking each other, and
 * busy_timeout makes a contended write wait rather than throwing SQLITE_BUSY. The Python edge
 * server already runs this exact configuration (`ivoryos_edge.db-wal`), so it is a known quantity
 * on this project's machines.
 *
 * `node:sqlite` is built into Node 22 — no native build, no node-gyp, nothing to install on
 * Windows. It is still flagged experimental and prints a warning on import; `npm run daemon`
 * silences just that one warning class.
 *
 * Schema mirrors supabase/migrations/0001..0003 closely enough that a graph authored in one mode
 * means the same thing in the other. Differences are only where Postgres types have no SQLite
 * equivalent: jsonb columns are TEXT holding JSON (serialised on the way in, parsed on the way
 * out, so callers never see the difference), and timestamptz columns are ISO-8601 TEXT, which
 * sorts and compares correctly as long as everything written is UTC — `new Date().toISOString()`
 * always is.
 */

const path = require('path');
const fs = require('fs');

/**
 * `require('node:sqlite')` directly would work in the daemon but breaks inside Next: Turbopack
 * tries to resolve the import at build time and fails with "Unsupported external type Url for
 * commonjs reference", because it has no externalization rule for this builtin. The health route
 * surfaced it as a store error rather than a crash, which is how it was caught.
 *
 * `process.getBuiltinModule` (Node 22.3+) exists precisely for this: it reaches a builtin at
 * runtime without leaving a static import for a bundler to trip over. The require() fallback
 * keeps the daemon working on a runtime that predates it.
 */
function loadSqlite() {
  if (typeof process.getBuiltinModule === 'function') {
    return process.getBuiltinModule('node:sqlite');
  }
  return require('node:sqlite');
}

const SCHEMA = `
create table if not exists devices (
    id text primary key,
    name text not null default '',
    status text not null default 'offline',
    -- 1 while the device reports a run in progress or queued there (bench runs included).
    busy integer not null default 0,
    last_seen text,
    schema text not null default '{}',
    -- A picture of the bench, set from the Devices page: a small data: URL (the browser scales it
    -- down before upload). Never read by listDevices, which is polled; see getDeviceImage.
    image text,
    image_updated_at text,
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists edge_sequences (
    device_id text not null,
    name text not null,
    description text not null default '',
    body text not null default '{}',
    updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    primary key (device_id, name)
);

create table if not exists runs (
    id text primary key,
    name text not null default '',
    status text not null default 'running',
    nodes text not null default '[]',
    edges text not null default '[]',
    -- A run submitted "after current work" starts 'queued' and waits for these runs (the ones with
    -- work open on its devices at submission) to have nothing left open. See daemon.js.
    after_runs text not null default '[]',
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists run_tasks (
    run_id text not null,
    node_id text not null,
    device_id text not null,
    block text not null default '{}',
    status text not null default 'blocked',
    -- The full run payload for a step that is more than one call: a spreadsheet, an optimization
    -- campaign, or a merged linear chain. Null means "dispatch the bare block", which keeps an
    -- ordinary instrument step at its original size on the wire (AWS IoT meters in 5KB steps).
    run text,
    -- Every canvas node this one task covers. Length 1 unless a chain was merged; the status
    -- route fans one status back out over all of them so a merged chain still lights up whole.
    members text not null default '[]',
    -- A node re-run on its own cadence inside the run: "every 20 minutes, 12 times". 0 for the
    -- interval means it runs once, which is every node that has no cadence set.
    repeat_every_ms integer not null default 0,
    repeat_total integer not null default 0,
    repeat_done integer not null default 0,
    -- Earliest this task may be dispatched. Set when a repeat is scheduled; a pending task whose
    -- time has not come is simply not picked up yet.
    not_before text,
    dispatched_at text,
    -- The device's latest progress summary for this task (JSON, see run_progress_summary in the
    -- edge's queue.py): steps done/total, current step, row. Cleared when the task is dispatched.
    progress text,
    -- The finished run's record as the device sent it (edge queue.build_cloud_result): the same
    -- parameters + steps shape the edge's Data History reads, so Cloud builds the same datasheet.
    result text,
    -- Every occurrence's record for a repeating task (JSON array, oldest first); see setTaskResult.
    results text,
    -- A decision made in Cloud about a task its device has stopped on -- an answer, or
    -- retry/skip/stop on an error -- until the device shows it took effect. JSON:
    -- {action, value, pause, state: 'pending'|'sent', sent_at, attempts}. See daemon.js
    -- sendTaskCommands.
    command text,
    updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    primary key (run_id, node_id)
);

create index if not exists run_tasks_status_idx on run_tasks(status);

-- Recurring triggers. A schedule stores an ALREADY-PLANNED run — its tasks exactly as planRun
-- produced them — rather than a graph to re-plan on every firing. Two reasons: daemon.js has no
-- build step and cannot import the TypeScript that builds run payloads, and a schedule that fires
-- unattended every ten minutes should replay something a person validated once, not re-derive it
-- from a canvas nobody is looking at.
-- The Orchestrator's saved multi-device graphs (the Library's "Distributed" workflows). Kept
-- here rather than in one browser's localStorage, where they used to live: a workflow saved on
-- one machine did not exist on any other, which is not what a shared Cloud library is for.
create table if not exists cloud_workflows (
    name text primary key,
    description text not null default '',
    nodes text not null default '[]',
    edges text not null default '[]',
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists schedules (
    id text primary key,
    name text not null default '',
    enabled integer not null default 1,
    -- 'interval' (every N ms) or 'once' (at a fixed time).
    trigger_type text not null default 'interval',
    every_ms integer not null default 0,
    -- Graph and plan, stored together so a firing is a pure copy.
    nodes text not null default '[]',
    edges text not null default '[]',
    tasks text not null default '[]',
    -- 0 means "until it is disabled".
    max_runs integer not null default 0,
    runs_fired integer not null default 0,
    next_fire_at text,
    last_fire_at text,
    last_run_id text,
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists schedules_due_idx on schedules(enabled, next_fire_at);

-- The daemon's liveness beacon, read by /api/health. One row, id='daemon'. Deliberately a table
-- and not a pid file: the Next app may not share a filesystem with the daemon in cloud mode, and
-- the health check must work identically in both.
-- Signed-in sessions (src/lib/auth.ts). The browser holds only the random id, in an http-only
-- cookie; the IvoryOS tokens stay here, so a self-hosted Cloud keeps a session working offline.
create table if not exists sessions (
    id text primary key,
    user_id text not null,
    email text,
    name text,
    access_token text,
    refresh_token text,
    token_expires_at integer not null default 0,
    workspace_id text not null,
    workspaces text not null default '[]',
    workspaces_checked_at text,
    expires_at text not null,
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen text
);

-- Which workspace owns what (src/lib/workspace.ts): a device, a run, a library workflow, a
-- schedule, a pairing code. Kept apart from those tables so the daemon, which works on every
-- workspace's tasks alike, never has to know workspaces exist.
create table if not exists ownership (
    kind text not null,
    key text not null,
    workspace_id text not null,
    primary key (kind, key)
);
create index if not exists ownership_workspace_idx on ownership(kind, workspace_id);

-- Platforms: named groups of edges inside a workspace ("Flow rig" = pump + collector).
create table if not exists edge_platforms (
    id text primary key,
    workspace_id text not null,
    name text not null,
    device_ids text not null default '[]',
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists cloud_status (
    id text primary key,
    broker_connected integer not null default 0,
    broker_url text not null default '',
    mode text not null default '',
    store_location text not null default '',
    last_seen text
);

-- Broker chosen in the UI. One row, id='broker'. Absent until someone sets it, in which case the
-- env vars still decide (see store/index.js resolveBrokerUrl).
create table if not exists cloud_config (
    id text primary key,
    host text not null default '',
    port integer not null default 1883,
    updated_at text
);

-- Small named settings (the assistant's model provider, for one). cloud_config above is typed
-- for the broker alone, so anything else goes here as JSON text under a key.
create table if not exists cloud_settings (
    key text primary key,
    value text not null,
    updated_at text
);

-- An outside agent (an MCP client) proves who it is with a token minted in Settings; only the
-- hash is kept, and a token stands for one workspace.
create table if not exists agent_tokens (
    token_hash text primary key,
    workspace_id text not null,
    user_id text not null default '',
    label text not null default '',
    created_at text,
    last_used_at text
);
create index if not exists agent_tokens_workspace_idx on agent_tokens(workspace_id);

-- What an agent proposed: a graph spec, the canvas graph built from it, and its verdict. Nothing
-- here is a workflow or a run until a person accepts it (the human gate).
-- A proposal answers one person's question, so accepting it is that person's decision: rows carry
-- the user who filed them (through the panel, or the minter of the token an outside agent used)
-- and are listed to that user only, even inside a shared organization workspace.
create table if not exists agent_proposals (
    id text primary key,
    workspace_id text not null,
    user_id text not null default '',
    name text not null,
    summary text not null default '',
    source text not null default '',
    spec text not null,
    graph text,
    issues text not null default '[]',
    questions text not null default '[]',
    status text not null default 'pending',
    result text,
    created_at text,
    decided_at text
);
create index if not exists agent_proposals_ws_status_idx on agent_proposals(workspace_id, user_id, status);

-- Outbox for Cloud -> Edge workflow writes. 'pending' -> 'sent' (published) -> 'acked' (the
-- device echoed the same body_hash back on its own sequences topic). A push that never reaches
-- 'acked' is a push that did not take effect, which is exactly what the UI needs to know.
create table if not exists sequence_pushes (
    device_id text not null,
    name text not null,
    body text not null default '{}',
    body_hash text not null default '',
    status text not null default 'pending',
    updated_at text,
    primary key (device_id, name)
);

create index if not exists sequence_pushes_status_idx on sequence_pushes(status);

-- Device pairing (src/lib/pairing.js): the edge starts a request and shows its code, a signed-in
-- person approves it, the edge collects its credentials with the secret only it holds.
-- status: waiting -> approved -> provisioning -> redeemed, or waiting -> denied.
create table if not exists pairing_requests (
    code text primary key,
    secret_hash text not null unique,
    requested_id text,                       -- the device's own lasting id (edge CLOUD_DEVICE_ID)
    device_name text not null default '',
    instruments text not null default '[]',
    status text not null default 'waiting',
    device_id text,
    created_at text,
    expires_at text not null,
    approved_at text,
    redeemed_at text
);

-- Devices removed from Cloud (their Devices page, or the device leaving). A device that is still
-- running, or a retained message the broker replays, would otherwise register it again from its
-- next heartbeat; the daemon ignores these ids until the device is paired again.
create table if not exists removed_devices (
    id text primary key,
    removed_at text not null
);

-- Each device's secret for the LAN broker (brokerAuth.js), as a hash only. Minted at pairing,
-- replaced by pairing again, deleted with the device.
create table if not exists broker_credentials (
    device_id text primary key,
    secret_hash text not null,
    created_at text not null
);
`;

function jsonParse(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

const nowIso = () => new Date().toISOString();
const parseJson = (text, fallback) => { try { return text == null ? fallback : JSON.parse(text); } catch { return fallback; } };
const mapProposal = (r) => ({
  ...r, spec: parseJson(r.spec, {}), graph: parseJson(r.graph, null), issues: parseJson(r.issues, []), questions: parseJson(r.questions, []),
});

/**
 * When a repeating task's next occurrence is due: `repeat_every_ms` after the previous one STARTED
 * (it was dispatched), not after it finished -- "every 10 minutes" means the changes land 10
 * minutes apart, however long each takes. Never in the past: an occurrence that overran its
 * interval is followed at once rather than skipped. Without a dispatch time, from now.
 */
function nextOccurrenceAt(row, now = Date.now()) {
  const started = Date.parse(row && row.dispatched_at || '');
  const base = Number.isNaN(started) ? now : started;
  return new Date(Math.max(now, base + ((row && row.repeat_every_ms) || 0))).toISOString();
}

/** Add one device record to a task's occurrences, replacing a redelivered copy of the same run. */
function appendOccurrence(results, result) {
  if (!result) return results || [];
  const kept = (Array.isArray(results) ? results : [])
    .filter((r) => result.edgeRunId === undefined || r.edgeRunId !== result.edgeRunId);
  return [...kept, result];
}

/** Row -> task, with the two JSON columns parsed. `run` stays null for a plain single-step task. */
function hydrateTask(r) {
  return {
    ...r,
    block: jsonParse(r.block, {}),
    run: r.run ? jsonParse(r.run, null) : null,
    progress: r.progress ? jsonParse(r.progress, null) : null,
  };
}

/**
 * A repeating node's next occurrence is pending but not yet due. Filtered here rather than in SQL
 * so the Supabase backend can apply the identical predicate to rows its own query returns —
 * "ready" has to mean the same thing in both modes or a repeat fires early in one of them.
 */
function hydrateSchedule(row) {
  return {
    ...row,
    enabled: !!row.enabled,
    nodes: jsonParse(row.nodes, []),
    edges: jsonParse(row.edges, []),
    tasks: jsonParse(row.tasks, []),
  };
}

function isDue(task, now = Date.now()) {
  if (!task || !task.not_before) return true;
  const at = Date.parse(task.not_before);
  return Number.isNaN(at) || at <= now;
}

function createSqliteStore(filePath) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(resolved);
  // Order matters: WAL must be set before the first write, and busy_timeout before any
  // contention. Without busy_timeout the daemon's 5s device-sweep and a browser poll landing
  // together surface as an SQLITE_BUSY throw rather than a brief wait.
  db.exec('pragma journal_mode = WAL');
  db.exec('pragma busy_timeout = 5000');
  db.exec('pragma foreign_keys = on');
  db.exec(SCHEMA);
  // Lightweight forward-migration for a database file created before store_location existed.
  // `create table if not exists` above does not add columns to an existing table, and a dev
  // machine will already have a file from the previous shape.
  // Columns added after the first release. `alter table` on a table that already has them throws,
  // which is the intended no-op — the same shape as the store_location migration below.
  for (const ddl of [
    'alter table run_tasks add column run text',
    "alter table run_tasks add column members text not null default '[]'",
    'alter table run_tasks add column repeat_every_ms integer not null default 0',
    'alter table run_tasks add column repeat_total integer not null default 0',
    'alter table run_tasks add column repeat_done integer not null default 0',
    'alter table run_tasks add column not_before text',
    'alter table run_tasks add column progress text',
    'alter table run_tasks add column result text',
    'alter table devices add column busy integer not null default 0',
    'alter table run_tasks add column command text',
    'alter table devices add column image text',
    'alter table devices add column image_updated_at text',
    'alter table run_tasks add column results text',
    "alter table runs add column after_runs text not null default '[]'",
    'alter table pairing_requests add column requested_id text',
  ]) {
    try { db.exec(ddl); } catch { /* column already present */ }
  }
  try { db.exec("alter table cloud_status add column store_location text not null default ''"); }
  catch { /* column already present */ }

  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);

  const mapDevice = (row) => row && ({
    id: row.id,
    name: row.name,
    status: row.status,
    busy: !!row.busy,
    last_seen: row.last_seen,
    schema: jsonParse(row.schema, {}),
    // Changes whenever the picture does, so it can key the image URL and bust the cache.
    image_version: row.image_updated_at || null,
  });

  const mapSequence = (row) => row && ({
    device_id: row.device_id,
    name: row.name,
    description: row.description,
    body: jsonParse(row.body, {}),
    updated_at: row.updated_at,
    created_at: row.created_at,
  });

  return {
    backend: 'sqlite',
    location: resolved,

    async ping() {
      get('select 1 as ok');
      return { ok: true, backend: 'sqlite', location: resolved };
    },

    // --- devices -------------------------------------------------------------------------
    // Status and schema arrive on separate MQTT topics and must not clobber each other: a status
    // ping carries no schema, and writing one row with both fields would blank the schema every
    // 5 seconds. Hence two narrow upserts that each touch only their own column.
    async upsertDeviceStatus(deviceId, status, busy = false) {
      run(
        `insert into devices (id, status, busy, last_seen) values (?, ?, ?, ?)
         on conflict(id) do update set status = excluded.status, busy = excluded.busy, last_seen = excluded.last_seen`,
        deviceId, status, busy ? 1 : 0, nowIso(),
      );
    },

    async upsertDeviceSchema(deviceId, schema) {
      run(
        `insert into devices (id, schema, last_seen) values (?, ?, ?)
         on conflict(id) do update set schema = excluded.schema, last_seen = excluded.last_seen`,
        deviceId, JSON.stringify(schema ?? {}), nowIso(),
      );
    },

    async upsertDevicePlaceholder(deviceId, name) {
      run(
        `insert into devices (id, name, status) values (?, ?, 'offline')
         on conflict(id) do update set name = excluded.name`,
        deviceId, name,
      );
    },

    /** A device's display name; its id (identity) is untouched. False if there is no such device. */
    async renameDevice(deviceId, name) {
      return run('update devices set name = ? where id = ?', name, deviceId).changes > 0;
    },

    /** The hash of a device's LAN broker secret (brokerAuth.js); one per device, replaced on re-pairing. */
    async setBrokerCredential(deviceId, secretHash) {
      run(
        `insert into broker_credentials (device_id, secret_hash, created_at) values (?, ?, ?)
         on conflict(device_id) do update set secret_hash = excluded.secret_hash, created_at = excluded.created_at`,
        deviceId, secretHash, nowIso(),
      );
    },

    async getBrokerCredential(deviceId) {
      return get('select secret_hash from broker_credentials where device_id = ?', deviceId)?.secret_hash || null;
    },

    async deleteBrokerCredential(deviceId) {
      run('delete from broker_credentials where device_id = ?', deviceId);
    },

    // A fixed order (by name, which is the id), never by last_seen: every device's heartbeat
    // bumps last_seen every 5 s, so with several devices that order reshuffled on every poll and
    // every list built from it -- the Orchestrator toolbox, Devices, the sidebar -- jumped around.
    // A removed device's kept record (status 'removed', see archiveDevice) is not a device anyone
    // can run on, so it is left out unless asked for: only the Library, which lists the workflows
    // kept from it, wants it.
    async listDevices({ includeRemoved = false } = {}) {
      return all('select id, name, status, busy, last_seen, schema, image_updated_at from devices order by id collate nocase, id')
        .map(mapDevice).filter((d) => includeRemoved || d.status !== 'removed');
    },

    /** Returns whether the device exists. `image` null removes the picture. */
    async setDeviceImage(deviceId, image) {
      const res = run('update devices set image = ?, image_updated_at = ? where id = ?',
        image, image ? nowIso() : null, deviceId);
      return res.changes > 0;
    },

    async getDeviceImage(deviceId) {
      const row = get('select image, image_updated_at from devices where id = ?', deviceId);
      return row && row.image ? { image: row.image, updated_at: row.image_updated_at } : null;
    },

    /** Cloud tasks not yet sent anywhere: ready but held (`pending`) or waiting on others (`blocked`). */
    /** A task's repeat counters, for numbering an occurrence and spotting a report from an earlier one. */
    async getTaskRepeat(runId, nodeId) {
      return get(
        'select status, repeat_total, repeat_done, repeat_every_ms, dispatched_at from run_tasks where run_id = ? and node_id = ?',
        runId, nodeId,
      ) || null;
    },
    /** Repeating tasks that still have occurrences to run, for telling a device what is to come. */
    async listRepeatingTasks() {
      return all(
        `select t.run_id, t.node_id, t.device_id, t.status, t.block, t.not_before, t.repeat_total, t.repeat_done,
                t.repeat_every_ms, r.name as run_name
         from run_tasks t left join runs r on r.id = t.run_id
         where t.repeat_total > 1 and t.status in ('pending', 'queued', 'running', 'waiting_input')
         order by t.updated_at asc`,
      ).map(r => ({ ...r, block: jsonParse(r.block, {}) }));
    },
    async listWaitingTasks() {
      return all(
        `select t.run_id, t.node_id, t.device_id, t.status, t.block, t.not_before, r.name as run_name
         from run_tasks t left join runs r on r.id = t.run_id
         where t.status in ('pending', 'blocked') order by t.updated_at asc`,
      ).map(r => ({ ...r, block: jsonParse(r.block, {}) }));
    },

    /**
     * `result` is the latest record; `results` keeps every occurrence of a repeating task ("every
     * 5 minutes, 3 times" is three runs on the device, and used to leave only the last one here).
     * Keyed on the device's run id, so a redelivered message replaces its entry, not duplicates it.
     */
    async setTaskResult(runId, nodeId, result) {
      const row = get('select results from run_tasks where run_id = ? and node_id = ?', runId, nodeId);
      const results = appendOccurrence(row ? jsonParse(row.results, []) : [], result);
      run('update run_tasks set result = ?, results = ? where run_id = ? and node_id = ?',
        JSON.stringify(result ?? null), JSON.stringify(results), runId, nodeId);
    },

    /** Every task of one Cloud run with whatever its device sent back -- one experiment's record. */
    async listRunTaskRecords(runId) {
      return all(
        `select node_id, device_id, status, dispatched_at, updated_at, result, results, progress, command
         from run_tasks where run_id = ?`,
        runId,
      ).map(r => ({
        ...r,
        result: r.result ? jsonParse(r.result, null) : null,
        results: r.results ? jsonParse(r.results, []) : [],
        progress: r.progress ? jsonParse(r.progress, null) : null,
        command: r.command ? jsonParse(r.command, null) : null,
      }));
    },

    async getTaskResult(runId, nodeId) {
      const row = get(
        `select t.run_id, t.node_id, t.device_id, t.status, t.updated_at, t.result, r.name as run_name
         from run_tasks t left join runs r on r.id = t.run_id where t.run_id = ? and t.node_id = ?`,
        runId, nodeId,
      );
      return row ? { ...row, result: row.result ? jsonParse(row.result, null) : null } : null;
    },

    /** Recent tasks that have a synced result, newest first -- summaries only, not the steps. */
    async listTaskResults(limit) {
      return all(
        `select t.run_id, t.node_id, t.device_id, t.status, t.updated_at, r.name as run_name,
                json_extract(t.result, '$.name') as name,
                json_extract(t.result, '$.edgeRunId') as edge_run_id,
                json_extract(t.result, '$.status') as result_status,
                json_extract(t.result, '$.parameters._issues') as issues,
                json_extract(t.result, '$.end_time') as end_time,
                json_array_length(t.result, '$.steps') as step_count
         from run_tasks t left join runs r on r.id = t.run_id
         where t.result is not null order by t.updated_at desc limit ?`,
        limit,
      );
    },

    /** Offline because it went quiet: unlike a status it sent, this must not move `last_seen`. */
    async markDeviceOffline(deviceId) {
      run(`update devices set status = 'offline', busy = 0 where id = ? and status = 'online'`, deviceId);
    },
    async getSequence(deviceId, name) {
      const row = get('select device_id, name, description, body, updated_at from edge_sequences where device_id = ? and name = ?', deviceId, name);
      return row ? { ...row, body: jsonParse(row.body, {}) } : null;
    },
    async markStaleDevicesOffline(staleBeforeIso) {
      const res = run(
        `update devices set status = 'offline' where status = 'online' and last_seen < ?`,
        staleBeforeIso,
      );
      return res.changes;
    },

    async countActiveDeviceTasks(deviceId, activeStatuses) {
      // The caller owns the status list (see dag.js) so this stays the one place that knows how
      // to query, and never a second place that knows what "active" means.
      const marks = activeStatuses.map(() => '?').join(',');
      const row = get(
        `select count(*) as c from run_tasks where device_id = ? and status in (${marks})`,
        deviceId, ...activeStatuses,
      );
      return row ? row.c : 0;
    },

    // Removes the device and the rows that exist only to serve it: its mirrored sequence library
    // and any queued pushes, both of which are caches of device state and meaningless once it is
    // gone. `run_tasks` is deliberately left alone — those are history, and a finished run that
    // named a since-removed device is still a truthful record of what actually ran.
    /**
     * Take a device out of Cloud but keep the workflows mirrored from it, as a record.
     *
     * The workflows move to `archiveId`, with a 'removed' device record of that id holding the
     * name and the instrument schema they were written against (so they can still be read).
     * The live id is freed completely: pairing the same device again, in any workspace, starts a
     * new device, and nothing it publishes can touch the kept copies. A device with no workflows
     * leaves nothing behind. Returns {removed, archived, workflows}.
     */
    async archiveDevice(deviceId, archiveId) {
      const device = get('select name, last_seen, schema from devices where id = ?', deviceId);
      const count = get('select count(*) as n from edge_sequences where device_id = ?', deviceId).n;
      const keep = !!device && count > 0;
      if (keep) {
        run(
          `insert into devices (id, name, status, busy, last_seen, schema) values (?, ?, 'removed', 0, ?, ?)`,
          archiveId, device.name || deviceId, device.last_seen, device.schema,
        );
        run('update edge_sequences set device_id = ? where device_id = ?', archiveId, deviceId);
      }
      run('delete from edge_sequences where device_id = ?', deviceId);
      run('delete from sequence_pushes where device_id = ?', deviceId);
      const res = run('delete from devices where id = ?', deviceId);
      return { removed: res.changes, archived: keep ? archiveId : null, workflows: keep ? count : 0 };
    },
    async deleteDevice(deviceId) {
      run('delete from edge_sequences where device_id = ?', deviceId);
      run('delete from sequence_pushes where device_id = ?', deviceId);
      const res = run('delete from devices where id = ?', deviceId);
      return res.changes;
    },

    // --- edge sequences ------------------------------------------------------------------
    async upsertSequence({ device_id, name, description, body }) {
      run(
        `insert into edge_sequences (device_id, name, description, body, updated_at)
         values (?, ?, ?, ?, ?)
         on conflict(device_id, name) do update set
           description = excluded.description,
           body = excluded.body,
           updated_at = excluded.updated_at`,
        device_id, name, description || '', JSON.stringify(body ?? {}), nowIso(),
      );
    },

    async deleteSequence(deviceId, name) {
      const res = run('delete from edge_sequences where device_id = ? and name = ?', deviceId, name);
      return res.changes > 0;
    },

    async listSequences(deviceId) {
      const rows = deviceId
        ? all('select * from edge_sequences where device_id = ? order by updated_at desc', deviceId)
        : all('select * from edge_sequences order by updated_at desc');
      return rows.map(mapSequence);
    },

    // --- runs ----------------------------------------------------------------------------
    async insertRun({ id, name, status, nodes, edges, after_runs }) {
      run(
        'insert into runs (id, name, status, nodes, edges, after_runs) values (?, ?, ?, ?, ?, ?)',
        id, name || '', status || 'running', JSON.stringify(nodes ?? []), JSON.stringify(edges ?? []),
        JSON.stringify(after_runs ?? []),
      );
    },

    /**
     * Runs with work still open on any of these devices -- running, sent, ready or waiting on an
     * earlier step (a repeat's next occurrence included) -- oldest first. Judged by the tasks, not
     * the run's own status, so a run left marked 'running' by an old failure holds nothing up.
     */
    async listOpenRunsOnDevices(deviceIds) {
      if (!deviceIds.length) return [];
      const marks = deviceIds.map(() => '?').join(',');
      return all(
        `select r.id, r.name, count(*) as open_tasks, min(r.created_at) as created_at
         from run_tasks t join runs r on r.id = t.run_id
         where t.device_id in (${marks}) and t.status in ('pending','blocked','queued','running')
         group by r.id order by created_at asc`,
        ...deviceIds,
      );
    },

    /** Whether any of these runs still has a task that has not finished. */
    async runsHaveOpenTasks(runIds) {
      if (!runIds.length) return false;
      const marks = runIds.map(() => '?').join(',');
      return !!get(
        `select 1 as open from run_tasks
         where run_id in (${marks}) and status in ('pending','blocked','queued','running') limit 1`,
        ...runIds,
      );
    },

    async listQueuedRuns() {
      return all(`select id, name, after_runs from runs where status = 'queued' order by created_at asc`)
        .map(r => ({ ...r, after_runs: jsonParse(r.after_runs, []) }));
    },

    /** Compare-and-set, so two sweeps cannot both start one queued run. */
    async updateRunStatusFrom(runId, fromStatus, toStatus) {
      const res = run('update runs set status = ?, updated_at = ? where id = ? and status = ?',
        toStatus, nowIso(), runId, fromStatus);
      return res.changes > 0;
    },

    async getRun(runId) {
      const row = get('select id, name, status, nodes, edges from runs where id = ?', runId);
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        status: row.status,
        nodes: jsonParse(row.nodes, []),
        edges: jsonParse(row.edges, []),
      };
    },

    /** How many runs are already called `base` or `base #N`, for numbering the next one. */
    async countRunsNamed(base) {
      return get(`select count(*) as c from runs where name = ? or name like ?`, base, `${base} #%`).c;
    },

    async updateRunStatus(runId, status) {
      run('update runs set status = ?, updated_at = ? where id = ?', status, nowIso(), runId);
    },

    // --- run tasks -----------------------------------------------------------------------
    async insertTasks(tasks) {
      if (!tasks.length) return;
      const stmt = db.prepare(
        `insert into run_tasks
           (run_id, node_id, device_id, block, run, members, status,
            repeat_every_ms, repeat_total, not_before)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // One transaction so a run is either fully planned or not planned at all — a partial insert
      // would leave a run whose graph is missing steps, which would then "complete" early.
      db.exec('begin');
      try {
        for (const t of tasks) {
          stmt.run(
            t.run_id, t.node_id, t.device_id,
            JSON.stringify(t.block ?? {}),
            t.run ? JSON.stringify(t.run) : null,
            JSON.stringify(t.members ?? [t.node_id]),
            t.status,
            t.repeat_every_ms || 0,
            t.repeat_total || 0,
            t.not_before || null,
          );
        }
        db.exec('commit');
      } catch (e) {
        db.exec('rollback');
        throw e;
      }
    },

    async listRunTasks(runId) {
      return all(
        `select node_id, status, members, repeat_every_ms, repeat_total, repeat_done, progress
         from run_tasks where run_id = ?`,
        runId,
      ).map(r => ({ ...r, members: jsonParse(r.members, [r.node_id]), progress: r.progress ? jsonParse(r.progress, null) : null }));
    },

    async listRecentTasks(limit) {
      return all(
        `select t.run_id, t.node_id, t.device_id, t.status, t.members, t.progress, t.command, t.updated_at,
                t.repeat_total, t.repeat_done, t.not_before,
                json_extract(t.result, '$.edgeRunId') as edge_run_id, r.status as run_status
         from run_tasks t left join runs r on r.id = t.run_id order by t.updated_at desc limit ?`,
        limit,
      ).map(r => ({
        ...r,
        members: jsonParse(r.members, [r.node_id]),
        progress: r.progress ? jsonParse(r.progress, null) : null,
        command: r.command ? jsonParse(r.command, null) : null,
      }));
    },

    async listTasksByStatus(status) {
      // Oldest first: tasks now wait their turn per device (see deviceHasActiveTask), so the
      // order they are offered in is the order a device works through them.
      return all(
        `select run_id, node_id, device_id, block, run, status, not_before, dispatched_at, progress, repeat_done, repeat_total
         from run_tasks where status = ? order by updated_at asc`,
        status,
      ).map(hydrateTask).filter((t) => isDue(t));
    },

    /** True while a Cloud task is on this device: sent, running, or waiting for input there. */
    async deviceHasActiveTask(deviceId) {
      return !!get(
        `select 1 as busy from run_tasks
         where device_id = ? and status not in ('pending','blocked','completed','error','cancelled','skipped') limit 1`,
        deviceId,
      );
    },

    /**
     * SQLite has no change feed, so LAN mode polls for ready work. 400ms is imperceptible next to
     * the physical time any real instrument step takes, and the query is an indexed lookup on a
     * table with a handful of rows.
     *
     * Polling is only safe because dispatch *claims* a task with a compare-and-set before it
     * publishes (see daemon.js's dispatchTask): a second tick that sees the same row mid-flight
     * loses the CAS and does nothing, so a slow publish can't become a double dispatch to a real
     * instrument.
     */
    subscribePendingTasks(onTask, intervalMs = 400) {
      let stopped = false;
      let inFlight = false;
      const tick = async () => {
        if (stopped || inFlight) return;
        inFlight = true;
        try {
          const rows = all(
            `select run_id, node_id, device_id, block, run, status, not_before, repeat_done
             from run_tasks where status = 'pending'`,
          ).map(hydrateTask).filter((t) => isDue(t));
          for (const r of rows) {
            if (stopped) break;
            await onTask(r);
          }
        } catch (e) {
          console.error('[Store] pending-task poll failed:', e.message);
        } finally {
          inFlight = false;
        }
      };
      const timer = setInterval(tick, intervalMs);
      tick();
      return () => { stopped = true; clearInterval(timer); };
    },

    /** Terminal-status guard: returns whether a row actually moved. */
    /** `progress`, when given, replaces the task's progress summary; omitted, it is left alone. */
    async updateTaskStatusIfNotTerminal(runId, nodeId, status, terminalStatuses, progress) {
      const placeholders = terminalStatuses.map(() => '?').join(',');
      const setProgress = progress !== undefined ? ', progress = ?' : '';
      const progressArg = progress !== undefined ? [progress === null ? null : JSON.stringify(progress)] : [];
      const res = run(
        `update run_tasks set status = ?, updated_at = ?${setProgress}
         where run_id = ? and node_id = ? and status not in (${placeholders})`,
        status, nowIso(), ...progressArg, runId, nodeId, ...terminalStatuses,
      );
      return res.changes > 0;
    },

    /** Compare-and-set, for the unblock / cancel / dispatch races. */
    /**
     * Record someone's answer to a Cloud User_Input step. Only a step that is actually waiting
     * (running, on the cloud pseudo-device, not yet answered) takes it -- the first answer is the
     * answer, even inside the second before the daemon's sweep completes the step. The daemon
     * does that completing, so it stays the only process that advances a run.
     */
    async answerTaskInput(runId, nodeId, cloudDeviceId, progress) {
      const res = run(
        `update run_tasks set progress = ?, updated_at = ?
         where run_id = ? and node_id = ? and device_id = ? and status = 'running'
           and (progress is null or json_extract(progress, '$.state') is not 'answered')`,
        JSON.stringify(progress), nowIso(), runId, nodeId, cloudDeviceId,
      );
      return res.changes > 0;
    },

    /**
     * Record a decision about a task its device has stopped on. Taken only while the task is
     * still stopped on the pause the decision names -- a second click, or a decision racing the
     * bench's own answer, finds the pause gone and changes nothing.
     */
    async setTaskCommand(runId, nodeId, command) {
      const res = run(
        `update run_tasks set command = ?, updated_at = ?
         where run_id = ? and node_id = ? and status = 'running'
           and json_extract(progress, '$.pause') = ?`,
        JSON.stringify(command), nowIso(), runId, nodeId, command.pause,
      );
      return res.changes > 0;
    },

    /** Decisions not yet seen to take effect, with the progress to check them against. */
    async listTaskCommands() {
      return all(
        `select run_id, node_id, device_id, status, progress, command
         from run_tasks where command is not null`,
      ).map(r => ({ ...r, progress: r.progress ? jsonParse(r.progress, null) : null, command: jsonParse(r.command, null) }));
    },

    /** Unguarded: the daemon is the only writer after the route, and `null` clears it. */
    async updateTaskCommand(runId, nodeId, command) {
      run('update run_tasks set command = ? where run_id = ? and node_id = ?',
        command ? JSON.stringify(command) : null, runId, nodeId);
    },

    async updateTaskStatusFrom(runId, nodeId, fromStatus, toStatus, extra) {
      // A dispatch starts the task afresh (a repeat's next occurrence included), so the previous
      // occurrence's progress -- and any decision about it -- must not show against it.
      const setDispatched = extra && extra.dispatched ? ', dispatched_at = ?, progress = null, command = null' : '';
      const args = extra && extra.dispatched
        ? [toStatus, nowIso(), nowIso(), runId, nodeId, fromStatus]
        : [toStatus, nowIso(), runId, nodeId, fromStatus];
      const res = run(
        `update run_tasks set status = ?, updated_at = ?${setDispatched}
         where run_id = ? and node_id = ? and status = ?`,
        ...args,
      );
      return res.changes > 0;
    },

    /**
     * Turn a just-completed repeating task back into the next occurrence.
     *
     * Returns true when a repeat was scheduled, in which case the run has NOT advanced: a node
     * with repeats left is not finished, so nothing downstream of it may start. `repeat_total`
     * of 0 means "no repeat", which falls out of the comparison rather than needing its own case.
     *
     * Guarded on `status = 'completed'` so two task-status messages arriving together cannot
     * schedule the same occurrence twice — the same compare-and-set discipline dispatch uses.
     */
    async scheduleTaskRepeat(runId, nodeId) {
      // The count is what makes a task repeat; the interval is only the wait between runs. A
      // count with no interval means back to back -- it used to mean "never", so "2 times" with
      // the minutes box left empty silently ran once.
      const row = get(
        'select repeat_every_ms, repeat_total, dispatched_at from run_tasks where run_id = ? and node_id = ?', runId, nodeId,
      );
      if (!row || !(row.repeat_total > 1)) return false;
      const res = run(
        `update run_tasks
         set status = 'pending', repeat_done = repeat_done + 1, not_before = ?, updated_at = ?
         where run_id = ? and node_id = ? and status = 'completed'
           and repeat_total > 1 and repeat_done + 1 < repeat_total`,
        nextOccurrenceAt(row), nowIso(), runId, nodeId,
      );
      return res.changes > 0;
    },

    // --- the Cloud library of distributed workflows ----------------------------------------
    async listCloudWorkflows() {
      return all('select * from cloud_workflows order by updated_at desc').map((r) => ({
        ...r, nodes: jsonParse(r.nodes, []), edges: jsonParse(r.edges, []),
      }));
    },

    /** Insert or replace by name; `created_at` survives a re-save, `updated_at` moves. */
    async upsertCloudWorkflow({ name, description, nodes, edges, created_at, updated_at }) {
      run(
        `insert into cloud_workflows (name, description, nodes, edges, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(name) do update set description = excluded.description, nodes = excluded.nodes,
           edges = excluded.edges, updated_at = excluded.updated_at`,
        name, description || '', JSON.stringify(nodes ?? []), JSON.stringify(edges ?? []),
        created_at || nowIso(), updated_at || nowIso(),
      );
    },

    // --- schedules -----------------------------------------------------------------------
    async insertSchedule(schedule) {
      run(
        `insert into schedules
           (id, name, enabled, trigger_type, every_ms, nodes, edges, tasks, max_runs, next_fire_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        schedule.id, schedule.name || '', schedule.enabled === false ? 0 : 1,
        schedule.trigger_type || 'interval', schedule.every_ms || 0,
        JSON.stringify(schedule.nodes ?? []), JSON.stringify(schedule.edges ?? []),
        JSON.stringify(schedule.tasks ?? []), schedule.max_runs || 0, schedule.next_fire_at || null,
      );
    },

    async listSchedules() {
      return all('select * from schedules order by created_at desc').map(hydrateSchedule);
    },

    async getSchedule(id) {
      const row = get('select * from schedules where id = ?', id);
      return row ? hydrateSchedule(row) : null;
    },

    async setScheduleEnabled(id, enabled, nextFireAt) {
      run(
        'update schedules set enabled = ?, next_fire_at = ?, updated_at = ? where id = ?',
        enabled ? 1 : 0, nextFireAt || null, nowIso(), id,
      );
    },

    async deleteSchedule(id) {
      const res = run('delete from schedules where id = ?', id);
      return res.changes > 0;
    },

    /** Enabled schedules whose time has come and that have firings left. */
    async listDueSchedules(nowIsoString) {
      return all(
        `select * from schedules
         where enabled = 1 and next_fire_at is not null and next_fire_at <= ?
           and (max_runs = 0 or runs_fired < max_runs)`,
        nowIsoString || nowIso(),
      ).map(hydrateSchedule);
    },

    /**
     * Claim a schedule's firing: move `next_fire_at` forward and count the firing, conditional on
     * the value the caller read. Whoever wins the compare-and-set owns this occurrence — the same
     * reason dispatch claims a task before publishing, since two daemon instances (or a restart
     * overlapping a tick) would otherwise both start the same scheduled run.
     */
    async claimScheduleFiring(id, expectedFireAt, nextFireAt, runId) {
      const res = run(
        `update schedules
         set runs_fired = runs_fired + 1, last_fire_at = ?, last_run_id = ?,
             next_fire_at = ?, enabled = case when ? is null then 0 else enabled end,
             updated_at = ?
         where id = ? and next_fire_at = ?`,
        nowIso(), runId, nextFireAt || null, nextFireAt || null, nowIso(), id, expectedFireAt,
      );
      return res.changes > 0;
    },

    // --- broker config -------------------------------------------------------------------
    // Which broker the daemon should dial, chosen in the UI rather than an env var. It lives in
    // the store because the daemon is a separate process: a Next route cannot reach into it, so
    // the route writes here and the daemon watches. Env vars remain the fallback for a first run
    // with no row yet.
    async getBrokerConfig() {
      const row = get('select host, port, updated_at from cloud_config where id = ?', 'broker');
      return row ? { host: row.host, port: row.port, updatedAt: row.updated_at } : null;
    },

    async setBrokerConfig({ host, port }) {
      run(
        `insert into cloud_config (id, host, port, updated_at) values ('broker', ?, ?, ?)
         on conflict(id) do update set
           host = excluded.host, port = excluded.port, updated_at = excluded.updated_at`,
        host, port, nowIso(),
      );
    },

    // --- named settings ----------------------------------------------------------------------
    async getSetting(key) {
      const row = get('select value from cloud_settings where key = ?', key);
      if (!row) return null;
      try { return JSON.parse(row.value); } catch { return null; }
    },

    async setSetting(key, value) {
      run(
        `insert into cloud_settings (key, value, updated_at) values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        key, JSON.stringify(value ?? null), nowIso(),
      );
    },

    // --- agent tokens and proposals (src/lib/agent/) ------------------------------------------
    async createAgentToken({ token_hash, workspace_id, user_id, label }) {
      run('insert into agent_tokens (token_hash, workspace_id, user_id, label, created_at) values (?, ?, ?, ?, ?)', token_hash, workspace_id, user_id || '', label || '', nowIso());
    },
    async resolveAgentToken(token_hash) {
      const row = get('select token_hash, workspace_id, user_id, label from agent_tokens where token_hash = ?', token_hash);
      if (row) run('update agent_tokens set last_used_at = ? where token_hash = ?', nowIso(), token_hash);
      return row || null;
    },
    async listAgentTokens(workspace_id) {
      return all('select token_hash, label, created_at, last_used_at from agent_tokens where workspace_id = ? order by created_at', workspace_id);
    },
    async deleteAgentToken(token_hash, workspace_id) {
      run('delete from agent_tokens where token_hash = ? and workspace_id = ?', token_hash, workspace_id);
    },
    async insertAgentProposal(p) {
      run(
        `insert into agent_proposals (id, workspace_id, user_id, name, summary, source, spec, graph, issues, questions, status, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        p.id, p.workspace_id, p.user_id || '', p.name, p.summary || '', p.source || '', JSON.stringify(p.spec), p.graph ? JSON.stringify(p.graph) : null,
        JSON.stringify(p.issues || []), JSON.stringify(p.questions || []), nowIso(),
      );
    },
    async listAgentProposals(workspace_id, user_id, status = 'pending', limit = 50) {
      const rows = status === 'all'
        ? all('select * from agent_proposals where workspace_id = ? and user_id = ? order by created_at desc limit ?', workspace_id, user_id, limit)
        : all('select * from agent_proposals where workspace_id = ? and user_id = ? and status = ? order by created_at desc limit ?', workspace_id, user_id, status, limit);
      return rows.map(mapProposal);
    },
    async getAgentProposal(id) {
      const row = get('select * from agent_proposals where id = ?', id);
      return row ? mapProposal(row) : null;
    },
    async decideAgentProposal(id, { status, result }) {
      run('update agent_proposals set status = ?, result = ?, decided_at = ? where id = ?', status, result || null, nowIso(), id);
    },

    // --- cloud -> edge workflow pushes -----------------------------------------------------
    // An outbox, for the same reason as above: only the daemon holds the broker connection, so a
    // sequence saved in the Cloud editor is queued here and the daemon publishes it. Keyed by
    // (device_id, name) so re-saving the same workflow replaces the queued push rather than
    // stacking up copies of it.
    async enqueueSequencePush({ device_id, name, body, body_hash }) {
      run(
        `insert into sequence_pushes (device_id, name, body, body_hash, status, updated_at)
         values (?, ?, ?, ?, 'pending', ?)
         on conflict(device_id, name) do update set
           body = excluded.body, body_hash = excluded.body_hash,
           status = 'pending', updated_at = excluded.updated_at`,
        device_id, name, JSON.stringify(body ?? {}), body_hash || '', nowIso(),
      );
    },

    async listSequencePushes(status) {
      const rows = status
        ? all('select * from sequence_pushes where status = ?', status)
        : all('select * from sequence_pushes');
      return rows.map(r => ({ ...r, body: jsonParse(r.body, {}) }));
    },

    async setSequencePushStatus(deviceId, name, status) {
      run(
        'update sequence_pushes set status = ?, updated_at = ? where device_id = ? and name = ?',
        status, nowIso(), deviceId, name,
      );
    },

    async getSequencePush(deviceId, name) {
      const row = get('select * from sequence_pushes where device_id = ? and name = ?', deviceId, name);
      return row ? { ...row, body: jsonParse(row.body, {}) } : null;
    },

    async ackSequencePush(deviceId, name) {
      const res = run(
        `update sequence_pushes set status = 'acked', updated_at = ?
         where device_id = ? and name = ? and status != 'acked'`,
        nowIso(), deviceId, name,
      );
      return res.changes > 0;
    },

    // --- device pairing (src/lib/pairing.js) ----------------------------------------------
    async createPairingRequest({ code, secretHash, requestedId, deviceName, instruments, expiresAt }) {
      run(
        `insert into pairing_requests (code, secret_hash, requested_id, device_name, instruments, status, created_at, expires_at)
         values (?, ?, ?, ?, ?, 'waiting', ?, ?)`,
        code, secretHash, requestedId || null, deviceName || '', JSON.stringify(instruments || []), nowIso(), expiresAt,
      );
    },

    // --- removed devices (never re-registered from a heartbeat until paired again) --------
    async markDeviceRemoved(deviceId) {
      run(
        `insert into removed_devices (id, removed_at) values (?, ?)
         on conflict(id) do update set removed_at = excluded.removed_at`,
        deviceId, nowIso(),
      );
    },

    async clearDeviceRemoved(deviceId) {
      run('delete from removed_devices where id = ?', deviceId);
    },

    async listRemovedDeviceIds() {
      return all('select id from removed_devices').map((r) => r.id);
    },

    async isDeviceRemoved(deviceId) {
      return !!get('select 1 as x from removed_devices where id = ?', deviceId);
    },

    async getPairingRequest(code) {
      const row = get('select * from pairing_requests where code = ?', code);
      return row ? { ...row, instruments: jsonParse(row.instruments, []) } : null;
    },

    async getPairingRequestBySecret(secretHash) {
      const row = get('select * from pairing_requests where secret_hash = ?', secretHash);
      return row ? { ...row, instruments: jsonParse(row.instruments, []) } : null;
    },

    /** waiting -> approved, only while unexpired. Approval restarts the clock, so a request
     *  approved at 9:59 is not lost before the edge's next poll collects it. */
    async approvePairingRequest(code, deviceName, nowIsoStr, expiresAt) {
      const res = run(
        `update pairing_requests set status = 'approved', device_name = ?, approved_at = ?, expires_at = ?
         where code = ? and status = 'waiting' and expires_at > ?`,
        deviceName, nowIso(), expiresAt, code, nowIsoStr,
      );
      return res.changes > 0;
    },

    async denyPairingRequest(code, nowIsoStr) {
      const res = run(
        `update pairing_requests set status = 'denied'
         where code = ? and status = 'waiting' and expires_at > ?`,
        code, nowIsoStr,
      );
      return res.changes > 0;
    },

    /** approved -> provisioning, atomically: one conditional UPDATE, so two polls can never both
     *  mint credentials (on AWS, two Things and two certificates) from one approval. */
    async claimPairingRequest(secretHash, nowIsoStr) {
      const res = run(
        `update pairing_requests set status = 'provisioning'
         where secret_hash = ? and status = 'approved' and expires_at > ?`,
        secretHash, nowIsoStr,
      );
      return res.changes > 0;
    },

    async finishPairingRequest(code, deviceId, status) {
      run(
        'update pairing_requests set status = ?, device_id = ?, redeemed_at = ? where code = ?',
        status, deviceId || null, status === 'redeemed' ? nowIso() : null, code,
      );
    },

    /** Requests nobody finished: expired while waiting or approved, and denied ones. A redeemed
     *  request is kept as the record of which request became which device. */
    async purgeExpiredPairingRequests(nowIsoStr) {
      const res = run(
        `delete from pairing_requests
         where status in ('waiting', 'approved', 'denied') and expires_at <= ?`,
        nowIsoStr,
      );
      return res.changes;
    },

    // --- daemon heartbeat ----------------------------------------------------------------
    async setDaemonHeartbeat({ brokerConnected, brokerUrl, mode, storeLocation }) {
      run(
        `insert into cloud_status (id, broker_connected, broker_url, mode, store_location, last_seen)
         values ('daemon', ?, ?, ?, ?, ?)
         on conflict(id) do update set
           broker_connected = excluded.broker_connected,
           broker_url = excluded.broker_url,
           mode = excluded.mode,
           store_location = excluded.store_location,
           last_seen = excluded.last_seen`,
        brokerConnected ? 1 : 0, brokerUrl || '', mode || '', storeLocation || '', nowIso(),
      );
    },

    async getDaemonHeartbeat() {
      const row = get('select * from cloud_status where id = ?', 'daemon');
      if (!row) return null;
      return {
        brokerConnected: !!row.broker_connected,
        brokerUrl: row.broker_url,
        mode: row.mode,
        storeLocation: row.store_location || '',
        lastSeen: row.last_seen,
      };
    },

    // --- sessions (src/lib/auth.ts) ---------------------------------------------------------

    async createSession(row) {
      run(
        `insert into sessions (id, user_id, email, name, access_token, refresh_token, token_expires_at,
           workspace_id, workspaces, workspaces_checked_at, expires_at, last_seen)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.user_id, row.email ?? null, row.name ?? null, row.access_token ?? null, row.refresh_token ?? null,
        Number(row.token_expires_at) || 0, row.workspace_id, JSON.stringify(row.workspaces || []),
        row.workspaces_checked_at ?? null, row.expires_at, nowIso(),
      );
    },

    async getSession(id) {
      const row = get('select * from sessions where id = ?', id);
      return row ? { ...row, workspaces: jsonParse(row.workspaces, []) } : null;
    },

    async updateSession(id, patch) {
      const fields = { ...patch };
      if (fields.workspaces) fields.workspaces = JSON.stringify(fields.workspaces);
      const keys = Object.keys(fields).filter((k) => ['access_token', 'refresh_token', 'token_expires_at', 'workspace_id',
        'workspaces', 'workspaces_checked_at', 'expires_at', 'last_seen', 'name', 'email'].includes(k));
      if (!keys.length) return;
      run(`update sessions set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`, ...keys.map((k) => fields[k]), id);
    },

    async deleteSession(id) {
      run('delete from sessions where id = ?', id);
    },

    async purgeExpiredSessions(nowIsoStr) {
      run('delete from sessions where expires_at < ?', nowIsoStr);
    },

    // --- ownership (src/lib/workspace.ts) -----------------------------------------------------

    async setOwner(kind, key, workspaceId) {
      run(
        `insert into ownership (kind, key, workspace_id) values (?, ?, ?)
         on conflict(kind, key) do update set workspace_id = excluded.workspace_id`,
        kind, String(key), workspaceId,
      );
    },

    async getOwner(kind, key) {
      const row = get('select workspace_id from ownership where kind = ? and key = ?', kind, String(key));
      return row ? row.workspace_id : null;
    },

    async listOwned(kind, workspaceId) {
      return all('select key from ownership where kind = ? and workspace_id = ?', kind, workspaceId).map((r) => r.key);
    },

    async listOwnedKeys(kind) {
      return all('select key from ownership where kind = ?', kind).map((r) => r.key);
    },

    async deleteOwner(kind, key) {
      run('delete from ownership where kind = ? and key = ?', kind, String(key));
    },

    // --- platforms: groups of edges ----------------------------------------------------------

    async listPlatforms(workspaceId) {
      return all('select * from edge_platforms where workspace_id = ? order by name collate nocase', workspaceId)
        .map((r) => ({ ...r, device_ids: jsonParse(r.device_ids, []) }));
    },

    async upsertPlatform({ id, workspace_id, name, device_ids }) {
      run(
        `insert into edge_platforms (id, workspace_id, name, device_ids, updated_at) values (?, ?, ?, ?, ?)
         on conflict(id) do update set name = excluded.name, device_ids = excluded.device_ids, updated_at = excluded.updated_at`,
        id, workspace_id, name, JSON.stringify(device_ids || []), nowIso(),
      );
    },

    async deletePlatform(id, workspaceId) {
      run('delete from edge_platforms where id = ? and workspace_id = ?', id, workspaceId);
    },

    close() {
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

module.exports = { createSqliteStore, appendOccurrence, nextOccurrenceAt };
