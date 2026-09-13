'use strict';

/**
 * Kevin Study OS — core auth logic.
 *
 * Single-user auth: exactly one row is ever expected in `app_user`
 * (supabase/migrations/0001_init.sql). No signup, no password reset, no
 * MFA, no multi-user roles — see task boundaries.
 *
 * Session strategy: a signed, stateless cookie (via `cookie-signature`),
 * not a JWT and not a server-side session store. The cookie value is a
 * base64url-encoded JSON payload (`{sub, email, iat, exp}`) plus an HMAC
 * signature. Verifying a session is just "is the signature valid and has
 * it not expired" — no DB round-trip needed per request.
 *
 * Password hashing: argon2 (the modern default; bcrypt was the other
 * option under consideration, argon2 wins for new code).
 *
 * Rate limiting: backed by the `login_attempts` table
 * (supabase/migrations/0003_login_attempts.sql), not a plain in-memory Map —
 * on Vercel, separate requests can be handled by different, memory-isolated
 * function instances, so an in-process Map would not reliably track
 * attempts across requests. See the "Login rate limiting" section below.
 *
 * Supabase wiring lives in `./supabaseClient.js` (shared with every other
 * route) — this module calls into it directly for the login_attempts table
 * (below), the same client every other route uses. That module falls back
 * to an in-memory fake automatically when SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY aren't set, which is what makes this app's own
 * tests (and routes/auth.js's tests) runnable without a live DB.
 */

const argon2 = require('argon2');
const cookieSignature = require('cookie-signature');
const { getSupabaseClient } = require('./supabaseClient');

const SESSION_COOKIE_NAME = 'kevin_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 5;

// ============================================================================
// Password hashing
// ============================================================================

async function hashPassword(password) {
  return argon2.hash(password);
}

async function verifyPassword(password, hash) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Malformed/unrecognized hash — treat as a failed verification, never
    // throw out of a login attempt for this reason.
    return false;
  }
}

// ============================================================================
// Session cookie signing / verification
// ============================================================================

function requireSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET must be set');
  }
  return secret;
}

function createSessionToken(user) {
  const payload = {
    sub: user.id,
    email: user.email,
    iat: Date.now(),
    exp: Date.now() + SESSION_MAX_AGE_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return cookieSignature.sign(encoded, requireSessionSecret());
}

// Returns { id, email } for a valid, unexpired token, or null otherwise.
// Never throws — every failure mode (bad signature, malformed payload,
// expired) collapses to the same "no session" result.
function verifySessionToken(token) {
  if (!token) return null;

  const unsigned = cookieSignature.unsign(token, requireSessionSecret());
  if (unsigned === false) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(unsigned, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;

  return { id: payload.sub, email: payload.email };
}

// ============================================================================
// Cookie plumbing
//
// No `cookie-parser` middleware is wired up in index.js, so this module
// owns both directions itself: parsing the incoming `Cookie` header and
// building the outgoing `Set-Cookie` header.
// ============================================================================

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;

  for (const pair of cookieHeader.split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }

  return cookies;
}

function buildSetCookieHeader(value, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`];
  parts.push('Path=/');
  parts.push('HttpOnly');
  parts.push('SameSite=Strict');
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', buildSetCookieHeader(token, Math.floor(SESSION_MAX_AGE_MS / 1000)));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', buildSetCookieHeader('', 0));
}

// Reads the session cookie off a request and returns { id, email } or null.
function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[SESSION_COOKIE_NAME]);
}

// ============================================================================
// Login rate limiting — 5 failed attempts / 15 minutes / IP
//
// Append-only: one row per failed attempt (login_attempts, same "never
// mutate history in place" spirit as course_profiles). "Rate limited" means
// 5+ rows for this IP within the last RATE_LIMIT_WINDOW_MS — isRateLimited's
// own `gte` filter is what actually excludes aged-out attempts from that
// count. recordFailedLoginAttempt additionally prunes this IP's own rows
// that have already aged out of the window before inserting the new one —
// pure hygiene (keeps the table from growing unbounded for one IP), not a
// correctness requirement.
// ============================================================================

const LOGIN_ATTEMPTS_TABLE = 'login_attempts';

function rateLimitWindowStartIso() {
  return new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
}

async function isRateLimited(ip) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(LOGIN_ATTEMPTS_TABLE)
    .select('id')
    .eq('ip', ip)
    .gte('attempted_at', rateLimitWindowStartIso());
  if (error) throw error;

  return (data || []).length >= RATE_LIMIT_MAX_ATTEMPTS;
}

async function recordFailedLoginAttempt(ip) {
  const supabase = getSupabaseClient();

  await supabase.from(LOGIN_ATTEMPTS_TABLE).delete().eq('ip', ip).lt('attempted_at', rateLimitWindowStartIso());

  // `attempted_at` is set explicitly rather than left to the column's own
  // `default now()` (0003_login_attempts.sql) — the in-memory fallback used
  // in every test in this repo (see inMemoryNotesStore.js) has no notion of
  // per-table column defaults beyond id/created_at/updated_at, so a row
  // inserted without this would never match `isRateLimited`'s/the prune's
  // `attempted_at` comparisons against the real client either, since the
  // column's presence in `.insert()`'s payload is what this app relies on
  // everywhere else (e.g. `note_date`, `notes_through_at`).
  const { error } = await supabase.from(LOGIN_ATTEMPTS_TABLE).insert({ ip, attempted_at: new Date().toISOString() });
  if (error) throw error;
}

async function clearLoginAttempts(ip) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from(LOGIN_ATTEMPTS_TABLE).delete().eq('ip', ip);
  if (error) throw error;
}

// Test-only utility — clears every row in login_attempts (every IP, not just
// one). Not reachable from any HTTP route; exists purely so test files can
// isolate cases that exercise the rate limiter from each other.
async function __resetRateLimiterForTests() {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from(LOGIN_ATTEMPTS_TABLE)
    .delete()
    .gte('attempted_at', new Date(0).toISOString());
  if (error) throw error;
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  RATE_LIMIT_MAX_ATTEMPTS,
  RATE_LIMIT_WINDOW_MS,
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  getSessionUser,
  isRateLimited,
  recordFailedLoginAttempt,
  clearLoginAttempts,
  __resetRateLimiterForTests,
};
