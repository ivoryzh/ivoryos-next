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

/** Older rows predate the column; a task with no members list covers exactly its own node. */
const withMembers = (t) => ({ ...t, members: t.members && t.members.length ? t.members : [t.node_id] });

/**
 * A pending task that is not yet due - the next occurrence of a repeating node. Mirrors the LAN
 * backend's predicate exactly: "ready" has to mean the same thing in both modes, or a cadence
 * fires early in one of them.
 */
const isDue = (task, now = Date.now()) => {
  if (!task || !task.not_before) return true;
  const at = Date.parse(task.not_before);
  return Number.isNaN(at) || at <= now;
};

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
    async upsertDeviceStatus(deviceId, status, busy = false) {
      const { error } = await supabase.from('devices')
        .upsert({ id: deviceId, status, busy: !!busy, last_seen: nowIso() }, { onConflict: 'id' });
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
        .select('id, name, status, busy, last_seen, schema')
        .order('last_seen', { ascending: false });
      if (error) fail('Failed to fetch devices', error);
      return data;
    },

    /** Cloud tasks not yet sent anywhere: ready but held (`pending`) or waiting on others (`blocked`). */
    async listWaitingTasks() {
      const { data, error } = await supabase.from('run_tasks')
        .select('run_id, node_id, device_id, status, block, not_before, runs(name)')
        .in('status', ['pending', 'blocked'])
        .order('updated_at', { ascending: true });
      if (error) fail('Failed to fetch waiting tasks', error);
      return (data || []).map(({ runs, ...t }) => ({ ...t, run_name: runs?.name || null }));
    },

    async setTaskResult(runId, nodeId, result) {
      const { error } = await supabase.from('run_tasks')
        .update({ result: result ?? null }).eq('run_id', runId).eq('node_id', nodeId);
      if (error) fail(`Failed to store the result of ${runId}/${nodeId}`, error);
    },

    /** Every task of one Cloud run with whatever its device sent back -- one experiment's record. */
    async listRunTaskRecords(runId) {
      const { data, error } = await supabase.from('run_tasks')
        .select('node_id, device_id, status, dispatched_at, updated_at, result, progress')
        .eq('run_id', runId);
      if (error) fail(`Failed to fetch the tasks of run ${runId}`, error);
      return data || [];
    },

    async getTaskResult(runId, nodeId) {
      const { data, error } = await supabase.from('run_tasks')
        .select('run_id, node_id, device_id, status, updated_at, result, runs(name)')
        .eq('run_id', runId).eq('node_id', nodeId).maybeSingle();
      if (error) fail(`Failed to fetch the result of ${runId}/${nodeId}`, error);
      if (!data) return null;
      const { runs, ...t } = data;
      return { ...t, run_name: runs?.name || null };
    },

    /** Recent tasks that have a synced result, newest first -- summaries only, not the steps. */
    async listTaskResults(limit) {
      const { data, error } = await supabase.from('run_tasks')
        .select('run_id, node_id, device_id, status, updated_at, runs(name), name:result->>name, edge_run_id:result->>edgeRunId, result_status:result->>status, end_time:result->>end_time')
        .not('result', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) fail('Failed to fetch results', error);
      return (data || []).map(({ runs, ...t }) => ({ ...t, run_name: runs?.name || null }));
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

    async countActiveDeviceTasks(deviceId, activeStatuses) {
      // The caller owns the status list (see dag.js) so this stays the one place that knows how
      // to query, and never a second place that knows what "active" means.
      const { count, error } = await supabase.from('run_tasks')
        .select('run_id', { count: 'exact', head: true })
        .eq('device_id', deviceId)
        .in('status', activeStatuses);
      if (error) fail(`Failed to count active tasks for ${deviceId}`, error);
      return count || 0;
    },

    // Removes the device and the rows that exist only to serve it: its mirrored sequence library
    // and any queued pushes, both of which are caches of device state and meaningless once it is
    // gone. `run_tasks` is deliberately left alone — those are history, and a finished run that
    // named a since-removed device is still a truthful record of what actually ran. Deleted
    // explicitly rather than leaning on a cascade so both stores behave identically whatever the
    // Supabase schema's foreign keys happen to say.
    async deleteDevice(deviceId) {
      for (const table of ['edge_sequences', 'sequence_pushes']) {
        const { error } = await supabase.from(table).delete().eq('device_id', deviceId);
        if (error) fail(`Failed to delete ${table} rows for ${deviceId}`, error);
      }
      const { data, error } = await supabase.from('devices')
        .delete().eq('id', deviceId).select('id');
      if (error) fail(`Failed to delete device ${deviceId}`, error);
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

    /** How many runs are already called `base` or `base #N`, for numbering the next one. */
    async countRunsNamed(base) {
      const { count, error } = await supabase.from('runs')
        .select('id', { count: 'exact', head: true })
        .or(`name.eq.${JSON.stringify(base)},name.like.${JSON.stringify(`${base} #%`)}`);
      if (error) fail('Failed to count runs', error);
      return count || 0;
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
        .select('node_id, status, members, repeat_every_ms, repeat_total, repeat_done, progress')
        .eq('run_id', runId);
      if (error) fail(`Failed to fetch tasks for run ${runId}`, error);
      return (data || []).map(withMembers);
    },

    async listRecentTasks(limit) {
      const { data, error } = await supabase.from('run_tasks')
        .select('run_id, node_id, device_id, status, members, progress, updated_at, edge_run_id:result->>edgeRunId')
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) fail('Failed to fetch run tasks', error);
      return (data || []).map(withMembers);
    },

    async listTasksByStatus(status) {
      const { data, error } = await supabase.from('run_tasks')
        .select('run_id, node_id, device_id, block, run, status, not_before, dispatched_at, progress').eq('status', status)
        .order('updated_at', { ascending: true });
      if (error) fail(`Failed to fetch ${status} tasks`, error);
      return (data || []).filter((t) => isDue(t));
    },

    /** True while a Cloud task is on this device: sent, running, or waiting for input there. */
    async deviceHasActiveTask(deviceId) {
      const { data, error } = await supabase.from('run_tasks').select('node_id')
        .eq('device_id', deviceId)
        .not('status', 'in', '(pending,blocked,completed,error,cancelled,skipped)')
        .limit(1);
      if (error) fail('Failed to check whether the device is busy', error);
      return (data || []).length > 0;
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
        // A repeating node's next occurrence is inserted as pending with a future `not_before`.
        // Realtime delivers it immediately, so the readiness predicate has to be applied here too
        // or the repeat fires the instant it is scheduled instead of when it is due. The LAN
        // backend applies the identical filter; see its `isDue`.
        ({ new: task }) => { if (isDue(task)) onTask(task); },
      ).subscribe((status) => {
        if (status === 'SUBSCRIBED' && onReady) onReady();
      });
      return () => { supabase.removeChannel(channel); };
    },

    /** `progress`, when given, replaces the task's progress summary; omitted, it is left alone. */
    async updateTaskStatusIfNotTerminal(runId, nodeId, status, terminalStatuses, progress) {
      const patch = { status, updated_at: nowIso() };
      if (progress !== undefined) patch.progress = progress;
      const { data, error } = await supabase.from('run_tasks')
        .update(patch)
        .eq('run_id', runId)
        .eq('node_id', nodeId)
        .not('status', 'in', `(${terminalStatuses.join(',')})`)
        .select('status');
      if (error) fail(`Failed to update run_task ${runId}/${nodeId}`, error);
      return (data || []).length > 0;
    },

    /** See the LAN backend: only a waiting cloud User_Input step takes an answer. */
    async answerTaskInput(runId, nodeId, cloudDeviceId, progress) {
      const { data, error } = await supabase.from('run_tasks')
        .update({ progress, updated_at: nowIso() })
        .eq('run_id', runId).eq('node_id', nodeId).eq('device_id', cloudDeviceId).eq('status', 'running')
        .or('progress.is.null,progress->>state.neq.answered')
        .select('node_id');
      if (error) fail(`Failed to record the answer for ${runId}/${nodeId}`, error);
      return (data || []).length > 0;
    },

    async updateTaskStatusFrom(runId, nodeId, fromStatus, toStatus, extra) {
      const patch = { status: toStatus, updated_at: nowIso() };
      // A dispatch starts the task afresh, so the previous occurrence's progress must not show.
      if (extra && extra.dispatched) { patch.dispatched_at = nowIso(); patch.progress = null; }
      const { data, error } = await supabase.from('run_tasks')
        .update(patch)
        .eq('run_id', runId)
        .eq('node_id', nodeId)
        .eq('status', fromStatus)
        .select('status');
      if (error) fail(`Failed to move ${runId}/${nodeId} ${fromStatus}->${toStatus}`, error);
      return (data || []).length > 0;
    },

    /**
     * Turn a just-completed repeating task back into the next occurrence. See the LAN backend for
     * the full reasoning; the guard on `status = 'completed'` is the same compare-and-set, with
     * `repeat_done` added to it so two concurrent status messages cannot both claim one occurrence
     * (Postgres has no single-statement conditional increment through this client).
     */
    async scheduleTaskRepeat(runId, nodeId) {
      const { data: rows, error: readErr } = await supabase.from('run_tasks')
        .select('repeat_every_ms, repeat_total, repeat_done')
        .eq('run_id', runId).eq('node_id', nodeId).limit(1);
      if (readErr) fail(`Failed to read repeat state for ${runId}/${nodeId}`, readErr);
      const row = (rows || [])[0];
      // The count makes a task repeat; the interval is only the wait (none = back to back).
      if (!row || !(row.repeat_total > 1)) return false;
      if (row.repeat_done + 1 >= row.repeat_total) return false;

      const { data, error } = await supabase.from('run_tasks')
        .update({
          status: 'pending',
          repeat_done: row.repeat_done + 1,
          not_before: new Date(Date.now() + (row.repeat_every_ms || 0)).toISOString(),
          updated_at: nowIso(),
        })
        .eq('run_id', runId).eq('node_id', nodeId)
        .eq('status', 'completed')
        .eq('repeat_done', row.repeat_done)
        .select('status');
      if (error) fail(`Failed to schedule repeat for ${runId}/${nodeId}`, error);
      return (data || []).length > 0;
    },

    // --- schedules -----------------------------------------------------------------------
    async insertSchedule(schedule) {
      const { error } = await supabase.from('schedules').insert({
        id: schedule.id,
        name: schedule.name || '',
        enabled: schedule.enabled !== false,
        trigger_type: schedule.trigger_type || 'interval',
        every_ms: schedule.every_ms || 0,
        nodes: schedule.nodes ?? [],
        edges: schedule.edges ?? [],
        tasks: schedule.tasks ?? [],
        max_runs: schedule.max_runs || 0,
        next_fire_at: schedule.next_fire_at || null,
      });
      if (error) fail('Failed to create schedule', error);
    },

    async listSchedules() {
      const { data, error } = await supabase.from('schedules')
        .select('*').order('created_at', { ascending: false });
      if (error) fail('Failed to list schedules', error);
      return data || [];
    },

    async getSchedule(id) {
      const { data, error } = await supabase.from('schedules').select('*').eq('id', id).single();
      if (error) return null;
      return data;
    },

    async setScheduleEnabled(id, enabled, nextFireAt) {
      const { error } = await supabase.from('schedules')
        .update({ enabled: !!enabled, next_fire_at: nextFireAt || null, updated_at: nowIso() })
        .eq('id', id);
      if (error) fail(`Failed to update schedule ${id}`, error);
    },

    async deleteSchedule(id) {
      const { data, error } = await supabase.from('schedules').delete().eq('id', id).select('id');
      if (error) fail(`Failed to delete schedule ${id}`, error);
      return (data || []).length > 0;
    },

    async listDueSchedules(nowIsoString) {
      const { data, error } = await supabase.from('schedules')
        .select('*')
        .eq('enabled', true)
        .not('next_fire_at', 'is', null)
        .lte('next_fire_at', nowIsoString || nowIso());
      if (error) fail('Failed to list due schedules', error);
      return (data || []).filter(s => !s.max_runs || s.runs_fired < s.max_runs);
    },

    /**
     * Claim this occurrence with a compare-and-set on the firing time.
     *
     * A database function rather than a plain update because the claim has to increment
     * `runs_fired` in the same statement that moves `next_fire_at` — read-then-write through the
     * client leaves a window where two daemons both start the same scheduled run.
     */
    async claimScheduleFiring(id, expectedFireAt, nextFireAt, runId) {
      const { data, error } = await supabase.rpc('claim_schedule_firing', {
        p_id: id,
        p_expected_fire_at: expectedFireAt,
        p_next_fire_at: nextFireAt || null,
        p_run_id: runId,
      });
      if (error) fail(`Failed to claim schedule ${id}`, error);
      return !!data;
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
