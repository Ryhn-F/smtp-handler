'use strict';

// Structured logger that can only emit non-sensitive, short, token-like values.
// Anything containing characters outside [A-Za-z0-9_.:-] (e-mail addresses,
// URLs, JSON, free text) is replaced with "[redacted]", and unknown field
// names are dropped. This is the code-level guarantee behind "never log PII".

const ALLOWED_FIELDS = new Set([
  'event', 'status', 'action', 'reason', 'count', 'ms', 'whid', 'recipients',
  'port', 'smtp_code', 'missing', 'node',
]);
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{0,160}$/;

function sanitize(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = SAFE_VALUE.test(v) ? v : '[redacted]';
  }
  return out;
}

function createLogger(sink = (line) => console.log(line)) {
  return {
    log(level, event, fields) {
      sink(JSON.stringify({ t: new Date().toISOString(), level, ...sanitize({ ...fields, event }) }));
    },
    info(event, fields) { this.log('info', event, fields); },
    warn(event, fields) { this.log('warn', event, fields); },
    error(event, fields) { this.log('error', event, fields); },
  };
}

module.exports = { createLogger, sanitize };
