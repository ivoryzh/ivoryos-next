'use strict';
// Where the app finds what it ships: the uv binary, the edge to install, and the built web UI.
//
// Packaged, all three are in the app's resources folder, put there by scripts/prepare-resources.js
// at build time. In development they come straight from this repository instead (uv from the
// machine, the edge as an editable install of ../edge_server, the UI from ../frontend/out), so a
// change to the Python or the frontend shows up on the next launch without rebuilding the app.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXE = process.platform === 'win32' ? '.exe' : '';

/**
 * A uv on this machine. An app launched from the Finder or Start menu does not get the login
 * shell's PATH, so the usual install locations are checked by hand as well.
 */
function findSystemUv() {
    const candidates = [
        ...(process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, `uv${EXE}`)),
        path.join(os.homedir(), '.local', 'bin', `uv${EXE}`),
        path.join(os.homedir(), '.cargo', 'bin', `uv${EXE}`),
        '/opt/homebrew/bin/uv',
        '/usr/local/bin/uv',
    ];
    return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function firstWheel(dir) {
    try {
        const wheel = fs.readdirSync(dir).filter((f) => f.endsWith('.whl')).sort().pop();
        return wheel ? path.join(dir, wheel) : null;
    } catch { return null; }
}

/**
 * @param {{isPackaged: boolean, resourcesPath?: string}} ctx
 * @returns {{uv: string|null, edgeSource: object|null, frontendDir: string|null, bundled: boolean}}
 */
function resolveResources({ isPackaged, resourcesPath }) {
    const bundleDir = isPackaged ? resourcesPath : path.join(REPO_ROOT, 'desktop', 'resources');
    const bundledUv = path.join(bundleDir, 'bin', `uv${EXE}`);
    const bundledWheel = firstWheel(path.join(bundleDir, 'edge'));
    const bundledUi = path.join(bundleDir, 'frontend');

    const uv = process.env.IVORYOS_UV
        || (fs.existsSync(bundledUv) ? bundledUv : null)
        || (isPackaged ? null : findSystemUv());

    let edgeSource = null;
    if (process.env.IVORYOS_EDGE_SOURCE) {
        const src = process.env.IVORYOS_EDGE_SOURCE;
        edgeSource = src.endsWith('.whl') ? { kind: 'wheel', path: src } : { kind: 'editable', path: src };
    } else if (!isPackaged) {
        // Development: always the live checkout, so Python edits apply on the next launch.
        edgeSource = { kind: 'editable', path: path.join(REPO_ROOT, 'edge_server') };
    } else if (bundledWheel) {
        edgeSource = { kind: 'wheel', path: bundledWheel };
    }

    const devUi = path.join(REPO_ROOT, 'frontend', 'out');
    const frontendDir = isPackaged
        ? (fs.existsSync(bundledUi) ? bundledUi : null)
        : (fs.existsSync(devUi) ? devUi : null);

    return { uv, edgeSource, frontendDir, bundled: isPackaged };
}

module.exports = { resolveResources, findSystemUv, REPO_ROOT };
