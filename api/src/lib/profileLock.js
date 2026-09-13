'use strict';

/**
 * Advisory-lock-equivalent for `course_profiles` regeneration.
 *
 * See supabase/README.md §4: the two SQL constraints on `course_profiles`
 * (`UNIQUE(course_id, version)` + the partial unique index on `is_current`)
 * are what actually GUARANTEE correctness, even if this lock is ever
 * forgotten or buggy. This lock exists purely to make concurrent
 * regeneration EFFICIENT — skip a redundant duplicate Claude call and a
 * write that would fail its own unique-version insert anyway, rather than
 * doing the wasted work and racing to fail.
 *
 * Two implementations, chosen by whether `DATABASE_URL` is set:
 *
 * 1. Real Postgres (`DATABASE_URL` set — a direct `postgres://` connection
 *    string, deliberately separate from `SUPABASE_URL` /
 *    `SUPABASE_SERVICE_ROLE_KEY`): `pg_try_advisory_xact_lock` is
 *    transaction-scoped, so it needs ONE held session/transaction spanning
 *    the whole critical section. supabase-js's PostgREST-based client has no
 *    such session of its own — every `.from(...)` call is its own implicit
 *    transaction — so it cannot hold this lock across the several separate
 *    REST calls `generateProfile` makes. This branch instead opens a
 *    dedicated `pg` client, `BEGIN`s a transaction, acquires the lock, runs
 *    the caller's callback (which does its actual work over the normal
 *    supabase-js client, unrelated to this connection), then `COMMIT`s —
 *    releasing the xact-scoped lock automatically. This is real,
 *    UNTESTED-HERE code (no live Postgres reachable in this environment,
 *    same limitation as every other integration in this repo — see
 *    supabaseClient.js's own deployment note). Whoever wires up
 *    `DATABASE_URL` for a real deployment should smoke-test this path
 *    directly before relying on it.
 *
 * 2. In-memory fallback (`DATABASE_URL` unset — local dev, and every test in
 *    this repo, same trigger condition as supabaseClient.js's in-memory
 *    fallback): a plain in-process `Set` keyed by courseId stands in for the
 *    lock. This is correct for a single Node process — which is all this
 *    repo's tests, or a single dev server, ever run — but is NOT a
 *    substitute for the real advisory lock across multiple deployed API
 *    instances. That gap is the exact reason the two DB-level uniqueness
 *    constraints above are the real correctness backstop, not this lock.
 */

const crypto = require('crypto');

const inProcessLocks = new Set();

/**
 * `pg_try_advisory_xact_lock(bigint)` takes a signed 64-bit key. Computed
 * here (rather than via Postgres's own `hashtext()`, referenced in
 * supabase/README.md §4) since there is no live connection to call
 * `hashtext()` through before the lock itself is acquired.
 */
function hashCourseIdToBigInt(courseId) {
  const digest = crypto.createHash('sha256').update(String(courseId)).digest();
  return digest.readBigInt64BE(0);
}

async function withRealPostgresLock(courseId, fn) {
  // eslint-disable-next-line global-require -- only loaded when DATABASE_URL
  // is actually set, so `pg` is never required in the in-memory-fallback
  // path every test in this repo runs.
  const { Client } = require('pg');
  const pgClient = new Client({ connectionString: process.env.DATABASE_URL });
  await pgClient.connect();
  try {
    await pgClient.query('BEGIN');
    const lockKey = hashCourseIdToBigInt(courseId);
    const { rows } = await pgClient.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [lockKey]);
    if (!rows[0].acquired) {
      await pgClient.query('ROLLBACK');
      return { acquired: false };
    }
    const result = await fn();
    await pgClient.query('COMMIT');
    return { acquired: true, result };
  } catch (err) {
    await pgClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await pgClient.end();
  }
}

async function withInProcessLock(courseId, fn) {
  if (inProcessLocks.has(courseId)) {
    return { acquired: false };
  }
  inProcessLocks.add(courseId);
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    inProcessLocks.delete(courseId);
  }
}

/**
 * @param {string} courseId
 * @param {() => Promise<any>} fn - the critical section to run while the
 *   lock is held.
 * @returns {Promise<{acquired: boolean, result?: any}>}
 */
function withCourseProfileLock(courseId, fn) {
  return process.env.DATABASE_URL
    ? withRealPostgresLock(courseId, fn)
    : withInProcessLock(courseId, fn);
}

module.exports = { withCourseProfileLock, hashCourseIdToBigInt };
