'use strict';
// Private drivers from GitHub or GitLab: connect by signing in (OAuth device flow) or with a
// personal access token, list the
// repositories it can read, and download one at a fixed commit so it can be installed like any
// other driver package.
//
// Why download instead of `pip install git+https://...`: that needs git on the machine (a clean
// Windows PC has none), and the token would have to go into the requirement string, which is
// saved in deck.json in the clear. Here the token is used for the download only; what the deck
// records is the path of a file named after the commit, so the install is pinned and repeatable
// (a rebuilt Python environment reinstalls exactly that commit) and holds no secret.
//
// Tokens are kept by the caller's `store` (secrets.js: encrypted by the OS keychain). Pure apart
// from `fetch`, `store` and the download folder, so it is tested without Electron.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS = {
    github: {
        label: 'GitHub',
        defaultHost: 'https://github.com',
        tokenHelp: 'https://github.com/settings/personal-access-tokens/new',
        scopes: 'a fine-grained token with Contents: Read-only on the repositories to import (or a classic token with the repo scope)',
    },
    gitlab: {
        label: 'GitLab',
        defaultHost: 'https://gitlab.com',
        tokenHelp: 'https://gitlab.com/-/user_settings/personal_access_tokens',
        scopes: 'a token with the read_api and read_repository scopes',
    },
};

/**
 * OAuth apps for signing in from the browser (the device flow: the app shows a short code, the
 * person approves it on github.com / gitlab.com, the app polls for the token). A device-flow app
 * has no secret to ship, which is what makes it usable from a desktop app; it does need registering
 * once per provider (GitHub: an OAuth App with "Enable Device Flow"; GitLab: an application,
 * non-confidential, scopes read_api + read_repository). Until an id is set here or in the
 * environment, only the token path is offered. A self-managed GitLab has its own applications, so
 * sign-in there needs IVORYOS_GITLAB_CLIENT_ID set for that server.
 */
const OAUTH_CLIENT_IDS = {
    github: process.env.IVORYOS_GITHUB_CLIENT_ID || '',
    gitlab: process.env.IVORYOS_GITLAB_CLIENT_ID || '',
};
const OAUTH_SCOPES = { github: 'repo read:user', gitlab: 'read_api read_repository read_user' };

class GitError extends Error {}

/** GitHub's API lives on api.github.com; GitHub Enterprise Server's on <host>/api/v3. */
function githubApi(host) {
    const h = (host || PROVIDERS.github.defaultHost).replace(/\/+$/, '');
    return h === 'https://github.com' ? 'https://api.github.com' : `${h}/api/v3`;
}

function normalizeHost(provider, host) {
    let h = String(host || PROVIDERS[provider].defaultHost).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(h)) h = `https://${h}`;
    return h;
}

class GitConnections {
    /**
     * @param {object} opts
     * @param {typeof fetch} opts.fetch
     * @param {{read(): any, write(v: any): void}} opts.store  {github?: {token, login, host}, gitlab?: {...}}
     * @param {string} opts.downloadDir  where downloaded archives are kept (they are what decks point at)
     */
    constructor({ fetch, store, downloadDir, clientIds = OAUTH_CLIENT_IDS, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
        this.fetch = fetch;
        this.store = store;
        this.downloadDir = downloadDir;
        this.clientIds = clientIds;
        this.now = now;
        this.sleep = sleep;
        this.pending = {}; // provider -> the device flow being approved {deviceCode, interval, expiresAt, host, cancelled}
    }

    _all() { return this.store.read() || {}; }

    _conn(provider) {
        if (!PROVIDERS[provider]) throw new GitError(`Unknown provider: ${provider}`);
        const c = this._all()[provider];
        if (!c) throw new GitError(`Connect ${PROVIDERS[provider].label} first.`);
        return c;
    }

    _headers(provider, token, kind) {
        if (provider === 'github') return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
        // A GitLab OAuth token is a bearer token; a personal access token has its own header.
        return kind === 'oauth' ? { Authorization: `Bearer ${token}` } : { 'PRIVATE-TOKEN': token };
    }

    _api(provider, host) {
        return provider === 'github' ? githubApi(host) : `${host}/api/v4`;
    }

    async _get(provider, conn, apiPath, { raw = false, headers = {} } = {}) {
        conn = await this._fresh(provider, conn);
        let res;
        try {
            res = await this.fetch(`${this._api(provider, conn.host)}${apiPath}`, { headers: { ...this._headers(provider, conn.token, conn.kind), ...headers } });
        } catch (e) {
            throw new GitError(`Could not reach ${PROVIDERS[provider].label} (${e.message}).`);
        }
        if (res.status === 401) throw new GitError(`${PROVIDERS[provider].label} refused the token: it may have expired or been revoked. Connect again with a new one.`);
        if (res.status === 403 || res.status === 404) {
            throw Object.assign(new GitError(`${PROVIDERS[provider].label} answered ${res.status}: the token cannot read that (check its scopes: ${PROVIDERS[provider].scopes}).`), { status: res.status });
        }
        if (!res.ok) throw new GitError(`${PROVIDERS[provider].label} answered ${res.status}.`);
        return raw ? res : res.json();
    }

    /**
     * A GitLab OAuth token lasts two hours and comes with a refresh token; renew it shortly before
     * it runs out and keep the new pair. (GitHub OAuth App tokens do not expire.)
     */
    async _fresh(provider, conn) {
        if (conn.kind !== 'oauth' || !conn.refreshToken || !conn.expiresAt || conn.expiresAt - 60_000 > this.now()) return conn;
        const tokens = await this._oauthPost(provider, conn.host, '/oauth/token', {
            grant_type: 'refresh_token', refresh_token: conn.refreshToken, client_id: this.clientIds[provider],
        });
        if (!tokens.access_token) throw new GitError(`${PROVIDERS[provider].label} ended the sign-in. Connect again.`);
        const next = { ...conn, ...this._tokenFields(tokens) };
        this.store.write({ ...this._all(), [provider]: next });
        return next;
    }

    _tokenFields(tokens) {
        return {
            token: tokens.access_token,
            ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
            ...(tokens.expires_in ? { expiresAt: this.now() + Number(tokens.expires_in) * 1000 } : {}),
        };
    }

    async _oauthPost(provider, host, pathName, form) {
        let res;
        try {
            res = await this.fetch(`${host}${pathName}`, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(form).toString(),
            });
        } catch (e) {
            throw new GitError(`Could not reach ${PROVIDERS[provider].label} (${e.message}).`);
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok && !body.error) throw new GitError(`${PROVIDERS[provider].label} answered ${res.status}.`);
        return body;
    }

    /** Whether signing in from the browser is set up for this provider (and server). */
    oauthAvailable(provider, host) {
        if (!this.clientIds[provider]) return false;
        // The built-in GitLab application is registered on gitlab.com only.
        return provider === 'github' || normalizeHost(provider, host) === PROVIDERS.gitlab.defaultHost || !!process.env.IVORYOS_GITLAB_CLIENT_ID;
    }

    /**
     * Start signing in: returns the code to show and the page to approve it on. `finishSignIn`
     * then waits for the approval. GitHub's endpoints are on github.com (not the API host); GitLab's
     * are /oauth/authorize_device and /oauth/token on the server itself.
     */
    async startSignIn(provider, host) {
        if (!PROVIDERS[provider]) throw new GitError(`Unknown provider: ${provider}`);
        const h = normalizeHost(provider, host);
        if (!this.oauthAvailable(provider, h)) throw new GitError(`Signing in to ${PROVIDERS[provider].label} is not set up in this build. Connect with a token instead.`);
        const body = await this._oauthPost(provider, h, provider === 'github' ? '/login/device/code' : '/oauth/authorize_device', {
            client_id: this.clientIds[provider], scope: OAUTH_SCOPES[provider],
        });
        if (!body.device_code) throw new GitError(body.error_description || body.error || `${PROVIDERS[provider].label} did not start the sign-in.`);
        this.pending[provider] = {
            deviceCode: body.device_code, host: h, cancelled: false,
            interval: Math.max(5, Number(body.interval) || 5) * 1000,
            expiresAt: this.now() + (Number(body.expires_in) || 900) * 1000,
        };
        return {
            userCode: body.user_code,
            verificationUri: body.verification_uri_complete || body.verification_uri,
            expiresIn: Number(body.expires_in) || 900,
        };
    }

    /** Wait until the person approves (or refuses) in the browser, then keep the connection. */
    async finishSignIn(provider) {
        const p = this.pending[provider];
        if (!p) throw new GitError('Start signing in first.');
        const tokenPath = provider === 'github' ? '/login/oauth/access_token' : '/oauth/token';
        let interval = p.interval;
        try {
            while (!p.cancelled) {
                if (this.now() > p.expiresAt) throw new GitError('The sign-in code expired. Start again.');
                await this.sleep(interval);
                if (p.cancelled) break;
                const body = await this._oauthPost(provider, p.host, tokenPath, {
                    client_id: this.clientIds[provider], device_code: p.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                });
                if (body.access_token) {
                    const conn = { kind: 'oauth', host: p.host, ...this._tokenFields(body) };
                    const me = await this._get(provider, conn, '/user');
                    conn.login = provider === 'github' ? me.login : me.username;
                    this.store.write({ ...this._all(), [provider]: conn });
                    return this.list();
                }
                if (body.error === 'authorization_pending') continue;
                if (body.error === 'slow_down') { interval += 5000; continue; }
                if (body.error === 'access_denied') throw new GitError('The sign-in was declined in the browser.');
                if (body.error === 'expired_token') throw new GitError('The sign-in code expired. Start again.');
                throw new GitError(body.error_description || body.error || 'The sign-in did not finish.');
            }
            throw new GitError('Sign-in cancelled.');
        } finally {
            if (this.pending[provider] === p) delete this.pending[provider];
        }
    }

    cancelSignIn(provider) {
        if (this.pending[provider]) this.pending[provider].cancelled = true;
    }

    /** Connections without their tokens, for the launcher page. */
    list() {
        const all = this._all();
        return Object.keys(PROVIDERS).map((provider) => ({
            provider,
            label: PROVIDERS[provider].label,
            tokenHelp: PROVIDERS[provider].tokenHelp,
            scopes: PROVIDERS[provider].scopes,
            oauth: this.oauthAvailable(provider, all[provider] ? all[provider].host : undefined),
            connected: !!all[provider],
            login: all[provider] ? all[provider].login : null,
            host: all[provider] ? all[provider].host : PROVIDERS[provider].defaultHost,
        }));
    }

    /** Check the token against the provider (it names its owner) and keep it. */
    async connect(provider, token, host) {
        if (!PROVIDERS[provider]) throw new GitError(`Unknown provider: ${provider}`);
        const t = String(token || '').trim();
        if (!t) throw new GitError('Paste a personal access token.');
        const conn = { kind: 'token', token: t, host: normalizeHost(provider, host) };
        const me = await this._get(provider, conn, '/user');
        conn.login = provider === 'github' ? me.login : me.username;
        this.store.write({ ...this._all(), [provider]: conn });
        return this.list();
    }

    disconnect(provider) {
        const all = { ...this._all() };
        delete all[provider];
        this.store.write(Object.keys(all).length ? all : null);
        return this.list();
    }

    /** Repositories the token can read, most recently changed first; `query` filters by name. */
    async repos(provider, query = '') {
        const conn = this._conn(provider);
        const q = String(query || '').trim().toLowerCase();
        if (provider === 'github') {
            const rows = await this._get(provider, conn, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
            return rows
                .filter((r) => !q || `${r.full_name} ${r.description || ''}`.toLowerCase().includes(q))
                .map((r) => ({
                    id: r.full_name, name: r.full_name, description: r.description, private: r.private,
                    defaultBranch: r.default_branch, updatedAt: r.pushed_at || r.updated_at, url: r.html_url,
                }));
        }
        const rows = await this._get(provider, conn, `/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at${q ? `&search=${encodeURIComponent(q)}` : ''}`);
        return rows.map((r) => ({
            id: String(r.id), name: r.path_with_namespace, description: r.description, private: r.visibility !== 'public',
            defaultBranch: r.default_branch, updatedAt: r.last_activity_at, url: r.web_url,
        }));
    }

    /** The commit a branch (default: the repository's default branch) points at now. */
    async resolveCommit(provider, repoId, ref) {
        const conn = this._conn(provider);
        if (provider === 'github') {
            const branch = ref || (await this._get(provider, conn, `/repos/${repoId}`)).default_branch;
            const res = await this._get(provider, conn, `/repos/${repoId}/commits/${encodeURIComponent(branch)}`, { raw: true, headers: { Accept: 'application/vnd.github.sha' } });
            return { ref: branch, sha: (await res.text()).trim() };
        }
        const id = encodeURIComponent(repoId);
        const branch = ref || (await this._get(provider, conn, `/projects/${id}`)).default_branch;
        const b = await this._get(provider, conn, `/projects/${id}/repository/branches/${encodeURIComponent(branch)}`);
        return { ref: branch, sha: b.commit.id };
    }

    /**
     * Download the repository at one commit, as a source archive pip/uv can install. Returns the
     * file path (what the deck lists as a package) and the commit. Reuses the file when that
     * commit was already downloaded.
     */
    async download(provider, repoId, ref) {
        const conn = this._conn(provider);
        const { sha, ref: branch } = await this.resolveCommit(provider, repoId, ref);
        if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new GitError(`Unexpected commit id from ${PROVIDERS[provider].label}: ${sha}`);
        const slug = String(repoId).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
        const file = path.join(this.downloadDir, `${provider}-${slug}-${sha.slice(0, 12)}.tar.gz`);
        if (!fs.existsSync(file)) {
            const archivePath = provider === 'github'
                ? `/repos/${repoId}/tarball/${sha}`
                : `/projects/${encodeURIComponent(repoId)}/repository/archive.tar.gz?sha=${sha}`;
            const res = await this._get(provider, conn, archivePath, { raw: true });
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < 20 || buf[0] !== 0x1f || buf[1] !== 0x8b) throw new GitError('The download is not a source archive.');
            fs.mkdirSync(this.downloadDir, { recursive: true });
            const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.part`;
            fs.writeFileSync(tmp, buf);
            fs.renameSync(tmp, file);
        }
        return { file, sha, ref: branch };
    }
}

module.exports = { GitConnections, GitError, PROVIDERS, githubApi };
