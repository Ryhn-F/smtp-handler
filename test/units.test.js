'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildVerifyLink, isAllowedRedirect } = require('../src/links');
const { loadTemplates, render, substitute, escapeHtml, NAMES } = require('../src/templates');
const { createRateLimiter } = require('../src/ratelimit');
const { createLogger } = require('../src/logger');
const { parseHookSecret } = require('../src/webhook');
const { loadConfig } = require('../src/config');
const { payload, makeEnv, startServer, signedHeaders } = require('../test-support/helpers');

const PREFIXES = ['https://app.example.test/auth/callback', 'dentisai://auth/callback'];

test('redirect allow-list: exact, sub-path, query, custom scheme', () => {
  assert.ok(isAllowedRedirect('https://app.example.test/auth/callback', PREFIXES));
  assert.ok(isAllowedRedirect('https://app.example.test/auth/callback/', PREFIXES));
  assert.ok(isAllowedRedirect('https://app.example.test/auth/callback?next=1', PREFIXES));
  assert.ok(isAllowedRedirect('dentisai://auth/callback', PREFIXES));
});

test('redirect allow-list rejects look-alikes and tricks', () => {
  for (const bad of [
    'https://app.example.test/auth/callbackevil',
    'https://app.example.test.evil.test/auth/callback',
    'https://evil.test/?https://app.example.test/auth/callback',
    'https://app.example.test/auth/callback\\@evil.test',
    'https://app.example.test/auth/callback\r\nX: y',
    'http://app.example.test/auth/callback',
    'javascript:alert(1)',
    'dentisai://auth/callbackx',
    '',
    undefined,
  ]) {
    assert.equal(isAllowedRedirect(bad, PREFIXES), false, String(bad));
  }
  assert.equal(isAllowedRedirect('https://app.example.test/auth/callback', []), false);
});

test('buildVerifyLink follows the Supabase docs format and encodes values', () => {
  const link = buildVerifyLink({
    supabaseUrl: 'https://proj.supabase.co',
    tokenHash: 'abc_DEF-123',
    type: 'recovery',
    redirectTo: 'dentisai://auth/callback?a=b&c=d',
    allowedPrefixes: PREFIXES,
  });
  const u = new URL(link);
  assert.equal(u.origin + u.pathname, 'https://proj.supabase.co/auth/v1/verify');
  assert.equal(u.searchParams.get('token'), 'abc_DEF-123');
  assert.equal(u.searchParams.get('type'), 'recovery');
  assert.equal(u.searchParams.get('redirect_to'), 'dentisai://auth/callback?a=b&c=d');
  assert.ok(link.includes('redirect_to=dentisai%3A%2F%2Fauth%2Fcallback%3Fa%3Db%26c%3Dd'));
  const dropped = buildVerifyLink({
    supabaseUrl: 'https://proj.supabase.co',
    tokenHash: 'abc',
    type: 'signup',
    redirectTo: 'https://evil.test',
    allowedPrefixes: PREFIXES,
  });
  assert.equal(new URL(dropped).searchParams.has('redirect_to'), false);
});

test('substitute: escapes values, single pass, unknown names empty', () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(substitute('a {{X}} b {{ Y }} c {{Z}}', { X: '<i>', Y: '{{X}}' }, escapeHtml), 'a &lt;i&gt; b {{X}} c ');
});

test('templates: all present in html + txt, Indonesian, no leftover placeholders, no forbidden phrases', () => {
  const templates = loadTemplates();
  const forbidden = [/diagnosis/i, /didiagnosis/i, /\bpasti\b/i, /dipastikan/i, /\baman\b/i, /100%/, /menderita/i, /positif karies/i, /obati sendiri/i];
  for (const name of NAMES) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'templates', `${name}.txt`)), name);
    const out = render(templates, name, { ConfirmationURL: 'https://x.test/?a=1&b=2', Token: '123456' });
    for (const field of [out.html, out.text, out.subject]) {
      assert.equal(/\{\{/.test(field), false, `${name} placeholder left`);
      for (const re of forbidden) assert.equal(re.test(field), false, `${name} ${re}`);
    }
    assert.equal(/<!--/.test(out.html), false, 'comments stripped');
    assert.ok(/DentisAI/.test(out.subject));
    // no child data placeholders
    assert.equal(/anak|foto|skrining|hasil/i.test(out.text), false, `${name} mentions health data`);
  }
});

test('templates: malicious values cannot break out of the HTML or text', () => {
  const templates = loadTemplates();
  const out = render(templates, 'confirmation', {
    ConfirmationURL: 'https://x.test/"><script>alert(1)</script>\r\nBcc: a@b.test',
    Token: '<b>',
  });
  assert.equal(out.html.includes('<script>'), false);
  assert.equal(out.html.includes('"><script'), false);
  assert.equal(out.text.includes('\r'), false);
  assert.equal(/^Bcc:/m.test(out.text), false);
});

test('rate limiter: sliding window, retryAfter, eviction bound', () => {
  let t = 1000;
  const rl = createRateLimiter({ max: 2, windowMs: 10000, now: () => t, maxKeys: 3 });
  assert.ok(rl.hit('a').allowed);
  assert.ok(rl.hit('a').allowed);
  const blocked = rl.hit('a');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSec, 10);
  t += 10000;
  assert.ok(rl.hit('a').allowed);
  for (const k of ['b', 'c', 'd', 'e', 'f']) rl.hit(k);
  assert.ok(rl.size() <= 3);
});

test('parseHookSecret: formats', () => {
  const b64 = Buffer.alloc(32, 7).toString('base64');
  for (const s of [`v1,whsec_${b64}`, `whsec_${b64}`, b64]) assert.equal(parseHookSecret(s).length, 32);
  for (const s of [undefined, '', 'v1,whsec_', 'v1,whsec_!!!', 'whsec_YQ==']) assert.equal(parseHookSecret(s), null);
});

test('config: defaults and validation', () => {
  const c = loadConfig(makeEnv({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_PORT: '465' }));
  assert.equal(c.ok, true);
  assert.equal(c.smtp.secure, true);
  assert.equal(c.limits.perEmailMax, 5);
  assert.equal(c.trustProxy, false);
  const missing = loadConfig({}).missing;
  for (const n of ['SEND_EMAIL_HOOK_SECRET', 'SUPABASE_URL', 'MAIL_FROM', 'SMTP_HOST']) assert.ok(missing.includes(n), n);
});

test('logs never contain e-mail addresses, tokens, links or bodies', async () => {
  const secretEmail = 'very.private.parent@example.test';
  const newEmail = 'brand.new.address@example.test';
  const tokenHash = 'SECRETHASHVALUE0123456789abcdef';
  const code = '987654';
  const captured = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  const origInfo = console.info;
  console.log = console.error = console.warn = console.info = (...a) => captured.push(a.map(String).join(' '));
  // use the DEFAULT logger (console sink) so that real output is inspected
  const s = await startServer({ logger: createLogger() });
  try {
    const scenarios = [
      payload({ email: secretEmail, extraData: { token: code, token_hash: tokenHash } }),
      payload({ email: secretEmail, action: 'reauthentication', extraData: { token: code } }),
      payload({ email: secretEmail, action: 'email_change', extraUser: { new_email: newEmail }, extraData: { token_hash: tokenHash, token_hash_new: tokenHash + 'N' } }),
      payload({ email: 'bad address@x', extraData: { token_hash: tokenHash } }),
    ];
    for (const p of scenarios) await s.post(p);
    await s.post(JSON.stringify(scenarios[0]), { 'content-type': 'application/json' }); // unsigned
    await s.post(null, signedHeaders('{oops', {}), { raw: '{oops' });
    const failing = await startServer({
      logger: createLogger(),
      transporter: { sendMail: async () => { throw Object.assign(new Error(`fail ${secretEmail}`), { code: 'EAUTH' }); } },
    });
    await failing.post(scenarios[0]);
    await failing.close();
  } finally {
    await s.close();
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
    console.info = origInfo;
  }
  const all = captured.join('\n');
  assert.ok(captured.length > 0, 'something was logged');
  for (const needle of [secretEmail, newEmail, tokenHash, code, 'private.parent', '@', 'supabase.co', '/auth/v1/verify', 'redirect_to', 'whsec_']) {
    assert.equal(all.includes(needle), false, `log leaked: ${needle}`);
  }
  assert.match(all, /"event":"sent"/);
});

test('logger drops unknown fields and redacts unsafe values', () => {
  const lines = [];
  const l = createLogger((x) => lines.push(x));
  l.info('evt', { email: 'a@b.test', reason: 'a@b.test', action: 'signup', count: 2, status: 200 });
  const o = JSON.parse(lines[0]);
  assert.equal(o.email, undefined);
  assert.equal(o.reason, '[redacted]');
  assert.equal(o.action, 'signup');
  assert.equal(o.count, 2);
});
