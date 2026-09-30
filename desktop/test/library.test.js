'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freeWorkflowName, cleanWorkflowName, workflowsDir, addWorkflows } = require('../src/library');

const body = { description: '', prep: [], script: [{ instrument: 'pump', action: 'prime', args: {} }], cleanup: [] };

test('names follow the edge rules and never replace an existing workflow', () => {
    assert.equal(cleanWorkflowName('../etc/passwd'), '-etc-passwd');
    assert.equal(cleanWorkflowName('.hidden'), 'hidden');
    assert.equal(cleanWorkflowName('   '), 'Hub template');
    assert.equal(freeWorkflowName(['Other'], 'Screen'), 'Screen');
    assert.equal(freeWorkflowName(['screen'], 'Screen'), 'Screen (2)');
    assert.equal(freeWorkflowName(['Screen', 'Screen (2)'], 'Screen'), 'Screen (3)');
});

test('a stopped deck gets files the edge adopts; a name in use gets a number', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-lib-'));
    const profile = { kind: 'deck', dataDir };
    assert.equal(workflowsDir(profile), path.join(dataDir, 'workflows'));
    const first = await addWorkflows(profile, [{ name: 'Screen', body }]);
    const second = await addWorkflows(profile, [{ name: 'Screen', body }]);
    assert.deepEqual([first[0].saved, second[0].saved], ['Screen', 'Screen (2)']);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'workflows', 'Screen (2).json'), 'utf8'));
    assert.equal(saved.name, 'Screen (2)');
    assert.equal(saved.script[0].action, 'prime');
});

test('a running deck is written through its API, the same path as a Designer save', async () => {
    const calls = [];
    const fetch = async (url, init = {}) => {
        calls.push({ url, init });
        if (!init.method) return { ok: true, json: async () => ({ workflows: [{ name: 'Screen' }] }) };
        return { ok: true, json: async () => ({ status: 'success' }) };
    };
    const out = await addWorkflows({ kind: 'deck', dataDir: null }, [{ name: 'Screen', body }], { url: 'http://127.0.0.1:8080', fetch });
    assert.equal(out[0].saved, 'Screen (2)');
    assert.equal(calls[1].url, 'http://127.0.0.1:8080/api/workflows/Screen%20(2)');
    const sent = JSON.parse(calls[1].init.body);
    assert.equal(sent.force, true);
    assert.equal(sent.name, 'Screen (2)');
});

test('a script profile with no data folder needs its edge running', async () => {
    await assert.rejects(addWorkflows({ kind: 'script', dataDir: null }, [{ name: 'x', body }]), /Start this profile first/);
});
