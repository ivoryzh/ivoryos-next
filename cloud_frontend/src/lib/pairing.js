'use strict';

/**
 * Device pairing: the edge shows a short code, a signed-in person approves it on Cloud, and only
 * then does the edge receive its credentials. The same shape as signing in a TV or a CLI tool.
 *
 *   edge   POST /api/pair/start   -> { code, secret }   shows the code, keeps the secret
 *   person /pair (signed in)      -> approve or deny    picks the name and the workspace
 *   edge   POST /api/pair/poll    { secret }            waits; after approval, gets the token once
 *
 * Why this way round (it used to be Cloud making a code for the edge to redeem):
 *
 * - The code is not a credential any more. It can only be *approved*; what collects the token is
 *   the secret, which never leaves the edge. Someone who photographs the code off a screen gets
 *   nothing.
 * - Talking someone into approving the wrong code adds *their* device to *your* workspace, which is
 *   visible, removable and cannot move your hardware. The old way, talking someone into typing
 *   *your* code on *their* edge put their instruments under your control. The approval screen
 *   shows the device's name and instruments so it is hard to approve something by mistake.
 * - Approval happens where the person is already signed in, in the workspace they are looking at.
 *
 * The code stays cheap to type and expensive to guess while it lives: 8 characters from an
 * alphabet without I, O, 0 or 1 (32 symbols, ~1.1e12 codes), 10 minutes, and every lookup is
 * rate limited and needs a session. The secret is 32 random bytes, stored only as its SHA-256.
 */

const crypto = require('crypto');

// No I, O, 0, 1 — the four characters people reliably mistype when reading a code off a screen.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const TTL_MS = 10 * 60 * 1000;
// How often the edge asks. Returned by /start so it can be changed here without an edge release.
const POLL_INTERVAL_S = 3;

function generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return out;
}

/** What the edge keeps and proves itself with: never shown to a person, never stored in clear. */
function generateSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex');
}

/** `7K4M-9QX2` for display; stored and compared without the dash. */
function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Accept what a person actually types: lower case, and the dash or spaces they copied along with
 * the code. Only separators are removed — an actually-wrong character is left in place so the
 * code simply fails to match. There is nothing to "correct" it to: I, O, 0 and 1 are excluded
 * from the alphabet entirely, so a typed O has no valid counterpart, and deleting it would
 * shift every following character and turn a one-character typo into gibberish.
 */
function normalizeCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .slice(0, CODE_LENGTH);
}

const expiryFrom = (now = Date.now()) => new Date(now + TTL_MS).toISOString();

/**
 * A device name is its MQTT client id on a LAN Cloud, and a segment of every topic it uses, so
 * the characters MQTT gives meaning to (`/`, `+`, `#`) and control characters are refused rather
 * than silently breaking its topics. Spaces are fine. Returns the cleaned name, or null.
 */
function cleanDeviceName(input) {
  const name = String(input || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 64) return null;
  if (/[/+#\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/**
 * The edge's display of itself for the approval screen: instrument names only, a bounded number
 * of short ones. It is what a person reads to recognise their device, not data anything uses.
 */
function cleanInstruments(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim().slice(0, 64))
    .slice(0, 50);
}

/*
 * A device's identity is its own lasting id (the edge's CLOUD_DEVICE_ID), not its name: the id is
 * its MQTT client id and AWS Thing name, the name only a label. So two decks may both be called
 * "My deck", and pairing the same deck again reattaches it (history, workspace, name) instead of
 * meeting itself as a stranger.
 */

// An MQTT topic segment and an AWS Thing name ([a-zA-Z0-9:_-]) alike.
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:-]{2,63}$/;

function cleanDeviceId(input) {
  const id = String(input || '').trim();
  return DEVICE_ID_RE.test(id) ? id : null;
}

/** For an edge too old to send its own id: the same shape the edge makes (`my-deck-7k4m2q`). */
function generateDeviceId(name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'edge';
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += alphabet[crypto.randomInt(0, alphabet.length)];
  return `${slug}-${suffix}`;
}

/**
 * What approving a request for this device id means:
 *   'new'       Cloud does not know the id (never paired, or removed since): a new device.
 *   'reattach'  the same device paired again, into a workspace of the approver's: reconnect it.
 *   'foreign'   it belongs to a workspace the approver is not in. Refused: approving would hand
 *               someone else's device (its connection, its tasks) to whoever typed the code.
 * A device paired before Cloud had sign-in has no workspace; it may be reattached where claiming
 * such devices is allowed at all (`claimable`: a lab's own Cloud, see workspace.ts claimAllowed).
 */
function identityDecision({ exists, owner, workspaces, claimable }) {
  if (!exists) return 'new';
  if (owner) return (workspaces || []).includes(owner) ? 'reattach' : 'foreign';
  return claimable ? 'reattach' : 'foreign';
}

/**
 * What a poll with this secret gets, from the request's row alone:
 *   'unknown'   no request has this secret
 *   'waiting'   nobody has approved it yet (or another poll is collecting it right now)
 *   'approved'  approved: this poll may collect the credentials
 *   'denied'    someone answered "not mine"
 *   'expired'   not approved in time, or approved and not collected in time
 *   'used'      the credentials were already collected; they are handed out once
 */
function pollOutcome(row, nowMs = Date.now()) {
  if (!row) return 'unknown';
  if (row.status === 'redeemed') return 'used';
  if (row.status === 'denied') return 'denied';
  if (row.status === 'provisioning') return 'waiting';
  if (new Date(row.expires_at).getTime() <= nowMs) return 'expired';
  if (row.status === 'approved') return 'approved';
  return 'waiting';
}

module.exports = {
  ALPHABET, CODE_LENGTH, TTL_MS, POLL_INTERVAL_S,
  generateCode, generateSecret, hashSecret, formatCode, normalizeCode, expiryFrom,
  cleanDeviceName, cleanInstruments, cleanDeviceId, generateDeviceId, identityDecision, pollOutcome,
};
