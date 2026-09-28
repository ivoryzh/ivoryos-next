'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Account, pkcePair } = require('../src/account');
const { secretFile } = require('../src/secrets');

/** A fake Supabase: routes by "METHOD path", records every request. */
function fakeSupabase(routes) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        const u = new URL(url);
        const key = `${init.method || 'GET'} ${u.pathname}${u.search}`;
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ key, headers: init.headers, body });
        const route = Object.keys(routes).find((k) => key.startsWith(k));
        if (!route) return new Response('{"msg":"no route"}', { status: 404 });
        const [status, json] = routes[route](body, init.headers);
        return new Response(json === undefined ? '' : JSON.stringify(json), { status });
    };
    return { fetch, calls };
}

const memoryStore = (initial = null) => { let v = initial; return { read: () => v, write: (x) => { v = x; } }; };
const user = (meta = {}) => ({ id: 'u1', email: 'ada@lab.org', user_metadata: meta, identities: [{ provider: 'email' }] });

test('sign in keeps the session in the store and tells the page no token', async () => {
    const { fetch } = fakeSupabase({
        'POST /auth/v1/token?grant_type=password': (b) => [200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: user({ full_name: 'Ada' }) }],
    });
    const store = memoryStore();
    const acc = new Account({ fetch, store, url: 'https://x.supabase.co', key: 'anon', now: () => 1000 });
    const me = await acc.signIn('ada@lab.org', 'pw123456');
    assert.equal(me.signedIn, true);
    assert.equal(me.plan, 'free');
    assert.equal(me.user.name, 'Ada');
    assert.equal(store.read().refresh_token, 'RT');
    assert.equal(store.read().expires_at, 4600);
    assert.doesNotMatch(JSON.stringify(me), /AT|RT/, 'describe() never carries a token');
});

test('wrong password reads as a sentence, not a status code', async () => {
    const { fetch } = fakeSupabase({ 'POST /auth/v1/token': () => [400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }] });
    const acc = new Account({ fetch, store: memoryStore(), url: 'https://x', key: 'k' });
    await assert.rejects(acc.signIn('a@b.c', 'nope12'), /do not match an IvoryOS account/);
});

test('sign-up with email confirmation reports it instead of signing in', async () => {
    const { fetch, calls } = fakeSupabase({ 'POST /auth/v1/signup': () => [200, { id: 'u2', email: 'new@lab.org' }] });
    const acc = new Account({ fetch, store: memoryStore(), url: 'https://x', key: 'k' });
    const res = await acc.signUp('new@lab.org', 'secret12', 'New Person');
    assert.equal(res.confirmEmail, true);
    assert.equal(res.signedIn, false);
    assert.deepEqual(calls[0].body.data, { full_name: 'New Person' });
});

test('an expired access token is refreshed, and the rotated refresh token is kept', async () => {
    const { fetch, calls } = fakeSupabase({
        'POST /auth/v1/token?grant_type=refresh_token': (b) => [200, { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600, user: user() }],
        'GET /auth/v1/user': (_b, h) => [200, user({ seen: h.Authorization })],
    });
    const store = memoryStore({ access_token: 'AT1', refresh_token: 'RT1', expires_at: 1030, user: user() });
    const acc = new Account({ fetch, store, url: 'https://x', key: 'k', now: () => 1000 });
    await acc.refreshUser();
    assert.equal(calls[0].body.refresh_token, 'RT1');
    assert.equal(store.read().refresh_token, 'RT2');
    assert.equal(store.read().user.user_metadata.seen, 'Bearer AT2');
});

test('a refused refresh token signs out; a network failure does not', async () => {
    const refused = fakeSupabase({ 'POST /auth/v1/token': () => [400, { error_description: 'Invalid Refresh Token: Already Used' }] });
    const store = memoryStore({ access_token: 'A', refresh_token: 'R', expires_at: 0, user: user() });
    const acc = new Account({ fetch: refused.fetch, store, url: 'https://x', key: 'k', now: () => 1000 });
    await assert.rejects(acc.token());
    assert.equal(store.read(), null);

    const offline = memoryStore({ access_token: 'A', refresh_token: 'R', expires_at: 0, user: user() });
    const acc2 = new Account({ fetch: async () => { throw new Error('ENOTFOUND'); }, store: offline, url: 'https://x', key: 'k', now: () => 1000 });
    await assert.rejects(acc2.token(), /Could not reach/);
    assert.notEqual(offline.read(), null, 'kept for when the network is back');
});

test('the preview plan is written to user metadata and read back', async () => {
    const { fetch, calls } = fakeSupabase({ 'PUT /auth/v1/user': (b) => [200, user(b.data)] });
    const acc = new Account({ fetch, store: memoryStore({ access_token: 'A', refresh_token: 'R', expires_at: 99999, user: user() }), url: 'https://x', key: 'k', now: () => 1 });
    assert.equal((await acc.setPlan('pro')).plan, 'pro');
    assert.deepEqual(calls[0].body, { data: { ivoryos_plan: 'pro' } });
    await assert.rejects(acc.setPlan('enterprise'), /Unknown plan/);
});

test('the Hub profile row supplies the name and lab, and is upserted on save', async () => {
    const { fetch, calls } = fakeSupabase({
        'GET /rest/v1/profiles': () => [200, [{ full_name: 'Ada L.', lab_info: 'Hein Lab', avatar_url: null }]],
        'POST /rest/v1/profiles': (b) => [201, [{ ...b }]],
    });
    const acc = new Account({ fetch, store: memoryStore({ access_token: 'A', refresh_token: 'R', expires_at: 99999, user: user() }), url: 'https://x', key: 'k', now: () => 1 });
    await acc.profile();
    assert.equal(acc.describe().user.lab, 'Hein Lab');
    await acc.updateProfile({ full_name: 'Ada Lovelace', lab_info: '' });
    assert.deepEqual(calls[1].body, { id: 'u1', full_name: 'Ada Lovelace', lab_info: null });
    assert.match(calls[1].headers.Prefer, /merge-duplicates/);
    assert.equal(acc.describe().user.name, 'Ada Lovelace');
});

test('OAuth URLs carry a PKCE challenge that matches the verifier', () => {
    const { verifier, challenge } = pkcePair();
    const acc = new Account({ fetch: null, store: memoryStore(), url: 'https://x.supabase.co', key: 'k' });
    const u = new URL(acc.oauthUrl('github', 'http://127.0.0.1:5000/callback', challenge));
    assert.equal(u.searchParams.get('code_challenge'), challenge);
    assert.equal(u.searchParams.get('code_challenge_method'), 's256');
    assert.equal(require('node:crypto').createHash('sha256').update(verifier).digest('base64url'), challenge);
    assert.throws(() => acc.oauthUrl('myspace', 'x', 'y'), /Unknown sign-in provider/);
});

test('secret files are encrypted at rest and not written without a keychain', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-sec-'));
    const file = path.join(dir, 's.bin');
    const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() };
    const store = secretFile(file, fakeSafe);
    store.write({ token: 'ghp_secret' });
    assert.doesNotMatch(fs.readFileSync(file).toString(), /ghp_secret/);
    assert.deepEqual(secretFile(file, fakeSafe).read(), { token: 'ghp_secret' });
    store.write(null);
    assert.equal(fs.existsSync(file), false);

    const noKeychain = secretFile(path.join(dir, 'n.bin'), { isEncryptionAvailable: () => false });
    noKeychain.write({ token: 't' });
    assert.equal(fs.existsSync(path.join(dir, 'n.bin')), false);
    assert.deepEqual(noKeychain.read(), { token: 't' }, 'kept in memory for this run');
});
