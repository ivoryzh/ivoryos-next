'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OriginOwners } = require('../src/originOwners');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-origins-')), 'edge-origins.json');

test('an address another deck used before is reported, so its storage is cleared', () => {
    const owners = new OriginOwners(tmpFile());
    assert.equal(owners.claim('http://127.0.0.1:8080', 'p_education'), false, 'first seen: recorded, not cleared');
    assert.equal(owners.claim('http://127.0.0.1:8080', 'p_education'), false, 'the same deck again keeps its canvas');
    assert.equal(owners.claim('http://127.0.0.1:8080', 'p_example'), true, 'a different deck on the same port');
    assert.equal(owners.claim('http://127.0.0.1:8080', 'p_example'), false);
});

test('each address has its own owner, and the record survives a restart of the app', () => {
    const file = tmpFile();
    new OriginOwners(file).claim('http://127.0.0.1:8080', 'p_a');
    new OriginOwners(file).claim('http://127.0.0.1:8081', 'p_b');
    const again = new OriginOwners(file);
    assert.equal(again.claim('http://127.0.0.1:8081', 'p_b'), false);
    assert.equal(again.claim('http://127.0.0.1:8080', 'p_b'), true);
});

test('an unreadable record starts over instead of failing to open a tab', () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'not json');
    assert.equal(new OriginOwners(file).claim('http://127.0.0.1:8080', 'p_a'), false);
    assert.equal(new OriginOwners(file).claim('http://127.0.0.1:8080', 'p_b'), true);
});
