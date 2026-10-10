'use strict';

const crypto = require('node:crypto');
const { createApp } = require('../src/create-app');
const { createLogger } = require('../src/logger');
const { sign } = require('../src/webhook');

const SECRET_KEY = crypto.randomBytes(32);
const SECRET = `v1,whsec_${SECRET_KEY.toString('base64')}`;

function makeEnv(overrides = {}) {
  return {
    SEND_EMAIL_HOOK_SECRET: SECRET,
    SUPABASE_URL: 'https://proj.supabase.co',
    MAIL_FROM: 'DentisAI <no-reply@auth.example.test>',
    ALLOWED_REDIRECT_PREFIXES: 'https://app.example.test/auth/callback,dentisai://auth/callback',
    ...overrides,
  };
}

function fakeTransporter({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(mail) {
      if (fail) throw Object.assign(new Error('boom user@secret.test'), { code: 'ECONNECTION' });
      sent.push(mail);
      return { messageId: 'x' };
    },
  };
}

function payload({ action = 'signup', email = 'parent@example.test', extraUser = {}, extraData = {} } = {}) {
  return {
    user: { id: 'u1', aud: 'authenticated', role: '', email, ...extraUser },
    email_data: {
      token: '123456',
      token_hash: 'abcDEF0123456789abcDEF0123456789',
      redirect_to: 'https://app.example.test/auth/callback',
      email_action_type: action,
      site_url: 'https://app.example.test',
      token_new: '',
      token_hash_new: '',
      ...extraData,
    },
  };
}

function signedHeaders(body, { id = `msg_${crypto.randomUUID()}`, ts = Math.floor(Date.now() / 1000), key = SECRET_KEY } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': `v1,${sign(key, id, String(ts), Buffer.from(raw)).toString('base64')}`,
  };
}

async function startServer({ env, transporter, logger, now } = {}) {
  const lines = [];
  const log = logger || createLogger((l) => lines.push(l));
  const t = transporter || fakeTransporter();
  const { app, config } = createApp({ env: env || makeEnv(), transporter: t, logger: log, now });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    lines,
    transporter: t,
    config,
    close: () => new Promise((r) => server.close(r)),
    async post(body, headers, { raw } = {}) {
      const text = raw !== undefined ? raw : typeof body === 'string' ? body : JSON.stringify(body);
      const res = await fetch(`${url}/hooks/send-email`, {
        method: 'POST',
        headers: headers || signedHeaders(text),
        body: text,
      });
      const bodyText = await res.text();
      let json = null;
      try {
        json = JSON.parse(bodyText);
      } catch {
        /* not json */
      }
      return { status: res.status, json, text: bodyText, headers: res.headers };
    },
  };
}

module.exports = { SECRET, SECRET_KEY, makeEnv, fakeTransporter, payload, signedHeaders, startServer };
