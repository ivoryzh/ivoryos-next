'use strict';
// Saved launch profiles: the launcher's equivalent of a launch.json.
//
// A profile is one way of starting an edge server, kept so it can be started again with one
// click. Two kinds:
//
//   deck    `python -m ivoryos_edge --deck <file>`: instruments are data (deck_config.py on the
//           edge), edited in the launcher, including each one's COM port or IP address.
//   script  any Python file that calls `ivoryos_edge.run(__name__)`, such as example/demo.py,
//           with its own interpreter, arguments and environment variables. A script that wants
//           its serial port configurable reads it from an environment variable set here.
//
// Pure and synchronous apart from reading and writing profiles.json, so it is tested without
// Electron (test/profiles.test.js).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DECK_FORMAT = 'ivoryos-deck/1';
const DEFAULT_PORT = 8080;

function profilesFile(home) {
    return path.join(home, 'profiles.json');
}

function profileDir(home, id) {
    return path.join(home, 'profiles', id);
}

function newId() {
    return `p_${crypto.randomBytes(4).toString('hex')}`;
}

/** Fill in everything a profile needs that the person did not choose. */
function withDefaults(home, profile) {
    const id = profile.id || newId();
    const base = {
        id,
        name: profile.name || (profile.kind === 'script' ? path.basename(profile.script || 'script.py') : 'New deck'),
        kind: profile.kind === 'script' ? 'script' : 'deck',
        port: Number(profile.port) || DEFAULT_PORT,
        listenOnNetwork: !!profile.listenOnNetwork,
        autoStart: !!profile.autoStart,
        env: profile.env && typeof profile.env === 'object' ? profile.env : {},
    };
    if (base.kind === 'deck') {
        return {
            ...base,
            deck: profile.deck || path.join(profileDir(home, id), 'deck.json'),
            // Each deck profile keeps its own runs and workflows: a demo deck and the real bench
            // should not share one history.
            dataDir: profile.dataDir || path.join(profileDir(home, id), 'data'),
        };
    }
    return {
        ...base,
        script: profile.script || '',
        cwd: profile.cwd || (profile.script ? path.dirname(profile.script) : ''),
        args: Array.isArray(profile.args) ? profile.args.map(String) : [],
        // null = the launcher's own Python environment (the edge plus every installed driver).
        python: profile.python || null,
        // null = wherever the script keeps its data already (its working directory and the
        // edge package's folders), so a script started here sees the same runs and workflows as
        // when it is started from a terminal. Set it to give the script a separate history.
        dataDir: profile.dataDir === undefined ? null : profile.dataDir,
    };
}

/** Problems that would stop a profile from starting, as readable sentences. */
function validateProfile(profile) {
    const problems = [];
    if (!profile.name || !String(profile.name).trim()) problems.push('Give the profile a name.');
    const port = Number(profile.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) problems.push('The port must be a whole number from 1024 to 65535.');
    for (const key of Object.keys(profile.env || {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) problems.push(`'${key}' is not a valid environment variable name.`);
    }
    if (profile.kind === 'script') {
        if (!profile.script) problems.push('Choose the Python script to run.');
        else if (!fs.existsSync(profile.script)) problems.push(`The script does not exist: ${profile.script}`);
        if (profile.python && !fs.existsSync(profile.python)) problems.push(`The Python interpreter does not exist: ${profile.python}`);
    }
    return problems;
}

/**
 * Read profiles.json, creating it on first use. A launcher that predates profiles kept a single
 * deck in <home>/data; that becomes the first profile, so nothing the person had is lost.
 */
function loadProfiles(home) {
    let stored = null;
    try { stored = JSON.parse(fs.readFileSync(profilesFile(home), 'utf8')); } catch { /* first run */ }
    if (stored && Array.isArray(stored.profiles)) {
        return { hubUrl: stored.hubUrl || null, profiles: stored.profiles.map((p) => withDefaults(home, p)) };
    }
    const legacyDeck = path.join(home, 'data', 'deck.json');
    const first = fs.existsSync(legacyDeck)
        ? withDefaults(home, { name: 'My deck', kind: 'deck', deck: legacyDeck, dataDir: path.join(home, 'data'), autoStart: true })
        : withDefaults(home, { name: 'My deck', kind: 'deck', autoStart: true });
    const initial = { hubUrl: null, profiles: [first] };
    saveProfiles(home, initial);
    return initial;
}

function saveProfiles(home, store) {
    fs.mkdirSync(home, { recursive: true });
    const tmp = `${profilesFile(home)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...store }, null, 2));
    fs.renameSync(tmp, profilesFile(home));
}

/**
 * How to start a profile: the command, its arguments, environment and working directory.
 * @param {object} profile
 * @param {{python: string, frontendDir?: string|null}} ctx  the launcher's venv python and the bundled UI
 */
function commandFor(profile, ctx) {
    const host = profile.listenOnNetwork ? '0.0.0.0' : '127.0.0.1';
    const env = {
        ...profile.env,
        IVORYOS_PORT: String(profile.port),
        IVORYOS_HOST: host,
        ...(profile.dataDir ? { IVORYOS_DATA_DIR: profile.dataDir } : {}),
        ...(ctx.frontendDir ? { IVORYOS_FRONTEND_DIR: ctx.frontendDir } : {}),
    };
    if (profile.kind === 'script') {
        return {
            command: profile.python || ctx.python,
            args: [profile.script, ...profile.args],
            cwd: profile.cwd || path.dirname(profile.script),
            env,
            port: profile.port,
        };
    }
    return {
        command: ctx.python,
        args: ['-m', 'ivoryos_edge', '--deck', profile.deck, '--data-dir', profile.dataDir,
            '--port', String(profile.port), '--host', host,
            ...(ctx.frontendDir ? ['--frontend-dir', ctx.frontendDir] : [])],
        cwd: profile.dataDir,
        env,
        port: profile.port,
    };
}

function readDeckFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return { format: DECK_FORMAT, name: 'My deck', packages: [], instruments: [] };
    }
}

function writeDeckFile(file, deck) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ format: DECK_FORMAT, ...deck }, null, 2));
    fs.renameSync(tmp, file); // never leave a half-written deck behind
}

module.exports = {
    DEFAULT_PORT, loadProfiles, saveProfiles, withDefaults, validateProfile, commandFor,
    readDeckFile, writeDeckFile, profileDir, newId,
};
