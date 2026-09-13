'use strict';

/**
 * Shared Supabase client for Kevin Study OS.
 *
 * DEPLOYMENT STEP (not solved here — no live Supabase project is
 * provisioned yet): set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in
 * the environment this API runs in. Once both are set, `getSupabaseClient`
 * talks to the real project via `@supabase/supabase-js`.
 *
 * Until then (local dev, and every test in this repo), both routes and
 * tests transparently run against `createInMemorySupabaseClient` — a
 * same-shaped fake covering the query-builder calls this app actually
 * makes (see `inMemoryNotesStore.js`). This is why `routes/notes.js` needs
 * no test-only branching of its own: it always just calls
 * `getSupabaseClient()`.
 */

const { createClient } = require('@supabase/supabase-js');
const { createInMemorySupabaseClient } = require('./inMemoryNotesStore');

let client = null;

function getSupabaseClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (url && key) {
    client = createClient(url, key);
  } else {
    console.warn(
      '[supabaseClient] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — ' +
        'falling back to the in-memory client. Set both before deploying.'
    );
    client = createInMemorySupabaseClient();
  }

  return client;
}

module.exports = { getSupabaseClient };
