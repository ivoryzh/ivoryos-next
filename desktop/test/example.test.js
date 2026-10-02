'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exampleSource, materializeExample, DRIVER_FILES, EXAMPLE_SCRIPT } = require('../src/example');
const { ProfileManager } = require('../src/manager');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-example-'));

test('the example is found in the repository in development and in the bundle when packaged', () => {
    assert.equal(exampleSource({ isPackaged: false, repoRoot: REPO_ROOT }), path.join(REPO_ROOT, 'example'));
    const bundle = tmp();
    assert.equal(exampleSource({ isPackaged: true, resourcesPath: bundle, repoRoot: REPO_ROOT }), null, 'an empty bundle has no example');
    fs.mkdirSync(path.join(bundle, 'example'));
    for (const f of DRIVER_FILES) fs.writeFileSync(path.join(bundle, 'example', f), '');
    assert.equal(exampleSource({ isPackaged: true, resourcesPath: bundle, repoRoot: REPO_ROOT }), path.join(bundle, 'example'));
});

test('materializing writes the script and drivers into the home folder and describes a script profile', () => {
    const home = tmp();
    const fields = materializeExample(home, path.join(REPO_ROOT, 'example'));
    assert.equal(fields.kind, 'script');
    assert.equal(fields.script, path.join(home, 'example', 'example_lab.py'));
    assert.equal(fs.readFileSync(fields.script, 'utf8'), EXAMPLE_SCRIPT);
    for (const f of DRIVER_FILES) assert.ok(fs.existsSync(path.join(home, 'example', f)), `${f} copied`);
    // The script only imports what ships beside it, so it runs anywhere the example folder does.
    for (const m of EXAMPLE_SCRIPT.match(/^from (\w+) import/gm).map((l) => l.split(' ')[1])) {
        assert.ok(m === 'lab_drivers' || m === 'ivoryos_edge', `unexpected import ${m}`);
    }
    // Drivers a person edited are kept; the script is reset, since re-trying the example is how it is reset.
    fs.writeFileSync(path.join(home, 'example', 'lab_drivers.py'), '# mine');
    fs.writeFileSync(fields.script, '# broken');
    materializeExample(home, path.join(REPO_ROOT, 'example'));
    assert.equal(fs.readFileSync(path.join(home, 'example', 'lab_drivers.py'), 'utf8'), '# mine');
    assert.equal(fs.readFileSync(fields.script, 'utf8'), EXAMPLE_SCRIPT);
    // And it is a profile the manager accepts as-is, with its own data folder.
    const mgr = new ProfileManager({ home, getRuntime: async () => ({ python: process.execPath, ensurePackages: async () => {} }) });
    const p = mgr.create(fields);
    assert.equal(p.kind, 'script');
    assert.equal(p.dataDir, path.join(home, 'example', 'data'));
    assert.deepEqual(mgr.list().find((x) => x.id === p.id).problems, []);
});
