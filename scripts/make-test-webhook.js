#!/usr/bin/env node
'use strict';

// Creates a correctly signed sample request for the Send Email hook, for manual
// testing with curl or --send. Uses SEND_EMAIL_HOOK_SECRET from the environment
// (or .env). NEVER send a real address you do not own.
//
//   node scripts/make-test-webhook.js --gen-secret
//   node scripts/make-test-webhook.js --email you@example.com --type signup
//   node scripts/make-test-webhook.js --email you@example.com --send --url http://localhost:5000
//
// Options: --email, --type (signup|invite|magiclink|recovery|email_change|reauthentication),
//          --new-email (email_change), --secure (email_change with 2 tokens),
//          --redirect <url>, --url <base url>, --send, --gen-secret

try {
  require('dotenv').config({ quiet: true });
} catch {
  /* dotenv is optional here */
}
const crypto = require('node:crypto');
const { sign, parseHookSecret } = require('../src/webhook');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function randomToken(len) {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args['gen-secret']) {
    console.log(`v1,whsec_${crypto.randomBytes(32).toString('base64')}`);
    console.error('Use this value for SEND_EMAIL_HOOK_SECRET on the server and in Supabase. Keep it secret.');
    return;
  }

  const key = parseHookSecret(process.env.SEND_EMAIL_HOOK_SECRET);
  if (!key) {
    console.error('SEND_EMAIL_HOOK_SECRET is missing or invalid (expected v1,whsec_<base64>).');
    process.exit(1);
  }

  const type = typeof args.type === 'string' ? args.type : 'signup';
  const email = typeof args.email === 'string' ? args.email : 'test@example.com';
  const baseUrl = typeof args.url === 'string' ? args.url.replace(/\/+$/, '') : 'http://localhost:5000';

  const user = { id: crypto.randomUUID(), aud: 'authenticated', role: '', email };
  const emailData = {
    token: String(100000 + crypto.randomInt(900000)),
    token_hash: randomToken(32),
    redirect_to: typeof args.redirect === 'string' ? args.redirect : 'https://app.ryhnfir.dev/auth/callback',
    email_action_type: type,
    site_url: 'https://app.ryhnfir.dev',
    token_new: '',
    token_hash_new: '',
  };
  if (type === 'email_change') {
    user.new_email = typeof args['new-email'] === 'string' ? args['new-email'] : 'new-address@example.com';
    if (args.secure) {
      emailData.token_new = String(100000 + crypto.randomInt(900000));
      emailData.token_hash_new = randomToken(32);
    }
  }

  const body = JSON.stringify({ user, email_data: emailData });
  const id = `msg_${crypto.randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = `v1,${sign(key, id, ts, Buffer.from(body)).toString('base64')}`;
  const endpoint = `${baseUrl}/hooks/send-email`;

  if (args.send) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': ts,
        'webhook-signature': signature,
      },
      body,
    });
    console.log(res.status, await res.text());
    return;
  }

  const shellBody = body.replace(/'/g, "'\\''");
  console.log(
    [
      `curl -i -X POST '${endpoint}' \\`,
      `  -H 'content-type: application/json' \\`,
      `  -H 'webhook-id: ${id}' \\`,
      `  -H 'webhook-timestamp: ${ts}' \\`,
      `  -H 'webhook-signature: ${signature}' \\`,
      `  --data-binary '${shellBody}'`,
    ].join('\n'),
  );
  console.error('The signature is valid for 5 minutes. Expected response: 200 and {}.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
