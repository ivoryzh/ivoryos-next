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
