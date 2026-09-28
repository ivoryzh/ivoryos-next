'use strict';
// Private drivers from GitHub or GitLab: connect with a personal access token, list the
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
    constructor({ fetch, store, downloadDir }) {
        this.fetch = fetch;
        this.store = store;
        this.downloadDir = downloadDir;
    }

    _all() { return this.store.read() || {}; }

    _conn(provider) {
        if (!PROVIDERS[provider]) throw new GitError(`Unknown provider: ${provider}`);
        const c = this._all()[provider];
        if (!c) throw new GitError(`Connect ${PROVIDERS[provider].label} first.`);
        return c;
    }

    _headers(provider, token) {
        return provider === 'github'
            ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
            : { 'PRIVATE-TOKEN': token };
    }

    _api(provider, host) {
        return provider === 'github' ? githubApi(host) : `${host}/api/v4`;
    }

    async _get(provider, conn, apiPath, { raw = false, headers = {} } = {}) {
        let res;
        try {
            res = await this.fetch(`${this._api(provider, conn.host)}${apiPath}`, { headers: { ...this._headers(provider, conn.token), ...headers } });
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

    /** Connections without their tokens, for the launcher page. */
    list() {
        const all = this._all();
        return Object.keys(PROVIDERS).map((provider) => ({
            provider,
            label: PROVIDERS[provider].label,
            tokenHelp: PROVIDERS[provider].tokenHelp,
            scopes: PROVIDERS[provider].scopes,
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
        const conn = { token: t, host: normalizeHost(provider, host) };
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
