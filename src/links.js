'use strict';

// Builds the Supabase verify link exactly like the official docs:
//   {SUPABASE_URL}/auth/v1/verify?token={token_hash}&type={email_action_type}&redirect_to={redirect_to}

/**
 * redirect_to must start with one of the allowed prefixes AND the prefix must end
 * at a boundary ("/", "?", "#" or end of string), so that
 * "https://app.example.com" does not match "https://app.example.com.evil.com".
 */
function isAllowedRedirect(redirectTo, prefixes) {
  if (typeof redirectTo !== 'string' || !redirectTo) return false;
  if (/[\s\\\u0000-\u001f\u007f]/.test(redirectTo)) return false;
  let parsed;
  try {
    parsed = new URL(redirectTo);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  return prefixes.some((raw) => {
    const prefix = raw.trim();
    if (!prefix || !redirectTo.startsWith(prefix)) return false;
    if (redirectTo.length === prefix.length) return true;
    if (/[/?#]$/.test(prefix)) return true;
    return /[/?#]/.test(redirectTo[prefix.length]);
  });
}

function buildVerifyLink({ supabaseUrl, tokenHash, type, redirectTo, allowedPrefixes }) {
  const params = new URLSearchParams();
  params.set('token', tokenHash);
  params.set('type', type);
  if (redirectTo && isAllowedRedirect(redirectTo, allowedPrefixes)) {
    params.set('redirect_to', redirectTo);
  } // otherwise dropped: Supabase then falls back to its configured Site URL
  return `${supabaseUrl}/auth/v1/verify?${params.toString()}`;
}

module.exports = { buildVerifyLink, isAllowedRedirect };
