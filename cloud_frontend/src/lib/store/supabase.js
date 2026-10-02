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
const { appendOccurrence, nextOccurrenceAt } = require('./sqlite.js');

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

    /** A device's display name; its id (identity) is untouched. False if there is no such device. */
    async renameDevice(deviceId, name) {
      const { data, error } = await supabase.from('devices').update({ name }).eq('id', deviceId).select('id');
      if (error) fail(`Failed to rename device ${deviceId}`, error);
      return (data || []).length > 0;
    },

    /** The hash of a device's broker secret (brokerAuth.js); used when this Cloud runs its own broker. */
    async setBrokerCredential(deviceId, secretHash) {
      const { error } = await supabase.from('broker_credentials')
        .upsert({ device_id: deviceId, secret_hash: secretHash, created_at: nowIso() }, { onConflict: 'device_id' });
      if (error) fail(`Failed to store broker credential for ${deviceId}`, error);
    },

    async getBrokerCredential(deviceId) {
      const { data, error } = await supabase.from('broker_credentials').select('secret_hash').eq('device_id', deviceId).maybeSingle();
      if (error) fail(`Failed to read broker credential for ${deviceId}`, error);
      return data?.secret_hash || null;
    },

    async deleteBrokerCredential(deviceId) {
      const { error } = await supabase.from('broker_credentials').delete().eq('device_id', deviceId);
      if (error) fail(`Failed to delete broker credential for ${deviceId}`, error);
    },

    // A removed device's kept record (status 'removed', see archiveDevice) is left out unless
    // asked for; only the Library, which lists the workflows kept from it, wants it.
    async listDevices({ includeRemoved = false } = {}) {
      const { data, error } = await supabase.from('devices')
        .select('id, name, status, busy, last_seen, schema, image_updated_at')
        .order('id', { ascending: true });
      if (error) fail('Failed to fetch devices', error);
      return (data || []).filter((d) => includeRemoved || d.status !== 'removed').map(({ image_updated_at, ...d }) => ({ ...d, image_version: image_updated_at || null }));
    },

    /** See the LAN backend. Returns whether the device exists; `image` null removes it. */
    async setDeviceImage(deviceId, image) {
      const { data, error } = await supabase.from('devices')
        .update({ image, image_updated_at: image ? nowIso() : null })
        .eq('id', deviceId).select('id');
      if (error) fail(`Failed to set the image of ${deviceId}`, error);
      return (data || []).length > 0;
    },

    async getDeviceImage(deviceId) {
      const { data, error } = await supabase.from('devices')
        .select('image, image_updated_at').eq('id', deviceId).maybeSingle();
      if (error) fail(`Failed to read the image of ${deviceId}`, error);
      return data && data.image ? { image: data.image, updated_at: data.image_updated_at } : null;
    },

    /** Cloud tasks not yet sent anywhere: ready but held (`pending`) or waiting on others (`blocked`). */
    /** A task's repeat counters, for numbering an occurrence and spotting a report from an earlier one. */
    async getTaskRepeat(runId, nodeId) {
      const { data, error } = await supabase.from('run_tasks')
        .select('status, repeat_total, repeat_done, repeat_every_ms, dispatched_at')
        .eq('run_id', runId).eq('node_id', nodeId).limit(1);
      if (error) fail(`Failed to read repeat state for ${runId}/${nodeId}`, error);
      return (data || [])[0] || null;
    },
    /** Repeating tasks that still have occurrences to run, for telling a device what is to come. */
    async listRepeatingTasks() {
      const { data, error } = await supabase.from('run_tasks')
        .select('run_id, node_id, device_id, status, block, not_before, repeat_total, repeat_done, repeat_every_ms, runs(name)')
        .gt('repeat_total', 1)
        .in('status', ['pending', 'queued', 'running', 'waiting_input'])
        .order('updated_at', { ascending: true });
      if (error) fail('Failed to fetch repeating tasks', error);
      return (data || []).map(({ runs, ...t }) => ({ ...t, run_name: runs?.name || null }));
    },
    async listWaitingTasks() {
      const { data, error } = await supabase.from('run_tasks')
        .select('run_id, node_id, device_id, status, block, not_before, runs(name)')
        .in('status', ['pending', 'blocked'])
        .order('updated_at', { ascending: true });
      if (error) fail('Failed to fetch waiting tasks', error);
      return (data || []).map(({ runs, ...t }) => ({ ...t, run_name: runs?.name || null }));
    },

    /** See the LAN backend: `results` keeps every occurrence. The daemon is the only writer. */
    async setTaskResult(runId, nodeId, result) {
      const { data: row, error: readError } = await supabase.from('run_tasks')
        .select('results').eq('run_id', runId).eq('node_id', nodeId).maybeSingle();
      if (readError) fail(`Failed to read the results of ${runId}/${nodeId}`, readError);
      const { error } = await supabase.from('run_tasks')
        .update({ result: result ?? null, results: appendOccurrence(row && row.results, result) })
        .eq('run_id', runId).eq('node_id', nodeId);
      if (error) fail(`Failed to store the result of ${runId}/${nodeId}`, error);
    },

    /** Every task of one Cloud run with whatever its device sent back -- one experiment's record. */
    async listRunTaskRecords(runId) {
      const { data, error } = await supabase.from('run_tasks')
        .select('node_id, device_id, status, dispatched_at, updated_at, result, results, progress, command')
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
        .select('run_id, node_id, device_id, status, updated_at, runs(name), name:result->>name, edge_run_id:result->>edgeRunId, result_status:result->>status, issues:result->parameters->_issues, end_time:result->>end_time')
        .not('result', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) fail('Failed to fetch results', error);
      return (data || []).map(({ runs, ...t }) => ({ ...t, run_name: runs?.name || null }));
    },

    /** Offline because it went quiet: unlike a status it sent, this must not move `last_seen`. */
    async markDeviceOffline(deviceId) {
      const { error } = await supabase.from('devices')
        .update({ status: 'offline', busy: false }).eq('id', deviceId).eq('status', 'online');
      if (error) fail(`Failed to mark ${deviceId} offline`, error);
    },
    async getSequence(deviceId, name) {
      const { data, error } = await supabase.from('edge_sequences')
        .select('device_id, name, description, body, updated_at').eq('device_id', deviceId).eq('name', name).limit(1);
      if (error) fail(`Failed to read sequence ${deviceId}/${name}`, error);
      return (data || [])[0] || null;
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
    /** Take a device out of Cloud but keep its mirrored workflows under `archiveId` (see sqlite.js). */
    async archiveDevice(deviceId, archiveId) {
      const { data: found, error: readErr } = await supabase.from('devices')
        .select('name, last_seen, schema').eq('id', deviceId).limit(1);
      if (readErr) fail(`Failed to read device ${deviceId}`, readErr);
      const device = (found || [])[0];
      const { count, error: countErr } = await supabase.from('edge_sequences')
        .select('name', { count: 'exact', head: true }).eq('device_id', deviceId);
      if (countErr) fail(`Failed to count the workflows of ${deviceId}`, countErr);
      const keep = !!device && (count || 0) > 0;
      if (keep) {
        // The kept record first: edge_sequences.device_id references devices(id).
        const { error: insErr } = await supabase.from('devices').insert({
          id: archiveId, name: device.name || deviceId, status: 'removed', busy: false,
          last_seen: device.last_seen, schema: device.schema,
        });
        if (insErr) fail(`Failed to keep a record of ${deviceId}`, insErr);
        const { error: moveErr } = await supabase.from('edge_sequences')
          .update({ device_id: archiveId }).eq('device_id', deviceId);
        if (moveErr) fail(`Failed to keep the workflows of ${deviceId}`, moveErr);
      }
      const removed = await this.deleteDevice(deviceId);
      return { removed, archived: keep ? archiveId : null, workflows: keep ? count : 0 };
    },
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
    async insertRun({ id, name, status, nodes, edges, after_runs }) {
      const { error } = await supabase.from('runs')
        .insert({ id, name: name || '', status: status || 'running', nodes, edges, after_runs: after_runs ?? [] });
      if (error) fail('Failed to create run', error);
    },

    /** See the LAN backend: judged by open tasks, oldest run first. */
    async listOpenRunsOnDevices(deviceIds) {
      if (!deviceIds.length) return [];
      const { data, error } = await supabase.from('run_tasks')
        .select('run_id, runs(name, created_at)')
        .in('device_id', deviceIds).in('status', ['pending', 'blocked', 'queued', 'running']);
      if (error) fail('Failed to list open runs', error);
      const byRun = new Map();
      for (const t of data || []) {
        const e = byRun.get(t.run_id) || { id: t.run_id, name: t.runs?.name || '', open_tasks: 0, created_at: t.runs?.created_at || '' };
        e.open_tasks += 1;
        byRun.set(t.run_id, e);
      }
      return [...byRun.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    },

    async runsHaveOpenTasks(runIds) {
      if (!runIds.length) return false;
      const { data, error } = await supabase.from('run_tasks').select('node_id')
        .in('run_id', runIds).in('status', ['pending', 'blocked', 'queued', 'running']).limit(1);
      if (error) fail('Failed to check earlier runs', error);
      return (data || []).length > 0;
    },

    async listQueuedRuns() {
      const { data, error } = await supabase.from('runs')
        .select('id, name, after_runs').eq('status', 'queued').order('created_at', { ascending: true });
      if (error) fail('Failed to list queued runs', error);
      return (data || []).map((r) => ({ ...r, after_runs: r.after_runs || [] }));
    },

    async updateRunStatusFrom(runId, fromStatus, toStatus) {
      const { data, error } = await supabase.from('runs')
        .update({ status: toStatus, updated_at: nowIso() }).eq('id', runId).eq('status', fromStatus).select('id');
      if (error) fail(`Failed to move run ${runId} ${fromStatus}->${toStatus}`, error);
      return (data || []).length > 0;
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
        .select('run_id, node_id, device_id, status, members, progress, command, updated_at, repeat_total, repeat_done, not_before, edge_run_id:result->>edgeRunId, runs(status)')
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) fail('Failed to fetch run tasks', error);
      return (data || []).map(({ runs, ...t }) => withMembers({ ...t, run_status: runs?.status || null }));
    },

    async listTasksByStatus(status) {
      const { data, error } = await supabase.from('run_tasks')
        .select('run_id, node_id, device_id, block, run, status, not_before, dispatched_at, progress, repeat_done, repeat_total').eq('status', status)
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

    /** See the LAN backend: taken only while the task is still stopped on the named pause. */
    async setTaskCommand(runId, nodeId, command) {
      const { data, error } = await supabase.from('run_tasks')
        .update({ command, updated_at: nowIso() })
        .eq('run_id', runId).eq('node_id', nodeId).eq('status', 'running')
        .eq('progress->>pause', command.pause)
        .select('node_id');
      if (error) fail(`Failed to record the decision for ${runId}/${nodeId}`, error);
      return (data || []).length > 0;
    },

    async listTaskCommands() {
      const { data, error } = await supabase.from('run_tasks')
        .select('run_id, node_id, device_id, status, progress, command')
        .not('command', 'is', null);
      if (error) fail('Failed to fetch pending decisions', error);
      return data || [];
    },

    async updateTaskCommand(runId, nodeId, command) {
      const { error } = await supabase.from('run_tasks')
        .update({ command: command || null }).eq('run_id', runId).eq('node_id', nodeId);
      if (error) fail(`Failed to update the decision for ${runId}/${nodeId}`, error);
    },

    async updateTaskStatusFrom(runId, nodeId, fromStatus, toStatus, extra) {
      const patch = { status: toStatus, updated_at: nowIso() };
      // A dispatch starts the task afresh, so the previous occurrence's progress (and any
      // decision about it) must not show.
      if (extra && extra.dispatched) { patch.dispatched_at = nowIso(); patch.progress = null; patch.command = null; }
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
        .select('repeat_every_ms, repeat_total, repeat_done, dispatched_at')
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
          not_before: nextOccurrenceAt(row),
          updated_at: nowIso(),
        })
        .eq('run_id', runId).eq('node_id', nodeId)
        .eq('status', 'completed')
        .eq('repeat_done', row.repeat_done)
        .select('status');
      if (error) fail(`Failed to schedule repeat for ${runId}/${nodeId}`, error);
      return (data || []).length > 0;
    },

    // --- the Cloud library of distributed workflows (see the LAN backend) -------------------
    async listCloudWorkflows() {
      const { data, error } = await supabase.from('cloud_workflows')
        .select('*').order('updated_at', { ascending: false });
      if (error) fail('Failed to list the Cloud library', error);
      return data || [];
    },

    async upsertCloudWorkflow({ name, description, nodes, edges, created_at, updated_at }) {
      const row = { name, description: description || '', nodes: nodes ?? [], edges: edges ?? [], updated_at: updated_at || nowIso() };
      // created_at only on first insert: an upsert that sent it would reset it on every save.
      const { data: existing, error: readError } = await supabase.from('cloud_workflows')
        .select('name').eq('name', name).maybeSingle();
      if (readError) fail(`Failed to read library workflow ${name}`, readError);
      const { error } = existing
        ? await supabase.from('cloud_workflows').update(row).eq('name', name)
        : await supabase.from('cloud_workflows').insert({ ...row, created_at: created_at || nowIso() });
      if (error) fail(`Failed to save library workflow ${name}`, error);
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

    // --- named settings ----------------------------------------------------------------------
    async getSetting(key) {
      const { data, error } = await supabase.from('cloud_settings').select('value').eq('key', key).single();
      if (error || !data) return null;
      return data.value;
    },

    async setSetting(key, value) {
      const { error } = await supabase.from('cloud_settings')
        .upsert({ key, value: value ?? null, updated_at: nowIso() }, { onConflict: 'key' });
      if (error) fail('Failed to save setting', error);
    },

    // --- agent tokens and proposals (src/lib/agent/) ------------------------------------------
    async createAgentToken({ token_hash, workspace_id, user_id, label }) {
      const { error } = await supabase.from('agent_tokens').insert({ token_hash, workspace_id, user_id: user_id || '', label: label || '', created_at: nowIso() });
      if (error) fail('Failed to create agent token', error);
    },
    async resolveAgentToken(token_hash) {
      const { data, error } = await supabase.from('agent_tokens').select('token_hash, workspace_id, user_id, label').eq('token_hash', token_hash).maybeSingle();
      if (error || !data) return null;
      await supabase.from('agent_tokens').update({ last_used_at: nowIso() }).eq('token_hash', token_hash);
      return data;
    },
    async listAgentTokens(workspace_id) {
      const { data, error } = await supabase.from('agent_tokens').select('token_hash, label, created_at, last_used_at').eq('workspace_id', workspace_id).order('created_at');
      if (error) fail('Failed to list agent tokens', error);
      return data || [];
    },
    async deleteAgentToken(token_hash, workspace_id) {
      const { error } = await supabase.from('agent_tokens').delete().eq('token_hash', token_hash).eq('workspace_id', workspace_id);
      if (error) fail('Failed to delete agent token', error);
    },
    async insertAgentProposal(p) {
      const { error } = await supabase.from('agent_proposals').insert({
        id: p.id, workspace_id: p.workspace_id, user_id: p.user_id || '', name: p.name, summary: p.summary || '', source: p.source || '',
        spec: p.spec, graph: p.graph || null, issues: p.issues || [], questions: p.questions || [], status: 'pending', created_at: nowIso(),
      });
      if (error) fail('Failed to file proposal', error);
    },
    async listAgentProposals(workspace_id, user_id, status = 'pending', limit = 50) {
      let q = supabase.from('agent_proposals').select('*').eq('workspace_id', workspace_id).eq('user_id', user_id).order('created_at', { ascending: false }).limit(limit);
      if (status !== 'all') q = q.eq('status', status);
      const { data, error } = await q;
      if (error) fail('Failed to list proposals', error);
      return data || [];
    },
    async getAgentProposal(id) {
      const { data, error } = await supabase.from('agent_proposals').select('*').eq('id', id).maybeSingle();
      if (error) fail('Failed to read proposal', error);
      return data || null;
    },
    async decideAgentProposal(id, { status, result }) {
      const { error } = await supabase.from('agent_proposals').update({ status, result: result || null, decided_at: nowIso() }).eq('id', id);
      if (error) fail('Failed to decide proposal', error);
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

    // --- device pairing (src/lib/pairing.js) ----------------------------------------------
    async createPairingRequest({ code, secretHash, requestedId, deviceName, instruments, expiresAt }) {
      const { error } = await supabase.from('pairing_requests').insert({
        code, secret_hash: secretHash, requested_id: requestedId || null, device_name: deviceName || '',
        instruments: instruments || [], status: 'waiting', created_at: nowIso(), expires_at: expiresAt,
      });
      if (error) fail('Failed to create pairing request', error);
    },

    // --- removed devices (never re-registered from a heartbeat until paired again) --------
    async markDeviceRemoved(deviceId) {
      const { error } = await supabase.from('removed_devices')
        .upsert({ id: deviceId, removed_at: nowIso() }, { onConflict: 'id' });
      if (error) fail(`Failed to record removal of ${deviceId}`, error);
    },

    async clearDeviceRemoved(deviceId) {
      const { error } = await supabase.from('removed_devices').delete().eq('id', deviceId);
      if (error) fail(`Failed to clear removal of ${deviceId}`, error);
    },

    async listRemovedDeviceIds() {
      const { data, error } = await supabase.from('removed_devices').select('id');
      if (error) fail('Failed to list removed devices', error);
      return (data || []).map((r) => r.id);
    },

    async isDeviceRemoved(deviceId) {
      const { data, error } = await supabase.from('removed_devices').select('id').eq('id', deviceId).maybeSingle();
      if (error) fail(`Failed to read removal of ${deviceId}`, error);
      return !!data;
    },

    async getPairingRequest(code) {
      const { data, error } = await supabase.from('pairing_requests')
        .select('*').eq('code', code).maybeSingle();
      if (error) fail('Failed to read pairing request', error);
      return data || null;
    },

    async getPairingRequestBySecret(secretHash) {
      const { data, error } = await supabase.from('pairing_requests')
        .select('*').eq('secret_hash', secretHash).maybeSingle();
      if (error) fail('Failed to read pairing request', error);
      return data || null;
    },

    /** waiting -> approved, only while unexpired; approval restarts the clock (see sqlite.js). */
    async approvePairingRequest(code, deviceName, nowIsoStr, expiresAt) {
      const { data, error } = await supabase.from('pairing_requests')
        .update({ status: 'approved', device_name: deviceName, approved_at: nowIso(), expires_at: expiresAt })
        .eq('code', code).eq('status', 'waiting').gt('expires_at', nowIsoStr)
        .select('code');
      if (error) fail('Failed to approve pairing request', error);
      return (data || []).length > 0;
    },

    async denyPairingRequest(code, nowIsoStr) {
      const { data, error } = await supabase.from('pairing_requests')
        .update({ status: 'denied' })
        .eq('code', code).eq('status', 'waiting').gt('expires_at', nowIsoStr)
        .select('code');
      if (error) fail('Failed to deny pairing request', error);
      return (data || []).length > 0;
    },

    /** approved -> provisioning in one conditional UPDATE: one approval mints one identity. */
    async claimPairingRequest(secretHash, nowIsoStr) {
      const { data, error } = await supabase.from('pairing_requests')
        .update({ status: 'provisioning' })
        .eq('secret_hash', secretHash).eq('status', 'approved').gt('expires_at', nowIsoStr)
        .select('code');
      if (error) fail('Failed to claim pairing request', error);
      return (data || []).length > 0;
    },

    async finishPairingRequest(code, deviceId, status) {
      const { error } = await supabase.from('pairing_requests')
        .update({ status, device_id: deviceId || null, redeemed_at: status === 'redeemed' ? nowIso() : null })
        .eq('code', code);
      if (error) fail('Failed to finish pairing request', error);
    },

    async purgeExpiredPairingRequests(nowIsoStr) {
      const { data, error } = await supabase.from('pairing_requests')
        .delete().in('status', ['waiting', 'approved', 'denied']).lte('expires_at', nowIsoStr).select('code');
      if (error) fail('Failed to purge pairing requests', error);
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

    // --- sessions (src/lib/auth.ts) ---------------------------------------------------------

    async createSession(row) {
      const { error } = await supabase.from('sessions').insert({
        id: row.id, user_id: row.user_id, email: row.email ?? null, name: row.name ?? null,
        access_token: row.access_token ?? null, refresh_token: row.refresh_token ?? null,
        token_expires_at: Number(row.token_expires_at) || 0, workspace_id: row.workspace_id,
        workspaces: row.workspaces || [], workspaces_checked_at: row.workspaces_checked_at ?? null,
        expires_at: row.expires_at, last_seen: nowIso(),
      });
      if (error) fail('Failed to create session', error);
    },

    async getSession(id) {
      const { data, error } = await supabase.from('sessions').select('*').eq('id', id).maybeSingle();
      if (error) fail('Failed to read session', error);
      return data || null;
    },

    async updateSession(id, patch) {
      const allowed = ['access_token', 'refresh_token', 'token_expires_at', 'workspace_id', 'workspaces',
        'workspaces_checked_at', 'expires_at', 'last_seen', 'name', 'email'];
      const fields = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
      if (!Object.keys(fields).length) return;
      const { error } = await supabase.from('sessions').update(fields).eq('id', id);
      if (error) fail('Failed to update session', error);
    },

    async deleteSession(id) {
      const { error } = await supabase.from('sessions').delete().eq('id', id);
      if (error) fail('Failed to delete session', error);
    },

    async purgeExpiredSessions(nowIsoStr) {
      const { error } = await supabase.from('sessions').delete().lt('expires_at', nowIsoStr);
      if (error) fail('Failed to purge sessions', error);
    },

    // --- ownership (src/lib/workspace.ts) -----------------------------------------------------

    async setOwner(kind, key, workspaceId) {
      const { error } = await supabase.from('ownership')
        .upsert({ kind, key: String(key), workspace_id: workspaceId }, { onConflict: 'kind,key' });
      if (error) fail('Failed to record ownership', error);
    },

    async getOwner(kind, key) {
      const { data, error } = await supabase.from('ownership').select('workspace_id')
        .eq('kind', kind).eq('key', String(key)).maybeSingle();
      if (error) fail('Failed to read ownership', error);
      return data ? data.workspace_id : null;
    },

    async listOwned(kind, workspaceId) {
      const { data, error } = await supabase.from('ownership').select('key').eq('kind', kind).eq('workspace_id', workspaceId);
      if (error) fail('Failed to list owned', error);
      return (data || []).map((r) => r.key);
    },

    async listOwnedKeys(kind) {
      const { data, error } = await supabase.from('ownership').select('key').eq('kind', kind);
      if (error) fail('Failed to list owned', error);
      return (data || []).map((r) => r.key);
    },

    async deleteOwner(kind, key) {
      const { error } = await supabase.from('ownership').delete().eq('kind', kind).eq('key', String(key));
      if (error) fail('Failed to delete ownership', error);
    },

    // --- platforms: groups of edges ----------------------------------------------------------

    async listPlatforms(workspaceId) {
      const { data, error } = await supabase.from('edge_platforms').select('*').eq('workspace_id', workspaceId).order('name');
      if (error) fail('Failed to list platforms', error);
      return data || [];
    },

    async upsertPlatform({ id, workspace_id, name, device_ids }) {
      const { error } = await supabase.from('edge_platforms')
        .upsert({ id, workspace_id, name, device_ids: device_ids || [], updated_at: nowIso() }, { onConflict: 'id' });
      if (error) fail('Failed to save platform', error);
    },

    async deletePlatform(id, workspaceId) {
      const { error } = await supabase.from('edge_platforms').delete().eq('id', id).eq('workspace_id', workspaceId);
      if (error) fail('Failed to delete platform', error);
    },

    close() { /* the supabase-js client holds no socket to release */ },
  };
}

module.exports = { createSupabaseStore };
