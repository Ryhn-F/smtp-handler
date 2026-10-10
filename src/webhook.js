'use strict';

// Standard Webhooks verification (https://github.com/standard-webhooks/standard-webhooks).
// Supabase signs the Send Email hook this way; the secret looks like
// `v1,whsec_<base64>`.

const crypto = require('node:crypto');

const ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;
const TS_RE = /^\d{1,12}$/;
const MAX_SIGNATURES = 10;

/** Returns the decoded secret key as a Buffer, or null if absent/invalid. */
function parseHookSecret(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith('v1,')) s = s.slice(3);
  if (s.startsWith('whsec_')) s = s.slice(6);
  if (!s || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const key = Buffer.from(s, 'base64');
  // Standard Webhooks secrets are 24-64 random bytes; refuse trivially short keys.
  if (key.length < 16) return null;
  return key;
}

function sign(key, id, timestamp, body) {
  return crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest();
}

/**
 * @param {object} p
 * @param {Buffer} p.key        decoded secret
 * @param {Buffer} p.body       RAW request body
 * @param {object} p.headers    lower-cased Node headers
 * @param {number} p.nowSec     current unix time (seconds)
 * @param {number} p.toleranceSec
 * @returns {{ok:true,id:string}|{ok:false,reason:string}}
 */
function verifyWebhook({ key, body, headers, nowSec, toleranceSec }) {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sigHeader = headers['webhook-signature'];
  if (typeof id !== 'string' || typeof ts !== 'string' || typeof sigHeader !== 'string') {
    return { ok: false, reason: 'missing_headers' };
  }
  if (!ID_RE.test(id) || !TS_RE.test(ts)) return { ok: false, reason: 'bad_headers' };
  if (Math.abs(nowSec - Number(ts)) > toleranceSec) return { ok: false, reason: 'timestamp_out_of_range' };

  const expected = sign(key, id, ts, body);
  const candidates = sigHeader.trim().split(/\s+/).slice(0, MAX_SIGNATURES);
  let matched = false;
  for (const entry of candidates) {
    const comma = entry.indexOf(',');
    if (comma < 0) continue;
    if (entry.slice(0, comma) !== 'v1') continue; // v1a (ed25519) is not used by Supabase
    const given = Buffer.from(entry.slice(comma + 1), 'base64');
    // Evaluate every candidate (no early exit) to keep timing independent of position.
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) matched = true;
  }
  return matched ? { ok: true, id } : { ok: false, reason: 'bad_signature' };
}

module.exports = { parseHookSecret, verifyWebhook, sign };
