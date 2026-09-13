'use strict';

/**
 * Vitest global setup — runs before any test file is imported.
 *
 * Every test in this repo was built and verified against the in-memory
 * Supabase stand-in (see lib/supabaseClient.js, lib/inMemoryNotesStore.js)
 * and, for voice-memo transcription, against mocked Whisper responses (see
 * lib/transcribe.js). That fallback only activates when
 * SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are absent — but a developer's real
 * `.env.local` (needed for actually running the app) now has real values in
 * it (including a real OPENAI_API_KEY, going forward), and `src/index.js`
 * loads that file via dotenv on require. Without this file, requiring
 * `src/index.js` from a test (as contract.test.js and others do, via
 * supertest) would silently point the whole test run at the real production
 * Supabase project (and a real OpenAI account) — corrupting real data and
 * failing tests that seed fixture rows the real DB doesn't have.
 *
 * Setting these to an explicit empty string (not deleting them) is
 * deliberate: dotenv's default `config()` call only ever fills in a key
 * that is NOT already present in `process.env` (it never overrides one that
 * exists, even if the existing value is falsy). Pre-setting them here, before
 * any test file's `require('../src/index')` triggers dotenv, means dotenv
 * sees the keys as already present and leaves them alone — so
 * `getSupabaseClient()`'s `if (url && key)` check reliably fails and every
 * test run, on every machine, always exercises the in-memory fallback
 * regardless of what's in that machine's real .env.local.
 */
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.DATABASE_URL = '';
