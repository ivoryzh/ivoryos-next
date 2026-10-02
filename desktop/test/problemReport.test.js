'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { redact, kindOf, buildDetails, buildRow, githubIssueUrl, describeDeck } = require('../src/problemReport');

const ctx = { home: '/Users/ada', username: 'ada' };

test('secrets that end up in edge logs do not survive redaction', () => {
    const log = [
        'CLOUD_TOKEN=eyJicm9rZXIiOiJsb2NhbGhvc3QifQabcdefghijklmnop',
        'MQTT_PASSWORD: s3cr3t-value',
        '"api_key": "abc123def456"',
        'Authorization: Bearer abcdefghijklmnop.qrstuv',
        'anthropic key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV',
        'agent token ivc_9f8e7d6c5b4a',
        'aws AKIAIOSFODNN7EXAMPLE',
        'github ghp_abcdefghijklmnopqrstuvwxyz0123',
        'broker mqtt://ivoryos:hunter2@10.0.0.4:1883',
        'contact ada.lovelace@example.org',
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----',
        'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ].join('\n');
    const out = redact(log, ctx);
    for (const secret of ['eyJicm9rZXIi', 's3cr3t', 'abc123def456', 'abcdefghijklmnop.qrstuv', 'sk-ant-api03', 'ivc_9f8e', 'AKIAIOSFODNN7EXAMPLE', 'ghp_abc', 'hunter2', 'ada.lovelace@', 'MIIEow', 'dozjgNryP4J3']) {
        assert.ok(!out.includes(secret), `${secret} leaked:\n${out}`);
    }
    // What a person needs to read is left alone.
    assert.match(out, /CLOUD_TOKEN=\[removed\]/);
    assert.match(out, /mqtt:\/\/\[removed\]@10\.0\.0\.4:1883/);
});

test('the home folder and the user name in paths are masked', () => {
    const out = redact('File "/Users/ada/lab/drivers.py", line 3\nOSError: /dev/tty.usbserial (owner ada)\nC:/Users/ada/x', ctx);
    assert.match(out, /File "~\/lab\/drivers\.py"/);
    assert.ok(!out.includes('/Users/ada'));
    // Only a path segment: the word itself elsewhere is not touched.
    assert.match(out, /owner ada/);
    const win = redact('C:\\Users\\ada\\venv\\lib and c:/users/ada/venv', { home: 'C:\\Users\\ada', username: 'ada' });
    assert.ok(!/users[\\/]ada/i.test(win), win);
});

test('a traceback reads the same after redaction', () => {
    const tb = 'Traceback (most recent call last):\n  File "~/x.py", line 12, in move\n    self.port.write(b"G1")\nserial.SerialException: could not open port COM3';
    assert.equal(redact(tb, ctx), tb);
});

test('kinds: install, crash, start', () => {
    assert.equal(kindOf({ state: 'error', message: 'Install failed: uv pip install failed (exit 1)' }), 'install');
    assert.equal(kindOf({ state: 'crashed', message: 'Stopped unexpectedly (exit 1)' }), 'crash');
    assert.equal(kindOf({ state: 'error', message: 'Could not start: port in use' }), 'start');
    assert.equal(kindOf({ state: 'running' }), 'other');
});

test('a deck is described by names and classes, never by its arguments', () => {
    const text = describeDeck({ packages: ['pyserial'], instruments: [{ name: 'pump', import: 'vendor.pumps', class: 'Pump', args: { port: '/dev/ttyUSB0', serial: 'SN-123' } }] });
    assert.match(text, /pump: vendor\.pumps\.Pump/);
    assert.ok(!text.includes('ttyUSB0') && !text.includes('SN-123'));
});

test('details: environment, dependency check and the last lines of the log', () => {
    const log = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n');
    const details = buildDetails({
        app: { version: '0.3.0', platform: 'darwin', arch: 'arm64' },
        profile: { kind: 'deck' },
        status: { state: 'crashed', message: 'Stopped unexpectedly' },
        log,
        installOutput: 'Resolved 12 packages\n  × No solution found when resolving dependencies',
        environment: { python: '3.12.4', prefix: '/Users/ada/venv', edge: '0.1.0', optimizers: { ax: '1.0.0', baybe: null }, packages: ['numpy==2.0.0'] },
        check: 'botorch 0.12.0 requires torch>=2.4, but torch 2.2 is installed',
    }, ctx);
    assert.match(details, /IvoryOS 0\.3\.0 on darwin \(arm64\)/);
    assert.match(details, /Optimizers: ax 1\.0\.0, baybe not installed/);
    assert.match(details, /botorch 0\.12\.0 requires torch/);
    assert.match(details, /Python 3\.12\.4 \(~\/venv\)/);
    assert.ok(details.includes('line 1499') && !details.includes('line 499\n'), 'keeps only the tail');
    assert.match(details, /## Log, this session \(last 1000 of 1500 lines\)/);
    assert.match(details, /## Install output\nResolved 12 packages\n  × No solution found/);
    assert.match(details, /numpy==2\.0\.0/);
});

test('the row: description first, title from it, redacted again, bounded', () => {
    const row = buildRow({
        id: 'r1', description: 'Pump stopped mid-run\nmy key was sk-proj-ABCDEFGHIJKLMNOPQRSTUV', details: 'Message: crashed\n## Log\nx',
        contactEmail: 'ada@example.org', app: { version: '0.3.0', platform: 'darwin', arch: 'arm64' }, kind: 'crash',
    }, ctx);
    assert.equal(row.title, 'Pump stopped mid-run');
    assert.ok(row.body.startsWith('## What happened\nPump stopped mid-run'));
    assert.ok(!row.body.includes('sk-proj-ABC'));
    assert.equal(row.contact_email, 'ada@example.org');
    assert.equal(row.platform, 'darwin-arm64');
    assert.equal(buildRow({ id: 'r2', details: 'IvoryOS\nMessage: Could not start', contactEmail: 'not an email' }).title, 'Could not start');
    assert.equal(buildRow({ id: 'r2', details: 'x', contactEmail: 'not an email' }).contact_email, null);
    const huge = buildRow({ id: 'r3', details: 'y '.repeat(200_000) });
    assert.ok(huge.body.length < 151_000);
});

test('the GitHub fallback is a bounded, prefilled issue', () => {
    const url = githubIssueUrl('ivoryzh/ivoryos-next', { title: 'T', body: 'z'.repeat(20_000) });
    assert.ok(url.startsWith('https://github.com/ivoryzh/ivoryos-next/issues/new?'));
    assert.ok(url.length < 8000);
});
