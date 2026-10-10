'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { SECRET, makeEnv, fakeTransporter, payload, signedHeaders, startServer } = require('../test-support/helpers');

const nowSec = () => Math.floor(Date.now() / 1000);

test('valid signature -> 200 {} and one email to user.email only', async () => {
  const s = await startServer();
  try {
    const r = await s.post(payload());
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {});
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal(s.transporter.sent.length, 1);
    const m = s.transporter.sent[0];
    assert.equal(m.to, 'parent@example.test');
    assert.equal(m.from, 'DentisAI <no-reply@auth.example.test>');
    assert.equal(m.subject, 'Konfirmasi email akun DentisAI');
    assert.match(m.text, /https:\/\/proj\.supabase\.co\/auth\/v1\/verify\?token=/);
    assert.ok(m.html.includes('lang="id"'));
  } finally {
    await s.close();
  }
});

test('RECEIVER_EMAIL / other env addresses are never used as recipients', async () => {
  const s = await startServer({ env: makeEnv({ RECEIVER_EMAIL: 'owner@evil.test', SMTP_USER: 'smtp@evil.test' }) });
  try {
    await s.post(payload());
    for (const m of s.transporter.sent) assert.equal(m.to, 'parent@example.test');
    assert.equal(JSON.stringify(s.transporter.sent).includes('owner@evil.test'), false);
  } finally {
    await s.close();
  }
});

test('tampered body is rejected with 401 and nothing is sent', async () => {
  const s = await startServer();
  try {
    const original = JSON.stringify(payload());
    const headers = signedHeaders(original);
    const tampered = original.replace('parent@example.test', 'attacker@example.test');
    const r = await s.post(null, headers, { raw: tampered });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.http_code, 401);
    assert.equal(s.transporter.sent.length, 0);
  } finally {
    await s.close();
  }
});

test('whitespace-reserialised body (not byte-identical) is rejected', async () => {
  const s = await startServer();
  try {
    const original = JSON.stringify(payload());
    const headers = signedHeaders(original);
    const r = await s.post(null, headers, { raw: JSON.stringify(JSON.parse(original), null, 2) });
    assert.equal(r.status, 401);
  } finally {
    await s.close();
  }
});

test('wrong secret is rejected', async () => {
  const s = await startServer();
  try {
    const body = JSON.stringify(payload());
    const r = await s.post(null, signedHeaders(body, { key: crypto.randomBytes(32) }), { raw: body });
    assert.equal(r.status, 401);
    assert.equal(s.transporter.sent.length, 0);
  } finally {
    await s.close();
  }
});

test('stale and future timestamps are rejected; +-4 min accepted', async () => {
  const s = await startServer();
  try {
    for (const delta of [-301, 301, -3600, 3600]) {
      const body = JSON.stringify(payload());
      const r = await s.post(null, signedHeaders(body, { ts: nowSec() + delta }), { raw: body });
      assert.equal(r.status, 401, `delta ${delta}`);
    }
    for (const delta of [-240, 240]) {
      const body = JSON.stringify(payload());
      const r = await s.post(null, signedHeaders(body, { ts: nowSec() + delta }), { raw: body });
      assert.equal(r.status, 200, `delta ${delta}`);
    }
  } finally {
    await s.close();
  }
});

test('missing or malformed signature headers are rejected', async () => {
  const s = await startServer();
  try {
    const body = JSON.stringify(payload());
    for (const drop of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      const h = signedHeaders(body);
      delete h[drop];
      assert.equal((await s.post(null, h, { raw: body })).status, 401, drop);
    }
    const h = signedHeaders(body);
    h['webhook-signature'] = 'v1,not-base64!!';
    assert.equal((await s.post(null, h, { raw: body })).status, 401);
    h['webhook-signature'] = 'v2,' + h['webhook-signature'].slice(3);
    assert.equal((await s.post(null, h, { raw: body })).status, 401);
    const h2 = signedHeaders(body);
    h2['webhook-timestamp'] = 'abc';
    assert.equal((await s.post(null, h2, { raw: body })).status, 401);
    assert.equal(s.transporter.sent.length, 0);
  } finally {
    await s.close();
  }
});

test('multiple space-separated signatures: accepted if any v1 matches', async () => {
  const s = await startServer();
  try {
    const body = JSON.stringify(payload());
    const h = signedHeaders(body);
    const bogus = `v1,${crypto.randomBytes(32).toString('base64')}`;
    h['webhook-signature'] = `${bogus} ${h['webhook-signature']} v1a,zzzz`;
    assert.equal((await s.post(null, h, { raw: body })).status, 200);
    const h2 = signedHeaders(body);
    h2['webhook-signature'] = `${bogus} v1,${crypto.randomBytes(32).toString('base64')}`;
    assert.equal((await s.post(null, h2, { raw: body })).status, 401);
  } finally {
    await s.close();
  }
});

test('fail closed: no secret configured -> 503, nothing sent, even with a "valid" request', async () => {
  const env = makeEnv();
  delete env.SEND_EMAIL_HOOK_SECRET;
  const s = await startServer({ env });
  try {
    const r = await s.post(payload());
    assert.equal(r.status, 503);
    assert.equal(r.json.error.http_code, 503);
    assert.equal(s.transporter.sent.length, 0);
    assert.equal((await fetch(`${s.url}/healthz`).then((x) => x.json())).configured, false);
  } finally {
    await s.close();
  }
});

test('fail closed: malformed / too-short secret and missing MAIL_FROM -> 503', async () => {
  for (const env of [
    makeEnv({ SEND_EMAIL_HOOK_SECRET: 'v1,whsec_' }),
    makeEnv({ SEND_EMAIL_HOOK_SECRET: 'v1,whsec_abcd' }),
    makeEnv({ MAIL_FROM: '' }),
    makeEnv({ SUPABASE_URL: 'http://proj.supabase.co' }),
  ]) {
    const s = await startServer({ env });
    try {
      assert.equal((await s.post(payload())).status, 503);
    } finally {
      await s.close();
    }
  }
});

test('payload validation: bad emails, unknown action, wrong shape -> 400', async () => {
  const s = await startServer();
  try {
    const bad = [
      payload({ email: 'not-an-email' }),
      payload({ email: 'a@b.test\r\nBcc: x@y.test' }),
      payload({ email: 'a b@example.test' }),
      payload({ email: '"x"@example.test' }),
      payload({ email: 'x'.repeat(250) + '@example.test' }),
      payload({ action: 'email' }),
      payload({ action: 'password_changed_notification' }),
      payload({ action: '../../x' }),
      payload({ extraData: { token_hash: 'a b' } }),
      payload({ extraData: { token_hash: '' } }),
      payload({ extraData: { token: '12ab' } }),
      payload({ extraData: { redirect_to: 5 } }),
      { user: 'x', email_data: {} },
      [],
    ];
    for (const p of bad) {
      const r = await s.post(p);
      assert.equal(r.status, 400, JSON.stringify(p).slice(0, 80));
      assert.equal(r.json.error.http_code, 400);
    }
    assert.equal((await s.post(null, undefined, { raw: '{not json' })).status, 400);
    assert.equal(s.transporter.sent.length, 0);
  } finally {
    await s.close();
  }
});

test('oversized body -> 413 JSON error; empty body -> 400', async () => {
  const s = await startServer();
  try {
    const big = JSON.stringify({ pad: 'x'.repeat(70 * 1024) });
    const r = await s.post(null, signedHeaders(big), { raw: big });
    assert.equal(r.status, 413);
    assert.equal(r.json.error.http_code, 413);
    assert.equal((await s.post(null, signedHeaders(''), { raw: '' })).status, 400);
  } finally {
    await s.close();
  }
});

test('wrong methods / unknown routes / removed endpoints', async () => {
  const s = await startServer();
  try {
    assert.equal((await fetch(`${s.url}/hooks/send-email`)).status, 405);
    assert.equal((await fetch(`${s.url}/api/send-email`, { method: 'POST', body: '{}' })).status, 404);
    const root = await fetch(`${s.url}/`);
    assert.equal(root.status, 200);
    assert.deepEqual(await (await fetch(`${s.url}/healthz`)).json(), { status: 'ok', configured: true });
    assert.equal(root.headers.get('access-control-allow-origin'), null);
    assert.equal(root.headers.get('x-powered-by'), null);
  } finally {
    await s.close();
  }
});

test('SMTP failure -> 503 in Supabase error shape without leaking internals', async () => {
  const s = await startServer({ transporter: fakeTransporter({ fail: true }) });
  try {
    const r = await s.post(payload());
    assert.equal(r.status, 503);
    assert.deepEqual(Object.keys(r.json.error).sort(), ['http_code', 'message']);
    assert.equal(r.text.includes('secret.test'), false);
    assert.equal(r.text.includes('boom'), false);
  } finally {
    await s.close();
  }
});

test('SMTP hang is cut by the deadline', async () => {
  const hanging = { sent: [], sendMail: () => new Promise(() => {}) };
  const s = await startServer({ transporter: hanging, env: makeEnv({ SMTP_SEND_DEADLINE_MS: '300' }) });
  try {
    const t0 = Date.now();
    const r = await s.post(payload());
    assert.equal(r.status, 503);
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    await s.close();
  }
});

test('replay of an already-processed webhook-id does not send twice', async () => {
  const s = await startServer();
  try {
    const body = JSON.stringify(payload());
    const h = signedHeaders(body);
    assert.equal((await s.post(null, h, { raw: body })).status, 200);
    const again = await s.post(null, h, { raw: body });
    assert.equal(again.status, 200);
    assert.equal(s.transporter.sent.length, 1);
  } finally {
    await s.close();
  }
});

test('reauthentication sends the code, not a link', async () => {
  const s = await startServer();
  try {
    const r = await s.post(payload({ action: 'reauthentication', extraData: { token: '654321', token_hash: '' } }));
    assert.equal(r.status, 200);
    const m = s.transporter.sent[0];
    assert.ok(m.text.includes('654321') && m.html.includes('654321'));
    assert.equal(m.subject, 'Kode verifikasi DentisAI');
    assert.equal(/auth\/v1\/verify/.test(m.text + m.html), false);
  } finally {
    await s.close();
  }
});

test('link and subject for every action type', async () => {
  const subjects = {
    signup: 'Konfirmasi email akun DentisAI',
    invite: 'Undangan akun DentisAI',
    magiclink: 'Masuk ke akun DentisAI',
    recovery: 'Atur ulang kata sandi DentisAI',
  };
  for (const [action, subject] of Object.entries(subjects)) {
    const s = await startServer();
    try {
      assert.equal((await s.post(payload({ action }))).status, 200);
      const m = s.transporter.sent[0];
      assert.equal(m.subject, subject);
      const expected =
        'https://proj.supabase.co/auth/v1/verify?token=abcDEF0123456789abcDEF0123456789' +
        `&type=${action}&redirect_to=${encodeURIComponent('https://app.example.test/auth/callback')}`;
      assert.ok(m.text.includes(expected), action);
      assert.ok(m.html.includes(expected.replace(/&/g, '&amp;')), action);
    } finally {
      await s.close();
    }
  }
});

test('email_change: secure mode sends two mails (old address: token_hash_new; new address: token_hash)', async () => {
  const s = await startServer();
  try {
    const p = payload({
      action: 'email_change',
      email: 'old@example.test',
      extraUser: { new_email: 'new@example.test' },
      extraData: { token_hash: 'HASHFORNEWADDRESS1', token_hash_new: 'HASHFOROLDADDRESS1', token_new: '111111' },
    });
    assert.equal((await s.post(p)).status, 200);
    assert.equal(s.transporter.sent.length, 2);
    const toOld = s.transporter.sent.find((m) => m.to === 'old@example.test');
    const toNew = s.transporter.sent.find((m) => m.to === 'new@example.test');
    assert.ok(toOld.text.includes('token=HASHFOROLDADDRESS1&type=email_change'));
    assert.ok(toNew.text.includes('token=HASHFORNEWADDRESS1&type=email_change'));
    assert.notEqual(toOld.subject, toNew.subject);
    assert.equal(s.transporter.sent.every((m) => ['old@example.test', 'new@example.test'].includes(m.to)), true);
  } finally {
    await s.close();
  }
});

test('email_change: non-secure mode sends one mail to the new address; missing new_email -> 400', async () => {
  const s = await startServer();
  try {
    const p = payload({ action: 'email_change', email: 'old@example.test', extraUser: { new_email: 'new@example.test' } });
    assert.equal((await s.post(p)).status, 200);
    assert.equal(s.transporter.sent.length, 1);
    assert.equal(s.transporter.sent[0].to, 'new@example.test');
    assert.equal((await s.post(payload({ action: 'email_change' }))).status, 400);
  } finally {
    await s.close();
  }
});

test('redirect_to outside the allow-list is dropped from the link', async () => {
  const s = await startServer();
  try {
    await s.post(payload({ extraData: { redirect_to: 'https://evil.example/phish' } }));
    const m = s.transporter.sent[0];
    assert.equal(m.text.includes('redirect_to'), false);
    assert.equal(m.text.includes('evil.example'), false);
    assert.ok(m.text.includes('/auth/v1/verify?token='));
  } finally {
    await s.close();
  }
});

test('malicious email_data values are HTML-escaped / rejected, never injected', async () => {
  const s = await startServer();
  try {
    // redirect_to with markup: matches the allow-list prefix, so it is kept but must be escaped.
    const evil = 'https://app.example.test/auth/callback?x="><script>alert(1)</script>';
    const r = await s.post(payload({ extraData: { redirect_to: evil } }));
    // spaces/quotes make it fail the strict redirect check -> dropped; either way no raw markup:
    assert.equal(r.status, 200);
    const m = s.transporter.sent[0];
    assert.equal(m.html.includes('<script>'), false);
    assert.equal(m.html.includes('"><script'), false);
    assert.equal(m.text.includes('<script>'), false);
    // token with markup is rejected by validation.
    assert.equal((await s.post(payload({ action: 'reauthentication', extraData: { token: '<b>1</b>' } }))).status, 400);
  } finally {
    await s.close();
  }
});

test('per-recipient rate limit: 5 per hour, then 429 with Retry-After; others unaffected', async () => {
  const s = await startServer();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.post(payload())).status, 200, `#${i}`);
    const r = await s.post(payload());
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal(s.transporter.sent.length, 5);
    // case-insensitive
    assert.equal((await s.post(payload({ email: 'PARENT@example.test' }))).status, 429);
    assert.equal((await s.post(payload({ email: 'other@example.test' }))).status, 200);
  } finally {
    await s.close();
  }
});

test('per-recipient limit uses an injectable clock (window expires)', async () => {
  let t = Date.now();
  const s = await startServer({ now: () => t, env: makeEnv({ RATE_LIMIT_EMAIL_PER_HOUR: '2' }) });
  try {
    const send = () => {
      const body = JSON.stringify(payload());
      return s.post(null, signedHeaders(body, { ts: Math.floor(t / 1000) }), { raw: body });
    };
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 429);
    t += 61 * 60 * 1000;
    assert.equal((await send()).status, 200);
  } finally {
    await s.close();
  }
});

test('per-IP rate limit applies, including to unsigned requests', async () => {
  const s = await startServer({ env: makeEnv({ RATE_LIMIT_IP_PER_HOUR: '3' }) });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await s.post('{}', { 'content-type': 'application/json' })).status, 401);
    assert.equal((await s.post('{}', { 'content-type': 'application/json' })).status, 429);
  } finally {
    await s.close();
  }
});

test('X-Forwarded-For is ignored unless TRUST_PROXY is set', async () => {
  const s = await startServer({ env: makeEnv({ RATE_LIMIT_IP_PER_HOUR: '2' }) });
  try {
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const r = await s.post('{}', { 'content-type': 'application/json', 'x-forwarded-for': `9.9.9.${i}` });
      codes.push(r.status);
    }
    assert.deepEqual(codes, [401, 401, 429]);
  } finally {
    await s.close();
  }
  const s2 = await startServer({ env: makeEnv({ RATE_LIMIT_IP_PER_HOUR: '2', TRUST_PROXY: '1' }) });
  try {
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const r = await s2.post('{}', { 'content-type': 'application/json', 'x-forwarded-for': `9.9.9.${i}` });
      codes.push(r.status);
    }
    assert.deepEqual(codes, [401, 401, 401]);
  } finally {
    await s2.close();
  }
});

test('secret is accepted with or without the v1,whsec_ prefix', async () => {
  const bare = SECRET.replace('v1,whsec_', '');
  for (const secret of [bare, 'whsec_' + bare, SECRET]) {
    const s = await startServer({ env: makeEnv({ SEND_EMAIL_HOOK_SECRET: secret }) });
    try {
      assert.equal((await s.post(payload())).status, 200);
    } finally {
      await s.close();
    }
  }
});
