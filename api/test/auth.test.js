'use strict';

/**
 * No live Supabase instance is provisioned for this task (see the app_user
 * comment in supabase/seed.sql). `lib/supabaseClient.js` (shared with every
 * other route) falls back to an in-memory fake automatically when
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set, so these tests just
 * seed that same in-memory `app_user` table directly and exercise the real
 * login/session/rate-limit logic against it, with no DB connection. Live
 * end-to-end testing against a real Supabase project is a deployment-time
 * step, not something these tests attempt to solve.
 */

import { createRequire } from 'module';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';

// `require`d rather than `import`ed: routes/auth.js reaches lib/auth.js and
// lib/supabaseClient.js via CommonJS `require`, and Vitest's ESM/CJS
// interop does not otherwise guarantee that an `import` of the same
// CommonJS file from this ESM test resolves to the exact same module
// instance — the rate-limiter Map and the cached Supabase client are both
// module-level singletons that would otherwise be silently re-initialized
// here, invisible to the app's own request handlers.
const require = createRequire(import.meta.url);
const app = require('../src/index.js');
const { __resetRateLimiterForTests } = require('../src/lib/auth.js');
const { getSupabaseClient } = require('../src/lib/supabaseClient.js');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-session-secret';

// Test-only credential — never a real password, only ever compared against
// its own argon2 hash below. Not Kevin's actual password.
const TEST_EMAIL = 'kevin@example.com';
const TEST_PASSWORD = 'correct-test-password-fixture';
let testUserId;

function extractCookie(res) {
  const setCookie = res.headers['set-cookie'];
  expect(setCookie, 'expected a Set-Cookie header').toBeDefined();
  return setCookie[0].split(';')[0];
}

describe('auth', () => {
  beforeAll(async () => {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('app_user')
      .insert({ email: TEST_EMAIL, password_hash: await argon2.hash(TEST_PASSWORD) })
      .select()
      .single();
    testUserId = data.id;
  });

  beforeEach(async () => {
    await __resetRateLimiterForTests();
  });

  describe('unauthenticated access to a protected endpoint', () => {
    it('GET /api/courses with no session returns a generic 401, no leakage', async () => {
      const res = await request(app).get('/api/courses');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: expect.any(String) });
      expect(JSON.stringify(res.body)).not.toMatch(/stack|Error:/i);
    });
  });

  describe('login', () => {
    it('correct credentials set a valid session cookie, and GET /api/me then returns the user', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body).toEqual({ user: { id: testUserId, email: TEST_EMAIL } });

      const cookie = extractCookie(loginRes);
      expect(cookie).toMatch(/^kevin_session=/);

      const meRes = await request(app).get('/api/me').set('Cookie', cookie);
      expect(meRes.status).toBe(200);
      expect(meRes.body).toEqual({ user: { id: testUserId, email: TEST_EMAIL } });
    });

    it('the session cookie is httpOnly, SameSite=Strict, and carries a 30-day Max-Age', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

      const rawCookie = loginRes.headers['set-cookie'][0];
      expect(rawCookie).toMatch(/HttpOnly/);
      expect(rawCookie).toMatch(/SameSite=Strict/);
      expect(rawCookie).toMatch(/Max-Age=2592000/); // 30 * 24 * 60 * 60
    });

    it('wrong password returns a generic 401', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: TEST_EMAIL, password: 'not-the-right-password' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it('unknown email returns the same generic 401 as a wrong password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: TEST_PASSWORD });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it('rate-limits after 5 failed attempts from the same source, before checking the password (login_attempts-table-backed, not the old in-memory Map)', async () => {
      for (let i = 0; i < 5; i += 1) {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ email: TEST_EMAIL, password: 'wrong' });
        expect(res.status).toBe(401);
      }

      // 6th attempt, even with the CORRECT password, is blocked before any
      // credential check happens.
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

      expect(res.status).toBe(429);
    });
  });

  describe('logout', () => {
    it('requires a session (gated like every other /api/* route except health/login)', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(401);
    });

    it('with a valid session, clears the cookie and returns 204', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
      const cookie = extractCookie(loginRes);

      const res = await request(app).post('/api/auth/logout').set('Cookie', cookie);
      expect(res.status).toBe(204);
      expect(res.headers['set-cookie'][0]).toMatch(/Max-Age=0/);
    });
  });

  describe('GET /api/me', () => {
    it('returns 401 with no session', async () => {
      const res = await request(app).get('/api/me');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: expect.any(String) });
    });
  });
});
