'use strict';

import crypto from 'crypto';
import { createRequire } from 'module';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';

// See api/test/notes.test.js for why this file uses `require` (via
// `createRequire`) rather than `import` for anything reaching the shared
// Supabase client / app singleton — the in-memory client is a module-level
// singleton that must be the same instance the app's own request handlers
// see.
const require = createRequire(import.meta.url);
const { getSupabaseClient } = require('../src/lib/supabaseClient.js');
const app = require('../src/index.js');
const {
  MIN_NOTES_REQUIRED,
  ProfileValidationError,
  generateProfile,
  dedupExamTopics,
  renumberRanks,
  postProcessExamTopics,
  callClaudeProfileTool,
} = require('../src/lib/profile.js');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-session-secret';

let sessionCookie;

beforeAll(async () => {
  const supabase = getSupabaseClient();
  await supabase
    .from('app_user')
    .insert({ email: 'kevin-profile-test@example.com', password_hash: await argon2.hash('test-password-fixture') })
    .select()
    .single();

  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'kevin-profile-test@example.com', password: 'test-password-fixture' });

  sessionCookie = loginRes.headers['set-cookie'][0].split(';')[0];
});

// ============================================================================
// Fixtures
// ============================================================================

function newId() {
  return crypto.randomUUID();
}

async function insertCourse(overrides = {}) {
  const supabase = getSupabaseClient();
  const id = overrides.id || newId();
  const { data, error } = await supabase
    .from('courses')
    .insert({
      term_id: newId(),
      code: 'TEST 101',
      name: 'Test Course',
      instructor_name: null,
      instructor_email: null,
      grading_scheme: 'percent',
      points_total_stated: null,
      grading_scale_unit: null,
      grading_scale_cutoffs: null,
      needs_review: false,
      review_reason: null,
      ...overrides,
      id,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function insertGradingComponent(courseId, overrides = {}) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('grading_components')
    .insert({
      course_id: courseId,
      parent_id: null,
      title: 'Final Exam',
      weight_percent: 40,
      points_possible: null,
      expected_count: null,
      count_best_n: null,
      drop_lowest_n: null,
      ...overrides,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

const FINAL_EXAM_SCOPE_TEXT = 'Final exam covers chapters 4-6 on regression analysis.';

async function insertSyllabusItem(courseId, overrides = {}) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('syllabus_items')
    .insert({
      course_id: courseId,
      upload_id: newId(),
      grading_component_id: null,
      points_possible: null,
      title: 'Final Exam',
      item_kind: 'final_exam',
      due_start: null,
      due_end: null,
      due_time: null,
      available_from: null,
      available_until: null,
      date_precision: 'tba',
      source_text: FINAL_EXAM_SCOPE_TEXT,
      source_section: 'body_prose',
      content_hash: newId(),
      is_recurring: false,
      expected_count: null,
      completed_count: null,
      confidence: 0.9,
      needs_review: false,
      is_user_edited: false,
      term_mismatch: false,
      origin: 'syllabus',
      completed_at: null,
      deleted_at: null,
      superseded_by_upload_id: null,
      ...overrides,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function createNote(courseId, overrides = {}) {
  const res = await request(app)
    .post(`/api/courses/${courseId}/notes`)
    .set('Cookie', sessionCookie)
    .send({ note_date: '2026-09-01', body_md: 'test note body', ...overrides });
  if (res.status !== 201) throw new Error(`note create failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Same call shape as the real Anthropic SDK client's `messages.create`,
 * returning the next queued tool input on each successive call. */
function createFakeClaudeClient(responses) {
  let callIndex = 0;
  return {
    messages: {
      async create({ tools }) {
        const input = responses[Math.min(callIndex, responses.length - 1)];
        callIndex += 1;
        return { content: [{ type: 'tool_use', id: 'toolu_fake', name: tools[0].name, input }] };
      },
    },
  };
}

const V1_TOPIC_EVIDENCE_NOTE = 'confused about interpreting p-values';
const V1_RESPONSE = {
  summary_md: '## TEST 101 — Course Profile\n\nFocus so far: regression analysis and p-value interpretation.',
  exam_topics: [
    {
      topic: 'Regression analysis and p-value interpretation',
      rank: 1,
      rationale:
        'Recurs across Kevin\'s notes (notes signal) and the syllabus explicitly states the final exam covers this material (syllabus signal).',
      evidence: [V1_TOPIC_EVIDENCE_NOTE, FINAL_EXAM_SCOPE_TEXT],
      confidence: 0.9,
    },
  ],
};

const V2_NEW_TOPIC_EVIDENCE = "don't understand the difference between CI and hypothesis testing";
const V2_RESPONSE = {
  summary_md:
    '## TEST 101 — Course Profile (updated)\n\nFocus so far: regression analysis, p-value interpretation, and now confidence intervals vs hypothesis testing.',
  exam_topics: [
    {
      topic: 'Regression analysis and p-value interpretation',
      rank: 1,
      rationale: 'Still recurs across Kevin\'s notes (notes signal) and the syllabus scope statement still applies (syllabus signal).',
      evidence: [V1_TOPIC_EVIDENCE_NOTE, FINAL_EXAM_SCOPE_TEXT],
      confidence: 0.85,
    },
    {
      topic: 'Confidence intervals vs hypothesis testing',
      rank: 2,
      rationale: "Newly introduced and Kevin explicitly flags confusion about it (notes signal).",
      evidence: [V2_NEW_TOPIC_EVIDENCE],
      confidence: 0.7,
    },
  ],
};

// ============================================================================
// generateProfile — lib level (mocked Claude client, in-memory Supabase)
// ============================================================================

describe('generateProfile', () => {
  it('returns not_enough_notes with 0 or 1 active notes, never calling Claude', async () => {
    const course = await insertCourse();
    const client = createFakeClaudeClient([V1_RESPONSE]);

    const zeroNotes = await generateProfile(course.id, { client });
    expect(zeroNotes).toEqual({ status: 'not_enough_notes' });

    await createNote(course.id);
    const oneNote = await generateProfile(course.id, { client });
    expect(oneNote).toEqual({ status: 'not_enough_notes' });
  });

  it('with 2 notes, produces version 1: ranked, deduplicated exam topics, every rationale non-empty, notes_through_at is the latest note\'s real created_at (not "now")', async () => {
    const course = await insertCourse();
    await insertGradingComponent(course.id);
    await insertSyllabusItem(course.id);

    await createNote(course.id, { note_date: '2026-09-01', body_md: 'Today we covered regression analysis basics and I\'m still confused about interpreting p-values.' });
    const secondNote = await createNote(course.id, { note_date: '2026-09-03', body_md: 'More regression analysis today, the professor emphasized p-values again. Still confused.' });

    const client = createFakeClaudeClient([V1_RESPONSE]);
    const before = Date.now();
    const profile = await generateProfile(course.id, { client });

    expect(profile.version).toBe(1);
    expect(profile.is_current).toBe(true);
    expect(profile.course_id).toBe(course.id);
    expect(profile.model).toBeTruthy();
    expect(profile.summary_md).toContain('regression analysis');

    expect(profile.exam_topics).toHaveLength(1);
    expect(profile.exam_topics[0].rank).toBe(1);
    expect(profile.exam_topics[0].rationale.length).toBeGreaterThan(0);
    expect(profile.exam_topics[0].evidence.length).toBeGreaterThan(0);

    // notes_through_at must be the latest note's real timestamp, not "now" —
    // it should match the second note's created_at exactly, and predate the
    // instant generateProfile actually ran.
    expect(profile.notes_through_note_id).toBe(secondNote.id);
    expect(profile.notes_through_at).toBe(secondNote.created_at);
    expect(new Date(profile.notes_through_at).getTime()).toBeLessThanOrEqual(before);
  });

  it('a 3rd note introducing a new topic produces version 2 whose summary_md differs from version 1\'s and contains the new topic, without mutating version 1', async () => {
    const course = await insertCourse();
    await insertSyllabusItem(course.id);
    await createNote(course.id, { note_date: '2026-09-01', body_md: 'Today we covered regression analysis basics and I\'m still confused about interpreting p-values.' });
    await createNote(course.id, { note_date: '2026-09-03', body_md: 'More regression analysis today, the professor emphasized p-values again. Still confused.' });

    const v1 = await generateProfile(course.id, { client: createFakeClaudeClient([V1_RESPONSE]) });
    expect(v1.version).toBe(1);

    await createNote(course.id, {
      note_date: '2026-09-05',
      body_md: "New topic today: we started confidence intervals and I don't understand the difference between CI and hypothesis testing at all.",
    });

    const v2 = await generateProfile(course.id, { client: createFakeClaudeClient([V2_RESPONSE]) });

    expect(v2.version).toBe(2);
    expect(v2.is_current).toBe(true);
    expect(v2.summary_md).not.toBe(v1.summary_md);
    expect(v2.summary_md.toLowerCase()).toContain('confidence intervals');
    expect(v2.exam_topics.map((t) => t.topic)).toContain('Confidence intervals vs hypothesis testing');

    // Ranks are sequential starting at 1, no duplicates.
    expect(v2.exam_topics.map((t) => t.rank)).toEqual([1, 2]);

    // Old version untouched: still exists, unchanged content, no longer current.
    const supabase = getSupabaseClient();
    const { data: rows } = await supabase.from('course_profiles').select('*').eq('course_id', course.id);
    const persistedV1 = rows.find((r) => r.version === 1);
    const persistedV2 = rows.find((r) => r.version === 2);
    expect(rows).toHaveLength(2);
    expect(persistedV1.summary_md).toBe(v1.summary_md);
    expect(persistedV1.is_current).toBe(false);
    expect(persistedV2.is_current).toBe(true);

    // Exactly one current row for the course.
    expect(rows.filter((r) => r.is_current)).toHaveLength(1);
  });

  it('an on-demand regeneration (calling generateProfile again with no new notes) still produces a new version without mutating the previous one', async () => {
    const course = await insertCourse();
    await createNote(course.id, { note_date: '2026-09-01', body_md: 'Today we covered regression analysis basics and I\'m still confused about interpreting p-values.' });
    await createNote(course.id, { note_date: '2026-09-03', body_md: 'More regression analysis today, the professor emphasized p-values again. Still confused.' });

    const v1 = await generateProfile(course.id, { client: createFakeClaudeClient([V1_RESPONSE]) });
    const v2 = await generateProfile(course.id, { client: createFakeClaudeClient([V1_RESPONSE]) });

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id);

    const supabase = getSupabaseClient();
    const { data: rows } = await supabase.from('course_profiles').select('*').eq('course_id', course.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.version === 1).is_current).toBe(false);
  });

  it('two near-simultaneous regenerations for the same course: exactly one proceeds, the other is skipped, and exactly one is_current row results', async () => {
    // No DATABASE_URL is set in this test environment (no live Postgres —
    // see profileLock.js's own module comment), so this exercises the
    // in-process-mutex branch of the lock, not the real
    // pg_try_advisory_xact_lock branch. That real branch cannot be exercised
    // without a live Postgres connection, same limitation as every other
    // live-credential-gated integration in this repo.
    //
    // The race is real, not simulated after the fact: `generateProfile` is
    // an async function whose lock-acquisition (a synchronous Set
    // check-then-add inside profileLock.js, with no `await` in between) runs
    // to completion before either call's first `await` yields control back
    // to the event loop. Calling it twice as the two arguments to
    // `Promise.all` means the first call's synchronous prefix (including
    // acquiring the lock) always completes before the second call's
    // synchronous prefix begins, so the second call's lock check reliably
    // observes the first call's lock as already held — deterministically
    // reproducing the race this test asserts against, not relying on timing
    // luck.
    const course = await insertCourse();
    await createNote(course.id, { note_date: '2026-09-01', body_md: 'Today we covered regression analysis basics and I\'m still confused about interpreting p-values.' });
    await createNote(course.id, { note_date: '2026-09-03', body_md: 'More regression analysis today, the professor emphasized p-values again. Still confused.' });

    const [first, second] = await Promise.all([
      generateProfile(course.id, { client: createFakeClaudeClient([V1_RESPONSE]) }),
      generateProfile(course.id, { client: createFakeClaudeClient([V1_RESPONSE]) }),
    ]);

    const results = [first, second];
    const skipped = results.filter((r) => r && r.status === 'skipped');
    const succeeded = results.filter((r) => r && r.version != null);

    expect(skipped).toHaveLength(1);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].version).toBe(1);

    const supabase = getSupabaseClient();
    const { data: rows } = await supabase.from('course_profiles').select('*').eq('course_id', course.id);
    expect(rows).toHaveLength(1);
    expect(rows.filter((r) => r.is_current)).toHaveLength(1);
  });

  it('never persists a row when Claude output fails schema validation on both attempts (returns null)', async () => {
    const course = await insertCourse();
    await createNote(course.id, { note_date: '2026-09-01', body_md: 'note one' });
    await createNote(course.id, { note_date: '2026-09-02', body_md: 'note two' });

    const invalidResponse = {
      summary_md: 'x',
      exam_topics: [
        { topic: 'T', rank: 1, rationale: 'just because', evidence: ['made up snippet never written anywhere'], confidence: 0.5 },
      ],
    };
    const client = createFakeClaudeClient([invalidResponse, invalidResponse]);

    const result = await generateProfile(course.id, { client });
    expect(result).toBeNull();

    const supabase = getSupabaseClient();
    const { data: rows } = await supabase.from('course_profiles').select('*').eq('course_id', course.id);
    expect(rows).toHaveLength(0);
  });
});

// ============================================================================
// Focused unit coverage for the deterministic post-processing logic.
// ============================================================================

describe('dedupExamTopics + renumberRanks', () => {
  it('merges two near-identical topic labels, keeping the better-ranked one and combining evidence', () => {
    const topics = [
      { topic: 'Regression Analysis', rank: 1, rationale: 'notes', evidence: ['a'], confidence: 0.6 },
      { topic: 'regression analysis', rank: 2, rationale: 'notes and syllabus', evidence: ['b'], confidence: 0.9 },
      { topic: 'Something unrelated', rank: 3, rationale: 'syllabus', evidence: ['c'], confidence: 0.5 },
    ];
    const deduped = dedupExamTopics(topics);
    expect(deduped).toHaveLength(2);
    const merged = deduped.find((t) => t.topic === 'Regression Analysis');
    expect(merged.evidence).toEqual(expect.arrayContaining(['a', 'b']));
    expect(merged.confidence).toBe(0.9);
  });

  it('renumbers gapped/duplicate ranks to sequential integers starting at 1, preserving relative order', () => {
    const topics = [
      { topic: 'A', rank: 5, rationale: 'notes', evidence: ['x'], confidence: 0.5 },
      { topic: 'B', rank: 1, rationale: 'notes', evidence: ['y'], confidence: 0.5 },
      { topic: 'C', rank: 5, rationale: 'notes', evidence: ['z'], confidence: 0.5 },
    ];
    const renumbered = renumberRanks(topics);
    expect(renumbered.map((t) => t.rank)).toEqual([1, 2, 3]);
    expect(renumbered.map((t) => t.topic)).toEqual(['B', 'A', 'C']);
  });

  it('postProcessExamTopics composes both: dedup then sequential renumber', () => {
    const topics = [
      { topic: 'Regression analysis', rank: 1, rationale: 'notes', evidence: ['a'], confidence: 0.5 },
      { topic: 'regression analysis', rank: 2, rationale: 'notes', evidence: ['b'], confidence: 0.5 },
      { topic: 'Balance sheet reconciliation', rank: 3, rationale: 'syllabus', evidence: ['c'], confidence: 0.5 },
    ];
    const result = postProcessExamTopics(topics);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.rank)).toEqual([1, 2]);
  });
});

describe('callClaudeProfileTool — validation gate + bounded retry', () => {
  const sourceTexts = ['a real verbatim snippet from a note'];

  it('retries once when evidence is not verbatim, then succeeds', async () => {
    const responses = [
      {
        summary_md: 'x',
        exam_topics: [{ topic: 'T', rank: 1, rationale: 'per the notes', evidence: ['not a real snippet'], confidence: 0.5 }],
      },
      {
        summary_md: 'x',
        exam_topics: [{ topic: 'T', rank: 1, rationale: 'per the notes', evidence: ['a real verbatim snippet from a note'], confidence: 0.5 }],
      },
    ];
    const client = createFakeClaudeClient(responses);

    const { parsed, rawResponses } = await callClaudeProfileTool({
      client,
      model: 'test-model',
      promptText: 'prompt',
      dataBlockText: 'data',
      sourceTexts,
    });

    expect(rawResponses).toHaveLength(2);
    expect(parsed.exam_topics[0].evidence[0]).toBe('a real verbatim snippet from a note');
  });

  it('throws ProfileValidationError after 2 attempts when the rationale never names a signal', async () => {
    const invalid = {
      summary_md: 'x',
      exam_topics: [{ topic: 'T', rank: 1, rationale: 'just because', evidence: ['a real verbatim snippet from a note'], confidence: 0.5 }],
    };
    const client = createFakeClaudeClient([invalid, invalid]);

    await expect(
      callClaudeProfileTool({ client, model: 'test-model', promptText: 'prompt', dataBlockText: 'data', sourceTexts })
    ).rejects.toBeInstanceOf(ProfileValidationError);
  });
});

// ============================================================================
// HTTP routes
// ============================================================================

describe('GET /api/courses/:id/profile', () => {
  it('returns not_enough_notes for a course with 0 or 1 notes', async () => {
    const course = await insertCourse();

    const zeroRes = await request(app).get(`/api/courses/${course.id}/profile`).set('Cookie', sessionCookie);
    expect(zeroRes.status).toBe(200);
    expect(zeroRes.body).toEqual({ status: 'not_enough_notes' });

    await createNote(course.id);
    const oneRes = await request(app).get(`/api/courses/${course.id}/profile`).set('Cookie', sessionCookie);
    expect(oneRes.status).toBe(200);
    expect(oneRes.body).toEqual({ status: 'not_enough_notes' });
  });

  it('returns the current profile once one has been generated', async () => {
    const course = await insertCourse();
    await createNote(course.id, { note_date: '2026-09-01', body_md: 'note one about regression analysis' });
    await createNote(course.id, { note_date: '2026-09-02', body_md: 'note two, still confused about interpreting p-values' });

    const generated = await generateProfile(course.id, { client: createFakeClaudeClient([V1_RESPONSE]) });

    const res = await request(app).get(`/api/courses/${course.id}/profile`).set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(generated.id);
    expect(res.body.version).toBe(1);
    expect(res.body.is_current).toBe(true);
  });
});

describe('POST /api/courses/:id/profile/regenerate', () => {
  it('returns {status: "queued"} for a course with fewer than 2 notes (never calls the real Anthropic client here — no live credentials in this environment, same limitation noted throughout this repo)', async () => {
    const course = await insertCourse();
    const res = await request(app).post(`/api/courses/${course.id}/profile/regenerate`).set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'queued' });
  });
});

describe(`MIN_NOTES_REQUIRED is ${MIN_NOTES_REQUIRED}`, () => {
  it('is exactly 2', () => {
    expect(MIN_NOTES_REQUIRED).toBe(2);
  });
});
