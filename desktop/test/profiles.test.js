'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfiles, saveProfiles, withDefaults, validateProfile, commandFor } = require('../src/profiles');
const { updateInstrument, removeInstrument, setInstrumentEnabled, freeName, DeckEditError } = require('../src/deckEdit');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-prof-'));

test('first run creates one deck profile with its own deck and data folder', () => {
    const home = tmp();
    const { profiles } = loadProfiles(home);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].kind, 'deck');
    assert.ok(profiles[0].deck.startsWith(path.join(home, 'profiles', profiles[0].id)));
    assert.ok(fs.existsSync(path.join(home, 'profiles.json')));
    assert.equal(loadProfiles(home).profiles[0].id, profiles[0].id, 'stable across loads');
});

test('a launcher that predates profiles keeps its deck and history as the first profile', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, 'data'));
    fs.writeFileSync(path.join(home, 'data', 'deck.json'), '{"instruments": []}');
    const [first] = loadProfiles(home).profiles;
    assert.equal(first.deck, path.join(home, 'data', 'deck.json'));
    assert.equal(first.dataDir, path.join(home, 'data'));
});

test('script profiles keep the script’s own data by default and pass port and env through', () => {
    const home = tmp();
    const script = path.join(home, 'demo.py');
    fs.writeFileSync(script, 'import ivoryos_edge\nivoryos_edge.run(__name__)\n');
    const p = withDefaults(home, { kind: 'script', script, port: 8081, env: { PUMP_PORT: 'COM3' }, args: ['--fast'] });
    assert.equal(p.name, 'demo.py');
    assert.equal(p.dataDir, null);
    assert.deepEqual(validateProfile(p), []);
    const cmd = commandFor(p, { python: '/venv/bin/python', frontendDir: '/ui' });
    assert.equal(cmd.command, '/venv/bin/python');
    assert.deepEqual(cmd.args, [script, '--fast']);
    assert.equal(cmd.cwd, home);
    assert.equal(cmd.env.PUMP_PORT, 'COM3');
    assert.equal(cmd.env.IVORYOS_PORT, '8081');
    assert.equal(cmd.env.IVORYOS_HOST, '127.0.0.1');
    assert.equal(cmd.env.IVORYOS_DATA_DIR, undefined);
    assert.equal(commandFor({ ...p, python: '/my/venv/python' }, { python: '/venv/bin/python' }).command, '/my/venv/python');
    // The edge keeps its own Cloud default unless the launcher was given one; a profile's env wins.
    assert.equal(cmd.env.IVORYOS_CLOUD_URL, undefined);
    assert.equal(commandFor(p, { python: 'py', cloudUrl: 'http://lab-cloud:3000' }).env.IVORYOS_CLOUD_URL, 'http://lab-cloud:3000');
    const own = { ...p, env: { IVORYOS_CLOUD_URL: 'http://mine:3000' } };
    assert.equal(commandFor(own, { python: 'py', cloudUrl: 'http://lab-cloud:3000' }).env.IVORYOS_CLOUD_URL, 'http://mine:3000');
});

test('deck profiles run the deck through the CLI with their own data folder', () => {
    const home = tmp();
    const p = withDefaults(home, { kind: 'deck', name: 'Bench 3', listenOnNetwork: true });
    const cmd = commandFor(p, { python: 'py' });
    assert.deepEqual(cmd.args.slice(0, 5), ['-m', 'ivoryos_edge', '--deck', p.deck, '--data-dir']);
    assert.ok(cmd.args.includes('0.0.0.0'));
    assert.equal(cmd.env.IVORYOS_DATA_DIR, p.dataDir);
});

test('validateProfile names each problem', () => {
    const problems = validateProfile({ name: '', kind: 'script', script: '/nope.py', port: 80, env: { 'BAD-NAME': '1' } });
    assert.equal(problems.length, 4);
    assert.ok(problems.some((p) => /port/.test(p)));
    assert.ok(problems.some((p) => /BAD-NAME/.test(p)));
    assert.ok(problems.some((p) => /does not exist/.test(p)));
});

test('saveProfiles round-trips and remembers the Hub address', () => {
    const home = tmp();
    const store = loadProfiles(home);
    store.hubUrl = 'http://localhost:3000';
    store.profiles.push(withDefaults(home, { kind: 'deck', name: 'Second' }));
    saveProfiles(home, store);
    const again = loadProfiles(home);
    assert.equal(again.hubUrl, 'http://localhost:3000');
    assert.deepEqual(again.profiles.map((p) => p.name), ['My deck', 'Second']);
});

const deck = { format: 'ivoryos-deck/1', instruments: [
    { name: 'pump', import: 'p', class: 'Pump', args: { port: 'COM3' } },
    { name: 'balance', import: 'b', class: 'Balance' },
] };

test('updateInstrument changes a COM port, renames only to a free name', () => {
    const next = updateInstrument(deck, 'pump', { ...deck.instruments[0], args: { port: 'COM4' } });
    assert.equal(next.instruments[0].args.port, 'COM4');
    assert.equal(deck.instruments[0].args.port, 'COM3', 'original untouched');
    assert.equal(updateInstrument(deck, 'pump', { ...deck.instruments[0], name: 'pump_a' }).instruments[0].name, 'pump_a');
    assert.throws(() => updateInstrument(deck, 'pump', { ...deck.instruments[0], name: 'balance' }), DeckEditError);
    assert.throws(() => updateInstrument(deck, 'pump', { ...deck.instruments[0], name: '9x' }), DeckEditError);
    assert.throws(() => updateInstrument(deck, 'ghost', deck.instruments[0]), /no instrument/);
});

test('instruments can be switched off, back on, and removed', () => {
    const off = setInstrumentEnabled(deck, 'balance', false);
    assert.equal(off.instruments[1].enabled, false);
    assert.equal('enabled' in setInstrumentEnabled(off, 'balance', true).instruments[1], false);
    assert.deepEqual(removeInstrument(deck, 'pump').instruments.map((i) => i.name), ['balance']);
});

test('freeName makes a usable, unused instrument name', () => {
    assert.equal(freeName(deck, 'Pump'), 'pump_2');
    assert.equal(freeName(deck, 'Sf10 Pump #1'), 'sf10_pump_1');
    assert.equal(freeName(deck, '1st HPLC'), 'device_1st_hplc');
    assert.equal(freeName(deck, '!!'), 'device');
});

test('launcher-wide settings survive a restart', () => {
    const home = tmp();
    const store = loadProfiles(home);
    saveProfiles(home, { ...store, hubUrl: 'http://localhost:3111', cloudUrl: 'http://localhost:3002' });
    const again = loadProfiles(home);
    assert.equal(again.hubUrl, 'http://localhost:3111');
    assert.equal(again.cloudUrl, 'http://localhost:3002');
});

test('a profiles.json saved with a byte-order mark is read, not replaced by defaults', () => {
    const home = tmp();
    const { profiles: [first] } = loadProfiles(home);
    const file = path.join(home, 'profiles.json');
    fs.writeFileSync(file, '﻿' + fs.readFileSync(file, 'utf8').replace(/"port": \d+/, '"port": 8095'));
    const [again] = loadProfiles(home).profiles;
    assert.equal(again.id, first.id);
    assert.equal(again.port, 8095);
});

test('tray preferences default to on, persist, and refuse unknown keys', () => {
    const { ProfileManager } = require('../src/manager');
    const home = tmp();
    const mgr = new ProfileManager({ home, getRuntime: async () => ({}) });
    assert.equal(mgr.windowPref('minimizeToTray'), true);
    assert.equal(mgr.windowPref('closeToTray'), true);
    assert.equal(mgr.windowPref('trayHintShown'), false);
    mgr.setWindowPref('closeToTray', false);
    mgr.setWindowPref('trayHintShown', true);
    const again = new ProfileManager({ home, getRuntime: async () => ({}) });
    assert.equal(again.windowPref('closeToTray'), false, 'kept across launches');
    assert.equal(again.windowPref('minimizeToTray'), true);
    assert.equal(again.windowPref('trayHintShown'), true, 'the hint is shown once, not every launch');
    assert.throws(() => mgr.setWindowPref('launchMissiles', true), /Unknown setting/);
});
