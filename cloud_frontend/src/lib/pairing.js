'use strict';

/**
 * Device pairing codes: the short, single-use, expiring string that replaces carrying a base64
 * token between machines by hand.
 *
 * What the old flow actually asked of people: copy a base64 blob and paste it into another
 * computer. On AWS that blob wrapped the device's **private key**, so the recommended workflow
 * put a private key on a clipboard and, in practice, through chat or email. The key now never
 * touches a clipboard — it is generated at redemption and travels once, over TLS, straight to the
 * device that will use it.
 *
 * The code is a bearer credential for exactly one provisioning, so it is deliberately cheap to
 * type and expensive to guess in the time it lives:
 *
 *   alphabet  31 unambiguous characters (no I, O, 0, 1 — they are misread when typed off a
 *             screen, and a pairing code exists to be typed off a screen)
 *   length    8, formatted 4-4 for reading; ~31^8 ≈ 8.5e11 possibilities
 *   lifetime  10 minutes, single use, claimed atomically
 *
 * Guessing one inside its window means ~10^11 attempts against a rate-limited endpoint. The
 * entropy is doing real work here, which is why this uses crypto.randomInt and not Math.random.
 */

const crypto = require('crypto');

// No I, O, 0, 1 — the four characters people reliably mistype when reading a code off a screen.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const TTL_MS = 10 * 60 * 1000;

function generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return out;
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

module.exports = { ALPHABET, CODE_LENGTH, TTL_MS, generateCode, formatCode, normalizeCode, expiryFrom };
