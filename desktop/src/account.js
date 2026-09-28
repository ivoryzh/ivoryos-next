'use strict';
// Signing in to IvoryOS: the same accounts as the Hub (its Supabase project), so one account
// covers the Hub website and this app, and the name and lab shown here are the Hub profile's.
//
// Tokens stay in this (main) process. The launcher page is told who is signed in and on which
// plan, never the access or refresh token: the page runs web code, and a token there can be read
// by anything that runs in it. The edge follows the same rule for its CLOUD_TOKEN.
//
// Supabase Auth is reached over its REST API rather than supabase-js: a handful of endpoints, no
// dependency, and nothing that assumes a browser's storage. Pure apart from `fetch` and `store`,
// both injected, so it is tested without Electron or a network.
//
// The plan ("free" / "pro") is a PREVIEW: it is kept in the user's own `user_metadata`, which the
// user can write. That is fine for showing what an upgrade would unlock and never fine for
// anything that is paid for; real entitlements must come from something only the server writes.

const crypto = require('node:crypto');

// The Hub's Supabase project. The anon key is public by design (it ships in the Hub's own web
// page); what a signed-in user may read or write is decided by row-level security.
const HUB_AUTH = {
    url: 'https://eaarfpxmxyhxndlsvgkd.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhYXJmcHhteHloeG5kbHN2Z2tkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM0MzcwMDEsImV4cCI6MjA3OTAxMzAwMX0.eSD7GpJ5boAxj5z0KaKoehILMUPbzuJBq7ZosJnfMsI',
};

const PLANS = ['free', 'pro'];

class AccountError extends Error {}

/** A PKCE pair for an OAuth sign-in: the verifier stays here, the challenge goes to the browser. */
function pkcePair() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

/** Supabase answers errors in three shapes depending on the endpoint; say the useful part. */
function errorMessage(body, status) {
    const raw = body && (body.msg || body.error_description || body.message || body.error);
    if (/invalid login credentials/i.test(raw || '')) return 'That email and password do not match an IvoryOS account.';
    if (/email not confirmed/i.test(raw || '')) return 'Confirm your email first: open the link we sent you, then sign in.';
    if (/user already registered/i.test(raw || '')) return 'There is already an account with this email. Sign in instead.';
    return raw || `The account service answered ${status}.`;
}

class Account {
    /**
     * @param {object} opts
     * @param {typeof fetch} opts.fetch
     * @param {{read(): any, write(value: any): void}} opts.store  where the session is kept (encrypted by the caller)
     * @param {string} [opts.url]
     * @param {string} [opts.key]
     * @param {() => number} [opts.now]  seconds since the epoch; injectable for tests
     */
    constructor({ fetch, store, url = HUB_AUTH.url, key = HUB_AUTH.key, now = () => Math.floor(Date.now() / 1000) }) {
        this.fetch = fetch;
        this.store = store;
        this.url = url.replace(/\/+$/, '');
        this.key = key;
        this.now = now;
        this.session = store.read() || null;
        this.profileCache = null;
    }

    async _request(path, { method = 'GET', body, token, headers = {} } = {}) {
        let res;
        try {
            res = await this.fetch(`${this.url}${path}`, {
                method,
                headers: {
                    apikey: this.key,
                    Authorization: `Bearer ${token || this.key}`,
                    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                    ...headers,
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
        } catch (e) {
            throw new AccountError(`Could not reach the IvoryOS account service (${e.message}).`);
        }
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        if (!res.ok) throw Object.assign(new AccountError(errorMessage(json, res.status)), { status: res.status });
        return json;
    }

    _save(session) {
        this.session = session;
        this.profileCache = null;
        this.store.write(session);
    }

    /** Keep a token response: Supabase sends `expires_in`, which is relative, so fix it in time. */
    _keep(tokens) {
        if (!tokens || !tokens.access_token) throw new AccountError('The account service did not return a session.');
        this._save({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: tokens.expires_at || this.now() + (tokens.expires_in || 3600),
            user: tokens.user,
        });
        return this.describe();
    }

    /** A usable access token, refreshed when it is about to expire; null when signed out. */
    async token() {
        if (!this.session) return null;
        if (this.session.expires_at - 60 > this.now()) return this.session.access_token;
        try {
            const tokens = await this._request('/auth/v1/token?grant_type=refresh_token', {
                method: 'POST', body: { refresh_token: this.session.refresh_token },
            });
            this._keep(tokens);
            return this.session.access_token;
        } catch (e) {
            // A refresh token that is refused (revoked, signed out elsewhere, reused) will never
            // work again: sign out here too rather than fail the same way on every call. A
            // network failure is not that, so the session is kept for next time.
            if (e.status >= 400 && e.status < 500) this._save(null);
            throw e;
        }
    }

    async signIn(email, password) {
        if (!email || !password) throw new AccountError('Enter your email and password.');
        return this._keep(await this._request('/auth/v1/token?grant_type=password', {
            method: 'POST', body: { email: String(email).trim(), password },
        }));
    }

    /**
     * Create an account. With email confirmation on (the Hub's setting), no session comes back
     * until the link in the email is opened, which is reported as `confirmEmail`.
     */
    async signUp(email, password, fullName) {
        if (!email || !password) throw new AccountError('Enter an email and a password.');
        if (String(password).length < 6) throw new AccountError('Use a password of at least 6 characters.');
        const body = await this._request('/auth/v1/signup', {
            method: 'POST',
            body: { email: String(email).trim(), password, data: fullName ? { full_name: String(fullName).trim() } : {} },
        });
        if (body && body.access_token) return this._keep(body);
        return { ...this.describe(), confirmEmail: true, email: String(email).trim() };
    }

    async resetPassword(email) {
        if (!email) throw new AccountError('Enter the email of your account.');
        await this._request('/auth/v1/recover', { method: 'POST', body: { email: String(email).trim() } });
    }

    /** Where to send the browser for "Continue with GitHub/Google" (PKCE: the code comes back here). */
    oauthUrl(provider, redirectTo, challenge) {
        if (!['github', 'google'].includes(provider)) throw new AccountError(`Unknown sign-in provider: ${provider}`);
        const q = new URLSearchParams({ provider, redirect_to: redirectTo, code_challenge: challenge, code_challenge_method: 's256' });
        return `${this.url}/auth/v1/authorize?${q}`;
    }

    async exchangeCode(code, verifier) {
        return this._keep(await this._request('/auth/v1/token?grant_type=pkce', {
            method: 'POST', body: { auth_code: code, code_verifier: verifier },
        }));
    }

    async signOut() {
        const token = this.session && this.session.access_token;
        this._save(null);
        // Revokes the refresh token server-side; best effort, since signing out here must never
        // fail just because the network is down.
        if (token) await this._request('/auth/v1/logout', { method: 'POST', token }).catch(() => {});
    }

    /** Re-read the user (plan, email changes) from the server. */
    async refreshUser() {
        const token = await this.token();
        if (!token) return this.describe();
        const user = await this._request('/auth/v1/user', { token });
        this._save({ ...this.session, user });
        return this.describe();
    }

    /** The Hub profile (name, lab, picture): the `profiles` row the Hub's own profile page edits. */
    async profile() {
        const token = await this.token();
        if (!token) return null;
        if (this.profileCache) return this.profileCache;
        const rows = await this._request(`/rest/v1/profiles?id=eq.${encodeURIComponent(this.session.user.id)}&select=full_name,lab_info,avatar_url`, { token });
        this.profileCache = (rows && rows[0]) || { full_name: null, lab_info: null, avatar_url: null };
        return this.profileCache;
    }

    async updateProfile({ full_name, lab_info }) {
        const token = await this.token();
        if (!token) throw new AccountError('Sign in first.');
        const patch = { id: this.session.user.id };
        if (full_name !== undefined) patch.full_name = String(full_name).trim() || null;
        if (lab_info !== undefined) patch.lab_info = String(lab_info).trim() || null;
        const rows = await this._request('/rest/v1/profiles?on_conflict=id', {
            method: 'POST', token, body: patch,
            headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        });
        this.profileCache = (rows && rows[0]) || { ...(this.profileCache || {}), ...patch };
        return this.profileCache;
    }

    async changePassword(password) {
        if (!password || String(password).length < 6) throw new AccountError('Use a password of at least 6 characters.');
        const token = await this.token();
        if (!token) throw new AccountError('Sign in first.');
        const user = await this._request('/auth/v1/user', { method: 'PUT', token, body: { password } });
        this._save({ ...this.session, user });
    }

    /** The preview plan switch (see the note at the top): no payment, no entitlement. */
    async setPlan(plan) {
        if (!PLANS.includes(plan)) throw new AccountError(`Unknown plan: ${plan}`);
        const token = await this.token();
        if (!token) throw new AccountError('Sign in to upgrade.');
        const user = await this._request('/auth/v1/user', { method: 'PUT', token, body: { data: { ivoryos_plan: plan } } });
        this._save({ ...this.session, user });
        return this.describe();
    }

    /** What the launcher page may know: who, and which plan. Never a token. */
    describe() {
        const user = this.session && this.session.user;
        if (!user) return { signedIn: false, plan: 'free' };
        const meta = user.user_metadata || {};
        const identities = (user.identities || []).map((i) => i.provider);
        return {
            signedIn: true,
            plan: meta.ivoryos_plan === 'pro' ? 'pro' : 'free',
            user: {
                id: user.id,
                email: user.email || null,
                name: (this.profileCache && this.profileCache.full_name) || meta.full_name || meta.name || meta.user_name || null,
                avatarUrl: (this.profileCache && this.profileCache.avatar_url) || meta.avatar_url || null,
                lab: (this.profileCache && this.profileCache.lab_info) || null,
                providers: identities.length ? identities : ['email'],
            },
        };
    }
}

module.exports = { Account, AccountError, HUB_AUTH, PLANS, pkcePair, errorMessage };
