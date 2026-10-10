'use strict';

// Reads and validates configuration from an env-like object. Nothing here is
// ever logged except the NAMES of missing variables.

const { parseHookSecret } = require('./webhook');

function intFrom(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false' || value === '0') return false;
  if (value === 'true') return true; // trusts every hop; documented as risky
  if (/^\d+$/.test(value)) return Number(value);
  return value; // e.g. "loopback" or a CIDR list, passed to Express as-is
}

function parseList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function validSupabaseUrl(value) {
  if (!value) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/**
 * @param {Record<string,string|undefined>} env
 * @param {{ needSmtp?: boolean }} [opts] needSmtp=false when a transporter is injected (tests)
 */
function loadConfig(env, { needSmtp = true } = {}) {
  const missing = [];

  const hookSecret = parseHookSecret(env.SEND_EMAIL_HOOK_SECRET);
  if (!hookSecret) missing.push('SEND_EMAIL_HOOK_SECRET');

  const supabaseUrl = validSupabaseUrl((env.SUPABASE_URL || '').trim());
  if (!supabaseUrl) missing.push('SUPABASE_URL');

  const mailFrom = (env.MAIL_FROM || '').trim();
  if (!mailFrom || /[\r\n]/.test(mailFrom)) missing.push('MAIL_FROM');

  const smtpPort = intFrom(env.SMTP_PORT, 587, { min: 1, max: 65535 });
  const smtp = {
    host: (env.SMTP_HOST || '').trim(),
    port: smtpPort,
    secure: env.SMTP_SECURE === undefined || env.SMTP_SECURE === '' ? smtpPort === 465 : env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    // Supabase gives the hook ~5 s in total, so keep SMTP timeouts short.
    connectionTimeout: intFrom(env.SMTP_CONNECTION_TIMEOUT_MS, 3000, { min: 200, max: 60000 }),
    greetingTimeout: intFrom(env.SMTP_GREETING_TIMEOUT_MS, 3000, { min: 200, max: 60000 }),
    socketTimeout: intFrom(env.SMTP_SOCKET_TIMEOUT_MS, 4000, { min: 200, max: 120000 }),
    sendDeadlineMs: intFrom(env.SMTP_SEND_DEADLINE_MS, 4200, { min: 200, max: 120000 }),
  };
  if (needSmtp) {
    if (!smtp.host) missing.push('SMTP_HOST');
    if (!smtp.user) missing.push('SMTP_USER');
    if (!smtp.pass) missing.push('SMTP_PASS');
  }

  return {
    ok: missing.length === 0,
    missing,
    port: intFrom(env.PORT, 5000, { min: 1, max: 65535 }),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    hookSecret,
    supabaseUrl,
    mailFrom,
    allowedRedirectPrefixes: parseList(env.ALLOWED_REDIRECT_PREFIXES),
    smtp,
    limits: {
      perEmailMax: intFrom(env.RATE_LIMIT_EMAIL_PER_HOUR, 5),
      perIpMax: intFrom(env.RATE_LIMIT_IP_PER_HOUR, 300),
      windowMs: intFrom(env.RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000, { min: 1000 }),
    },
    toleranceSec: 300,
    bodyLimit: '64kb',
  };
}

module.exports = { loadConfig, parseTrustProxy, parseList, validSupabaseUrl };
