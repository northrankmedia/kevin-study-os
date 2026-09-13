'use strict';

import { createRequire } from 'module';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { ENDPOINTS } from '../../shared/contract.js';

// `require`d rather than `import`ed — see api/test/auth.test.js for why
// (the cached Supabase client is a module-level singleton that must be the
// exact same instance the app's own request handlers see).
const require = createRequire(import.meta.url);
const app = require('../src/index.js');
const { getSupabaseClient } = require('../src/lib/supabaseClient.js');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-session-secret';

// Test-only credential, never a real password — see api/test/auth.test.js
// for the dedicated auth test suite this fixture also appears in.
const TEST_EMAIL = 'kevin@example.com';
const TEST_PASSWORD = 'correct-test-password-fixture';

// A concrete UUID standing in for any `:id` path param — the stub routes
// return a fixed mock body regardless of the id supplied (no DB is wired up
// yet — see task boundaries).
const DUMMY_ID = '00000000-0000-4000-8000-000000000000';

function resolvePath(pathTemplate) {
  return pathTemplate.replace(/:id/g, DUMMY_ID);
}

// Per-endpoint request fixtures, keyed by "METHOD /path" — only needed
// where the stub actually validates req.body/req.query, so the success
// path (not just the 400-empty-body path) gets exercised too.
const REQUEST_FIXTURES = {
  'POST /api/auth/login': { body: { email: TEST_EMAIL, password: TEST_PASSWORD } },
  'POST /api/courses/:id/notes': { body: { note_date: '2026-09-05', body_md: 'test note' } },
  'PATCH /api/notes/:id': { body: { title: 'updated title' } },
  'PATCH /api/items/:id': { body: { completed_at: '2026-09-06T12:00:00.000Z' } },
};

describe('frozen HTTP contract — every stubbed endpoint returns a schema-valid mock', () => {
  let sessionCookie;
  const supabase = getSupabaseClient();

  beforeAll(async () => {
    // Every /api/* route except health and login is now gated behind a
    // session (this task). No live Supabase instance is provisioned for
    // this task, so this seeds the same in-memory `app_user` table that
    // `lib/supabaseClient.js` falls back to automatically, letting the
    // loop below authenticate once and reuse that session cookie.
    await supabase
      .from('app_user')
      .insert({ email: TEST_EMAIL, password_hash: await argon2.hash(TEST_PASSWORD) })
      .select()
      .single();

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    sessionCookie = loginRes.headers['set-cookie'][0].split(';')[0];
  });

  for (const endpoint of ENDPOINTS) {
    const key = `${endpoint.method} ${endpoint.path}`;

    it(`${key}`, async () => {
      const path = resolvePath(endpoint.path);
      const fixture = REQUEST_FIXTURES[key];
      const method = endpoint.method.toLowerCase();

      let req = request(app)[method](path).set('Cookie', sessionCookie);
      if (endpoint.path === '/api/courses/:id/syllabus/upload-url') {
        req = req.send({ mimetype: 'application/pdf', size_bytes: 1024 });
      } else if (endpoint.path === '/api/courses/:id/syllabus') {
        // The processing endpoint now fetches its bytes from Supabase
        // Storage itself — seed a stub file directly into the (in-memory)
        // bucket to stand in for "the browser already PUT this file
        // directly via the /upload-url step's signed URL".
        const relativePath = `${DUMMY_ID}/contract-test-syllabus.pdf`;
        await supabase.storage
          .from('syllabi')
          .upload(relativePath, Buffer.from('%PDF-1.4 stub'), { contentType: 'application/pdf' });
        req = req.send({
          storage_path: `syllabi/${relativePath}`,
          original_filename: 'stub.pdf',
          mimetype: 'application/pdf',
        });
      } else if (endpoint.path === '/api/courses/:id/notes/voice/upload-url') {
        req = req.send({ mimetype: 'audio/mp4', size_bytes: 1024 });
      } else if (endpoint.path === '/api/courses/:id/notes/voice') {
        const relativePath = `${DUMMY_ID}/contract-test-voice.m4a`;
        await supabase.storage
          .from('voice-memos')
          .upload(relativePath, Buffer.from('stub audio bytes'), { contentType: 'audio/mp4' });
        req = req.send({
          storage_path: `voice-memos/${relativePath}`,
          original_filename: 'stub.m4a',
          mimetype: 'audio/mp4',
        });
      } else if (fixture && fixture.body) {
        req = req.send(fixture.body);
      }

      const res = await req;

      // 204 No Content is intentionally absent from `endpoint.responses` —
      // there's no body to validate.
      if (res.status === 204) {
        expect(res.body).toEqual({});
        return;
      }

      const schema = endpoint.responses[res.status];
      expect(schema, `${key} returned undocumented status ${res.status}`).toBeDefined();

      const result = schema.safeParse(res.body);
      expect(
        result.success,
        result.success ? undefined : JSON.stringify(result.error.issues, null, 2)
      ).toBe(true);
    });
  }
});
