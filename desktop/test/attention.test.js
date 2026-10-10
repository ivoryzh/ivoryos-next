'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AttentionWatcher } = require('../src/attention');

/** A WebSocket stand-in the test drives by hand. */
function fakeSockets() {
    const made = [];
    class FakeSocket {
        constructor(url) { this.url = url; this.closed = false; made.push(this); }
        close() { this.closed = true; }
        send(data) { this.onmessage && this.onmessage({ data: JSON.stringify(data) }); }
    }
    return { FakeSocket, made };
}

const input = { key: 'input:7:71', kind: 'input', run_id: 7, run_name: 'Screen', title: 'Input needed', body: 'Load vial 3' };

test('each moment is announced once, with the deck it came from', () => {
    const { FakeSocket, made } = fakeSockets();
    const watcher = new AttentionWatcher({ WebSocket: FakeSocket });
    const heard = [];
    watcher.on('attention', (a) => heard.push(a));
    watcher.sync([{ id: 'p1', name: 'Bench', url: 'http://127.0.0.1:8085' }]);
    assert.equal(made[0].url, 'ws://127.0.0.1:8085/api/ws/queue');

    made[0].send({ status: { attention: [input] } });
    made[0].send({ status: { attention: [input] } }); // every step change re-sends the status
    assert.equal(heard.length, 1);
    assert.equal(heard[0].deckName, 'Bench');
    assert.equal(heard[0].body, 'Load vial 3');

    // Answered, then asked again (a loop): a new moment.
    made[0].send({ status: { attention: [] } });
    made[0].send({ status: { attention: [input] } });
    assert.equal(heard.length, 2);
    // A message without a status (or garbage) changes nothing.
    made[0].onmessage({ data: 'not json' });
    made[0].send({ runs: [] });
    assert.equal(heard.length, 2);
    watcher.close();
});

test('decks are watched while they run and dropped when they stop', () => {
    const { FakeSocket, made } = fakeSockets();
    const watcher = new AttentionWatcher({ WebSocket: FakeSocket });
    watcher.sync([{ id: 'p1', name: 'A', url: 'http://127.0.0.1:8081' }, { id: 'p2', name: 'B', url: 'http://127.0.0.1:8082' }]);
    assert.equal(made.length, 2);
    watcher.sync([{ id: 'p2', name: 'B renamed', url: 'http://127.0.0.1:8082' }]);
    assert.equal(made[0].closed, true);       // p1 stopped
    assert.equal(made.length, 2);             // p2 kept its socket through a rename
    assert.equal(watcher.decks.get('p2').deck.name, 'B renamed');
    watcher.sync([{ id: 'p2', name: 'B', url: 'http://127.0.0.1:9000' }]);
    assert.equal(made[1].closed, true);       // a new port is a new socket
    assert.equal(made.length, 3);
    watcher.close();
    assert.equal(made[2].closed, true);
});

test('a dropped deck is reconnected while it is still watched', async () => {
    const { FakeSocket, made } = fakeSockets();
    const watcher = new AttentionWatcher({ WebSocket: FakeSocket, retryMs: 10 });
    watcher.sync([{ id: 'p1', name: 'A', url: 'http://127.0.0.1:8081' }]);
    made[0].onclose();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(made.length, 2);
    watcher.close();
    made[1].onclose();                        // closed on purpose: no reconnect
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(made.length, 2);
});

const ended = (key, age) => ({ key, kind: 'finished', run_id: 9, run_name: 'Screen', title: 'Run finished', body: 'Completed in 12 min', duration_s: 720, age_s: age });

test('a run that ends is announced once; one that ended before anyone listened is not', () => {
    const { FakeSocket, made } = fakeSockets();
    const watcher = new AttentionWatcher({ WebSocket: FakeSocket });
    const heard = [];
    watcher.on('notice', (n) => heard.push(n));
    watcher.sync([{ id: 'p1', name: 'Bench', url: 'http://127.0.0.1:8085' }]);

    // First message: an old one (ended before the app watched) and one that just happened.
    made[0].send({ status: { notices: [ended('finished:3', 400), ended('finished:9', 2)] } });
    assert.deepEqual(heard.map((n) => n.key), ['finished:9']);
    assert.equal(heard[0].deckName, 'Bench');
    // Re-sent with every status: still once. A later one is new, whatever its age.
    made[0].send({ status: { notices: [ended('finished:3', 410), ended('finished:9', 12)] } });
    made[0].send({ status: { notices: [ended('finished:9', 20), ended('finished:10', 300)] } });
    assert.deepEqual(heard.map((n) => n.key), ['finished:9', 'finished:10']);

    // One that ended while the socket was reconnecting is still announced on reconnect.
    made[0].onclose && made[0].onclose();
    watcher._connect(watcher.decks.get('p1'));
    made[made.length - 1].send({ status: { notices: [ended('finished:10', 320), ended('finished:11', 90)] } });
    assert.deepEqual(heard.map((n) => n.key), ['finished:9', 'finished:10', 'finished:11']);
    watcher.close();
});

test('what waits is counted across decks, and the last run outlives a stopped deck', () => {
    const { FakeSocket, made } = fakeSockets();
    const watcher = new AttentionWatcher({ WebSocket: FakeSocket });
    let changes = 0;
    watcher.on('changed', () => { changes += 1; });
    watcher.sync([{ id: 'p1', name: 'A', url: 'http://127.0.0.1:8081' }, { id: 'p2', name: 'B', url: 'http://127.0.0.1:8082' }]);
    made[0].send({ status: { active_workflow_id: 7, attention: [input] }, active_run: { name: 'Screen' } });
    made[1].send({ status: { attention: [{ ...input, key: 'error:4:40:1', kind: 'error' }] } });
    assert.deepEqual(watcher.waiting().map((w) => `${w.deckId}:${w.kind}`), ['p1:input', 'p2:error']);
    assert.equal(changes, 2);
    made[0].send({ status: { active_workflow_id: 7, attention: [input] }, active_run: { name: 'Screen' } });
    assert.equal(changes, 2);                 // the same things waiting is not a change
    assert.deepEqual(watcher.lastRun('p1'), { id: 7, name: 'Screen' });

    watcher.sync([{ id: 'p2', name: 'B', url: 'http://127.0.0.1:8082' }]); // p1 crashed and was dropped
    assert.equal(changes, 3);
    assert.deepEqual(watcher.waiting().map((w) => w.deckId), ['p2']);
    assert.deepEqual(watcher.lastRun('p1'), { id: 7, name: 'Screen' }); // for the crash notification
    made[1].send({ status: { attention: [] } });
    assert.equal(watcher.waiting().length, 0);
    assert.equal(watcher.lastRun('p2'), null);
    watcher.close();
});
