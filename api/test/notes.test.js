'use strict';

import crypto from 'crypto';
import { createRequire } from 'module';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { todayNY, isNoteDateWithinBounds } from '../src/lib/nyDate.js';

// Everything below is `require`d (via the same `createRequire`), not
// `import`ed, and in a specific order — routes/notes.js reaches queue.js
// and supabaseClient.js via CommonJS `require`, and Vitest's ESM/CJS
// interop does not otherwise guarantee that an `import` of the same
// CommonJS file from this ESM test resolves to the exact same module
// instance (supabaseClient.js's module-level `client` singleton would be
// silently re-initialized into a table the app's own request handlers can
// never see). Patching queue.js's export BEFORE requiring `../src/index.js`
// matters too: routes/notes.js destructures `queueProfileRegeneration` out
// of queue.js's exports at require time, so the patched `vi.fn()` below
// must already be in place the first time anything requires queue.js.
const require = createRequire(import.meta.url);
const queueModule = require('../src/lib/queue.js');
const queueProfileRegeneration = vi.fn();
queueModule.queueProfileRegeneration = queueProfileRegeneration;

// Referenced (not destructured) by routes/notes.js the same way — see
// `lib/transcribe.js`'s module comment. Individual voice-note tests below
// swap `transcribeModule.transcribeAudio` out temporarily to control the
// mocked Whisper outcome, then restore the real function afterward.
const transcribeModule = require('../src/lib/transcribe.js');
const realTranscribeAudio = transcribeModule.transcribeAudio;

const { getSupabaseClient } = require('../src/lib/supabaseClient.js');
const app = require('../src/index.js');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-session-secret';

// Every /api/* route except health and login is gated behind a session
// (see auth.test.js) — seed the in-memory `app_user` table and log in once
// so every request below can carry a valid session cookie.
let sessionCookie;

beforeAll(async () => {
  const supabase = getSupabaseClient();
  await supabase
    .from('app_user')
    .insert({ email: 'kevin@example.com', password_hash: await argon2.hash('test-password-fixture') })
    .select()
    .single();

  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'kevin@example.com', password: 'test-password-fixture' });

  sessionCookie = loginRes.headers['set-cookie'][0].split(';')[0];
});

function newCourseId() {
  return crypto.randomUUID();
}

async function createNote(courseId, overrides = {}) {
  return request(app)
    .post(`/api/courses/${courseId}/notes`)
    .set('Cookie', sessionCookie)
    .send({ note_date: '2026-09-05', body_md: 'test note body', ...overrides });
}

// Two-step flow, mirroring the browser's own get-upload-url -> upload
// directly to Supabase Storage -> call the processing endpoint sequence.
// Since there is no real network in tests, "the browser uploaded directly to
// Supabase Storage" is stood in for by seeding the in-memory storage fake
// directly with the same bytes, at the exact path the upload-url endpoint
// minted. If the upload-url step itself rejects (bad mimetype/size), its
// response is returned as-is — the processing endpoint is never reached, the
// same shape of failure the old single-request multipart flow produced.
async function createVoiceNote(courseId, { mimetype = 'audio/mp4', filename = 'memo.m4a', buffer, noteDate } = {}) {
  const audioBuffer = buffer || Buffer.from('fake audio bytes');

  const uploadUrlRes = await request(app)
    .post(`/api/courses/${courseId}/notes/voice/upload-url`)
    .set('Cookie', sessionCookie)
    .send({ mimetype, size_bytes: audioBuffer.length });

  if (uploadUrlRes.status !== 200) return uploadUrlRes;

  const { storage_path: storagePath } = uploadUrlRes.body;
  const relativePath = storagePath.replace(/^voice-memos\//, '');
  await getSupabaseClient().storage.from('voice-memos').upload(relativePath, audioBuffer, { contentType: mimetype });

  const body = { storage_path: storagePath, original_filename: filename, mimetype };
  if (noteDate) body.note_date = noteDate;

  return request(app).post(`/api/courses/${courseId}/notes/voice`).set('Cookie', sessionCookie).send(body);
}

describe('POST /api/courses/:id/notes', () => {
  it('persists two notes on the same course and same note_date, both returned on a subsequent GET', async () => {
    const courseId = newCourseId();

    const first = await createNote(courseId, { note_date: '2026-09-05', body_md: 'first note', title: 'A' });
    const second = await createNote(courseId, { note_date: '2026-09-05', body_md: 'second note', title: 'B' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).not.toBe(second.body.id);

    const listRes = await request(app).get(`/api/courses/${courseId}/notes`).set('Cookie', sessionCookie);
    expect(listRes.status).toBe(200);

    const bodies = listRes.body.map((n) => n.body_md);
    expect(bodies).toContain('first note');
    expect(bodies).toContain('second note');
    expect(listRes.body.every((n) => n.note_date === '2026-09-05')).toBe(true);
  });

  it('rejects empty/whitespace-only body_md with 400 and writes no row', async () => {
    const courseId = newCourseId();

    const emptyRes = await createNote(courseId, { body_md: '' });
    const whitespaceRes = await createNote(courseId, { body_md: '   \n\t  ' });

    expect(emptyRes.status).toBe(400);
    expect(whitespaceRes.status).toBe(400);

    const listRes = await request(app).get(`/api/courses/${courseId}/notes`).set('Cookie', sessionCookie);
    expect(listRes.body).toEqual([]);
  });

  it('rejects a note_date far enough in the future with 400', async () => {
    const courseId = newCourseId();
    // MAX_FUTURE_DAYS is 1 — 30 days out is unambiguously out of bounds
    // regardless of what "today" resolves to.
    const farFuture = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    const res = await createNote(courseId, { note_date: farFuture });
    expect(res.status).toBe(400);
  });

  it('scopes GET to the requested course only — another course\'s notes never leak in', async () => {
    const courseA = newCourseId();
    const courseB = newCourseId();

    await createNote(courseA, { body_md: 'belongs to A' });
    await createNote(courseB, { body_md: 'belongs to B' });

    const listA = await request(app).get(`/api/courses/${courseA}/notes`).set('Cookie', sessionCookie);
    expect(listA.body).toHaveLength(1);
    expect(listA.body[0].body_md).toBe('belongs to A');
    expect(listA.body[0].course_id).toBe(courseA);
  });

  it('calls queueProfileRegeneration exactly once per successful create, and the 201 response does not wait on it', async () => {
    queueProfileRegeneration.mockClear();
    // Artificially slow stub — if the route awaited this, the request would
    // take >=300ms. It shouldn't: the write must return immediately.
    queueProfileRegeneration.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 300))
    );

    const courseId = newCourseId();
    const start = Date.now();
    const res = await createNote(courseId);
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(201);
    expect(elapsedMs).toBeLessThan(150);
    expect(queueProfileRegeneration).toHaveBeenCalledTimes(1);
    expect(queueProfileRegeneration).toHaveBeenCalledWith(courseId);

    queueProfileRegeneration.mockReset();
  });
});

describe('POST /api/courses/:id/notes/voice', () => {
  it('creates a note with source: "voice", a non-null audio_url, and the mocked transcript as body_md', async () => {
    transcribeModule.transcribeAudio = vi.fn().mockResolvedValue('this is the mocked transcript text');

    const courseId = newCourseId();
    const res = await createVoiceNote(courseId);

    expect(res.status).toBe(201);
    expect(res.body.source).toBe('voice');
    expect(res.body.body_md).toBe('this is the mocked transcript text');
    expect(res.body.audio_url).not.toBeNull();
    expect(typeof res.body.audio_url).toBe('string');
    expect(res.body.course_id).toBe(courseId);

    transcribeModule.transcribeAudio = realTranscribeAudio;
  });

  it('rejects an unsupported mimetype with 400, creating no note and never calling transcribeAudio', async () => {
    transcribeModule.transcribeAudio = vi.fn();

    const courseId = newCourseId();
    const res = await createVoiceNote(courseId, { mimetype: 'text/plain', filename: 'notes.txt' });

    expect(res.status).toBe(400);
    expect(transcribeModule.transcribeAudio).not.toHaveBeenCalled();

    const listRes = await request(app).get(`/api/courses/${courseId}/notes`).set('Cookie', sessionCookie);
    expect(listRes.body).toEqual([]);

    transcribeModule.transcribeAudio = realTranscribeAudio;
  });

  it('rejects a file over VOICE_NOTE_MAX_BYTES with 413, creating no note', async () => {
    const { VOICE_NOTE_MAX_BYTES } = require('../../shared/contract.js');
    const oversizedBuffer = Buffer.alloc(VOICE_NOTE_MAX_BYTES + 1);

    const courseId = newCourseId();
    const res = await createVoiceNote(courseId, { buffer: oversizedBuffer });

    expect(res.status).toBe(413);

    const listRes = await request(app).get(`/api/courses/${courseId}/notes`).set('Cookie', sessionCookie);
    expect(listRes.body).toEqual([]);
  });

  it('a mocked failed transcription returns 422 and creates no note', async () => {
    transcribeModule.transcribeAudio = vi
      .fn()
      .mockRejectedValue(new transcribeModule.TranscriptionError('mocked Whisper failure'));

    const courseId = newCourseId();
    const res = await createVoiceNote(courseId);

    expect(res.status).toBe(422);
    expect(res.body.error).toBeTruthy();

    const listRes = await request(app).get(`/api/courses/${courseId}/notes`).set('Cookie', sessionCookie);
    expect(listRes.body).toEqual([]);

    transcribeModule.transcribeAudio = realTranscribeAudio;
  });

  it('a missing OPENAI_API_KEY (the real function, unmocked) produces a clean 422, not a crash', async () => {
    // OPENAI_API_KEY is force-emptied for every test — see test/setup.js —
    // so the real (unmocked) transcribeAudio is exercised here directly.
    const courseId = newCourseId();
    const res = await createVoiceNote(courseId);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/OPENAI_API_KEY/);

    const listRes = await request(app).get(`/api/courses/${courseId}/notes`).set('Cookie', sessionCookie);
    expect(listRes.body).toEqual([]);
  });

  it('GET /api/courses/:id/notes returns both a text note and a voice note, each correctly shaped', async () => {
    transcribeModule.transcribeAudio = vi.fn().mockResolvedValue('voice note transcript');

    const courseId = newCourseId();
    await createNote(courseId, { body_md: 'a text note' });
    await createVoiceNote(courseId);

    const listRes = await request(app).get(`/api/courses/${courseId}/notes`).set('Cookie', sessionCookie);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(2);

    const textNote = listRes.body.find((n) => n.source === 'text');
    const voiceNote = listRes.body.find((n) => n.source === 'voice');

    expect(textNote).toBeDefined();
    expect(textNote.body_md).toBe('a text note');
    expect(textNote.audio_url).toBeNull();

    expect(voiceNote).toBeDefined();
    expect(voiceNote.body_md).toBe('voice note transcript');
    expect(voiceNote.audio_url).not.toBeNull();

    transcribeModule.transcribeAudio = realTranscribeAudio;
  });

  it('calls queueProfileRegeneration exactly once per successful voice-note create, and the 201 response does not wait on it', async () => {
    transcribeModule.transcribeAudio = vi.fn().mockResolvedValue('quick transcript');
    queueProfileRegeneration.mockClear();
    // Artificially slow stub — if the route awaited this, the request would
    // take >=300ms. It shouldn't: the write must return immediately.
    queueProfileRegeneration.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 300))
    );

    const courseId = newCourseId();
    const start = Date.now();
    const res = await createVoiceNote(courseId);
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(201);
    expect(elapsedMs).toBeLessThan(150);
    expect(queueProfileRegeneration).toHaveBeenCalledTimes(1);
    expect(queueProfileRegeneration).toHaveBeenCalledWith(courseId);

    queueProfileRegeneration.mockReset();
    transcribeModule.transcribeAudio = realTranscribeAudio;
  });
});

describe('note_date validated against America/New_York, not server local time', () => {
  it('todayNY resolves the NY calendar day even when it already differs from the UTC calendar day', () => {
    // 11:30pm US Eastern (EDT, UTC-4 in September) on 2026-09-05 is
    // 2026-09-06T03:30:00.000Z in UTC — already the next calendar day in
    // UTC (and in IST, UTC+5:30, it's 2026-09-06T09:00 — same next day).
    const elevenThirtyPmEasternOnSept5 = new Date('2026-09-06T03:30:00.000Z');

    const nyToday = todayNY(elevenThirtyPmEasternOnSept5);
    const utcToday = elevenThirtyPmEasternOnSept5.toISOString().slice(0, 10);

    expect(nyToday).toBe('2026-09-05');
    expect(utcToday).toBe('2026-09-06');
    expect(nyToday).not.toBe(utcToday);
  });

  it('a note dated the true NY calendar day is within bounds at that instant, using the injected now param (not global Date)', () => {
    const elevenThirtyPmEasternOnSept5 = new Date('2026-09-06T03:30:00.000Z');

    expect(isNoteDateWithinBounds('2026-09-05', elevenThirtyPmEasternOnSept5)).toBe(true);

    // Two calendar days ahead of the true NY today is out of bounds
    // (MAX_FUTURE_DAYS is 1) — this only fails correctly if the bounds
    // check is anchored to NY, not to the UTC day (which, at this instant,
    // is already one day ahead of NY, so a UTC-anchored bug would wrongly
    // accept this as only "1 day ahead").
    expect(isNoteDateWithinBounds('2026-09-07', elevenThirtyPmEasternOnSept5)).toBe(false);
  });

  it('end-to-end: submitting a note dated today in NY succeeds and is stored verbatim', async () => {
    const courseId = newCourseId();
    const nyToday = todayNY();

    const res = await createNote(courseId, { note_date: nyToday });

    expect(res.status).toBe(201);
    expect(res.body.note_date).toBe(nyToday);
  });
});

describe('PATCH /api/notes/:id', () => {
  it('partially updates body_md and/or title, and bumps updated_at', async () => {
    const courseId = newCourseId();
    const created = await createNote(courseId, { body_md: 'original body', title: 'original title' });
    expect(created.status).toBe(201);

    // Ensure a measurable clock tick between create and update.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const patchRes = await request(app)
      .patch(`/api/notes/${created.body.id}`)
      .set('Cookie', sessionCookie)
      .send({ body_md: 'updated body' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.body_md).toBe('updated body');
    expect(patchRes.body.title).toBe('original title');
    expect(new Date(patchRes.body.updated_at).getTime()).toBeGreaterThan(
      new Date(created.body.updated_at).getTime()
    );
  });

  it('rejects an empty/whitespace-only body_md patch with 400', async () => {
    const courseId = newCourseId();
    const created = await createNote(courseId);

    const patchRes = await request(app)
      .patch(`/api/notes/${created.body.id}`)
      .set('Cookie', sessionCookie)
      .send({ body_md: '   ' });

    expect(patchRes.status).toBe(400);
  });

  it('returns 404 for a note id that does not exist', async () => {
    const res = await request(app)
      .patch(`/api/notes/${crypto.randomUUID()}`)
      .set('Cookie', sessionCookie)
      .send({ title: 'does not matter' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/notes/:id', () => {
  it('soft-deletes: the note no longer appears in GET afterwards', async () => {
    const courseId = newCourseId();
    const created = await createNote(courseId);
    expect(created.status).toBe(201);

    const deleteRes = await request(app).delete(`/api/notes/${created.body.id}`).set('Cookie', sessionCookie);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app).get(`/api/courses/${courseId}/notes`).set('Cookie', sessionCookie);
    expect(listRes.body.find((n) => n.id === created.body.id)).toBeUndefined();
  });

  it('is idempotent — deleting a nonexistent id still returns 204', async () => {
    const res = await request(app).delete(`/api/notes/${crypto.randomUUID()}`).set('Cookie', sessionCookie);
    expect(res.status).toBe(204);
  });
});
