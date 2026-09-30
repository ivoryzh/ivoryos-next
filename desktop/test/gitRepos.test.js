'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { GitConnections, githubApi } = require('../src/gitRepos');
const { packageKey, mergeIntoDeck } = require('../src/manifest');
const { compareVersions } = require('../src/updater');

const memoryStore = () => { let v = null; return { read: () => v, write: (x) => { v = x; } }; };
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

function fakeForge(routes) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        calls.push({ url, headers: init.headers || {} });
        const route = Object.keys(routes).find((k) => url.startsWith(k));
        if (!route) return new Response('not found', { status: 404 });
        const [status, body, type] = routes[route](url, init.headers || {});
        return new Response(Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type || 'application/json' } });
    };
    return { fetch, calls };
}

test('connecting checks the token and never hands it back', async () => {
    const { fetch, calls } = fakeForge({ 'https://api.github.com/user': () => [200, { login: 'ada' }] });
    const git = new GitConnections({ fetch, store: memoryStore(), downloadDir: os.tmpdir() });
    const list = await git.connect('github', ' ghp_x ');
    assert.equal(calls[0].headers.Authorization, 'Bearer ghp_x');
    const gh = list.find((c) => c.provider === 'github');
    assert.equal(gh.connected, true);
    assert.equal(gh.login, 'ada');
    assert.doesNotMatch(JSON.stringify(list), /ghp_x/);
});

test('a revoked token says so', async () => {
    const { fetch } = fakeForge({ 'https://gitlab.com/api/v4/user': () => [401, { message: '401 Unauthorized' }] });
    const git = new GitConnections({ fetch, store: memoryStore(), downloadDir: os.tmpdir() });
    await assert.rejects(git.connect('gitlab', 'glpat-x'), /refused the token/);
});

test('GitHub import downloads the archive at the resolved commit, named after it', async () => {
    const archive = zlib.gzipSync(Buffer.from('fake tar'));
    const { fetch, calls } = fakeForge({
        'https://api.github.com/user': () => [200, { login: 'ada' }],
        'https://api.github.com/repos/lab/pumps/commits/main': () => [200, `${SHA}\n`, 'text/plain'],
        'https://api.github.com/repos/lab/pumps/tarball/': () => [200, archive, 'application/x-gzip'],
        'https://api.github.com/repos/lab/pumps': () => [200, { default_branch: 'main' }],
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-git-'));
    const git = new GitConnections({ fetch, store: memoryStore(), downloadDir: dir });
    await git.connect('github', 'ghp_x');
    const got = await git.download('github', 'lab/pumps');
    assert.equal(got.sha, SHA);
    assert.equal(got.ref, 'main');
    assert.equal(path.basename(got.file), `github-lab-pumps-${SHA.slice(0, 12)}.tar.gz`);
    assert.ok(calls.some((c) => c.url.endsWith(`/tarball/${SHA}`)), 'downloads that exact commit, not the branch');
    const before = calls.length;
    await git.download('github', 'lab/pumps');
    assert.ok(!calls.slice(before).some((c) => c.url.includes('/tarball/')), 'a commit already downloaded is reused');
});

test('GitLab uses its own token header and project ids', async () => {
    const archive = zlib.gzipSync(Buffer.from('x'));
    const { fetch, calls } = fakeForge({
        'https://git.lab.org/api/v4/user': () => [200, { username: 'ada' }],
        'https://git.lab.org/api/v4/projects/42/repository/branches/dev': () => [200, { commit: { id: SHA } }],
        'https://git.lab.org/api/v4/projects/42/repository/archive.tar.gz': () => [200, archive, 'application/gzip'],
    });
    const git = new GitConnections({ fetch, store: memoryStore(), downloadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-gl-')) });
    await git.connect('gitlab', 'glpat-x', 'git.lab.org');
    const got = await git.download('gitlab', '42', 'dev');
    assert.equal(calls[0].headers['PRIVATE-TOKEN'], 'glpat-x');
    assert.match(path.basename(got.file), /^gitlab-42-abcdef123456\.tar\.gz$/);
});

test('something that is not an archive is refused', async () => {
    const { fetch } = fakeForge({
        'https://api.github.com/user': () => [200, { login: 'a' }],
        'https://api.github.com/repos/o/r/commits/': () => [200, SHA, 'text/plain'],
        'https://api.github.com/repos/o/r/tarball/': () => [200, '<html>login</html>', 'text/html'],
    });
    const git = new GitConnections({ fetch, store: memoryStore(), downloadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ivoryos-bad-')) });
    await git.connect('github', 't');
    await assert.rejects(git.download('github', 'o/r', 'main'), /not a source archive/);
});

test('GitHub Enterprise has its API under /api/v3', () => {
    assert.equal(githubApi('https://github.com'), 'https://api.github.com');
    assert.equal(githubApi('https://github.lab.org/'), 'https://github.lab.org/api/v3');
});

test('local archives are keyed by repository, so a newer commit replaces the older one', () => {
    const a = 'C:\\Users\\me\\AppData\\Roaming\\IvoryOS\\private-packages\\github-lab-pumps-aaaaaaaaaaaa.tar.gz';
    const b = 'C:\\Users\\me\\AppData\\Roaming\\IvoryOS\\private-packages\\github-lab-pumps-bbbbbbbbbbbb.tar.gz';
    const other = 'C:\\Users\\me\\AppData\\Roaming\\IvoryOS\\private-packages\\github-lab-balance-aaaaaaaaaaaa.tar.gz';
    assert.equal(packageKey(a), packageKey(b));
    assert.notEqual(packageKey(a), packageKey(other), 'two private packages on Windows no longer collide as "c"');
    assert.notEqual(packageKey(a), packageKey('c'));
    const { deck } = mergeIntoDeck({ packages: [a, other] }, { packages: [b] });
    assert.deepEqual(deck.packages, [b, other]);
    assert.equal(packageKey('/Users/me/pkgs/gitlab-42-aaaaaaaaaaaa.tar.gz'), packageKey('/Users/me/pkgs/gitlab-42-cccccccccccc.tar.gz'));
});

test('versions compare numerically, pre-releases before their release', () => {
    assert.equal(compareVersions('0.10.0', '0.9.3'), 1);
    assert.equal(compareVersions('desktop-v0.2.0', '0.2.0'), 0);
    assert.equal(compareVersions('0.2.0-test.1', '0.2.0'), -1);
    assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
});

test('signing in from the browser: GitHub device flow, polled until approved', async () => {
    let polls = 0;
    const { fetch, calls } = fakeForge({
        'https://github.com/login/device/code': () => [200, { device_code: 'dev1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 }],
        'https://github.com/login/oauth/access_token': () => {
            polls += 1;
            return polls === 1 ? [200, { error: 'authorization_pending' }] : polls === 2 ? [200, { error: 'slow_down' }] : [200, { access_token: 'gho_ok', token_type: 'bearer' }];
        },
        'https://api.github.com/user': (_u, headers) => [200, { login: headers.Authorization === 'Bearer gho_ok' ? 'ada' : '?' }],
    });
    const waits = [];
    const store = memoryStore();
    const git = new GitConnections({ fetch, store, downloadDir: os.tmpdir(), clientIds: { github: 'Iv1.test', gitlab: '' }, sleep: async (ms) => { waits.push(ms); } });
    assert.equal(git.list().find((c) => c.provider === 'github').oauth, true);
    assert.equal(git.list().find((c) => c.provider === 'gitlab').oauth, false);
    const flow = await git.startSignIn('github');
    assert.deepEqual([flow.userCode, flow.verificationUri], ['ABCD-1234', 'https://github.com/login/device']);
    const list = await git.finishSignIn('github');
    assert.equal(list.find((c) => c.provider === 'github').login, 'ada');
    assert.deepEqual(waits, [5000, 5000, 10000]); // slow_down adds five seconds
    assert.equal(store.read().github.kind, 'oauth');
    assert.ok(calls.some((c) => c.url === 'https://github.com/login/device/code'));
});

test('a GitLab sign-in renews its two-hour token with the refresh token', async () => {
    let now = 1_000_000;
    const { fetch } = fakeForge({
        'https://gitlab.com/oauth/authorize_device': () => [200, { device_code: 'd', user_code: 'XY', verification_uri: 'https://gitlab.com/oauth/device', verification_uri_complete: 'https://gitlab.com/oauth/device?user_code=XY', interval: 5, expires_in: 300 }],
        'https://gitlab.com/oauth/token': (_u, _h) => [200, { access_token: `glo_${now}`, refresh_token: `r_${now}`, expires_in: 7200 }],
        'https://gitlab.com/api/v4/user': (_u, headers) => [200, { username: headers.Authorization ? 'lab' : '?' }],
        'https://gitlab.com/api/v4/projects': (_u, headers) => [200, [{ id: 1, path_with_namespace: `a/${headers.Authorization}`, visibility: 'private' }]],
    });
    const store = memoryStore();
    const git = new GitConnections({ fetch, store, downloadDir: os.tmpdir(), clientIds: { github: '', gitlab: 'gl-app' }, now: () => now, sleep: async () => {} });
    const flow = await git.startSignIn('gitlab');
    assert.match(flow.verificationUri, /user_code=XY/);
    await git.finishSignIn('gitlab');
    assert.equal(store.read().gitlab.token, 'glo_1000000');
    now += 2 * 3600 * 1000; // two hours later the token is stale
    const repos = await git.repos('gitlab');
    assert.equal(repos[0].name, `a/Bearer glo_${now}`);
    assert.equal(store.read().gitlab.refreshToken, `r_${now}`);
});

test('a declined or unavailable sign-in says so', async () => {
    const { fetch } = fakeForge({
        'https://github.com/login/device/code': () => [200, { device_code: 'd', user_code: 'U', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 }],
        'https://github.com/login/oauth/access_token': () => [200, { error: 'access_denied' }],
    });
    const git = new GitConnections({ fetch, store: memoryStore(), downloadDir: os.tmpdir(), clientIds: { github: 'Iv1.test', gitlab: '' }, sleep: async () => {} });
    await git.startSignIn('github');
    await assert.rejects(git.finishSignIn('github'), /declined/);
    await assert.rejects(git.startSignIn('gitlab'), /not set up/);
});
