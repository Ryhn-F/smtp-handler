'use strict';

const defaultExpress = require('express');
const nodemailer = require('nodemailer');

const { loadConfig } = require('./config');
const { verifyWebhook } = require('./webhook');
const { validatePayload, planMessages } = require('./payload');
const { buildVerifyLink } = require('./links');
const { loadTemplates, render } = require('./templates');
const { createRateLimiter } = require('./ratelimit');
const { createLogger } = require('./logger');
const crypto = require('node:crypto');

const SEEN_TTL_MS = 10 * 60 * 1000;
const SEEN_MAX = 5000;

function errorBody(httpCode, message) {
  return { error: { http_code: httpCode, message } };
}

function sendError(res, httpCode, message, extraHeaders) {
  if (extraHeaders) res.set(extraHeaders);
  return res.status(httpCode).json(errorBody(httpCode, message));
}

function createTransporter(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure && smtp.requireTLS,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: smtp.connectionTimeout,
    greetingTimeout: smtp.greetingTimeout,
    socketTimeout: smtp.socketTimeout,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
}

function withDeadline(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('deadline'), { code: 'EDEADLINE' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env]        defaults to process.env
 * @param {{sendMail:Function}} [opts.transporter]            injectable (tests)
 * @param {() => number} [opts.now]                           ms clock (tests)
 * @param {object} [opts.logger]
 */
function createApp(opts = {}) {
  // `express` can be injected: index.js imports it itself because Vercel's entrypoint detection
  // only accepts a file that directly imports express.
  const express = opts.express || defaultExpress;
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const logger = opts.logger || createLogger();
  const config = loadConfig(env, { needSmtp: !opts.transporter });
  config.smtp.requireTLS = env.SMTP_REQUIRE_TLS !== 'false';

  const templates = loadTemplates();
  const transporter = opts.transporter || (config.ok ? createTransporter(config.smtp) : null);

  const ipLimiter = createRateLimiter({ max: config.limits.perIpMax, windowMs: config.limits.windowMs, now });
  const emailLimiter = createRateLimiter({ max: config.limits.perEmailMax, windowMs: config.limits.windowMs, now });
  const seen = new Map(); // webhook-id -> expiry ms (only successfully processed ids)

  function rememberId(id) {
    const t = now();
    if (seen.size >= SEEN_MAX) {
      for (const [k, exp] of seen) if (exp <= t) seen.delete(k);
      while (seen.size >= SEEN_MAX) seen.delete(seen.keys().next().value);
    }
    seen.set(id, t + SEEN_TTL_MS);
  }
  function alreadySeen(id) {
    const exp = seen.get(id);
    if (exp === undefined) return false;
    if (exp <= now()) {
      seen.delete(id);
      return false;
    }
    return true;
  }

  const emailKey = (addr) => crypto.createHash('sha256').update(addr.toLowerCase()).digest('hex');

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });

  // --- health (no secrets) ---
  app.get('/', (_req, res) => res.type('text/plain').send('DentisAI mailer is running.'));
  app.get('/healthz', (_req, res) => res.json({ status: 'ok', configured: config.ok }));

  // --- Supabase Auth "Send Email" hook ---
  function ipGate(req, res, next) {
    if (!config.ok) {
      logger.error('hook_not_configured', { status: 503, missing: config.missing.join(':') });
      return sendError(res, 503, 'Service is not configured');
    }
    const r = ipLimiter.hit(req.ip || 'unknown');
    if (!r.allowed) {
      logger.warn('rate_limited', { reason: 'ip', status: 429 });
      return sendError(res, 429, 'Too many requests', { 'Retry-After': String(r.retryAfterSec) });
    }
    return next();
  }

  const rawBody = express.raw({ type: () => true, limit: config.bodyLimit });

  app.post('/hooks/send-email', ipGate, rawBody, async (req, res) => {
    const started = now();
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      logger.warn('rejected', { reason: 'empty_body', status: 400 });
      return sendError(res, 400, 'Invalid request');
    }

    // 1) Authenticate FIRST: nothing in the body is trusted or parsed before this.
    const verdict = verifyWebhook({
      key: config.hookSecret,
      body,
      headers: req.headers,
      nowSec: Math.floor(now() / 1000),
      toleranceSec: config.toleranceSec,
    });
    if (!verdict.ok) {
      logger.warn('rejected', { reason: verdict.reason, status: 401 });
      return sendError(res, 401, 'Invalid webhook signature');
    }
    const whid = verdict.id;

    // 2) Replay of an already-processed message: acknowledge without sending again.
    if (alreadySeen(whid)) {
      logger.info('replay_ignored', { whid, status: 200 });
      return res.status(200).json({});
    }

    // 3) Parse + strictly validate.
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      logger.warn('rejected', { whid, reason: 'bad_json', status: 400 });
      return sendError(res, 400, 'Invalid request body');
    }
    const valid = validatePayload(parsed);
    if (!valid.ok) {
      logger.warn('rejected', { whid, reason: valid.reason, status: 400 });
      return sendError(res, 400, 'Invalid request body');
    }
    const p = valid.value;
    const plan = planMessages(p);
    if (!plan.ok) {
      logger.warn('rejected', { whid, action: p.action, reason: plan.reason, status: 400 });
      return sendError(res, 400, 'Invalid request body');
    }

    // 4) Per-recipient rate limit (check all first so a 2-mail plan is all-or-nothing).
    const keys = plan.messages.map((m) => emailKey(m.to));
    for (const k of keys) {
      const r = emailLimiter.peek(k);
      if (!r.allowed) {
        logger.warn('rate_limited', { whid, action: p.action, reason: 'recipient', status: 429 });
        return sendError(res, 429, 'Too many emails for this recipient', { 'Retry-After': String(r.retryAfterSec) });
      }
    }
    for (const k of keys) emailLimiter.hit(k);

    // 5) Build and send. Recipients come only from the signed payload.
    const allowedRecipients = new Set([p.email, p.newEmail].filter(Boolean));
    try {
      const mails = plan.messages.map((m) => {
        if (!allowedRecipients.has(m.to)) throw new Error('recipient not in payload'); // defensive
        const link = m.link
          ? buildVerifyLink({
              supabaseUrl: config.supabaseUrl,
              tokenHash: m.link.tokenHash,
              type: p.action,
              redirectTo: p.redirectTo,
              allowedPrefixes: config.allowedRedirectPrefixes,
            })
          : '';
        const out = render(templates, m.template, { ConfirmationURL: link, Token: m.code || '' });
        return {
          from: config.mailFrom,
          to: m.to,
          subject: out.subject,
          text: out.text,
          html: out.html,
          headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
        };
      });
      await withDeadline(Promise.all(mails.map((mail) => transporter.sendMail(mail))), config.smtp.sendDeadlineMs);
    } catch (err) {
      const code = err && typeof err.code === 'string' ? err.code : 'UNKNOWN';
      logger.error('send_failed', { whid, action: p.action, smtp_code: code, status: 503, ms: now() - started });
      return sendError(res, 503, 'Failed to send email');
    }

    rememberId(whid);
    logger.info('sent', { whid, action: p.action, count: plan.messages.length, status: 200, ms: now() - started });
    return res.status(200).json({});
  });

  // Anything else on the hook path: wrong method.
  app.all('/hooks/send-email', (_req, res) => sendError(res, 405, 'Method not allowed', { Allow: 'POST' }));

  app.use((_req, res) => sendError(res, 404, 'Not found'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      logger.warn('rejected', { reason: 'too_large', status: 413 });
      return sendError(res, 413, 'Payload too large');
    }
    const status = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    logger.error('unhandled_error', { status });
    return sendError(res, status, status === 500 ? 'Internal error' : 'Invalid request');
  });

  return { app, config, logger };
}

module.exports = { createApp, errorBody };
