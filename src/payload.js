'use strict';

// Strict validation of the (already signature-verified) hook payload, and the
// plan of which e-mails to send. Recipients can ONLY come from the signed
// payload: user.email and, for email_change, user.new_email.

const ACTION_TYPES = new Set([
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'reauthentication',
]);

const EMAIL_MAX = 254;
// Deliberately conservative: no quotes, spaces, angle brackets, commas, etc.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const OTP_RE = /^\d{6,10}$/; // Supabase docs: 6 digits; allow longer in case OTP length is configured higher
const HASH_RE = /^[A-Za-z0-9_-]{1,256}$/;
const REDIRECT_MAX = 2048;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validEmail(v) {
  return typeof v === 'string' && v.length <= EMAIL_MAX && EMAIL_RE.test(v);
}

/** Optional string field: undefined/null/'' -> ''; wrong type -> null (invalid). */
function optString(v, re, max) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > max) return null;
  if (re && !re.test(v)) return null;
  return v;
}

/**
 * @returns {{ok:true,value:object}|{ok:false,reason:string}}
 */
function validatePayload(body) {
  if (!isPlainObject(body) || !isPlainObject(body.user) || !isPlainObject(body.email_data)) {
    return { ok: false, reason: 'bad_shape' };
  }
  const { user, email_data: ed } = body;

  if (!validEmail(user.email)) return { ok: false, reason: 'bad_user_email' };
  if (typeof ed.email_action_type !== 'string' || !ACTION_TYPES.has(ed.email_action_type)) {
    return { ok: false, reason: 'unsupported_action' };
  }

  const token = optString(ed.token, OTP_RE, 10);
  const tokenNew = optString(ed.token_new, OTP_RE, 10);
  const tokenHash = optString(ed.token_hash, HASH_RE, 256);
  const tokenHashNew = optString(ed.token_hash_new, HASH_RE, 256);
  const redirectTo = optString(ed.redirect_to, null, REDIRECT_MAX);
  if (token === null || tokenNew === null || tokenHash === null || tokenHashNew === null || redirectTo === null) {
    return { ok: false, reason: 'bad_email_data' };
  }

  let newEmail = '';
  if (user.new_email !== undefined && user.new_email !== null && user.new_email !== '') {
    if (!validEmail(user.new_email)) return { ok: false, reason: 'bad_new_email' };
    newEmail = user.new_email;
  }

  return {
    ok: true,
    value: {
      email: user.email,
      newEmail,
      action: ed.email_action_type,
      token,
      tokenNew,
      tokenHash,
      tokenHashNew,
      redirectTo,
    },
  };
}

/**
 * Decide which messages to send. Each: { to, template, subjectKey, link: {tokenHash}|null, code: string|null }
 * @returns {{ok:true,messages:object[]}|{ok:false,reason:string}}
 */
function planMessages(p) {
  switch (p.action) {
    case 'reauthentication':
      if (!p.token) return { ok: false, reason: 'missing_token' };
      return { ok: true, messages: [{ to: p.email, template: 'reauthentication', link: null, code: p.token }] };

    case 'email_change': {
      // Supabase docs (field names are crossed for backward compatibility):
      //   Secure email change ON  -> two e-mails:
      //     current address (user.email):    token + token_hash_new
      //     new address (user.new_email):    token_new + token_hash
      //   Secure email change OFF -> one e-mail to the new address, token_hash.
      // user.new_email is not in the documented schema [PERLU VERIFIKASI].
      if (!p.newEmail) return { ok: false, reason: 'missing_new_email' };
      if (!p.tokenHash) return { ok: false, reason: 'missing_token_hash' };
      const toNew = { to: p.newEmail, template: 'email_change', link: { tokenHash: p.tokenHash }, code: null };
      if (p.tokenHashNew) {
        return {
          ok: true,
          messages: [
            { to: p.email, template: 'email_change_current', link: { tokenHash: p.tokenHashNew }, code: null },
            toNew,
          ],
        };
      }
      return { ok: true, messages: [toNew] };
    }

    default: {
      if (!p.tokenHash) return { ok: false, reason: 'missing_token_hash' };
      const template = { signup: 'confirmation', invite: 'invite', magiclink: 'magic_link', recovery: 'recovery' }[p.action];
      return { ok: true, messages: [{ to: p.email, template, link: { tokenHash: p.tokenHash }, code: null }] };
    }
  }
}

module.exports = { validatePayload, planMessages, ACTION_TYPES, validEmail };
