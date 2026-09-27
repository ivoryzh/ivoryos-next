'use strict';
// Owns the edge server process: starts it, knows when it is actually serving, restarts it when
// asked, and says why when it dies.
//
// Plain Node, no Electron, so it can be tested on its own (test/supervisor.test.js runs it against
// a fake edge) and reused by anything else that needs to keep an edge alive.
//
// The protocol with the edge is two things:
//   - "ready" means GET /api/status answers. Not "the process started": a Python server takes a
//     few seconds to import drivers and introspect them, and a window pointed at it before then
//     shows a connection error.
//   - exit code 75 means "start me again" (RESTART_EXIT_CODE in server.py). The web UI's Restart
//     button makes the edge exit with it; any other exit is a crash.

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const RESTART_EXIT_CODE = 75;
const LOG_LINES = 400;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET http://host:port/api/status; resolves true on a 2xx, false otherwise. */
function probe(host, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const req = http.get({ host, port, path: '/api/status', timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 300);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

class EdgeSupervisor extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.command      executable (the venv's python)
     * @param {string[]} opts.args       its arguments (-m ivoryos_edge --deck ... --port ...)
     * @param {object} [opts.env]        extra environment; IVORYOS_SUPERVISED=1 is always added
     * @param {string} [opts.cwd]
     * @param {number} opts.port         where to probe for readiness
     * @param {string} [opts.host]       where to probe (always loopback: we are on the same machine)
     * @param {string} [opts.logFile]    appended to, so a crash can be read after the fact
     * @param {number} [opts.readyTimeoutMs]
     */
    constructor(opts) {
        super();
        this.opts = { host: '127.0.0.1', readyTimeoutMs: 120000, ...opts };
        this.state = 'stopped';
        this.child = null;
        this.lines = [];
        this._stopping = false;
        this._exitWaiters = [];
        this._generation = 0;
    }

    get port() {
        return this.opts.port;
    }

    get logTail() {
        return this.lines.join('\n');
    }

    _setState(state, detail) {
        this.state = state;
        this.emit('state', state, detail);
    }

    _log(chunk) {
        const text = chunk.toString();
        if (this.opts.logFile) {
            try { fs.appendFileSync(this.opts.logFile, text); } catch { /* logging must not kill the edge */ }
        }
        for (const line of text.split(/\r?\n/)) {
            if (!line) continue;
            // The edge prints the address it is about to bind (server.py's run()). A script that
            // hardcodes run(port=9000) ignores the port it was offered, so readiness is checked
            // on the port it actually announced rather than on the one requested.
            const announced = /Starting IvoryOS Edge Server on [^\s:]+:(\d+)/.exec(line);
            if (announced && Number(announced[1]) !== this.opts.port) {
                this.opts.port = Number(announced[1]);
                this.emit('port', this.opts.port);
            }
            this.lines.push(line);
            this.emit('log', line);
        }
        if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES);
    }

    /** Start the edge and resolve once it serves requests. Rejects if it dies or times out first. */
    async start() {
        if (this.child) return;
        this._stopping = false;
        const generation = ++this._generation;
        this._setState('starting');
        if (this.opts.logFile) {
            fs.mkdirSync(path.dirname(this.opts.logFile), { recursive: true });
            this._log(`\n--- starting edge ${new Date().toISOString()} ---\n`);
        }

        const child = spawn(this.opts.command, this.opts.args, {
            cwd: this.opts.cwd,
            env: { ...process.env, ...this.opts.env, IVORYOS_SUPERVISED: '1', PYTHONUNBUFFERED: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.child = child;
        child.stdout.on('data', (d) => this._log(d));
        child.stderr.on('data', (d) => this._log(d));

        let exited = null;
        child.on('error', (err) => {
            // spawn failures (command not found) arrive here, not as an exit.
            this._log(`Could not start the edge: ${err.message}\n`);
            exited = exited || { code: null, signal: null, error: err };
            this._onExit(child, exited);
        });
        child.on('exit', (code, signal) => {
            exited = exited || { code, signal };
            this._onExit(child, exited);
        });

        const deadline = Date.now() + this.opts.readyTimeoutMs;
        while (Date.now() < deadline) {
            if (exited || generation !== this._generation) {
                throw new Error(`The edge exited before it was ready (code ${exited ? exited.code : '?'})`);
            }
            if (await probe(this.opts.host, this.opts.port)) {
                this._setState('running');
                this.emit('ready', { pid: child.pid });
                return;
            }
            await sleep(300);
        }
        this._log(`Edge did not answer on port ${this.opts.port} within ${Math.round(this.opts.readyTimeoutMs / 1000)}s; stopping it.\n`);
        await this.stop();
        throw new Error('The edge did not become ready in time');
    }

    _onExit(child, { code, signal, error }) {
        if (this.child !== child) return; // an old process's late event
        this.child = null;
        const waiters = this._exitWaiters.splice(0);
        waiters.forEach((resolve) => resolve({ code, signal }));

        if (this._stopping) {
            this._setState('stopped');
            return;
        }
        if (code === RESTART_EXIT_CODE) {
            // Asked for by the edge itself (the web UI's Restart button). The page reconnects on
            // its own by polling, so this is not surfaced as an error anywhere.
            this._setState('restarting');
            this.emit('restart-requested');
            this.start().catch((e) => this._crashed({ code: null, signal: null, error: e }));
            return;
        }
        this._crashed({ code, signal, error });
    }

    _crashed(info) {
        this._setState('crashed', info);
        this.emit('crashed', { ...info, logTail: this.logTail });
    }

    /** Stop the edge. SIGTERM first; a process that ignores it for 8s is killed. */
    async stop() {
        const child = this.child;
        this._stopping = true;
        if (!child) {
            if (this.state !== 'stopped') this._setState('stopped');
            return;
        }
        this._setState('stopping');
        const exited = new Promise((resolve) => this._exitWaiters.push(resolve));
        child.kill('SIGTERM');
        const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 8000);
        await exited;
        clearTimeout(killer);
    }

    /** Stop, start again, and resolve when it is serving. */
    async restart() {
        await this.stop();
        await this.start();
    }

    /**
     * Run `fn` with the edge stopped, then start it again whatever happened.
     *
     * Installing or upgrading a driver has to happen here: a running interpreter holds its
     * packages' compiled files open, and on Windows those cannot be replaced until it exits.
     */
    async whileStopped(fn) {
        await this.stop();
        try {
            return await fn();
        } finally {
            await this.start();
        }
    }
}

module.exports = { EdgeSupervisor, RESTART_EXIT_CODE, probe };
