#!/usr/bin/env node
'use strict';

/**
 * One-time setup helper: hashes a password with argon2 and prints the hash
 * to paste into `.env.local` as `KEVIN_PASSWORD_HASH` (and/or into a manual
 * `insert into app_user (...)` against the real Supabase project — see
 * supabase/seed.sql, which deliberately does not seed app_user itself).
 *
 * Usage:
 *   node scripts/generate-password-hash.js <password>
 *
 * The plaintext password is read from argv only for this one-time local
 * run — it is never logged, stored, or transmitted anywhere by this script.
 */

const { hashPassword } = require('../api/src/lib/auth.js');

async function main() {
  const password = process.argv[2];

  if (!password) {
    console.error('Usage: node scripts/generate-password-hash.js <password>');
    process.exitCode = 1;
    return;
  }

  const hash = await hashPassword(password);

  console.log('KEVIN_PASSWORD_HASH=' + hash);
}

main().catch((err) => {
  console.error('Failed to generate password hash:', err.message);
  process.exitCode = 1;
});
