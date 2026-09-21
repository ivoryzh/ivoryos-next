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
    last_seen text,
    schema text not null default '{}',
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
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists run_tasks (
    run_id text not null,
    node_id text not null,
    device_id text not null,
    block text not null default '{}',
    status text not null default 'blocked',
    dispatched_at text,
    updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    primary key (run_id, node_id)
);

create index if not exists run_tasks_status_idx on run_tasks(status);

-- The daemon's liveness beacon, read by /api/health. One row, id='daemon'. Deliberately a table
-- and not a pid file: the Next app may not share a filesystem with the daemon in cloud mode, and
-- the health check must work identically in both.
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

-- Short-lived, single-use device pairing codes. Replaces carrying a base64 token (which, on AWS,
-- wrapped a device private key) between machines by hand.
create table if not exists pairing_codes (
    code text primary key,
    device_name text not null default '',
    status text not null default 'pending',
    device_id text,
    created_at text,
    expires_at text,
    redeemed_at text
);
`;

function jsonParse(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

const nowIso = () => new Date().toISOString();

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
  try { db.exec("alter table cloud_status add column store_location text not null default ''"); }
  catch { /* column already present */ }

  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);

  const mapDevice = (row) => row && ({
    id: row.id,
    name: row.name,
    status: row.status,
    last_seen: row.last_seen,
    schema: jsonParse(row.schema, {}),
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
    async upsertDeviceStatus(deviceId, status) {
      run(
        `insert into devices (id, status, last_seen) values (?, ?, ?)
         on conflict(id) do update set status = excluded.status, last_seen = excluded.last_seen`,
        deviceId, status, nowIso(),
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

    async listDevices() {
      return all('select id, name, status, last_seen, schema from devices order by last_seen desc')
        .map(mapDevice);
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
    async insertRun({ id, name, status, nodes, edges }) {
      run(
        'insert into runs (id, name, status, nodes, edges) values (?, ?, ?, ?, ?)',
        id, name || '', status || 'running', JSON.stringify(nodes ?? []), JSON.stringify(edges ?? []),
      );
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

    async updateRunStatus(runId, status) {
      run('update runs set status = ?, updated_at = ? where id = ?', status, nowIso(), runId);
    },

    // --- run tasks -----------------------------------------------------------------------
    async insertTasks(tasks) {
      if (!tasks.length) return;
      const stmt = db.prepare(
        `insert into run_tasks (run_id, node_id, device_id, block, status)
         values (?, ?, ?, ?, ?)`,
      );
      // One transaction so a run is either fully planned or not planned at all — a partial insert
      // would leave a run whose graph is missing steps, which would then "complete" early.
      db.exec('begin');
      try {
        for (const t of tasks) {
          stmt.run(t.run_id, t.node_id, t.device_id, JSON.stringify(t.block ?? {}), t.status);
        }
        db.exec('commit');
      } catch (e) {
        db.exec('rollback');
        throw e;
      }
    },

    async listRunTasks(runId) {
      return all('select node_id, status from run_tasks where run_id = ?', runId);
    },

    async listRecentTasks(limit) {
      return all(
        'select run_id, node_id, status from run_tasks order by updated_at desc limit ?',
        limit,
      );
    },

    async listTasksByStatus(status) {
      return all(
        'select run_id, node_id, device_id, block, status from run_tasks where status = ?',
        status,
      ).map(r => ({ ...r, block: jsonParse(r.block, {}) }));
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
            "select run_id, node_id, device_id, block, status from run_tasks where status = 'pending'",
          );
          for (const r of rows) {
            if (stopped) break;
            await onTask({ ...r, block: jsonParse(r.block, {}) });
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
    async updateTaskStatusIfNotTerminal(runId, nodeId, status, terminalStatuses) {
      const placeholders = terminalStatuses.map(() => '?').join(',');
      const res = run(
        `update run_tasks set status = ?, updated_at = ?
         where run_id = ? and node_id = ? and status not in (${placeholders})`,
        status, nowIso(), runId, nodeId, ...terminalStatuses,
      );
      return res.changes > 0;
    },

    /** Compare-and-set, for the unblock / cancel / dispatch races. */
    async updateTaskStatusFrom(runId, nodeId, fromStatus, toStatus, extra) {
      const setDispatched = extra && extra.dispatched ? ', dispatched_at = ?' : '';
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

    // --- device pairing ------------------------------------------------------------------
    async createPairingCode({ code, deviceName, expiresAt }) {
      run(
        `insert into pairing_codes (code, device_name, status, created_at, expires_at)
         values (?, ?, 'pending', ?, ?)`,
        code, deviceName || '', nowIso(), expiresAt,
      );
    },

    async getPairingCode(code) {
      return get('select * from pairing_codes where code = ?', code) || null;
    },

    /** Claim atomically: only the first redeemer of an unexpired, unredeemed code wins. Doing
     *  this as one conditional UPDATE rather than read-then-write is what stops two devices
     *  racing the same code into two provisioned identities. */
    async claimPairingCode(code, nowIsoStr) {
      const res = run(
        `update pairing_codes set status = 'redeeming', redeemed_at = ?
         where code = ? and status = 'pending' and expires_at > ?`,
        nowIso(), code, nowIsoStr,
      );
      return res.changes > 0;
    },

    async finishPairingCode(code, deviceId, status) {
      run(
        'update pairing_codes set status = ?, device_id = ? where code = ?',
        status, deviceId || null, code,
      );
    },

    async purgeExpiredPairingCodes(nowIsoStr) {
      const res = run(
        "delete from pairing_codes where status = 'pending' and expires_at <= ?", nowIsoStr,
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

    close() {
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

module.exports = { createSqliteStore };
