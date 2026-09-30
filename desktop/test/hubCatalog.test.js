'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HubCatalog, moduleToDeckEntry, pluginToDeckEntry, toEdgeWorkflow, requirementFor } = require('../src/hubCatalog');

/** A fake PostgREST: answers from `tables`, and refuses `visibility` when `legacy`. */
function fakeHub(tables, { legacy = false } = {}) {
    const calls = [];
    const fetch = async (url, init) => {
        const u = new URL(url);
        const table = u.pathname.split('/').pop();
        const select = u.searchParams.get('select') || '';
        calls.push({ table, query: u.search, auth: init.headers.Authorization });
        if (legacy && /visibility|plugin_api/.test(select)) {
            return { ok: false, status: 400, text: async () => JSON.stringify({ code: '42703', message: 'column modules.visibility does not exist' }) };
        }
        let rows = tables[table] || [];
        const id = u.searchParams.get('id');
        if (id && id.startsWith('eq.')) rows = rows.filter((r) => String(r.id) === id.slice(3));
        const or = u.searchParams.get('or');
        if (or) {
            const own = /contributor_id\.eq\.([\w-]+)/.exec(or);
            rows = rows.filter((r) => !r.is_unlisted || (own && r.contributor_id === own[1]));
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
    };
    return { fetch, calls };
}

const modules = [
    { id: 1, name: 'Pump', pip_name: 'pumps==1.0', module_path: 'pumps', module_name: 'Pump', init_args: [{ name: 'port', type: 'str' }], is_unlisted: false, contributor_id: 'u1' },
    { id: 2, name: 'Draft', pip_name: 'draft', module_path: 'draft', module_name: 'D', init_args: [], is_unlisted: true, contributor_id: 'me' },
    { id: 3, name: 'Theirs', pip_name: 'x', module_path: 'x', module_name: 'X', init_args: [], is_unlisted: true, contributor_id: 'u9' },
];

test('an old Hub database (no visibility) shows listed rows plus only the caller\'s own', async () => {
    const hub = fakeHub({ modules }, { legacy: true });
    const anon = new HubCatalog({ fetch: hub.fetch, url: 'https://hub.example', key: 'anon' });
    assert.deepEqual((await anon.browse()).modules.map((m) => m.name), ['Pump']);
    assert.equal(anon.legacy, true);

    const me = new HubCatalog({ fetch: hub.fetch, url: 'https://hub.example', key: 'anon', token: async () => 'jwt', userId: () => 'me' });
    const mine = (await me.browse()).modules;
    assert.deepEqual(mine.map((m) => [m.name, m.visibility]), [['Pump', 'public'], ['Draft', 'private']]);
    assert.equal(hub.calls.at(-1).auth, 'Bearer jwt');
});

test('a migrated database is trusted: rows come back as row-level security returned them', async () => {
    const rows = [{ ...modules[0], visibility: 'public' }, { ...modules[2], visibility: 'org', organizations: { name: 'Lab' } }];
    const hub = fakeHub({ modules: rows });
    const c = new HubCatalog({ fetch: hub.fetch, url: 'https://hub.example', key: 'anon', token: async () => 'jwt' });
    assert.deepEqual((await c.browse()).modules.map((m) => m.visibility), ['public', 'org']);
    assert.equal(c.legacy, false);
    assert.match(hub.calls[0].query, /visibility/);
});

test('deck entries, plugin entries and templates convert as the Hub converts them', async () => {
    const { instrument, packages } = moduleToDeckEntry(modules[0], 'pump_1', { args: { port: 'COM3' } });
    assert.deepEqual([instrument.import, instrument.class, instrument.args.port, packages[0]], ['pumps', 'Pump', 'COM3', 'pumps==1.0']);
    assert.equal(requirementFor('https://github.com/x/y.git'), 'git+https://github.com/x/y.git');

    assert.match(pluginToDeckEntry({ name: 'Old', plugin_api: null }).blocked, /v1 plugin/);
    assert.deepEqual(pluginToDeckEntry({ name: 'New', plugin_api: 'v2', import_path: 'view.plugin', module_name: 'plugin', pip_name: 'view' }),
        { packages: ['view'], plugins: ['view.plugin:plugin'], blocked: null });

    const wf = toEdgeWorkflow({ name: 't', script_dict: { prep: [{ instrument: 'pause', action: 'pause', args: { statement: 'Load vials' } }], script: [{ instrument: 'deck.pump', action: 'prime', args: {} }, { instrument: 'wait', action: 'wait', args: { statement: 2 } }], cleanup: [] } }, 'x');
    assert.deepEqual(wf.prep.map((b) => [b.instrument, b.action]), [['Flow_Control', 'User_Input']]);
    assert.deepEqual(wf.script.map((b) => [b.instrument, b.action, b.args]), [['pump', 'prime', {}], ['Flow_Control', 'Sleep', { duration_seconds: 2 }]]);
});

test('an unknown or unshared row says so', async () => {
    const c = new HubCatalog({ fetch: fakeHub({ modules }).fetch, url: 'https://hub.example', key: 'anon' });
    await assert.rejects(c.module(99), /not shared with you/);
    await assert.rejects(c.deckEntry({ moduleId: 1, name: '1bad' }), /letters, digits/);
});
