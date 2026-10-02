'use strict';
// "Send to IvoryOS": a problem report built from what the launcher already knows about a profile
// (its state and log, the deck, the Python environment), shown to the person in full before
// anything leaves the machine, and filed in the Automation Hub's database (hubCatalog.fileReport,
// table `problem_reports`, write-only for clients).
//
// A log is written for the person reading it at the bench, not for sending: it can hold paths
// with their name in them, a pairing token, an API key a driver printed, an email. So everything
// goes through redact() before it is shown, and again before it is sent (the person may have
// pasted something into their description). Redaction is a safety net, not the consent: the
// person sees and can edit the exact text that is sent.
//
// Pure apart from what the caller passes in, so it is tested without Electron
// (test/problemReport.test.js).

// The log is the current session's (what the Log tab shows), so this only trims a very long one.
const LOG_LINES = 1000;
const MAX_BODY = 150_000; // the table refuses more than 200,000 characters

const RULES = [
    // A PEM block (an AWS IoT private key or certificate) is removed whole.
    [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, '[key removed]'],
    // `NAME=value` / `"name": "value"` where the name says what it is.
    [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2[removed]'],
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [removed]'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[token removed]'],     // a JWT
    [/\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, '[key removed]'],        // OpenAI / Anthropic / Stripe style
    [/\bivc_[A-Za-z0-9_-]{8,}/g, '[key removed]'],                                              // a Cloud agent token
    [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[key removed]'],                                        // an AWS access key id
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[key removed]'],                                       // a GitHub token
    [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '[key removed]'],                                         // a GitLab token
    // Credentials inside a URL: scheme://user:password@host
    [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[removed]@'],
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
    // A long unbroken base64-ish run is almost never something a person needs to read.
    [/[A-Za-z0-9+/_-]{120,}={0,2}/g, '[long value removed]'],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove what should not leave the machine. `home` becomes `~` (it usually holds the person's
 * name), and `username` is masked wherever else it appears in a path.
 */
function redact(text, { home, username } = {}) {
    let out = String(text || '');
    if (home && home.length > 2) {
        out = out.replace(new RegExp(escapeRe(home), 'g'), '~');
        // Windows logs mix separators and case.
        if (home.includes('\\')) out = out.replace(new RegExp(escapeRe(home.replace(/\\/g, '/')), 'gi'), '~');
    }
    if (username && username.length > 2) {
        out = out.replace(new RegExp(`([\\\\/])${escapeRe(username)}(?=[\\\\/])`, 'g'), '$1[user]');
    }
    for (const [re, to] of RULES) out = out.replace(re, to);
    return out;
}

/** What kind of problem this is, for sorting reports: from the profile's state and message. */
function kindOf(status = {}) {
    const message = String(status.message || status.error || '');
    if (/^install/i.test(message) || /pip|uv |resolv|conflict|No matching distribution/i.test(message)) return 'install';
    if (status.state === 'crashed') return 'crash';
    if (status.state === 'error') return 'start';
    return 'other';
}

/** The last `n` lines of a log. */
function tail(text, n = LOG_LINES) {
    const lines = String(text || '').split(/\r?\n/);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.slice(-n).join('\n');
}

/** A deck as names and classes only: an instrument's arguments are addresses, ports and serials. */
function describeDeck(deck) {
    if (!deck) return '';
    const lines = [];
    if ((deck.packages || []).length) lines.push(`packages: ${deck.packages.join(', ')}`);
    for (const inst of deck.instruments || []) {
        lines.push(`- ${inst.name}: ${inst.import || '?'}.${inst.class || '?'}${inst.enabled === false ? ' (disabled)' : ''}`);
    }
    if ((deck.plugins || []).length) lines.push(`plugins: ${deck.plugins.join(', ')}`);
    return lines.join('\n');
}

function describeEnvironment(env) {
    if (!env) return '';
    if (env.error) return `Could not inspect the Python environment: ${env.error}`;
    const lines = [`Python ${env.python || '?'} (${env.prefix || 'unknown location'})`, `ivoryos-edge ${env.edge || 'not installed'}`];
    const opt = env.optimizers || {};
    if (Object.keys(opt).length) {
        lines.push(`Optimizers: ${Object.entries(opt).map(([name, v]) => `${name} ${v || 'not installed'}`).join(', ')}`);
    }
    return lines.join('\n');
}

/**
 * The report's details, everything but the person's own description: the text shown in the
 * dialog for them to read and edit. Already redacted.
 */
function buildDetails({ app = {}, profile = {}, status = {}, log = '', installOutput = null, deck = null, environment = null, check = null }, ctx = {}) {
    const sections = [];
    const head = [
        `IvoryOS ${app.version || '?'} on ${app.platform || '?'}${app.arch ? ` (${app.arch})` : ''}${app.os ? `, ${app.os}` : ''}`,
        `Profile: ${profile.kind || '?'}${status.state ? `, ${status.state}` : ''}`,
    ];
    if (status.message) head.push(`Message: ${status.message}`);
    sections.push(head.join('\n'));
    const env = describeEnvironment(environment);
    if (env) sections.push(`## Python environment\n${env}`);
    if (check) sections.push(`## Dependency check (uv pip check)\n${check.trim()}`);
    const deckText = describeDeck(deck);
    if (deckText) sections.push(`## Deck\n${deckText}`);
    if (installOutput && String(installOutput).trim()) sections.push(`## Install output\n${tail(installOutput, 200)}`);
    const lines = String(log || '').split(/\r?\n/).filter((l, i, all) => i < all.length - 1 || l.trim()).length;
    sections.push(`## Log, this session${lines > LOG_LINES ? ` (last ${LOG_LINES} of ${lines} lines)` : ''}\n${tail(log) || '(empty)'}`);
    if (environment && (environment.packages || []).length) sections.push(`## Installed packages\n${environment.packages.join('\n')}`);
    return redact(sections.join('\n\n'), ctx);
}

/**
 * The row filed in the Hub: the description first (what a person triaging reads), the details
 * after. Redacted again: the description is whatever the person typed or pasted.
 */
function buildRow({ id, description = '', details = '', contactEmail = null, app = {}, kind = 'other' }, ctx = {}) {
    const said = String(description || '').trim();
    const firstLine = said.split(/\r?\n/)[0] || String(details).split(/\r?\n/).find((l) => l.startsWith('Message:'))?.slice(9) || 'Problem report';
    let body = [said && `## What happened\n${said}`, details].filter(Boolean).join('\n\n');
    body = redact(body, ctx);
    if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n[cut: the report was longer than ${MAX_BODY} characters]`;
    const email = contactEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contactEmail).trim()) ? String(contactEmail).trim() : null;
    return {
        id,
        source: 'desktop',
        kind,
        title: redact(firstLine, ctx).trim().slice(0, 200) || 'Problem report',
        body,
        app_version: app.version || null,
        platform: [app.platform, app.arch].filter(Boolean).join('-') || null,
        contact_email: email,
    };
}

/**
 * A prefilled GitHub issue, for when the Hub cannot take the report. GitHub issues are public
 * and a URL holds only so much, so this carries the description and the head of the details
 * and says the rest was left out.
 */
function githubIssueUrl(repo, row) {
    const room = 6000;
    const body = row.body.length > room ? `${row.body.slice(0, room)}\n\n[cut for length]` : row.body;
    const q = new URLSearchParams({ title: row.title, body, labels: 'from-app' });
    return `https://github.com/${repo}/issues/new?${q}`;
}

module.exports = { redact, kindOf, tail, describeDeck, buildDetails, buildRow, githubIssueUrl, LOG_LINES, MAX_BODY };
