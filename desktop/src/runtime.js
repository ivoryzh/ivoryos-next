'use strict';
// The Python environment the edge runs in, managed with uv.
//
// It lives in the user's data folder, never inside the app: the app bundle is code-signed, and a
// signed bundle cannot have packages installed into it without breaking the signature. So the
// app ships a uv binary and (when packaged) a wheel of the edge; on first launch it creates a
// venv here and installs the edge into it, and every driver installed later lands here too.
//
// uv does the heavy lifting: it downloads a standalone CPython if the machine has none (so the
// user never installs Python), and installs packages an order of magnitude faster than pip,
// which matters because a driver install happens with the edge stopped.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PYTHON_VERSION = '3.11';

function venvPython(venvDir) {
    return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
}

/** Run a command, streaming its output to `onLine`; resolve with the output, reject on failure. */
function run(command, args, { onLine, env, cwd } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env: { ...process.env, ...env }, cwd, windowsHide: true });
        let output = '';
        const take = (d) => {
            const text = d.toString();
            output += text;
            if (onLine) text.split(/\r?\n/).filter(Boolean).forEach(onLine);
        };
        child.stdout.on('data', take);
        child.stderr.on('data', take);
        child.on('error', (err) => reject(new Error(`Could not run ${path.basename(command)}: ${err.message}`)));
        child.on('exit', (code) => {
            if (code === 0) resolve(output);
            else {
                const err = new Error(`${path.basename(command)} ${args[0] || ''} failed (exit ${code})`);
                err.output = output;
                reject(err);
            }
        });
    });
}

class PythonRuntime {
    /**
     * @param {object} opts
     * @param {string} opts.uv          path to the uv binary
     * @param {string} opts.dir         runtime folder (holds venv/ and state.json)
     * @param {object} opts.edgeSource  how to install the edge: {kind: 'wheel', path} or
     *                                  {kind: 'editable', path} (a source checkout, in development)
     * @param {(line: string) => void} [opts.onLine]
     */
    constructor(opts) {
        this.uv = opts.uv;
        this.dir = opts.dir;
        this.venv = path.join(opts.dir, 'venv');
        this.statePath = path.join(opts.dir, 'state.json');
        this.edgeSource = opts.edgeSource;
        this.onLine = opts.onLine || (() => {});
    }

    get python() {
        return venvPython(this.venv);
    }

    _readState() {
        try { return JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { return {}; }
    }

    _writeState(state) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    }

    /** A string that changes whenever a different edge build has to be installed. */
    _edgeFingerprint() {
        const src = this.edgeSource;
        if (src.kind === 'editable') return `editable:${path.resolve(src.path)}`;
        const stat = fs.statSync(src.path);
        return `wheel:${path.basename(src.path)}:${stat.size}`;
    }

    /**
     * Make sure the venv exists and holds the current edge. Cheap when nothing changed: it checks
     * a fingerprint rather than asking uv, so an ordinary launch adds no delay.
     * @param {{onProgress?: (msg: string) => void}} [opts]
     */
    async ensure({ onProgress = () => {} } = {}) {
        const state = this._readState();
        if (!fs.existsSync(this.python)) {
            onProgress('Setting up Python (first launch only)…');
            fs.mkdirSync(this.dir, { recursive: true });
            await run(this.uv, ['venv', '--python', PYTHON_VERSION, '--seed', this.venv], { onLine: this.onLine });
            delete state.edge;
        }
        const fingerprint = this._edgeFingerprint();
        if (state.edge !== fingerprint) {
            onProgress('Installing the IvoryOS edge…');
            const target = this.edgeSource.kind === 'editable'
                ? ['-e', this.edgeSource.path]
                : [this.edgeSource.path];
            await run(this.uv, ['pip', 'install', '--python', this.python, ...target], { onLine: this.onLine });
            state.edge = fingerprint;
            state.installedAt = new Date().toISOString();
            this._writeState(state);
        }
    }

    /**
     * Make sure a deck's packages are installed. Skipped when that deck's list is unchanged since
     * its last successful install, which is what keeps an ordinary start fast; tracked per `key`
     * (the launcher passes the profile id) because several decks share this one environment.
     * After reset() every list is installed again, so a rebuilt environment still has the drivers.
     */
    async ensurePackages(requirements, { key = 'default', onProgress = () => {} } = {}) {
        const state = this._readState();
        const fingerprint = JSON.stringify([...requirements].sort());
        if ((state.packagesByKey || {})[key] === fingerprint) return;
        if (requirements.length) {
            onProgress(`Installing ${requirements.length} driver package${requirements.length === 1 ? '' : 's'}…`);
            await this.install(requirements);
        }
        const latest = this._readState();
        this._writeState({ ...latest, packagesByKey: { ...(latest.packagesByKey || {}), [key]: fingerprint } });
    }

    /** Install pip requirements into the venv. Call with the edge stopped (see supervisor). */
    async install(requirements) {
        if (!requirements.length) return '';
        return run(this.uv, ['pip', 'install', '--python', this.python, ...requirements], { onLine: this.onLine });
    }

    /** Throw the venv away; the next ensure() rebuilds it. For a broken environment. */
    reset() {
        fs.rmSync(this.venv, { recursive: true, force: true });
        const state = this._readState();
        delete state.edge;
        delete state.packagesByKey;
        this._writeState(state);
    }
}

module.exports = { PythonRuntime, PYTHON_VERSION, venvPython, run };
