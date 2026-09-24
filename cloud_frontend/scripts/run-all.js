#!/usr/bin/env node
/**
 * Run the Cloud web app and its daemon as one unit: `node scripts/run-all.js <dev|start> [next args]`.
 *
 *   npm run dev:all   -- -p 3002     next dev   + daemon  (development)
 *   npm run start:all -- -p 3002     next start + daemon  (a single self-hosted machine; run
 *                                                          `npm run build` first)
 *
 * Why this exists: the daemon is a separate process by design (it owns a long-lived MQTT
 * connection, which a request-scoped Next route must not), so starting the web app never started
 * it and stopping the web app never stopped it. The result in practice was a daemon left running
 * for days on old code, and restarts that forgot one half. Here the two share a lifetime:
 *
 *   - either exiting stops the other, and this process exits with its code -- so a supervisor
 *     (Docker, systemd, pm2) sees one failure and restarts the pair, rather than half a system
 *     carrying on quietly;
 *   - Ctrl+C / SIGTERM stops both;
 *   - if whatever launched this process disappears without signalling it, it notices and stops
 *     both. Windows does not deliver a signal when a parent is killed, and a launcher that is
 *     terminated outright otherwise leaves its children running -- which is exactly how a stale
 *     server kept holding port 8080 after its preview was stopped.
 *
 * On Windows each child is stopped as a whole process tree (`taskkill /T`): `next dev` runs its
 * server in a worker process of its own, and stopping only the top process orphans the worker.
 *
 * In Docker the two run as separate services instead (see deploy/cloud/docker-compose.yml): the
 * container runtime supervises and restarts each one, which is the better arrangement once there
 * is a supervisor to do it.
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const mode = process.argv[2];
const nextArgs = process.argv.slice(3);
if (mode !== 'dev' && mode !== 'start') {
  console.error('usage: node scripts/run-all.js <dev|start> [next args...]');
  process.exit(2);
}

const appDir = path.resolve(__dirname, '..');
const nextBin = require.resolve('next/dist/bin/next', { paths: [appDir] });

const children = [];
let stopping = false;

function start(name, args) {
  // The node binary directly, never through a shell or npm: each extra wrapper process is one
  // more thing that can be killed while its children live on.
  const child = spawn(process.execPath, args, { cwd: appDir, stdio: 'inherit', env: process.env });
  child.label = name;
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[run-all] ${name} exited (${signal || code}); stopping the rest.`);
    shutdown(typeof code === 'number' && code !== 0 ? code : 1);
  });
  children.push(child);
  return child;
}

function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach(kill);
  // Give POSIX children a moment to exit cleanly on SIGTERM before leaving.
  setTimeout(() => process.exit(code), process.platform === 'win32' ? 0 : 1500);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(0));

// Stop when the launcher closes our input. Some launchers (IDE and preview tools among them)
// "stop" a process by closing its stdio pipes rather than signalling it -- and on Windows there is
// no signal to send anyway. Only when stdin is a pipe: under Docker or systemd it is usually
// /dev/null, which reads as closed immediately and must not mean "stop".
try {
  if (require('fs').fstatSync(0).isFIFO()) {
    process.stdin.on('end', () => { console.error('[run-all] input closed; stopping.'); shutdown(0); });
    process.stdin.on('error', () => shutdown(0));
    process.stdin.resume();
  }
} catch { /* no stdin at all -- nothing to watch */ }

// Stop with the parent. `process.kill(pid, 0)` only tests that the process exists.
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    console.error('[run-all] launcher went away; stopping.');
    shutdown(0);
  }
}, 2000).unref();

start('web', [nextBin, mode, ...nextArgs]);
start('daemon', ['--disable-warning=ExperimentalWarning', path.join(appDir, 'daemon.js')]);
