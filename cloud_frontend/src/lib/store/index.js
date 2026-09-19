'use strict';

/**
 * Picks the storage backend and hands back a single shared instance per process.
 *
 * Two deployment shapes, one code path above this file:
 *
 *   local  — a lab on a LAN. SQLite file + a local MQTT broker (mosquitto). No accounts, no keys,
 *            no internet. This is the default, so a fresh clone runs with nothing configured.
 *   cloud  — the hosted product. Supabase + AWS IoT Core (or any remote broker).
 *
 * Mode is inferred from whether SUPABASE_URL is set, because that is the thing that actually
 * decides whether a hosted backend exists to talk to. `IVORYOS_CLOUD_MODE` overrides the
 * inference when you need to be explicit (CI, or a deploy that must fail loudly rather than
 * quietly fall back to a local file).
 *
 * The important property of defaulting to local: a missing/incomplete cloud config can no longer
 * present as "connected, zero devices". It either runs locally on purpose, or /api/health says
 * precisely which link is down.
 */

const path = require('path');

const VALID_MODES = ['local', 'cloud'];

function resolveMode() {
  const explicit = (process.env.IVORYOS_CLOUD_MODE || '').trim().toLowerCase();
  if (explicit) {
    if (!VALID_MODES.includes(explicit)) {
      throw new Error(
        `IVORYOS_CLOUD_MODE must be one of ${VALID_MODES.join(' | ')} (got "${explicit}").`,
      );
    }
    return explicit;
  }
  return process.env.SUPABASE_URL ? 'cloud' : 'local';
}

/**
 * Where the LAN-mode database lives. Kept beside the app, not in the OS temp dir — temp is wiped
 * on reboot, and a run's history disappearing on restart is precisely the failure the old tmpfile
 * orchestrator had.
 *
 * Resolving this is fiddlier than it looks, and getting it wrong is silent: the daemon writes one
 * file, the app reads another, and the UI shows zero devices with everything apparently healthy.
 * Both of the obvious answers are wrong:
 *
 *   __dirname     — Turbopack rewrites it inside the Next bundle. Observed: the app resolved
 *                   `C:\ROOT\cloud_frontend\ivoryos_cloud.db` while the daemon used the real path.
 *   process.cwd() — differs by launch method. `npm --prefix cloud_frontend run daemon` (what
 *                   .claude/launch.json uses) runs with cwd at the repo root; `npm run daemon`
 *                   from inside cloud_frontend/ has cwd there. Both are normal ways to start it.
 *
 * So: anchor on cwd, then normalise so both spellings land on the same file. A mismatch is also
 * no longer silent — the daemon reports its path in the heartbeat and /api/health compares them.
 */
function localDbPath() {
  if (process.env.IVORYOS_LOCAL_DB) return path.resolve(process.env.IVORYOS_LOCAL_DB);
  const cwd = process.cwd();
  const base = path.basename(cwd) === 'cloud_frontend' ? cwd : path.join(cwd, 'cloud_frontend');
  return path.join(base, 'ivoryos_cloud.db');
}

/** The broker this mode talks to, so the daemon and the health check agree on one answer. */
function resolveBrokerUrl() {
  if (process.env.AWS_IOT_ENDPOINT) return `mqtts://${process.env.AWS_IOT_ENDPOINT}:8883`;
  return process.env.MQTT_BROKER_URL || 'mqtt://127.0.0.1:1883';
}

let cached = null;

/**
 * One instance per process. Re-opening a SQLite handle per request would be wasteful and would
 * multiply lock contention; the Supabase client is likewise designed to be long-lived.
 */
function getStore() {
  if (cached) return cached;
  const mode = resolveMode();

  if (mode === 'cloud') {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      // Deliberately fatal rather than falling back to local: a deployment that believes it is in
      // cloud mode must not silently start writing to a SQLite file nobody will ever read.
      throw new Error(
        'Cloud mode needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. '
        + 'Set both, or unset SUPABASE_URL to run in local (LAN) mode.',
      );
    }
    const { createSupabaseStore } = require('./supabase.js');
    cached = createSupabaseStore(url, key);
  } else {
    const { createSqliteStore } = require('./sqlite.js');
    cached = createSqliteStore(localDbPath());
  }

  cached.mode = mode;
  return cached;
}

module.exports = { getStore, resolveMode, resolveBrokerUrl, localDbPath, VALID_MODES };
