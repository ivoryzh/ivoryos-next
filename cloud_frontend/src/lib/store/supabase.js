'use strict';

/**
 * Cloud-mode storage: the hosted Supabase project, behind the same interface as the SQLite
 * backend so nothing above this layer knows which one it is talking to.
 *
 * This is the pre-existing behaviour, moved rather than rewritten — the queries are the same ones
 * that were previously inlined in daemon.js and the API routes. Two changes worth knowing about:
 *
 * - The client is built here instead of imported from `../supabase.ts`. `daemon.js` is plain
 *   CommonJS with no build step and cannot import TypeScript, and having the daemon and the app
 *   construct their clients differently is exactly how the two dispatch implementations drifted
 *   apart before. One construction site, both processes.
 * - Errors are thrown rather than swallowed. Routes used to log-and-return-[] on failure, which
 *   is what made a misconfigured Supabase indistinguishable from "no devices yet". The caller
 *   decides what to do now, and /api/health reports it explicitly.
 *
 * Service-role key: bypasses Row Level Security. Safe only server-side — never import this from a
 * "use client" component.
 */

const { createClient } = require('@supabase/supabase-js');

const nowIso = () => new Date().toISOString();

function createSupabaseStore(url, serviceRoleKey) {
  const supabase = createClient(url, serviceRoleKey);
  const fail = (what, error) => { throw new Error(`${what}: ${error.message}`); };

  return {
    backend: 'supabase',
    location: url,

    async ping() {
      // Cheapest round-trip that still proves credentials work: a count with no rows returned.
      // A wrong key fails here with a clear PostgREST error instead of silently returning [].
      const { error } = await supabase.from('devices').select('id', { count: 'exact', head: true });
      if (error) fail('Supabase unreachable', error);
      return { ok: true, backend: 'supabase', location: url };
    },

    // --- devices -------------------------------------------------------------------------
    // Separate status/schema upserts: they arrive on different MQTT topics and a status ping
    // carries no schema, so a combined write would blank the schema column every 5 seconds.
    async upsertDeviceStatus(deviceId, status) {
      const { error } = await supabase.from('devices')
        .upsert({ id: deviceId, status, last_seen: nowIso() }, { onConflict: 'id' });
      if (error) fail(`Failed to upsert device status for ${deviceId}`, error);
    },

    async upsertDeviceSchema(deviceId, schema) {
      const { error } = await supabase.from('devices')
        .upsert({ id: deviceId, schema: schema ?? {}, last_seen: nowIso() }, { onConflict: 'id' });
      if (error) fail(`Failed to upsert device schema for ${deviceId}`, error);
    },

    async upsertDevicePlaceholder(deviceId, name) {
      const { error } = await supabase.from('devices')
        .upsert({ id: deviceId, name, status: 'offline' }, { onConflict: 'id' });
      if (error) fail(`Failed to create device row for ${deviceId}`, error);
    },

    async listDevices() {
      const { data, error } = await supabase.from('devices')
        .select('id, name, status, last_seen, schema')
        .order('last_seen', { ascending: false });
      if (error) fail('Failed to fetch devices', error);
      return data;
    },

    async markStaleDevicesOffline(staleBeforeIso) {
      const { data, error } = await supabase.from('devices')
        .update({ status: 'offline' })
        .lt('last_seen', staleBeforeIso)
        .eq('status', 'online')
        .select('id');
      if (error) fail('Failed to mark stale devices offline', error);
      return (data || []).length;
    },

    // --- edge sequences ------------------------------------------------------------------
    async upsertSequence({ device_id, name, description, body }) {
      const { error } = await supabase.from('edge_sequences').upsert({
        device_id, name, description: description || '', body: body ?? {}, updated_at: nowIso(),
      }, { onConflict: 'device_id,name' });
      if (error) fail(`Failed to upsert sequence ${device_id}/${name}`, error);
    },

    async deleteSequence(deviceId, name) {
      const { data, error } = await supabase.from('edge_sequences')
        .delete().eq('device_id', deviceId).eq('name', name).select('name');
      if (error) fail(`Failed to delete sequence ${deviceId}/${name}`, error);
      return (data || []).length > 0;
    },

    async listSequences(deviceId) {
      let query = supabase.from('edge_sequences')
        .select('device_id, name, description, body, updated_at, created_at');
      if (deviceId) query = query.eq('device_id', deviceId);
      const { data, error } = await query.order('updated_at', { ascending: false });
      if (error) fail('Failed to fetch edge sequences', error);
      return data;
    },

    // --- runs ----------------------------------------------------------------------------
    async insertRun({ id, name, status, nodes, edges }) {
      const { error } = await supabase.from('runs')
        .insert({ id, name: name || '', status: status || 'running', nodes, edges });
      if (error) fail('Failed to create run', error);
    },

    async getRun(runId) {
      const { data, error } = await supabase.from('runs')
        .select('id, name, status, nodes, edges').eq('id', runId).single();
      if (error) return null;
      return data;
    },

    async updateRunStatus(runId, status) {
      const { error } = await supabase.from('runs')
        .update({ status, updated_at: nowIso() }).eq('id', runId);
      if (error) fail(`Failed to update run ${runId}`, error);
    },

    // --- run tasks -----------------------------------------------------------------------
    async insertTasks(tasks) {
      if (!tasks.length) return;
      const { error } = await supabase.from('run_tasks').insert(tasks);
      if (error) fail('Failed to create run tasks', error);
    },

    async listRunTasks(runId) {
      const { data, error } = await supabase.from('run_tasks')
        .select('node_id, status').eq('run_id', runId);
      if (error) fail(`Failed to fetch tasks for run ${runId}`, error);
      return data;
    },

    async listRecentTasks(limit) {
      const { data, error } = await supabase.from('run_tasks')
        .select('run_id, node_id, status, updated_at')
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) fail('Failed to fetch run tasks', error);
      return data;
    },

    async listTasksByStatus(status) {
      const { data, error } = await supabase.from('run_tasks')
        .select('run_id, node_id, device_id, block, status').eq('status', status);
      if (error) fail(`Failed to fetch ${status} tasks`, error);
      return data;
    },

    /**
     * Cloud mode reacts the instant a task becomes ready, via Realtime rather than polling.
     *
     * Realtime only streams changes going forward — it does not replay rows that were already
     * pending when the subscription opened — so the caller must also scan once on startup or a
     * daemon restart mid-run strands whatever was pending at the time. That scan is
     * `listTasksByStatus('pending')`, which the LAN backend's poll performs implicitly.
     */
    subscribePendingTasks(onTask, onReady) {
      const channel = supabase.channel('run_tasks_dispatch').on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'run_tasks', filter: 'status=eq.pending' },
        ({ new: task }) => onTask(task),
      ).subscribe((status) => {
        if (status === 'SUBSCRIBED' && onReady) onReady();
      });
      return () => { supabase.removeChannel(channel); };
    },

    async updateTaskStatusIfNotTerminal(runId, nodeId, status, terminalStatuses) {
      const { data, error } = await supabase.from('run_tasks')
        .update({ status, updated_at: nowIso() })
        .eq('run_id', runId)
        .eq('node_id', nodeId)
        .not('status', 'in', `(${terminalStatuses.join(',')})`)
        .select('status');
      if (error) fail(`Failed to update run_task ${runId}/${nodeId}`, error);
      return (data || []).length > 0;
    },

    async updateTaskStatusFrom(runId, nodeId, fromStatus, toStatus, extra) {
      const patch = { status: toStatus, updated_at: nowIso() };
      if (extra && extra.dispatched) patch.dispatched_at = nowIso();
      const { data, error } = await supabase.from('run_tasks')
        .update(patch)
        .eq('run_id', runId)
        .eq('node_id', nodeId)
        .eq('status', fromStatus)
        .select('status');
      if (error) fail(`Failed to move ${runId}/${nodeId} ${fromStatus}->${toStatus}`, error);
      return (data || []).length > 0;
    },

    // --- broker config -------------------------------------------------------------------
    // Which broker the daemon should dial, chosen in the UI rather than an env var. It lives in
    // the store because the daemon is a separate process: a Next route cannot reach into it, so
    // the route writes here and the daemon watches. Env vars remain the fallback for a first run
    // with no row yet.
    async getBrokerConfig() {
      const { data, error } = await supabase.from('cloud_config')
        .select('host, port, updated_at').eq('id', 'broker').single();
      if (error) return null;
      return { host: data.host, port: data.port, updatedAt: data.updated_at };
    },

    async setBrokerConfig({ host, port }) {
      const { error } = await supabase.from('cloud_config')
        .upsert({ id: 'broker', host, port, updated_at: nowIso() }, { onConflict: 'id' });
      if (error) fail('Failed to save broker config', error);
    },

    // --- cloud -> edge workflow pushes -----------------------------------------------------
    // An outbox, for the same reason as above: only the daemon holds the broker connection, so a
    // sequence saved in the Cloud editor is queued here and the daemon publishes it. Keyed by
    // (device_id, name) so re-saving the same workflow replaces the queued push rather than
    // stacking up copies of it.
    async enqueueSequencePush({ device_id, name, body, body_hash }) {
      const { error } = await supabase.from('sequence_pushes').upsert({
        device_id, name, body: body ?? {}, body_hash: body_hash || '',
        status: 'pending', updated_at: nowIso(),
      }, { onConflict: 'device_id,name' });
      if (error) fail(`Failed to queue push for ${device_id}/${name}`, error);
    },

    async listSequencePushes(status) {
      let query = supabase.from('sequence_pushes')
        .select('device_id, name, body, body_hash, status, updated_at');
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      if (error) fail('Failed to fetch sequence pushes', error);
      return data;
    },

    async setSequencePushStatus(deviceId, name, status) {
      const { error } = await supabase.from('sequence_pushes')
        .update({ status, updated_at: nowIso() })
        .eq('device_id', deviceId).eq('name', name);
      if (error) fail(`Failed to update push ${deviceId}/${name}`, error);
    },

    async getSequencePush(deviceId, name) {
      const { data, error } = await supabase.from('sequence_pushes')
        .select('device_id, name, body, body_hash, status, updated_at')
        .eq('device_id', deviceId).eq('name', name).single();
      if (error) return null;
      return data;
    },

    async ackSequencePush(deviceId, name) {
      const { data, error } = await supabase.from('sequence_pushes')
        .update({ status: 'acked', updated_at: nowIso() })
        .eq('device_id', deviceId).eq('name', name)
        .neq('status', 'acked')
        .select('name');
      if (error) fail(`Failed to ack push ${deviceId}/${name}`, error);
      return (data || []).length > 0;
    },

    // --- device pairing ------------------------------------------------------------------
    async createPairingCode({ code, deviceName, expiresAt }) {
      const { error } = await supabase.from('pairing_codes').insert({
        code, device_name: deviceName || '', status: 'pending',
        created_at: nowIso(), expires_at: expiresAt,
      });
      if (error) fail('Failed to create pairing code', error);
    },

    async getPairingCode(code) {
      const { data, error } = await supabase.from('pairing_codes')
        .select('code, device_name, status, device_id, created_at, expires_at, redeemed_at')
        .eq('code', code).single();
      if (error) return null;
      return data;
    },

    /** Claim atomically: only the first redeemer of an unexpired, unredeemed code wins. Doing
     *  this as one conditional UPDATE rather than read-then-write is what stops two devices
     *  racing the same code into two provisioned identities. */
    async claimPairingCode(code, nowIsoStr) {
      const { data, error } = await supabase.from('pairing_codes')
        .update({ status: 'redeeming', redeemed_at: nowIso() })
        .eq('code', code).eq('status', 'pending').gt('expires_at', nowIsoStr)
        .select('code');
      if (error) fail('Failed to claim pairing code', error);
      return (data || []).length > 0;
    },

    async finishPairingCode(code, deviceId, status) {
      const { error } = await supabase.from('pairing_codes')
        .update({ status, device_id: deviceId || null }).eq('code', code);
      if (error) fail('Failed to finalise pairing code', error);
    },

    async purgeExpiredPairingCodes(nowIsoStr) {
      const { data, error } = await supabase.from('pairing_codes')
        .delete().eq('status', 'pending').lte('expires_at', nowIsoStr).select('code');
      if (error) fail('Failed to purge expired pairing codes', error);
      return (data || []).length;
    },

    // --- daemon heartbeat ----------------------------------------------------------------
    async setDaemonHeartbeat({ brokerConnected, brokerUrl, mode, storeLocation }) {
      const { error } = await supabase.from('cloud_status').upsert({
        id: 'daemon',
        broker_connected: !!brokerConnected,
        broker_url: brokerUrl || '',
        mode: mode || '',
        store_location: storeLocation || '',
        last_seen: nowIso(),
      }, { onConflict: 'id' });
      if (error) fail('Failed to write daemon heartbeat', error);
    },

    async getDaemonHeartbeat() {
      const { data, error } = await supabase.from('cloud_status')
        .select('broker_connected, broker_url, mode, store_location, last_seen').eq('id', 'daemon').single();
      if (error) return null;
      return {
        brokerConnected: !!data.broker_connected,
        brokerUrl: data.broker_url,
        mode: data.mode,
        storeLocation: data.store_location || '',
        lastSeen: data.last_seen,
      };
    },

    close() { /* the supabase-js client holds no socket to release */ },
  };
}

module.exports = { createSupabaseStore };
